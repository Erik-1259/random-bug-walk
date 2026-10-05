-- Rows enter the spend tables only through the spend database functions.
--
-- Each writing entry point turns on the transaction-local setting rbw.spend_api for the duration
-- of its call: it calls set_config(..., true) on entry and restores the previous value before it
-- returns. A SET clause on the function would need superuser privileges, because rbw.spend_api is
-- a custom parameter, and the database's owner role need not be a superuser. A BEFORE INSERT
-- trigger on every table refuses rows while the setting is off, so a session that did not go
-- through a function cannot write. The setting is a guard against direct writes by the
-- application's own roles, not a privilege boundary: a role that owns the schema can still alter
-- its triggers and functions.
--
-- Also: a slot release is blocked by every unconfirmed child resource of the root, under any slot
-- key; reservations of one operation ID serialize; and every function's captured search_path
-- names pg_temp last, so a session's temp tables cannot shadow the spend tables.

CREATE FUNCTION spend_require_function() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF current_setting('rbw.spend_api', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'table % accepts rows only through the spend database functions', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

-- The name sorts before every other BEFORE INSERT trigger on these tables, so it fires first.
DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'units', 'enforcement_methods', 'pools', 'pool_allocations', 'pool_cap_changes',
    'allocation_transfers', 'execution_slot', 'operations', 'operation_lines', 'operation_events',
    'spend', 'settlements', 'reconciliations', 'reservation_refusals', 'halt_observations',
    'halt_resumes', 'slot_events', 'slot_children', 'slot_child_confirmations'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION spend_require_function()',
      v_table || '_api_only', v_table
    );
  END LOOP;
END
$$;

-- What stops a root from releasing a slot: its unconfirmed child resources under any slot key,
-- and its unresolved operations. Each child names its slot key, where it is confirmed.
CREATE OR REPLACE FUNCTION spend_slot_blockers(p_slot text, p_root text) RETURNS jsonb LANGUAGE sql
BEGIN ATOMIC
  SELECT jsonb_build_object(
    'child_resources', coalesce((
      SELECT jsonb_agg(jsonb_build_object('slot_key', c.slot_key, 'provider', c.provider, 'resource_id', c.resource_id)
                       ORDER BY c.seq)
      FROM slot_children c
      WHERE c.root_execution_id = p_root
        AND NOT EXISTS (SELECT 1 FROM slot_child_confirmations x WHERE x.child_seq = c.seq)
    ), '[]'::jsonb),
    'operation_ids', coalesce((
      SELECT jsonb_agg(o.operation_id ORDER BY o.seq)
      FROM operations o
      WHERE o.root_execution_id = p_root
        AND spend_operation_state(o.operation_id) IN ('prepared', 'launching', 'running', 'uncertain')
    ), '[]'::jsonb)
  );
END;

CREATE OR REPLACE FUNCTION spend_reserve(p_request jsonb, p_now text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path FROM CURRENT AS $$
DECLARE
  r jsonb := p_request;
  v_now timestamptz := spend_parse_time(p_now);
  v_err text;
  v_envelope jsonb;
  v_worst bigint;
  v_operation_id text := r ->> 'operation_id';
  v_pool text := r ->> 'pool_key';
  v_allocation text := r ->> 'allocation_key';
  v_existing operations%ROWTYPE;
  v_previous operations%ROWTYPE;
  v_ordinal bigint;
  v_pool_available numeric;
  v_allocation_available numeric;
  v_code text;
BEGIN
  PERFORM spend_require_read_committed();
  IF v_now IS NULL THEN
    RETURN spend_invalid('now must be a UTC RFC3339 time ending in Z');
  END IF;
  v_err := coalesce(
    spend_keys_error(r, ARRAY[
      'operation_id', 'payload_hash', 'attempt_ordinal', 'previous_operation_id', 'project_id',
      'project_policy_sha256', 'batch_id', 'task_revision', 'root_execution_id', 'execution_id',
      'parent_execution_id', 'kind', 'call_name', 'provider', 'provider_replay_key', 'pool_key',
      'allocation_key', 'runtime_profile_sha256', 'rate_sheet_sha256', 'envelope'
    ]),
    spend_field_error(r, 'operation_id', 'hex64'),
    spend_field_error(r, 'payload_hash', 'hex64'),
    spend_field_error(r, 'attempt_ordinal', 'positive_int'),
    spend_field_error(r, 'previous_operation_id', 'hex64', true),
    spend_field_error(r, 'project_id', 'uuid'),
    spend_field_error(r, 'project_policy_sha256', 'hex64'),
    spend_field_error(r, 'batch_id', 'uuid', true),
    spend_field_error(r, 'task_revision', 'hex64'),
    spend_field_error(r, 'root_execution_id', 'uuid'),
    spend_field_error(r, 'execution_id', 'uuid'),
    spend_field_error(r, 'parent_execution_id', 'uuid', true),
    spend_field_error(r, 'kind', 'label'),
    spend_field_error(r, 'call_name', 'label'),
    spend_field_error(r, 'provider', 'label'),
    spend_field_error(r, 'provider_replay_key', 'identifier', true),
    spend_field_error(r, 'pool_key', 'key'),
    spend_field_error(r, 'allocation_key', 'key', true),
    spend_field_error(r, 'runtime_profile_sha256', 'hex64'),
    spend_field_error(r, 'rate_sheet_sha256', 'hex64')
  );
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;
  v_ordinal := (r ->> 'attempt_ordinal')::bigint;
  IF (v_ordinal = 1) <> (jsonb_typeof(r -> 'previous_operation_id') = 'null') THEN
    RETURN spend_invalid('previous_operation_id is required above attempt 1 and must be null on attempt 1');
  END IF;
  IF ((r ->> 'execution_id') = (r ->> 'root_execution_id')) <> (jsonb_typeof(r -> 'parent_execution_id') = 'null') THEN
    RETURN spend_invalid('parent_execution_id must be null exactly when execution_id is the root_execution_id');
  END IF;

  -- Serialize every reservation of one operation ID, whatever pool it names. A call that waited
  -- here reads a fresh snapshot below (READ COMMITTED), so it sees an operation committed while it
  -- waited and returns the replay or operation_conflict instead of failing on the primary key.
  PERFORM pg_advisory_xact_lock(hashtext('spend_reserve'), hashtext(v_operation_id));
  SELECT * INTO v_existing FROM operations WHERE operation_id = v_operation_id;
  IF FOUND THEN
    IF v_existing.intent = r THEN
      RETURN spend_reservation_result(v_operation_id, true);
    END IF;
    RETURN spend_refusal('operation_conflict');
  END IF;

  v_envelope := spend_price_envelope(r -> 'envelope');
  IF NOT (v_envelope ->> 'ok')::boolean THEN
    RETURN v_envelope;
  END IF;
  v_worst := (v_envelope ->> 'worst_case_microusd')::bigint;

  -- Serialize check-and-reserve per pool. The row lock is held until commit, and every later
  -- statement reads a fresh snapshot (READ COMMITTED), so a reservation committed while this
  -- call waited for the lock is counted below.
  PERFORM 1 FROM pools WHERE pool_key = v_pool FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN spend_refusal('unknown_pool');
  END IF;
  IF EXISTS (SELECT 1 FROM pool_allocations WHERE pool_key = v_pool) <> (v_allocation IS NOT NULL)
     OR (v_allocation IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM pool_allocations WHERE pool_key = v_pool AND allocation_key = v_allocation)) THEN
    RETURN spend_refusal('unknown_allocation');
  END IF;

  IF v_ordinal > 1 THEN
    SELECT * INTO v_previous FROM operations WHERE operation_id = r ->> 'previous_operation_id';
    IF NOT FOUND OR v_previous.attempt_ordinal <> v_ordinal - 1
       OR spend_operation_state(v_previous.operation_id) NOT IN ('terminal', 'reconciled') THEN
      RETURN spend_refusal('previous_attempt_unresolved');
    END IF;
  END IF;

  v_pool_available := spend_available(v_pool, NULL);
  v_allocation_available := CASE WHEN v_allocation IS NULL THEN NULL ELSE spend_available(v_pool, v_allocation) END;
  IF spend_halted() THEN
    v_code := 'pool_halted';
  ELSIF v_worst > v_pool_available OR v_worst > v_allocation_available THEN
    v_code := 'insufficient_funds';
  END IF;
  IF v_code IS NOT NULL THEN
    INSERT INTO reservation_refusals (
      operation_id, pool_key, allocation_key, code, requested_microusd,
      pool_available_microusd, allocation_available_microusd, recorded_at
    ) VALUES (
      v_operation_id, v_pool, v_allocation, v_code, v_worst,
      v_pool_available, v_allocation_available, v_now
    );
    RETURN spend_refusal(v_code, NULL, jsonb_build_object('requested_microusd', v_worst::text)
      || spend_amounts(v_pool, v_allocation));
  END IF;

  INSERT INTO operations (
    operation_id, payload_hash, attempt_ordinal, previous_operation_id, project_id,
    project_policy_sha256, batch_id, task_revision, root_execution_id, execution_id,
    parent_execution_id, kind, call_name, provider, provider_replay_key, pool_key,
    allocation_key, runtime_profile_sha256, rate_sheet_sha256, worst_case_microusd, intent, recorded_at
  ) VALUES (
    v_operation_id, r ->> 'payload_hash', v_ordinal, r ->> 'previous_operation_id', r ->> 'project_id',
    r ->> 'project_policy_sha256', r ->> 'batch_id', r ->> 'task_revision', r ->> 'root_execution_id', r ->> 'execution_id',
    r ->> 'parent_execution_id', r ->> 'kind', r ->> 'call_name', r ->> 'provider', r ->> 'provider_replay_key', v_pool,
    v_allocation, r ->> 'runtime_profile_sha256', r ->> 'rate_sheet_sha256', v_worst, r, v_now
  );
  INSERT INTO operation_lines (
    operation_id, line_no, service, unit, limit_quantity, enforced_by,
    price_microusd, price_per_units, worst_case_microusd
  )
  SELECT v_operation_id, l.n, l.e ->> 'service', l.e ->> 'unit', (l.e ->> 'limit')::bigint, l.e ->> 'enforced_by',
         (l.e ->> 'price_microusd')::bigint, (l.e ->> 'price_per_units')::bigint, (l.e ->> 'worst_case_microusd')::bigint
  FROM jsonb_array_elements(v_envelope -> 'lines') WITH ORDINALITY AS l(e, n);
  INSERT INTO spend (operation_id, pool_key, allocation_key, kind, amount_microusd, source, recorded_at)
  VALUES (v_operation_id, v_pool, v_allocation, 'reserve', v_worst, 'reservation', v_now);
  RETURN spend_reservation_result(v_operation_id, false);
END
$$;

-- The writing entry points. Each function above is renamed to spend_<name>_body, and a function
-- with the original name and signature turns the guard on, calls the body, and restores the
-- previous value before it returns. An error in the body aborts the transaction, or the enclosing
-- subtransaction, and that undoes the set_config with the rest of the call's work. Read-only status
-- functions and internal helpers stay without it.
DO $$
DECLARE
  v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'create_pool', 'create_slot_key', 'raise_cap', 'transfer', 'resume', 'reserve', 'transition',
    'settle', 'reconcile', 'slot_acquire', 'slot_record_child', 'slot_confirm_child', 'slot_release'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %I(jsonb, text) RENAME TO %I', 'spend_' || v_name, 'spend_' || v_name || '_body');
    EXECUTE format(
      $create$
      CREATE FUNCTION %I(p_request jsonb, p_now text) RETURNS jsonb
      LANGUAGE plpgsql VOLATILE SET search_path FROM CURRENT AS $fn$
      DECLARE
        v_previous text := current_setting('rbw.spend_api', true);
        v_result jsonb;
      BEGIN
        PERFORM set_config('rbw.spend_api', 'on', true);
        v_result := %I(p_request, p_now);
        PERFORM set_config('rbw.spend_api', coalesce(v_previous, ''), true);
        RETURN v_result;
      END
      $fn$
      $create$,
      'spend_' || v_name, 'spend_' || v_name || '_body'
    );
  END LOOP;
END
$$;

-- Recapture search_path in every function of this schema that pins it. The runner now sets
-- '<schema>, pg_temp', so the session's temp schema is searched last instead of first.
DO $$
DECLARE
  v_function regprocedure;
BEGIN
  FOR v_function IN
    SELECT p.oid::regprocedure FROM pg_proc p
    WHERE p.pronamespace = current_schema()::regnamespace
      AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path FROM CURRENT', v_function);
  END LOOP;
END
$$;

-- The call_name column takes the shared schema's CallName form.
--
-- The record schema (packages/schema/schema/records.schema.json, $defs.CallName) joins call-name
-- segments with ':', such as writer.issue:cand-17:3, which the spend_label domain refuses. The
-- column gets its own domain with the schema's pattern, unchanged, and a limit of 128 characters;
-- every other spend_label column keeps spend_label. Every spend_label value is also a call name, so
-- rows written before this migration still satisfy the new domain.
--
-- spend_reserve_body is the reservation body that 0004 renamed; it is replaced here with call_name
-- checked against the new format, and is otherwise unchanged. The spend_reserve wrapper calls it by
-- name, so the wrapper needs no change.

CREATE FUNCTION spend_is_call_name(p text) RETURNS boolean LANGUAGE sql IMMUTABLE
RETURN coalesce(p ~ '^[a-z0-9._-]+(?::[a-z0-9._-]+)*$' AND length(p) <= 128, false);

CREATE DOMAIN spend_call_name AS text CHECK (VALUE IS NULL OR spend_is_call_name(VALUE));

ALTER TABLE operations ALTER COLUMN call_name TYPE spend_call_name;

CREATE OR REPLACE FUNCTION spend_field_error(p jsonb, p_field text, p_format text, p_nullable boolean DEFAULT false)
RETURNS text LANGUAGE plpgsql STABLE SET search_path FROM CURRENT AS $$
DECLARE
  v jsonb := p -> p_field;
  v_text text := spend_text(p -> p_field);
  v_ok boolean;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' THEN
    IF p_nullable THEN
      RETURN NULL;
    END IF;
    RETURN p_field || ' is required';
  END IF;
  v_ok := CASE p_format
    WHEN 'hex64' THEN spend_is_hex64(v_text)
    WHEN 'uuid' THEN spend_is_uuid(v_text)
    WHEN 'key' THEN spend_is_key(v_text)
    WHEN 'label' THEN spend_is_label(v_text)
    WHEN 'call_name' THEN spend_is_call_name(v_text)
    WHEN 'role' THEN spend_is_role(v_text)
    WHEN 'identifier' THEN spend_is_identifier(v_text)
    WHEN 'reason' THEN spend_is_reason(v_text)
    WHEN 'time' THEN spend_parse_time(v_text) IS NOT NULL
    WHEN 'safe_int' THEN spend_safe_int(v) IS NOT NULL
    WHEN 'positive_int' THEN spend_safe_int(v) >= 1
    WHEN 'state' THEN v_text IN ('prepared', 'launching', 'running', 'terminal', 'reconciled', 'uncertain')
    WHEN 'terminal_status' THEN v_text IN ('completed', 'failed', 'cancelled')
    WHEN 'uncertainty' THEN v_text IN ('lost_response', 'unknown_status')
    WHEN 'usage_state' THEN v_text IN ('known', 'partly_unknown', 'unknown')
    WHEN 'decision' THEN v_text IN ('found_running', 'confirm_no_launch', 'accept_complete', 'confirm_stopped_incomplete')
    WHEN 'evidence' THEN spend_is_evidence(v)
    WHEN 'evidence_list' THEN spend_is_evidence_list(v)
    WHEN 'schema_version' THEN v = '1'::jsonb
  END;
  IF coalesce(v_ok, false) THEN
    RETURN NULL;
  END IF;
  RETURN p_field || ' must be ' || CASE p_format
    WHEN 'hex64' THEN '64 lowercase hexadecimal characters'
    WHEN 'uuid' THEN 'a lowercase UUID string'
    WHEN 'key' THEN 'lowercase letters, digits and hyphens (at most 64)'
    WHEN 'label' THEN 'lowercase letters, digits, ".", "_" and "-" (at most 64)'
    WHEN 'call_name' THEN 'segments of lowercase letters, digits, ".", "_" and "-" joined by ":" (at most 128)'
    WHEN 'role' THEN 'a role label such as owner, operator or workflow'
    WHEN 'identifier' THEN 'a non-empty string of at most 512 characters without control characters'
    WHEN 'reason' THEN 'a non-blank string of at most 2,000 characters'
    WHEN 'time' THEN 'a UTC RFC3339 time ending in Z'
    WHEN 'safe_int' THEN 'an integer from 0 to 9007199254740991'
    WHEN 'positive_int' THEN 'an integer from 1 to 9007199254740991'
    WHEN 'state' THEN 'an operation state'
    WHEN 'terminal_status' THEN 'completed, failed or cancelled'
    WHEN 'uncertainty' THEN 'lost_response or unknown_status'
    WHEN 'usage_state' THEN 'known, partly_unknown or unknown'
    WHEN 'decision' THEN 'found_running, confirm_no_launch, accept_complete or confirm_stopped_incomplete'
    WHEN 'evidence' THEN 'an evidence reference {key, sha256}'
    WHEN 'evidence_list' THEN 'a non-empty array of evidence references {key, sha256}'
    WHEN 'schema_version' THEN '1'
    ELSE p_format
  END;
END
$$;

CREATE OR REPLACE FUNCTION spend_reserve_body(p_request jsonb, p_now text) RETURNS jsonb
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
    spend_field_error(r, 'call_name', 'call_name'),
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

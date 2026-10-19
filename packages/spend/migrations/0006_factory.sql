-- Request budgets and factory records.
--
-- Forward-only and additive: this file creates tables, functions and triggers and changes nothing
-- that earlier migrations created (no existing table, function, trigger, pool or allocation). It
-- seeds no pool and no slot key: the factory pool and slot key are owner actions
-- (spend_create_pool, spend_create_slot_key), like every deployment's slot key.
--
-- A request budget caps the commitments of one factory request on its own pool. The pool counts
-- only what operations commit (open reservations plus settled spend); creating a budget holds
-- nothing in the pool. spend_budget_reserve checks the budget, then reserves through the existing
-- reservation body, which checks the halt and the pool as for any reservation.
--
-- The factory records keep a request's durable progress: the request and its frozen
-- interpretation, its numbered events, the worker's heartbeats, a stop request, per-case
-- evidence, and validation runs with their own numbered events. Every write is idempotent by key:
-- the same key with the same content replays and writes nothing; other content is refused with
-- idempotency_conflict.
--
-- Every table is insert-only and takes rows only through the entry functions (the rbw.spend_api
-- guard of 0004), like the earlier tables.

-- Formats and closed lists ---------------------------------------------------------------------

-- The contract's stop codes (bug-request/1, section 8): the causes a budget can be closed with.
CREATE FUNCTION factory_stop_codes() RETURNS text[] LANGUAGE sql IMMUTABLE
RETURN ARRAY['fulfilled', 'budget_exhausted', 'time_limit', 'candidate_limit', 'sources_exhausted',
             'cancelled_by_user', 'worker_lost', 'needs_reconciliation', 'operational_error'];

-- The contract's event types (bug-request/1, section 8.4).
CREATE FUNCTION factory_event_types() RETURNS text[] LANGUAGE sql IMMUTABLE
RETURN ARRAY['request_accepted', 'worker_started', 'host_preparing', 'host_ready', 'candidate_selected',
             'check_finished', 'behavior_checks_passed', 'requested_criteria_passed', 'candidate_rejected',
             'candidate_invalid', 'candidate_incomplete', 'candidate_skipped', 'package_ready', 'case_delivered',
             'source_exhausted', 'budget_updated', 'stop_requested', 'attention', 'attention_cleared',
             'request_finished', 'validation_started', 'validation_finished'];

-- The only events that may follow request_finished (section 8.4).
CREATE FUNCTION factory_after_finish_types() RETURNS text[] LANGUAGE sql IMMUTABLE
RETURN ARRAY['budget_updated', 'attention', 'attention_cleared', 'validation_started', 'validation_finished'];

-- Event keys: segments of lowercase letters, digits, ".", "_" and "-" joined by ":", at most 256.
CREATE FUNCTION factory_is_event_key(p text) RETURNS boolean LANGUAGE sql IMMUTABLE
RETURN coalesce(p ~ '^[a-z0-9._-]+(?::[a-z0-9._-]+)*$' AND length(p) <= 256, false);

-- Validation event types: lowercase letters, digits and underscores, starting with a letter.
CREATE FUNCTION factory_is_validation_event_type(p text) RETURNS boolean LANGUAGE sql IMMUTABLE
RETURN coalesce(p ~ '^[a-z][a-z0-9_]{0,63}$', false);

-- The contract's item_key pattern.
CREATE FUNCTION factory_is_item_key(p text) RETURNS boolean LANGUAGE sql IMMUTABLE
RETURN coalesce(p ~ '^[a-z0-9][a-z0-9-]{0,31}$', false);

-- Event messages: any text of at most 2,000 characters; may be empty.
CREATE FUNCTION factory_is_message(p text) RETURNS boolean LANGUAGE sql IMMUTABLE
RETURN coalesce(length(p) <= 2000, false);

-- Times in results: UTC ISO 8601 with milliseconds and Z, as the contract writes them.
CREATE FUNCTION factory_time(p timestamptz) RETURNS text LANGUAGE sql STABLE
RETURN to_char(p AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

-- NULL when the field is a string, or null when p_nullable, that p_check accepts; otherwise a message.
CREATE FUNCTION factory_text_error(p jsonb, p_field text, p_ok boolean, p_format text, p_nullable boolean DEFAULT false)
RETURNS text LANGUAGE sql IMMUTABLE
RETURN CASE
  WHEN p_nullable AND jsonb_typeof(p -> p_field) = 'null' THEN NULL
  WHEN jsonb_typeof(p -> p_field) IS DISTINCT FROM 'string' THEN p_field || ' must be ' || p_format
                                                               || CASE WHEN p_nullable THEN ' or null' ELSE '' END
  WHEN coalesce(p_ok, false) THEN NULL
  ELSE p_field || ' must be ' || p_format
END;

-- NULL when field p_field of p is an integer from p_min to p_max; otherwise a message.
CREATE FUNCTION factory_range_error(p jsonb, p_field text, p_min bigint, p_max bigint) RETURNS text
LANGUAGE sql IMMUTABLE
RETURN CASE WHEN spend_safe_int(p -> p_field) BETWEEN p_min AND p_max THEN NULL
            ELSE p_field || ' must be an integer from ' || p_min::text || ' to ' || p_max::text END;

-- The complete field checks of a reservation request, as spend_reserve_body makes them, so a
-- budget reservation is refused as invalid_request before any budget rule is applied.
CREATE FUNCTION spend_reservation_error(r jsonb) RETURNS text
LANGUAGE plpgsql STABLE SET search_path FROM CURRENT AS $$
DECLARE
  v_err text;
BEGIN
  IF jsonb_typeof(r) IS DISTINCT FROM 'object' THEN
    RETURN 'reservation must be a JSON object';
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
    RETURN 'reservation: ' || v_err;
  END IF;
  IF ((r ->> 'attempt_ordinal')::bigint = 1) <> (jsonb_typeof(r -> 'previous_operation_id') = 'null') THEN
    RETURN 'reservation: previous_operation_id is required above attempt 1 and must be null on attempt 1';
  END IF;
  IF ((r ->> 'execution_id') = (r ->> 'root_execution_id')) <> (jsonb_typeof(r -> 'parent_execution_id') = 'null') THEN
    RETURN 'reservation: parent_execution_id must be null exactly when execution_id is the root_execution_id';
  END IF;
  RETURN NULL;
END
$$;

-- Budgets -------------------------------------------------------------------------------------

-- One budget per factory request, bound to the request's root execution. Its cap bounds what the
-- operations charged to it commit. It never uses the judge-demo pool.
CREATE TABLE budgets (
  budget_key spend_hex64 PRIMARY KEY,
  seq bigint NOT NULL UNIQUE DEFAULT nextval('spend_event_seq'),
  root_execution_id spend_uuid NOT NULL UNIQUE,
  pool_key spend_key NOT NULL REFERENCES pools,
  cap_microusd spend_safe_int NOT NULL CHECK (cap_microusd > 0),
  -- The request as received, compared on replay.
  content jsonb NOT NULL,
  actor_role spend_role NOT NULL,
  recorded_at timestamptz NOT NULL,
  CONSTRAINT budgets_pool_not_judge_demo CHECK (pool_key <> 'judge-demo')
);

-- Every operation a budget admitted. role 'request' runs under the budget's root; role
-- 'validation' under a validation run's root.
CREATE TABLE budget_operations (
  operation_id spend_hex64 PRIMARY KEY REFERENCES operations,
  seq bigint NOT NULL UNIQUE DEFAULT nextval('spend_event_seq'),
  budget_key spend_hex64 NOT NULL REFERENCES budgets,
  role text NOT NULL CHECK (role IN ('request', 'validation')),
  root_execution_id spend_uuid NOT NULL,
  recorded_at timestamptz NOT NULL
);

CREATE INDEX budget_operations_by_budget ON budget_operations (budget_key);
CREATE INDEX budget_operations_by_root ON budget_operations (root_execution_id);

-- The operation's pool and root agree with its budget and its role.
CREATE FUNCTION spend_check_budget_operation() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  v_budget budgets%ROWTYPE;
  v_operation operations%ROWTYPE;
BEGIN
  SELECT * INTO v_budget FROM budgets WHERE budget_key = NEW.budget_key;
  SELECT * INTO v_operation FROM operations WHERE operation_id = NEW.operation_id;
  IF v_operation.pool_key IS DISTINCT FROM v_budget.pool_key
     OR v_operation.root_execution_id IS DISTINCT FROM NEW.root_execution_id
     OR (NEW.role = 'request') IS DISTINCT FROM (NEW.root_execution_id = v_budget.root_execution_id) THEN
    RAISE EXCEPTION 'budget operation % does not match its budget', NEW.operation_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER budget_operations_check BEFORE INSERT ON budget_operations
  FOR EACH ROW EXECUTE FUNCTION spend_check_budget_operation();

-- A closed budget admits no more 'request' reservations; 'validation' reservations still fit
-- within its remaining room.
CREATE TABLE budget_closures (
  budget_key spend_hex64 PRIMARY KEY REFERENCES budgets,
  seq bigint NOT NULL UNIQUE DEFAULT nextval('spend_event_seq'),
  cause text NOT NULL CHECK (cause = ANY (factory_stop_codes())),
  actor_role spend_role NOT NULL,
  recorded_at timestamptz NOT NULL
);

-- Refused budget reservations, so a report can say why work stopped.
CREATE TABLE budget_refusals (
  seq bigint PRIMARY KEY DEFAULT nextval('spend_event_seq'),
  budget_key spend_hex64 NOT NULL REFERENCES budgets,
  operation_id spend_hex64 NOT NULL,
  role text NOT NULL CHECK (role IN ('request', 'validation')),
  code text NOT NULL CHECK (code IN ('budget_exhausted', 'budget_closed')),
  requested_microusd spend_safe_int NOT NULL,
  -- The cap minus committed when refused; negative after an overrun.
  budget_available_microusd bigint NOT NULL,
  recorded_at timestamptz NOT NULL
);

-- What a budget's operations commit: settled spend plus open reservations, over every root.
CREATE FUNCTION spend_budget_totals(p_budget text, OUT settled numeric, OUT open numeric) LANGUAGE sql
BEGIN ATOMIC
  SELECT coalesce(sum(s.amount_microusd) FILTER (WHERE s.kind = 'settle'), 0),
         coalesce(sum(s.amount_microusd) FILTER (WHERE s.kind = 'reserve'), 0)
           - coalesce(sum(s.amount_microusd) FILTER (WHERE s.kind = 'close'), 0)
  FROM budget_operations b JOIN spend s ON s.operation_id = b.operation_id
  WHERE b.budget_key = p_budget;
END;

-- A budget's operations as result documents, oldest first: all of them, or those not reconciled.
CREATE FUNCTION spend_budget_operation_list(p_budget text, p_all boolean) RETURNS jsonb LANGUAGE sql
BEGIN ATOMIC
  SELECT coalesce(jsonb_agg(x.doc ORDER BY x.seq), '[]'::jsonb)
  FROM (
    SELECT o.seq, jsonb_build_object(
      'operation_id', o.operation_id,
      'role', b.role,
      'root_execution_id', o.root_execution_id,
      'execution_id', o.execution_id,
      'kind', o.kind,
      'call_name', o.call_name,
      'attempt_ordinal', o.attempt_ordinal,
      'state', st.state,
      'reserved_microusd', t.reserved::text,
      'open_microusd', (t.reserved - t.closed)::text,
      'settled_microusd', CASE
        WHEN EXISTS (SELECT 1 FROM settlements x WHERE x.operation_id = o.operation_id)
          OR EXISTS (SELECT 1 FROM reconciliations x WHERE x.operation_id = o.operation_id AND x.decision <> 'found_running')
        THEN t.settled::text END,
      'reserved_at', factory_time(o.recorded_at)
    ) AS doc
    FROM budget_operations b
    JOIN operations o ON o.operation_id = b.operation_id
    CROSS JOIN LATERAL spend_operation_totals(o.operation_id) t
    CROSS JOIN LATERAL (SELECT spend_operation_state(o.operation_id) AS state) st
    WHERE b.budget_key = p_budget AND (p_all OR st.state <> 'reconciled')
  ) x;
END;

CREATE FUNCTION spend_create_budget_body(p_request jsonb, p_now text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path FROM CURRENT AS $$
DECLARE
  r jsonb := p_request;
  v_now timestamptz := spend_parse_time(p_now);
  v_err text;
  v_existing budgets%ROWTYPE;
  v_available numeric;
BEGIN
  PERFORM spend_require_read_committed();
  IF v_now IS NULL THEN
    RETURN spend_invalid('now must be a UTC RFC3339 time ending in Z');
  END IF;
  v_err := coalesce(
    spend_keys_error(r, ARRAY['budget_key', 'root_execution_id', 'pool_key', 'cap_microusd', 'pool_required_microusd', 'actor_role']),
    spend_field_error(r, 'budget_key', 'hex64'),
    spend_field_error(r, 'root_execution_id', 'uuid'),
    spend_field_error(r, 'pool_key', 'key'),
    spend_field_error(r, 'cap_microusd', 'positive_int'),
    spend_field_error(r, 'pool_required_microusd', 'safe_int'),
    spend_field_error(r, 'actor_role', 'role')
  );
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;

  -- Concurrent creates of one key or one root run one at a time, so a duplicate replays or
  -- conflicts instead of failing on a unique index.
  PERFORM pg_advisory_xact_lock(hashtext('spend_budget'), hashtext(r ->> 'budget_key'));
  PERFORM pg_advisory_xact_lock(hashtext('spend_budget_root'), hashtext(r ->> 'root_execution_id'));
  SELECT * INTO v_existing FROM budgets WHERE budget_key = r ->> 'budget_key';
  IF FOUND THEN
    IF v_existing.content = r THEN
      RETURN jsonb_build_object('ok', true, 'replay', true, 'budget_key', v_existing.budget_key,
                                'created_at', factory_time(v_existing.recorded_at));
    END IF;
    RETURN spend_refusal('idempotency_conflict', 'the budget key exists with a different request');
  END IF;
  IF EXISTS (SELECT 1 FROM budgets WHERE root_execution_id = r ->> 'root_execution_id') THEN
    RETURN spend_refusal('idempotency_conflict', 'another budget is bound to this root execution');
  END IF;
  -- Reservations made before the budget, or outside it, would never count against it.
  IF EXISTS (SELECT 1 FROM operations WHERE root_execution_id = r ->> 'root_execution_id') THEN
    RETURN spend_invalid('root_execution_id already has operations; a budget''s root starts with none');
  END IF;

  IF r ->> 'pool_key' = 'judge-demo' THEN
    RETURN spend_invalid('a budget never uses the judge-demo pool');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pools WHERE pool_key = r ->> 'pool_key') THEN
    RETURN spend_refusal('unknown_pool');
  END IF;
  IF EXISTS (SELECT 1 FROM pool_allocations WHERE pool_key = r ->> 'pool_key') THEN
    RETURN spend_invalid('a budget needs a pool without allocations');
  END IF;

  -- Nothing is reserved here: the pool must only be able to cover the first reservation now.
  IF spend_halted() THEN
    RETURN spend_refusal('pool_halted');
  END IF;
  v_available := spend_available(r ->> 'pool_key', NULL);
  IF (r ->> 'pool_required_microusd')::numeric > v_available THEN
    RETURN spend_refusal('insufficient_funds', NULL, jsonb_build_object(
      'requested_microusd', r ->> 'pool_required_microusd',
      'pool_available_microusd', v_available::text
    ));
  END IF;

  INSERT INTO budgets (budget_key, root_execution_id, pool_key, cap_microusd, content, actor_role, recorded_at)
  VALUES (r ->> 'budget_key', r ->> 'root_execution_id', r ->> 'pool_key', (r ->> 'cap_microusd')::bigint, r,
          r ->> 'actor_role', v_now);
  RETURN jsonb_build_object('ok', true, 'replay', false, 'budget_key', r ->> 'budget_key', 'created_at', factory_time(v_now));
END
$$;

-- Check-and-reserve against a budget. Order: the reservation's own replay or operation_conflict
-- (under the per-operation lock that spend_reserve_body also takes), then the budget row lock,
-- the budget's rules, and finally the existing reservation body, which takes the pool lock. Lock
-- order is operation, budget, pool; settlement takes pool then operation and never a budget, so
-- the orders do not invert.
CREATE FUNCTION spend_budget_reserve_body(p_request jsonb, p_now text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path FROM CURRENT AS $$
DECLARE
  r jsonb := p_request;
  v_now timestamptz := spend_parse_time(p_now);
  v_err text;
  v_reservation jsonb := p_request -> 'reservation';
  v_role text := spend_text(p_request -> 'role');
  v_operation_id text;
  v_root text;
  v_budget budgets%ROWTYPE;
  v_existing operations%ROWTYPE;
  v_member budget_operations%ROWTYPE;
  v_envelope jsonb;
  v_worst bigint;
  v_totals record;
  v_available numeric;
  v_code text;
  v_result jsonb;
BEGIN
  PERFORM spend_require_read_committed();
  IF v_now IS NULL THEN
    RETURN spend_invalid('now must be a UTC RFC3339 time ending in Z');
  END IF;
  v_err := coalesce(
    spend_keys_error(r, ARRAY['budget_key', 'role', 'reservation']),
    spend_field_error(r, 'budget_key', 'hex64'),
    CASE WHEN v_role IS NULL OR v_role NOT IN ('request', 'validation') THEN 'role must be request or validation' END,
    spend_reservation_error(v_reservation)
  );
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;
  v_operation_id := v_reservation ->> 'operation_id';
  v_root := v_reservation ->> 'root_execution_id';

  -- An existing operation ID answers first, whatever the budget's state: its replay when it is
  -- this budget's operation with this role and the same intent, otherwise operation_conflict.
  PERFORM pg_advisory_xact_lock(hashtext('spend_reserve'), hashtext(v_operation_id));
  SELECT * INTO v_existing FROM operations WHERE operation_id = v_operation_id;
  IF FOUND THEN
    SELECT * INTO v_member FROM budget_operations WHERE operation_id = v_operation_id;
    IF v_existing.intent = v_reservation AND v_member.budget_key IS NOT DISTINCT FROM r ->> 'budget_key'
       AND v_member.role IS NOT DISTINCT FROM v_role THEN
      RETURN spend_reservation_result(v_operation_id, true);
    END IF;
    RETURN spend_refusal('operation_conflict');
  END IF;

  -- Serialize check-and-reserve per budget; later statements read fresh rows (READ COMMITTED).
  SELECT * INTO v_budget FROM budgets WHERE budget_key = r ->> 'budget_key' FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN spend_refusal('unknown_budget');
  END IF;
  IF v_reservation ->> 'pool_key' <> v_budget.pool_key THEN
    RETURN spend_invalid('reservation.pool_key must be the budget''s pool');
  END IF;
  IF v_role = 'request' AND v_root <> v_budget.root_execution_id THEN
    RETURN spend_invalid('a request reservation uses the budget''s root execution');
  END IF;
  IF v_role = 'validation' THEN
    -- The lock spend_create_budget takes on a root, so a root is never charged to two budgets at
    -- once, nor becomes a budget's root while it is charged to another.
    PERFORM pg_advisory_xact_lock(hashtext('spend_budget_root'), hashtext(v_root));
    IF EXISTS (SELECT 1 FROM budgets WHERE root_execution_id = v_root) THEN
      RETURN spend_invalid('a validation reservation uses a validation root, never a budget''s root');
    END IF;
    IF EXISTS (SELECT 1 FROM budget_operations WHERE root_execution_id = v_root AND budget_key <> v_budget.budget_key) THEN
      RETURN spend_invalid('this validation root is charged to another budget');
    END IF;
  END IF;

  v_envelope := spend_price_envelope(v_reservation -> 'envelope');
  IF NOT (v_envelope ->> 'ok')::boolean THEN
    RETURN v_envelope;
  END IF;
  v_worst := (v_envelope ->> 'worst_case_microusd')::bigint;
  SELECT * INTO v_totals FROM spend_budget_totals(v_budget.budget_key);
  v_available := v_budget.cap_microusd - v_totals.settled - v_totals.open;
  IF v_role = 'request' AND EXISTS (SELECT 1 FROM budget_closures WHERE budget_key = v_budget.budget_key) THEN
    v_code := 'budget_closed';
  ELSIF v_worst > v_available THEN
    v_code := 'budget_exhausted';
  END IF;
  IF v_code IS NOT NULL THEN
    INSERT INTO budget_refusals (budget_key, operation_id, role, code, requested_microusd, budget_available_microusd, recorded_at)
    VALUES (v_budget.budget_key, v_operation_id, v_role, v_code, v_worst, v_available, v_now);
    RETURN spend_refusal(v_code, NULL, jsonb_build_object(
      'requested_microusd', v_worst::text,
      'budget_available_microusd', v_available::text
    ));
  END IF;

  -- The existing body checks the pool, the halt and an earlier attempt, and records its own refusals.
  v_result := spend_reserve_body(v_reservation, p_now);
  IF (v_result ->> 'ok')::boolean AND NOT (v_result ->> 'replay')::boolean THEN
    INSERT INTO budget_operations (operation_id, budget_key, role, root_execution_id, recorded_at)
    VALUES (v_operation_id, v_budget.budget_key, v_role, v_root, v_now);
  END IF;
  RETURN v_result;
END
$$;

CREATE FUNCTION spend_budget_close_body(p_request jsonb, p_now text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path FROM CURRENT AS $$
DECLARE
  r jsonb := p_request;
  v_now timestamptz := spend_parse_time(p_now);
  v_err text;
  v_closure budget_closures%ROWTYPE;
BEGIN
  PERFORM spend_require_read_committed();
  IF v_now IS NULL THEN
    RETURN spend_invalid('now must be a UTC RFC3339 time ending in Z');
  END IF;
  v_err := coalesce(
    spend_keys_error(r, ARRAY['budget_key', 'cause', 'actor_role']),
    spend_field_error(r, 'budget_key', 'hex64'),
    factory_text_error(r, 'cause', spend_text(r -> 'cause') = ANY (factory_stop_codes()), 'a contract stop code'),
    spend_field_error(r, 'actor_role', 'role')
  );
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;
  -- The same lock as check-and-reserve, so a reservation and a close never interleave.
  PERFORM 1 FROM budgets WHERE budget_key = r ->> 'budget_key' FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN spend_refusal('unknown_budget');
  END IF;
  SELECT * INTO v_closure FROM budget_closures WHERE budget_key = r ->> 'budget_key';
  IF FOUND THEN
    IF v_closure.cause = r ->> 'cause' THEN
      RETURN jsonb_build_object('ok', true, 'replay', true, 'budget_key', v_closure.budget_key,
                                'cause', v_closure.cause, 'closed_at', factory_time(v_closure.recorded_at));
    END IF;
    RETURN spend_refusal('idempotency_conflict', 'the budget is already closed with cause ' || v_closure.cause);
  END IF;
  INSERT INTO budget_closures (budget_key, cause, actor_role, recorded_at)
  VALUES (r ->> 'budget_key', r ->> 'cause', r ->> 'actor_role', v_now);
  RETURN jsonb_build_object('ok', true, 'replay', false, 'budget_key', r ->> 'budget_key',
                            'cause', r ->> 'cause', 'closed_at', factory_time(v_now));
END
$$;

CREATE FUNCTION spend_budget_status(p_request jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path FROM CURRENT AS $$
DECLARE
  v_err text := coalesce(spend_keys_error(p_request, ARRAY['budget_key']), spend_field_error(p_request, 'budget_key', 'hex64'));
  v_budget budgets%ROWTYPE;
  v_closure budget_closures%ROWTYPE;
  v_totals record;
  v_committed numeric;
BEGIN
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;
  SELECT * INTO v_budget FROM budgets WHERE budget_key = p_request ->> 'budget_key';
  IF NOT FOUND THEN
    RETURN spend_refusal('unknown_budget');
  END IF;
  SELECT * INTO v_closure FROM budget_closures WHERE budget_key = v_budget.budget_key;
  SELECT * INTO v_totals FROM spend_budget_totals(v_budget.budget_key);
  v_committed := v_totals.settled + v_totals.open;
  RETURN jsonb_build_object(
    'ok', true,
    'budget_key', v_budget.budget_key,
    'root_execution_id', v_budget.root_execution_id,
    'pool_key', v_budget.pool_key,
    'cap_microusd', v_budget.cap_microusd::text,
    'settled_microusd', v_totals.settled::text,
    'open_microusd', v_totals.open::text,
    'committed_microusd', v_committed::text,
    'available_microusd', (v_budget.cap_microusd - v_committed)::text,
    'overrun', v_committed > v_budget.cap_microusd,
    'closed', CASE WHEN v_closure.budget_key IS NULL THEN NULL
                   ELSE jsonb_build_object('cause', v_closure.cause, 'closed_at', factory_time(v_closure.recorded_at)) END,
    'operations', spend_budget_operation_list(v_budget.budget_key, false)
  );
END
$$;

CREATE FUNCTION spend_budget_operations(p_request jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path FROM CURRENT AS $$
DECLARE
  v_err text := coalesce(spend_keys_error(p_request, ARRAY['budget_key']), spend_field_error(p_request, 'budget_key', 'hex64'));
BEGIN
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM budgets WHERE budget_key = p_request ->> 'budget_key') THEN
    RETURN spend_refusal('unknown_budget');
  END IF;
  RETURN jsonb_build_object(
    'ok', true,
    'budget_key', p_request ->> 'budget_key',
    'operations', spend_budget_operation_list(p_request ->> 'budget_key', true)
  );
END
$$;

-- Factory records -----------------------------------------------------------------------------

-- One factory request: its canonical start body hash, frozen interpretation and budget.
CREATE TABLE factory_requests (
  request_id spend_uuid PRIMARY KEY,
  seq bigint NOT NULL UNIQUE DEFAULT nextval('spend_event_seq'),
  request_sha256 spend_hex64 NOT NULL,
  interpretation jsonb NOT NULL,
  interpretation_sha256 spend_hex64 NOT NULL,
  budget_key spend_hex64 NOT NULL UNIQUE REFERENCES budgets,
  root_execution_id spend_uuid NOT NULL UNIQUE,
  factory_profile_sha256 spend_hex64 NOT NULL,
  recorded_at timestamptz NOT NULL,
  CONSTRAINT factory_requests_interpretation_hash CHECK (
    jsonb_typeof(interpretation) = 'object' AND interpretation ->> 'interpretation_sha256' = interpretation_sha256
  )
);

-- The request's root is its budget's root.
CREATE FUNCTION factory_check_request() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.root_execution_id IS DISTINCT FROM (SELECT root_execution_id FROM budgets WHERE budget_key = NEW.budget_key) THEN
    RAISE EXCEPTION 'request % must use its budget''s root execution', NEW.request_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER factory_requests_check BEFORE INSERT ON factory_requests
  FOR EACH ROW EXECUTE FUNCTION factory_check_request();

-- A request's events, numbered from 1 with no gaps (contract section 8.4).
CREATE TABLE factory_events (
  request_id spend_uuid NOT NULL REFERENCES factory_requests,
  seq bigint NOT NULL CHECK (seq >= 1),
  event_key text NOT NULL CHECK (factory_is_event_key(event_key)),
  type text NOT NULL CHECK (type = ANY (factory_event_types())),
  host_id spend_key,
  candidate_id spend_hex64,
  item_key text CHECK (item_key IS NULL OR factory_is_item_key(item_key)),
  case_id spend_hex64,
  message text NOT NULL CHECK (factory_is_message(message)),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (request_id, seq),
  UNIQUE (request_id, event_key)
);

-- Each event follows its request's latest event, so concurrent writers cannot fork or skip.
CREATE FUNCTION factory_check_event_seq() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.seq IS DISTINCT FROM coalesce((SELECT max(seq) FROM factory_events WHERE request_id = NEW.request_id), 0) + 1 THEN
    RAISE EXCEPTION 'event % of request % does not follow its latest event', NEW.seq, NEW.request_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER factory_events_chain BEFORE INSERT ON factory_events
  FOR EACH ROW EXECUTE FUNCTION factory_check_event_seq();

-- One factory validation run of a delivered case; its root holds the factory slot and its
-- operations are charged to the request's budget with the validation role.
CREATE TABLE factory_validations (
  validation_id spend_uuid PRIMARY KEY,
  seq bigint NOT NULL UNIQUE DEFAULT nextval('spend_event_seq'),
  request_id spend_uuid NOT NULL REFERENCES factory_requests,
  case_id spend_hex64 NOT NULL,
  root_execution_id spend_uuid NOT NULL UNIQUE,
  recorded_at timestamptz NOT NULL
);

CREATE INDEX factory_validations_by_request ON factory_validations (request_id);

-- A validation run's events, numbered from 1 with no gaps. Their types are the worker's own.
CREATE TABLE factory_validation_events (
  validation_id spend_uuid NOT NULL REFERENCES factory_validations,
  seq bigint NOT NULL CHECK (seq >= 1),
  event_key text NOT NULL CHECK (factory_is_event_key(event_key)),
  type text NOT NULL CHECK (factory_is_validation_event_type(type)),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (validation_id, seq),
  UNIQUE (validation_id, event_key)
);

CREATE FUNCTION factory_check_validation_event_seq() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.seq IS DISTINCT FROM coalesce((SELECT max(seq) FROM factory_validation_events WHERE validation_id = NEW.validation_id), 0) + 1 THEN
    RAISE EXCEPTION 'event % of validation % does not follow its latest event', NEW.seq, NEW.validation_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER factory_validation_events_chain BEFORE INSERT ON factory_validation_events
  FOR EACH ROW EXECUTE FUNCTION factory_check_validation_event_seq();

-- The worker's heartbeats for a request (validation_id null) or for one of its validation runs.
-- Never events; the latest is read as last_heartbeat_at.
CREATE TABLE factory_heartbeats (
  seq bigint PRIMARY KEY DEFAULT nextval('spend_event_seq'),
  request_id spend_uuid NOT NULL REFERENCES factory_requests,
  validation_id spend_uuid REFERENCES factory_validations,
  recorded_at timestamptz NOT NULL
);

CREATE INDEX factory_heartbeats_by_subject ON factory_heartbeats (request_id, validation_id, recorded_at);

-- A request's stop request; the worker checks for it between copies.
CREATE TABLE factory_stops (
  request_id spend_uuid PRIMARY KEY REFERENCES factory_requests,
  seq bigint NOT NULL UNIQUE DEFAULT nextval('spend_event_seq'),
  actor_role spend_role NOT NULL,
  recorded_at timestamptz NOT NULL
);

-- A delivered case's per-request evidence: exact JSON text and the SHA-256 of its UTF-8 bytes.
CREATE TABLE factory_evidence (
  request_id spend_uuid NOT NULL REFERENCES factory_requests,
  case_id spend_hex64 NOT NULL,
  seq bigint NOT NULL UNIQUE DEFAULT nextval('spend_event_seq'),
  sha256 spend_hex64 NOT NULL,
  evidence_json text NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (request_id, case_id),
  CONSTRAINT factory_evidence_is_object CHECK (evidence_json IS JSON OBJECT WITH UNIQUE KEYS),
  CONSTRAINT factory_evidence_hash CHECK (sha256 = encode(sha256(convert_to(evidence_json, 'UTF8')), 'hex'))
);

CREATE FUNCTION factory_record_request_body(p_request jsonb, p_now text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path FROM CURRENT AS $$
DECLARE
  r jsonb := p_request;
  v_now timestamptz := spend_parse_time(p_now);
  v_err text;
  v_existing factory_requests%ROWTYPE;
  v_budget budgets%ROWTYPE;
BEGIN
  PERFORM spend_require_read_committed();
  IF v_now IS NULL THEN
    RETURN spend_invalid('now must be a UTC RFC3339 time ending in Z');
  END IF;
  v_err := coalesce(
    spend_keys_error(r, ARRAY['request_id', 'request_sha256', 'interpretation', 'interpretation_sha256', 'budget_key',
                              'root_execution_id', 'factory_profile_sha256']),
    spend_field_error(r, 'request_id', 'uuid'),
    spend_field_error(r, 'request_sha256', 'hex64'),
    CASE WHEN jsonb_typeof(r -> 'interpretation') IS DISTINCT FROM 'object' THEN 'interpretation must be a JSON object' END,
    spend_field_error(r, 'interpretation_sha256', 'hex64'),
    spend_field_error(r, 'budget_key', 'hex64'),
    spend_field_error(r, 'root_execution_id', 'uuid'),
    spend_field_error(r, 'factory_profile_sha256', 'hex64')
  );
  IF v_err IS NULL AND (r -> 'interpretation' ->> 'interpretation_sha256') IS DISTINCT FROM r ->> 'interpretation_sha256' THEN
    v_err := 'interpretation.interpretation_sha256 must equal interpretation_sha256';
  END IF;
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('factory_request'), hashtext(r ->> 'request_id'));
  SELECT * INTO v_existing FROM factory_requests WHERE request_id = r ->> 'request_id';
  IF FOUND THEN
    IF (v_existing.request_sha256, v_existing.interpretation_sha256, v_existing.budget_key,
        v_existing.root_execution_id, v_existing.factory_profile_sha256)
       = (r ->> 'request_sha256', r ->> 'interpretation_sha256', r ->> 'budget_key',
          r ->> 'root_execution_id', r ->> 'factory_profile_sha256')
       AND v_existing.interpretation = r -> 'interpretation' THEN
      RETURN jsonb_build_object('ok', true, 'replay', true, 'request_id', v_existing.request_id,
                                'created_at', factory_time(v_existing.recorded_at));
    END IF;
    RETURN spend_refusal('idempotency_conflict', 'the request ID exists with a different request');
  END IF;
  -- The budget row lock orders this against another request recorded on the same budget.
  SELECT * INTO v_budget FROM budgets WHERE budget_key = r ->> 'budget_key' FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN spend_refusal('unknown_budget');
  END IF;
  IF v_budget.root_execution_id <> r ->> 'root_execution_id' THEN
    RETURN spend_invalid('root_execution_id must be the budget''s root execution');
  END IF;
  IF EXISTS (SELECT 1 FROM factory_requests WHERE budget_key = v_budget.budget_key) THEN
    RETURN spend_refusal('idempotency_conflict', 'another request uses this budget');
  END IF;
  INSERT INTO factory_requests (request_id, request_sha256, interpretation, interpretation_sha256, budget_key,
                                root_execution_id, factory_profile_sha256, recorded_at)
  VALUES (r ->> 'request_id', r ->> 'request_sha256', r -> 'interpretation', r ->> 'interpretation_sha256',
          r ->> 'budget_key', r ->> 'root_execution_id', r ->> 'factory_profile_sha256', v_now);
  RETURN jsonb_build_object('ok', true, 'replay', false, 'request_id', r ->> 'request_id', 'created_at', factory_time(v_now));
END
$$;

CREATE FUNCTION factory_event_json(e factory_events) RETURNS jsonb LANGUAGE sql STABLE
RETURN jsonb_build_object(
  'seq', e.seq, 'at', factory_time(e.recorded_at), 'type', e.type, 'host_id', e.host_id,
  'candidate_id', e.candidate_id, 'item_key', e.item_key, 'case_id', e.case_id, 'message', e.message, 'data', e.data
);

CREATE FUNCTION factory_append_event_body(p_request jsonb, p_now text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path FROM CURRENT AS $$
DECLARE
  r jsonb := p_request;
  v_now timestamptz := spend_parse_time(p_now);
  v_err text;
  v_existing factory_events%ROWTYPE;
  v_seq bigint;
BEGIN
  PERFORM spend_require_read_committed();
  IF v_now IS NULL THEN
    RETURN spend_invalid('now must be a UTC RFC3339 time ending in Z');
  END IF;
  v_err := coalesce(
    spend_keys_error(r, ARRAY['request_id', 'event_key', 'type', 'host_id', 'candidate_id', 'item_key', 'case_id', 'message', 'data']),
    spend_field_error(r, 'request_id', 'uuid'),
    factory_text_error(r, 'event_key', factory_is_event_key(spend_text(r -> 'event_key')),
      'segments of lowercase letters, digits, ".", "_" and "-" joined by ":" (at most 256)'),
    factory_text_error(r, 'type', spend_text(r -> 'type') = ANY (factory_event_types()), 'a contract event type'),
    spend_field_error(r, 'host_id', 'key', true),
    spend_field_error(r, 'candidate_id', 'hex64', true),
    factory_text_error(r, 'item_key', factory_is_item_key(spend_text(r -> 'item_key')), 'an item key', true),
    spend_field_error(r, 'case_id', 'hex64', true),
    factory_text_error(r, 'message', factory_is_message(spend_text(r -> 'message')),
      'a string of at most 2,000 characters'),
    CASE WHEN jsonb_typeof(r -> 'data') IS DISTINCT FROM 'object' THEN 'data must be a JSON object' END
  );
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;

  -- Serializes this request's writers; the next seq is computed under the lock.
  PERFORM 1 FROM factory_requests WHERE request_id = r ->> 'request_id' FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN spend_refusal('unknown_request');
  END IF;
  SELECT * INTO v_existing FROM factory_events WHERE request_id = r ->> 'request_id' AND event_key = r ->> 'event_key';
  IF FOUND THEN
    IF (v_existing.type, v_existing.message, v_existing.data) = (r ->> 'type', r ->> 'message', r -> 'data')
       AND v_existing.host_id IS NOT DISTINCT FROM r ->> 'host_id'
       AND v_existing.candidate_id IS NOT DISTINCT FROM r ->> 'candidate_id'
       AND v_existing.item_key IS NOT DISTINCT FROM r ->> 'item_key'
       AND v_existing.case_id IS NOT DISTINCT FROM r ->> 'case_id' THEN
      RETURN jsonb_build_object('ok', true, 'replay', true, 'seq', v_existing.seq, 'at', factory_time(v_existing.recorded_at));
    END IF;
    RETURN spend_refusal('idempotency_conflict', 'the event key exists with different content');
  END IF;
  IF NOT (r ->> 'type' = ANY (factory_after_finish_types()))
     AND EXISTS (SELECT 1 FROM factory_events WHERE request_id = r ->> 'request_id' AND type = 'request_finished') THEN
    RETURN spend_refusal('event_not_allowed', 'after request_finished only budget, attention and validation events follow');
  END IF;
  v_seq := coalesce((SELECT max(seq) FROM factory_events WHERE request_id = r ->> 'request_id'), 0) + 1;
  IF (r ->> 'type' = 'request_accepted') <> (v_seq = 1) THEN
    RETURN spend_refusal('event_not_allowed', 'request_accepted is a request''s first event, and only its first');
  END IF;
  INSERT INTO factory_events (request_id, seq, event_key, type, host_id, candidate_id, item_key, case_id, message, data, recorded_at)
  VALUES (r ->> 'request_id', v_seq, r ->> 'event_key', r ->> 'type', r ->> 'host_id', r ->> 'candidate_id',
          r ->> 'item_key', r ->> 'case_id', r ->> 'message', r -> 'data', v_now);
  RETURN jsonb_build_object('ok', true, 'replay', false, 'seq', v_seq, 'at', factory_time(v_now));
END
$$;

-- Creates the budget, records the request and appends request_accepted, all or nothing: a
-- refusal from any step rolls back the steps before it (contract section 7, step 7).
CREATE FUNCTION factory_accept_request_body(p_request jsonb, p_now text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path FROM CURRENT AS $$
DECLARE
  r jsonb := p_request;
  v_err text;
  v_budget jsonb;
  v_request jsonb;
  v_event jsonb;
  v_refusal jsonb;
BEGIN
  PERFORM spend_require_read_committed();
  v_err := coalesce(
    spend_keys_error(r, ARRAY['budget', 'request', 'accepted_message']),
    CASE WHEN jsonb_typeof(r -> 'budget') IS DISTINCT FROM 'object' THEN 'budget must be a JSON object' END,
    CASE WHEN jsonb_typeof(r -> 'request') IS DISTINCT FROM 'object' THEN 'request must be a JSON object' END,
    factory_text_error(r, 'accepted_message', factory_is_message(spend_text(r -> 'accepted_message')),
      'a string of at most 2,000 characters')
  );
  IF v_err IS NULL AND ((r -> 'budget' ->> 'budget_key') IS DISTINCT FROM (r -> 'request' ->> 'budget_key')
     OR (r -> 'budget' ->> 'root_execution_id') IS DISTINCT FROM (r -> 'request' ->> 'root_execution_id')) THEN
    v_err := 'request.budget_key and request.root_execution_id must be the budget''s';
  END IF;
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;

  BEGIN
    v_budget := spend_create_budget_body(r -> 'budget', p_now);
    IF NOT (v_budget ->> 'ok')::boolean THEN
      v_refusal := v_budget;
      RAISE EXCEPTION USING ERRCODE = 'RBW01', MESSAGE = 'factory acceptance refused';
    END IF;
    v_request := factory_record_request_body(r -> 'request', p_now);
    IF NOT (v_request ->> 'ok')::boolean THEN
      v_refusal := v_request;
      RAISE EXCEPTION USING ERRCODE = 'RBW01', MESSAGE = 'factory acceptance refused';
    END IF;
    v_event := factory_append_event_body(jsonb_build_object(
      'request_id', r -> 'request' -> 'request_id', 'event_key', 'request_accepted', 'type', 'request_accepted',
      'host_id', NULL, 'candidate_id', NULL, 'item_key', NULL, 'case_id', NULL,
      'message', r -> 'accepted_message', 'data', '{}'::jsonb
    ), p_now);
    IF NOT (v_event ->> 'ok')::boolean THEN
      v_refusal := v_event;
      RAISE EXCEPTION USING ERRCODE = 'RBW01', MESSAGE = 'factory acceptance refused';
    END IF;
  EXCEPTION WHEN SQLSTATE 'RBW01' THEN
    -- The block's writes are rolled back; the refusal was kept in a variable.
    RETURN v_refusal;
  END;
  RETURN jsonb_build_object(
    'ok', true,
    'replay', (v_budget ->> 'replay')::boolean AND (v_request ->> 'replay')::boolean AND (v_event ->> 'replay')::boolean,
    'request_id', v_request -> 'request_id',
    'budget_key', v_budget -> 'budget_key',
    'created_at', v_request -> 'created_at',
    'seq', v_event -> 'seq'
  );
END
$$;

CREATE FUNCTION factory_record_heartbeat_body(p_request jsonb, p_now text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path FROM CURRENT AS $$
DECLARE
  r jsonb := p_request;
  v_now timestamptz := spend_parse_time(p_now);
  v_err text;
BEGIN
  PERFORM spend_require_read_committed();
  IF v_now IS NULL THEN
    RETURN spend_invalid('now must be a UTC RFC3339 time ending in Z');
  END IF;
  v_err := coalesce(
    spend_keys_error(r, ARRAY['request_id', 'validation_id']),
    spend_field_error(r, 'request_id', 'uuid'),
    spend_field_error(r, 'validation_id', 'uuid', true)
  );
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM factory_requests WHERE request_id = r ->> 'request_id') THEN
    RETURN spend_refusal('unknown_request');
  END IF;
  IF r ->> 'validation_id' IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM factory_validations WHERE validation_id = r ->> 'validation_id' AND request_id = r ->> 'request_id'
  ) THEN
    RETURN spend_refusal('unknown_validation');
  END IF;
  INSERT INTO factory_heartbeats (request_id, validation_id, recorded_at)
  VALUES (r ->> 'request_id', r ->> 'validation_id', v_now);
  RETURN jsonb_build_object('ok', true, 'recorded_at', factory_time(v_now));
END
$$;

CREATE FUNCTION factory_record_stop_body(p_request jsonb, p_now text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path FROM CURRENT AS $$
DECLARE
  r jsonb := p_request;
  v_now timestamptz := spend_parse_time(p_now);
  v_err text;
  v_existing factory_stops%ROWTYPE;
BEGIN
  PERFORM spend_require_read_committed();
  IF v_now IS NULL THEN
    RETURN spend_invalid('now must be a UTC RFC3339 time ending in Z');
  END IF;
  v_err := coalesce(
    spend_keys_error(r, ARRAY['request_id', 'actor_role']),
    spend_field_error(r, 'request_id', 'uuid'),
    spend_field_error(r, 'actor_role', 'role')
  );
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;
  PERFORM 1 FROM factory_requests WHERE request_id = r ->> 'request_id' FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN spend_refusal('unknown_request');
  END IF;
  SELECT * INTO v_existing FROM factory_stops WHERE request_id = r ->> 'request_id';
  IF FOUND THEN
    IF v_existing.actor_role = r ->> 'actor_role' THEN
      RETURN jsonb_build_object('ok', true, 'replay', true, 'recorded_at', factory_time(v_existing.recorded_at));
    END IF;
    RETURN spend_refusal('idempotency_conflict', 'the request already has a stop from another actor role');
  END IF;
  INSERT INTO factory_stops (request_id, actor_role, recorded_at) VALUES (r ->> 'request_id', r ->> 'actor_role', v_now);
  RETURN jsonb_build_object('ok', true, 'replay', false, 'recorded_at', factory_time(v_now));
END
$$;

CREATE FUNCTION factory_record_evidence_body(p_request jsonb, p_now text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path FROM CURRENT AS $$
DECLARE
  r jsonb := p_request;
  v_now timestamptz := spend_parse_time(p_now);
  v_err text;
  v_text text := spend_text(p_request -> 'evidence_json');
  v_existing factory_evidence%ROWTYPE;
BEGIN
  PERFORM spend_require_read_committed();
  IF v_now IS NULL THEN
    RETURN spend_invalid('now must be a UTC RFC3339 time ending in Z');
  END IF;
  v_err := coalesce(
    spend_keys_error(r, ARRAY['request_id', 'case_id', 'sha256', 'evidence_json']),
    spend_field_error(r, 'request_id', 'uuid'),
    spend_field_error(r, 'case_id', 'hex64'),
    spend_field_error(r, 'sha256', 'hex64'),
    factory_text_error(r, 'evidence_json', v_text IS JSON OBJECT WITH UNIQUE KEYS, 'the text of a JSON object')
  );
  IF v_err IS NULL AND r ->> 'sha256' <> encode(sha256(convert_to(v_text, 'UTF8')), 'hex') THEN
    v_err := 'sha256 must be the SHA-256 of evidence_json''s UTF-8 bytes';
  END IF;
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;
  PERFORM 1 FROM factory_requests WHERE request_id = r ->> 'request_id' FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN spend_refusal('unknown_request');
  END IF;
  SELECT * INTO v_existing FROM factory_evidence WHERE request_id = r ->> 'request_id' AND case_id = r ->> 'case_id';
  IF FOUND THEN
    IF v_existing.sha256 = r ->> 'sha256' THEN
      RETURN jsonb_build_object('ok', true, 'replay', true, 'recorded_at', factory_time(v_existing.recorded_at));
    END IF;
    RETURN spend_refusal('idempotency_conflict', 'the case already has different evidence in this request');
  END IF;
  INSERT INTO factory_evidence (request_id, case_id, sha256, evidence_json, recorded_at)
  VALUES (r ->> 'request_id', r ->> 'case_id', r ->> 'sha256', v_text, v_now);
  RETURN jsonb_build_object('ok', true, 'replay', false, 'recorded_at', factory_time(v_now));
END
$$;

CREATE FUNCTION factory_record_validation_body(p_request jsonb, p_now text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path FROM CURRENT AS $$
DECLARE
  r jsonb := p_request;
  v_now timestamptz := spend_parse_time(p_now);
  v_err text;
  v_existing factory_validations%ROWTYPE;
BEGIN
  PERFORM spend_require_read_committed();
  IF v_now IS NULL THEN
    RETURN spend_invalid('now must be a UTC RFC3339 time ending in Z');
  END IF;
  v_err := coalesce(
    spend_keys_error(r, ARRAY['validation_id', 'request_id', 'case_id', 'root_execution_id']),
    spend_field_error(r, 'validation_id', 'uuid'),
    spend_field_error(r, 'request_id', 'uuid'),
    spend_field_error(r, 'case_id', 'hex64'),
    spend_field_error(r, 'root_execution_id', 'uuid')
  );
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;
  -- A validation ID is scoped to (request_id, case_id) and checked across every request. Its root
  -- is locked too, so two runs claiming one root get idempotency_conflict, not a unique violation.
  PERFORM pg_advisory_xact_lock(hashtext('factory_validation'), hashtext(r ->> 'validation_id'));
  PERFORM pg_advisory_xact_lock(hashtext('factory_validation_root'), hashtext(r ->> 'root_execution_id'));
  SELECT * INTO v_existing FROM factory_validations WHERE validation_id = r ->> 'validation_id';
  IF FOUND THEN
    IF (v_existing.request_id, v_existing.case_id, v_existing.root_execution_id)
       = (r ->> 'request_id', r ->> 'case_id', r ->> 'root_execution_id') THEN
      RETURN jsonb_build_object('ok', true, 'replay', true, 'recorded_at', factory_time(v_existing.recorded_at));
    END IF;
    RETURN spend_refusal('idempotency_conflict', 'the validation ID is used on another request or case');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM factory_requests WHERE request_id = r ->> 'request_id') THEN
    RETURN spend_refusal('unknown_request');
  END IF;
  IF EXISTS (SELECT 1 FROM budgets WHERE root_execution_id = r ->> 'root_execution_id') THEN
    RETURN spend_invalid('root_execution_id must be a validation root, never a budget''s root');
  END IF;
  IF EXISTS (SELECT 1 FROM factory_validations WHERE root_execution_id = r ->> 'root_execution_id') THEN
    RETURN spend_refusal('idempotency_conflict', 'another validation run uses this root execution');
  END IF;
  IF EXISTS (
    SELECT 1 FROM budget_operations b JOIN factory_requests q ON q.request_id = r ->> 'request_id'
    WHERE b.root_execution_id = r ->> 'root_execution_id' AND b.budget_key <> q.budget_key
  ) THEN
    RETURN spend_invalid('operations under this root are charged to another request''s budget');
  END IF;
  INSERT INTO factory_validations (validation_id, request_id, case_id, root_execution_id, recorded_at)
  VALUES (r ->> 'validation_id', r ->> 'request_id', r ->> 'case_id', r ->> 'root_execution_id', v_now);
  RETURN jsonb_build_object('ok', true, 'replay', false, 'recorded_at', factory_time(v_now));
END
$$;

CREATE FUNCTION factory_append_validation_event_body(p_request jsonb, p_now text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path FROM CURRENT AS $$
DECLARE
  r jsonb := p_request;
  v_now timestamptz := spend_parse_time(p_now);
  v_err text;
  v_existing factory_validation_events%ROWTYPE;
  v_seq bigint;
BEGIN
  PERFORM spend_require_read_committed();
  IF v_now IS NULL THEN
    RETURN spend_invalid('now must be a UTC RFC3339 time ending in Z');
  END IF;
  v_err := coalesce(
    spend_keys_error(r, ARRAY['validation_id', 'event_key', 'type', 'data']),
    spend_field_error(r, 'validation_id', 'uuid'),
    factory_text_error(r, 'event_key', factory_is_event_key(spend_text(r -> 'event_key')),
      'segments of lowercase letters, digits, ".", "_" and "-" joined by ":" (at most 256)'),
    factory_text_error(r, 'type', factory_is_validation_event_type(spend_text(r -> 'type')),
      'lowercase letters, digits and underscores, starting with a letter (at most 64)'),
    CASE WHEN jsonb_typeof(r -> 'data') IS DISTINCT FROM 'object' THEN 'data must be a JSON object' END
  );
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;
  PERFORM 1 FROM factory_validations WHERE validation_id = r ->> 'validation_id' FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN spend_refusal('unknown_validation');
  END IF;
  SELECT * INTO v_existing FROM factory_validation_events
  WHERE validation_id = r ->> 'validation_id' AND event_key = r ->> 'event_key';
  IF FOUND THEN
    IF (v_existing.type, v_existing.data) = (r ->> 'type', r -> 'data') THEN
      RETURN jsonb_build_object('ok', true, 'replay', true, 'seq', v_existing.seq, 'at', factory_time(v_existing.recorded_at));
    END IF;
    RETURN spend_refusal('idempotency_conflict', 'the event key exists with different content');
  END IF;
  v_seq := coalesce((SELECT max(seq) FROM factory_validation_events WHERE validation_id = r ->> 'validation_id'), 0) + 1;
  INSERT INTO factory_validation_events (validation_id, seq, event_key, type, data, recorded_at)
  VALUES (r ->> 'validation_id', v_seq, r ->> 'event_key', r ->> 'type', r -> 'data', v_now);
  RETURN jsonb_build_object('ok', true, 'replay', false, 'seq', v_seq, 'at', factory_time(v_now));
END
$$;

-- Factory reads -------------------------------------------------------------------------------

-- Two plain predicates rather than IS NOT DISTINCT FROM, so each lookup uses the index.
CREATE FUNCTION factory_last_heartbeat(p_request text, p_validation text) RETURNS text LANGUAGE sql STABLE
RETURN CASE
  WHEN p_validation IS NULL THEN (SELECT factory_time(max(recorded_at)) FROM factory_heartbeats
                                  WHERE request_id = p_request AND validation_id IS NULL)
  ELSE (SELECT factory_time(max(recorded_at)) FROM factory_heartbeats
        WHERE request_id = p_request AND validation_id = p_validation)
END;

CREATE FUNCTION factory_validation_json(v factory_validations) RETURNS jsonb LANGUAGE sql STABLE
RETURN jsonb_build_object(
  'validation_id', v.validation_id, 'request_id', v.request_id, 'case_id', v.case_id,
  'root_execution_id', v.root_execution_id, 'recorded_at', factory_time(v.recorded_at),
  'last_heartbeat_at', factory_last_heartbeat(v.request_id, v.validation_id)
);

CREATE FUNCTION factory_request_read(p_request jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path FROM CURRENT AS $$
DECLARE
  r jsonb := p_request;
  v_err text := coalesce(
    spend_keys_error(r, ARRAY['request_id', 'after', 'limit']),
    spend_field_error(r, 'request_id', 'uuid'),
    spend_field_error(r, 'after', 'safe_int'),
    factory_range_error(r, 'limit', 1, 1000)
  );
  v_request factory_requests%ROWTYPE;
  v_stop factory_stops%ROWTYPE;
  v_events jsonb;
  v_last factory_events%ROWTYPE;
BEGIN
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;
  SELECT * INTO v_request FROM factory_requests WHERE request_id = r ->> 'request_id';
  IF NOT FOUND THEN
    RETURN spend_refusal('unknown_request');
  END IF;
  SELECT * INTO v_stop FROM factory_stops WHERE request_id = v_request.request_id;
  SELECT * INTO v_last FROM factory_events WHERE request_id = v_request.request_id ORDER BY seq DESC LIMIT 1;
  SELECT coalesce(jsonb_agg(e.doc ORDER BY e.seq), '[]'::jsonb) INTO v_events
  FROM (SELECT f.seq, factory_event_json(f) AS doc FROM factory_events f
        WHERE f.request_id = v_request.request_id AND f.seq > (r ->> 'after')::bigint
        ORDER BY f.seq LIMIT (r ->> 'limit')::bigint) e;
  RETURN jsonb_build_object(
    'ok', true,
    'request', jsonb_build_object(
      'request_id', v_request.request_id,
      'request_sha256', v_request.request_sha256,
      'interpretation', v_request.interpretation,
      'interpretation_sha256', v_request.interpretation_sha256,
      'budget_key', v_request.budget_key,
      'root_execution_id', v_request.root_execution_id,
      'factory_profile_sha256', v_request.factory_profile_sha256,
      'created_at', factory_time(v_request.recorded_at)
    ),
    'events', v_events,
    'next_after', coalesce((v_events -> -1 ->> 'seq')::bigint, (r ->> 'after')::bigint),
    'last_seq', coalesce(v_last.seq, 0),
    'last_event_at', factory_time(v_last.recorded_at),
    'last_heartbeat_at', factory_last_heartbeat(v_request.request_id, NULL),
    'stop', CASE WHEN v_stop.request_id IS NULL THEN NULL
                 ELSE jsonb_build_object('actor_role', v_stop.actor_role, 'recorded_at', factory_time(v_stop.recorded_at)) END,
    'evidence', coalesce((
      SELECT jsonb_agg(jsonb_build_object('case_id', x.case_id, 'sha256', x.sha256, 'recorded_at', factory_time(x.recorded_at))
                       ORDER BY x.seq)
      FROM factory_evidence x WHERE x.request_id = v_request.request_id
    ), '[]'::jsonb),
    'validations', coalesce((
      SELECT jsonb_agg(factory_validation_json(v) ORDER BY v.seq)
      FROM factory_validations v WHERE v.request_id = v_request.request_id
    ), '[]'::jsonb)
  );
END
$$;

CREATE FUNCTION factory_evidence_read(p_request jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path FROM CURRENT AS $$
DECLARE
  r jsonb := p_request;
  v_err text := coalesce(
    spend_keys_error(r, ARRAY['request_id', 'case_id']),
    spend_field_error(r, 'request_id', 'uuid'),
    spend_field_error(r, 'case_id', 'hex64')
  );
  v_evidence factory_evidence%ROWTYPE;
BEGIN
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM factory_requests WHERE request_id = r ->> 'request_id') THEN
    RETURN spend_refusal('unknown_request');
  END IF;
  SELECT * INTO v_evidence FROM factory_evidence WHERE request_id = r ->> 'request_id' AND case_id = r ->> 'case_id';
  IF NOT FOUND THEN
    RETURN spend_refusal('unknown_evidence');
  END IF;
  RETURN jsonb_build_object(
    'ok', true,
    'request_id', v_evidence.request_id,
    'case_id', v_evidence.case_id,
    'sha256', v_evidence.sha256,
    'evidence_json', v_evidence.evidence_json,
    'recorded_at', factory_time(v_evidence.recorded_at)
  );
END
$$;

CREATE FUNCTION factory_validation_read(p_request jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path FROM CURRENT AS $$
DECLARE
  r jsonb := p_request;
  v_err text := coalesce(
    spend_keys_error(r, ARRAY['validation_id', 'after', 'limit']),
    spend_field_error(r, 'validation_id', 'uuid'),
    spend_field_error(r, 'after', 'safe_int'),
    factory_range_error(r, 'limit', 1, 1000)
  );
  v_validation factory_validations%ROWTYPE;
  v_events jsonb;
BEGIN
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;
  SELECT * INTO v_validation FROM factory_validations WHERE validation_id = r ->> 'validation_id';
  IF NOT FOUND THEN
    RETURN spend_refusal('unknown_validation');
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('seq', e.seq, 'at', factory_time(e.recorded_at), 'type', e.type, 'data', e.data)
                            ORDER BY e.seq), '[]'::jsonb) INTO v_events
  FROM (SELECT * FROM factory_validation_events
        WHERE validation_id = v_validation.validation_id AND seq > (r ->> 'after')::bigint
        ORDER BY seq LIMIT (r ->> 'limit')::bigint) e;
  RETURN jsonb_build_object(
    'ok', true,
    'validation', factory_validation_json(v_validation),
    'events', v_events,
    'next_after', coalesce((v_events -> -1 ->> 'seq')::bigint, (r ->> 'after')::bigint),
    'last_seq', coalesce((SELECT max(seq) FROM factory_validation_events WHERE validation_id = v_validation.validation_id), 0)
  );
END
$$;

-- Which request or validation run a root execution belongs to, for example a slot holder.
CREATE FUNCTION factory_root_read(p_request jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path FROM CURRENT AS $$
DECLARE
  r jsonb := p_request;
  v_err text := coalesce(spend_keys_error(r, ARRAY['root_execution_id']), spend_field_error(r, 'root_execution_id', 'uuid'));
  v_request text;
  v_validation text;
BEGIN
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;
  SELECT request_id INTO v_request FROM factory_requests WHERE root_execution_id = r ->> 'root_execution_id';
  IF v_request IS NULL THEN
    SELECT request_id, validation_id INTO v_request, v_validation
    FROM factory_validations WHERE root_execution_id = r ->> 'root_execution_id';
  END IF;
  IF v_request IS NULL THEN
    RETURN spend_refusal('unknown_request', 'no factory request or validation run has this root execution');
  END IF;
  RETURN jsonb_build_object('ok', true, 'root_execution_id', r ->> 'root_execution_id',
                            'request_id', v_request, 'validation_id', v_validation);
END
$$;

-- Guards on the new tables and entry points ----------------------------------------------------

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'budgets', 'budget_operations', 'budget_closures', 'budget_refusals', 'factory_requests', 'factory_events',
    'factory_validations', 'factory_validation_events', 'factory_heartbeats', 'factory_stops', 'factory_evidence'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION spend_reject_change()',
      v_table || '_insert_only', v_table
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION spend_reject_change()',
      v_table || '_no_truncate', v_table
    );
    -- The name sorts before every other BEFORE INSERT trigger on these tables, so it fires first.
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION spend_require_function()',
      v_table || '_api_only', v_table
    );
  END LOOP;
END
$$;

-- The writing entry points, as in 0004: each turns the guard on, calls its body and restores the
-- previous value before it returns.
DO $$
DECLARE
  v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'spend_create_budget', 'spend_budget_reserve', 'spend_budget_close', 'factory_accept_request',
    'factory_record_request', 'factory_append_event', 'factory_record_heartbeat', 'factory_record_stop',
    'factory_record_evidence', 'factory_record_validation', 'factory_append_validation_event'
  ] LOOP
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
      v_name, v_name || '_body'
    );
  END LOOP;
END
$$;

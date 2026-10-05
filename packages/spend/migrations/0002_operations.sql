-- Spend pool and serial execution slot: the database operations.
--
-- Every entry point takes one jsonb request (and, when it writes, the event time as a UTC
-- RFC3339 string) and returns one jsonb result: {"ok": true, ...} or
-- {"ok": false, "code": "<refusal code>", ...}. Amounts in results are decimal strings.
-- Business refusals are results; anything else (a dropped connection, a violated constraint)
-- is raised. Callers in any language get the same behaviour by calling these functions.

-- Request helpers -----------------------------------------------------------------------------

CREATE FUNCTION spend_refusal(p_code text, p_detail text DEFAULT NULL, p_extra jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE
RETURN jsonb_build_object('ok', false, 'code', p_code)
  || CASE WHEN p_detail IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('detail', p_detail) END
  || p_extra;

CREATE FUNCTION spend_invalid(p_detail text) RETURNS jsonb LANGUAGE sql IMMUTABLE
RETURN spend_refusal('invalid_request', p_detail);

CREATE FUNCTION spend_text(p jsonb) RETURNS text LANGUAGE sql IMMUTABLE
RETURN CASE WHEN jsonb_typeof(p) = 'string' THEN p #>> '{}' END;

-- A JSON number that is an integer from 0 to 2^53 - 1, or NULL.
CREATE FUNCTION spend_safe_int(p jsonb) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE SET search_path FROM CURRENT AS $$
DECLARE
  v numeric;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'number' THEN
    RETURN NULL;
  END IF;
  v := p::numeric;
  IF scale(v) <> 0 OR v < 0 OR v > 9007199254740991 THEN
    RETURN NULL;
  END IF;
  RETURN v::bigint;
END
$$;

-- A UTC RFC3339 time ending in Z, or NULL.
CREATE FUNCTION spend_parse_time(p text) RETURNS timestamptz
LANGUAGE plpgsql STABLE SET search_path FROM CURRENT AS $$
BEGIN
  IF p IS NULL OR p !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$' THEN
    RETURN NULL;
  END IF;
  RETURN p::timestamptz;
EXCEPTION
  -- A well-formed string can still name an impossible date; the caller reports it as malformed.
  WHEN datetime_field_overflow OR invalid_datetime_format THEN
    RETURN NULL;
END
$$;

-- NULL when p is an object with exactly p_keys; otherwise a description of the problem.
CREATE FUNCTION spend_keys_error(p jsonb, p_keys text[]) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path FROM CURRENT AS $$
DECLARE
  v_key text;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' THEN
    RETURN 'request must be a JSON object';
  END IF;
  SELECT k INTO v_key FROM unnest(p_keys) k WHERE NOT p ? k ORDER BY k LIMIT 1;
  IF v_key IS NOT NULL THEN
    RETURN 'missing field ' || v_key;
  END IF;
  SELECT k INTO v_key FROM jsonb_object_keys(p) k WHERE k <> ALL (p_keys) ORDER BY k LIMIT 1;
  IF v_key IS NOT NULL THEN
    RETURN 'unknown field ' || v_key;
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION spend_is_price(p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path FROM CURRENT AS $$
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;
  IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) <> ARRAY['microusd', 'per_units'] THEN
    RETURN false;
  END IF;
  RETURN spend_safe_int(p -> 'microusd') IS NOT NULL AND coalesce(spend_safe_int(p -> 'per_units') >= 1, false);
END
$$;

-- NULL when field p_field of p has format p_format; otherwise a description of the problem.
CREATE FUNCTION spend_field_error(p jsonb, p_field text, p_format text, p_nullable boolean DEFAULT false)
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

CREATE FUNCTION spend_role_error(p_role text, p_allowed text[]) RETURNS text LANGUAGE sql IMMUTABLE
RETURN CASE WHEN p_role = ANY (p_allowed) THEN NULL
            ELSE 'actor_role must be ' || array_to_string(p_allowed, ' or ') || ' for this action' END;

-- Prices the envelope. Returns a refusal, or {"ok": true, "worst_case_microusd": n, "lines": [...]}.
CREATE FUNCTION spend_price_envelope(p_envelope jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path FROM CURRENT AS $$
DECLARE
  v_line jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_total numeric := 0;
  v_worst numeric;
  v_limit bigint;
  v_microusd bigint;
  v_per_units bigint;
BEGIN
  IF jsonb_typeof(p_envelope) IS DISTINCT FROM 'array' OR jsonb_array_length(p_envelope) = 0 THEN
    RETURN spend_invalid('envelope must be a non-empty array of lines');
  END IF;
  FOR v_line IN SELECT e FROM jsonb_array_elements(p_envelope) e LOOP
    IF jsonb_typeof(v_line) <> 'object' THEN
      RETURN spend_invalid('each envelope line must be a JSON object');
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_object_keys(v_line) k WHERE k NOT IN ('service', 'unit', 'limit', 'enforced_by', 'price')
    ) THEN
      RETURN spend_invalid('envelope lines have only service, unit, limit, enforced_by and price');
    END IF;
  END LOOP;

  FOR v_line IN SELECT e FROM jsonb_array_elements(p_envelope) e LOOP
    IF NOT spend_is_label(spend_text(v_line -> 'service')) THEN
      RETURN spend_refusal('unknown_price', 'service must be lowercase letters, digits, ".", "_" and "-" (at most 64)');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM units WHERE unit = spend_text(v_line -> 'unit')) THEN
      RETURN spend_refusal('unknown_price', 'unit must be on the units list');
    END IF;
    IF NOT spend_is_price(v_line -> 'price') THEN
      RETURN spend_refusal('unknown_price', 'price must be {microusd, per_units} from the rate sheet');
    END IF;
  END LOOP;

  FOR v_line IN SELECT e FROM jsonb_array_elements(p_envelope) e LOOP
    IF spend_safe_int(v_line -> 'limit') IS NULL THEN
      RETURN spend_refusal('unenforceable_limit', 'limit must be an integer from 0 to 9007199254740991');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM enforcement_methods WHERE enforced_by = spend_text(v_line -> 'enforced_by')) THEN
      RETURN spend_refusal('unenforceable_limit', 'enforced_by must be on the enforcement list');
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM jsonb_array_elements(p_envelope))
     <> (SELECT count(DISTINCT (e ->> 'service', e ->> 'unit')) FROM jsonb_array_elements(p_envelope) e) THEN
    RETURN spend_invalid('envelope repeats a (service, unit) pair');
  END IF;

  FOR v_line IN SELECT e FROM jsonb_array_elements(p_envelope) e LOOP
    v_limit := spend_safe_int(v_line -> 'limit');
    v_microusd := spend_safe_int(v_line -> 'price' -> 'microusd');
    v_per_units := spend_safe_int(v_line -> 'price' -> 'per_units');
    -- ceil(limit * price / block), in exact integer arithmetic.
    v_worst := div(v_limit::numeric * v_microusd + v_per_units - 1, v_per_units);
    v_total := v_total + v_worst;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'service', v_line ->> 'service',
      'unit', v_line ->> 'unit',
      'limit', v_limit,
      'enforced_by', v_line ->> 'enforced_by',
      'price_microusd', v_microusd,
      'price_per_units', v_per_units,
      'worst_case_microusd', v_worst
    ));
  END LOOP;

  IF v_total > 9007199254740991 THEN
    RETURN spend_invalid('envelope total is above 9007199254740991 micro-USD');
  END IF;
  RETURN jsonb_build_object('ok', true, 'worst_case_microusd', v_total, 'lines', v_lines);
END
$$;

CREATE FUNCTION spend_amounts(p_pool text, p_allocation text) RETURNS jsonb LANGUAGE sql
BEGIN ATOMIC
  SELECT jsonb_build_object(
    'pool_available_microusd', spend_available(p_pool, NULL)::text,
    'allocation_available_microusd', CASE WHEN p_allocation IS NULL THEN NULL
                                          ELSE spend_available(p_pool, p_allocation)::text END
  );
END;

CREATE FUNCTION spend_reservation_result(p_operation text, p_replay boolean) RETURNS jsonb LANGUAGE sql
BEGIN ATOMIC
  SELECT jsonb_build_object(
    'ok', true,
    'replay', p_replay,
    'operation_id', o.operation_id,
    'state', spend_operation_state(o.operation_id),
    'reserved_microusd', o.worst_case_microusd::text
  ) || spend_amounts(o.pool_key, o.allocation_key)
  FROM operations o WHERE o.operation_id = p_operation;
END;

-- Records an over-envelope observation. Serialized with resumes so a resume never misses one.
CREATE FUNCTION spend_observe_overrun(
  p_operation text, p_pool text, p_source text, p_service text, p_unit text,
  p_measure text, p_observed bigint, p_bound numeric, p_now timestamptz
) RETURNS void LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  LOCK TABLE halt_resumes IN SHARE ROW EXCLUSIVE MODE;
  INSERT INTO halt_observations (operation_id, pool_key, source, service, unit, measure, observed, bound, recorded_at)
  VALUES (p_operation, p_pool, p_source, p_service, p_unit, p_measure, p_observed, p_bound, p_now);
END
$$;

-- Manual actions ------------------------------------------------------------------------------

CREATE FUNCTION spend_create_pool(p_request jsonb, p_now text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path FROM CURRENT AS $$
DECLARE
  r jsonb := p_request;
  v_now timestamptz := spend_parse_time(p_now);
  v_err text;
  v_allocation jsonb;
  v_seq bigint;
BEGIN
  PERFORM spend_require_read_committed();
  IF v_now IS NULL THEN
    RETURN spend_invalid('now must be a UTC RFC3339 time ending in Z');
  END IF;
  v_err := coalesce(
    spend_keys_error(r, ARRAY['pool_key', 'cap_microusd', 'allocations', 'actor_role', 'reason']),
    spend_field_error(r, 'pool_key', 'key'),
    spend_field_error(r, 'cap_microusd', 'safe_int'),
    spend_field_error(r, 'actor_role', 'role'),
    spend_field_error(r, 'reason', 'reason'),
    spend_role_error(r ->> 'actor_role', ARRAY['owner']),
    CASE WHEN jsonb_typeof(r -> 'allocations') IS DISTINCT FROM 'array' THEN 'allocations must be an array' END
  );
  IF v_err IS NULL THEN
    FOR v_allocation IN SELECT e FROM jsonb_array_elements(r -> 'allocations') e LOOP
      v_err := coalesce(
        spend_keys_error(v_allocation, ARRAY['allocation_key', 'limit_microusd']),
        spend_field_error(v_allocation, 'allocation_key', 'key'),
        spend_field_error(v_allocation, 'limit_microusd', 'safe_int')
      );
      EXIT WHEN v_err IS NOT NULL;
    END LOOP;
  END IF;
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;
  IF (SELECT count(*) <> count(DISTINCT e ->> 'allocation_key') FROM jsonb_array_elements(r -> 'allocations') e) THEN
    RETURN spend_invalid('allocation keys must be distinct');
  END IF;
  IF jsonb_array_length(r -> 'allocations') > 0 AND (
    SELECT sum((e ->> 'limit_microusd')::numeric) FROM jsonb_array_elements(r -> 'allocations') e
  ) <> (r ->> 'cap_microusd')::numeric THEN
    RETURN spend_invalid('allocation limits must sum to the cap');
  END IF;
  IF EXISTS (SELECT 1 FROM pools WHERE pool_key = r ->> 'pool_key') THEN
    RETURN spend_invalid('pool already exists');
  END IF;

  INSERT INTO pools (pool_key, actor_role, reason, recorded_at)
  VALUES (r ->> 'pool_key', r ->> 'actor_role', r ->> 'reason', v_now)
  RETURNING seq INTO v_seq;
  INSERT INTO pool_cap_changes (pool_key, kind, amount_microusd, actor_role, reason, recorded_at)
  VALUES (r ->> 'pool_key', 'initial', (r ->> 'cap_microusd')::bigint, r ->> 'actor_role', r ->> 'reason', v_now);
  INSERT INTO pool_allocations (pool_key, allocation_key, initial_limit_microusd, recorded_at)
  SELECT r ->> 'pool_key', e ->> 'allocation_key', (e ->> 'limit_microusd')::bigint, v_now
  FROM jsonb_array_elements(r -> 'allocations') e;
  RETURN jsonb_build_object('ok', true, 'seq', v_seq);
END
$$;

CREATE FUNCTION spend_create_slot_key(p_request jsonb, p_now text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path FROM CURRENT AS $$
DECLARE
  r jsonb := p_request;
  v_now timestamptz := spend_parse_time(p_now);
  v_err text;
  v_seq bigint;
BEGIN
  PERFORM spend_require_read_committed();
  IF v_now IS NULL THEN
    RETURN spend_invalid('now must be a UTC RFC3339 time ending in Z');
  END IF;
  v_err := coalesce(
    spend_keys_error(r, ARRAY['slot_key', 'actor_role', 'reason']),
    spend_field_error(r, 'slot_key', 'key'),
    spend_field_error(r, 'actor_role', 'role'),
    spend_field_error(r, 'reason', 'reason'),
    spend_role_error(r ->> 'actor_role', ARRAY['owner'])
  );
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;
  IF EXISTS (SELECT 1 FROM execution_slot WHERE slot_key = r ->> 'slot_key') THEN
    RETURN spend_invalid('slot key already exists');
  END IF;
  INSERT INTO execution_slot (slot_key, actor_role, reason, recorded_at)
  VALUES (r ->> 'slot_key', r ->> 'actor_role', r ->> 'reason', v_now)
  RETURNING seq INTO v_seq;
  RETURN jsonb_build_object('ok', true, 'seq', v_seq);
END
$$;

CREATE FUNCTION spend_raise_cap(p_request jsonb, p_now text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path FROM CURRENT AS $$
DECLARE
  r jsonb := p_request;
  v_now timestamptz := spend_parse_time(p_now);
  v_err text;
  v_cap numeric;
  v_seq bigint;
BEGIN
  PERFORM spend_require_read_committed();
  IF v_now IS NULL THEN
    RETURN spend_invalid('now must be a UTC RFC3339 time ending in Z');
  END IF;
  v_err := coalesce(
    spend_keys_error(r, ARRAY['pool_key', 'new_cap_microusd', 'actor_role', 'reason']),
    spend_field_error(r, 'pool_key', 'key'),
    spend_field_error(r, 'new_cap_microusd', 'safe_int'),
    spend_field_error(r, 'actor_role', 'role'),
    spend_field_error(r, 'reason', 'reason'),
    spend_role_error(r ->> 'actor_role', ARRAY['owner'])
  );
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;
  PERFORM 1 FROM pools WHERE pool_key = r ->> 'pool_key' FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN spend_refusal('unknown_pool');
  END IF;
  IF EXISTS (SELECT 1 FROM pool_allocations WHERE pool_key = r ->> 'pool_key') THEN
    RETURN spend_refusal('cap_change_refused', 'a pool with allocations changes only through a transfer');
  END IF;
  v_cap := spend_pool_cap(r ->> 'pool_key');
  IF (r ->> 'new_cap_microusd')::numeric <= v_cap THEN
    RETURN spend_refusal('cap_change_refused', 'a cap may only be raised');
  END IF;
  INSERT INTO pool_cap_changes (pool_key, kind, amount_microusd, actor_role, reason, recorded_at)
  VALUES (r ->> 'pool_key', 'raise', ((r ->> 'new_cap_microusd')::numeric - v_cap)::bigint,
          r ->> 'actor_role', r ->> 'reason', v_now)
  RETURNING seq INTO v_seq;
  RETURN jsonb_build_object('ok', true, 'seq', v_seq);
END
$$;

CREATE FUNCTION spend_transfer(p_request jsonb, p_now text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path FROM CURRENT AS $$
DECLARE
  r jsonb := p_request;
  v_now timestamptz := spend_parse_time(p_now);
  v_err text;
  v_seq bigint;
BEGIN
  PERFORM spend_require_read_committed();
  IF v_now IS NULL THEN
    RETURN spend_invalid('now must be a UTC RFC3339 time ending in Z');
  END IF;
  v_err := coalesce(
    spend_keys_error(r, ARRAY['pool_key', 'from_allocation_key', 'to_allocation_key', 'amount_microusd', 'actor_role', 'reason']),
    spend_field_error(r, 'pool_key', 'key'),
    spend_field_error(r, 'from_allocation_key', 'key'),
    spend_field_error(r, 'to_allocation_key', 'key'),
    spend_field_error(r, 'amount_microusd', 'positive_int'),
    spend_field_error(r, 'actor_role', 'role'),
    spend_field_error(r, 'reason', 'reason'),
    spend_role_error(r ->> 'actor_role', ARRAY['owner', 'operator'])
  );
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;
  -- Same lock as check-and-reserve, so a transfer and a reservation never both use the same amount.
  PERFORM 1 FROM pools WHERE pool_key = 'judge-demo' FOR NO KEY UPDATE;
  IF (r ->> 'pool_key', r ->> 'from_allocation_key', r ->> 'to_allocation_key') <> ('judge-demo', 'public', 'judge') THEN
    RETURN spend_refusal('transfer_refused', 'the only transfer is public to judge in judge-demo');
  END IF;
  IF (r ->> 'amount_microusd')::numeric > spend_available('judge-demo', 'public') THEN
    RETURN spend_refusal('transfer_refused', 'amount exceeds the public allocation''s available amount');
  END IF;
  INSERT INTO allocation_transfers (pool_key, from_allocation_key, to_allocation_key, amount_microusd, actor_role, reason, recorded_at)
  VALUES ('judge-demo', 'public', 'judge', (r ->> 'amount_microusd')::bigint, r ->> 'actor_role', r ->> 'reason', v_now)
  RETURNING seq INTO v_seq;
  RETURN jsonb_build_object('ok', true, 'seq', v_seq);
END
$$;

CREATE FUNCTION spend_resume(p_request jsonb, p_now text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path FROM CURRENT AS $$
DECLARE
  r jsonb := p_request;
  v_now timestamptz := spend_parse_time(p_now);
  v_err text;
  v_seq bigint;
BEGIN
  PERFORM spend_require_read_committed();
  IF v_now IS NULL THEN
    RETURN spend_invalid('now must be a UTC RFC3339 time ending in Z');
  END IF;
  v_err := coalesce(
    spend_keys_error(r, ARRAY['actor_role', 'evidence', 'reason']),
    spend_field_error(r, 'actor_role', 'role'),
    spend_field_error(r, 'evidence', 'evidence_list'),
    spend_field_error(r, 'reason', 'reason'),
    spend_role_error(r ->> 'actor_role', ARRAY['owner', 'operator'])
  );
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;
  LOCK TABLE halt_resumes IN SHARE ROW EXCLUSIVE MODE;
  IF NOT spend_halted() THEN
    RETURN spend_invalid('nothing is halted');
  END IF;
  INSERT INTO halt_resumes (actor_role, evidence, reason, recorded_at)
  VALUES (r ->> 'actor_role', r -> 'evidence', r ->> 'reason', v_now)
  RETURNING seq INTO v_seq;
  RETURN jsonb_build_object('ok', true, 'seq', v_seq);
END
$$;

-- Atomic check-and-reserve --------------------------------------------------------------------

CREATE FUNCTION spend_reserve(p_request jsonb, p_now text) RETURNS jsonb
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

  -- An existing operation is immutable, so its replay or conflict is decided without a lock.
  -- A concurrent first reservation of the same ID on another pool fails on the primary key and
  -- is raised; repeating the request then returns the replay or the conflict.
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
  -- Checked again under the pool lock: an identical request that committed while this call waited.
  SELECT * INTO v_existing FROM operations WHERE operation_id = v_operation_id;
  IF FOUND THEN
    IF v_existing.intent = r THEN
      RETURN spend_reservation_result(v_operation_id, true);
    END IF;
    RETURN spend_refusal('operation_conflict');
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

-- State transitions ---------------------------------------------------------------------------

CREATE FUNCTION spend_transition(p_request jsonb, p_now text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path FROM CURRENT AS $$
DECLARE
  r jsonb := p_request;
  v_now timestamptz := spend_parse_time(p_now);
  v_err text;
  v_to text := spend_text(p_request -> 'to_state');
  v_operation operations%ROWTYPE;
  v_state text;
  v_slot text;
  v_seq bigint;
BEGIN
  PERFORM spend_require_read_committed();
  IF v_now IS NULL THEN
    RETURN spend_invalid('now must be a UTC RFC3339 time ending in Z');
  END IF;
  v_err := coalesce(
    spend_keys_error(r, ARRAY['operation_id', 'from_state', 'to_state', 'actor_role'] || CASE v_to
      WHEN 'launching' THEN ARRAY['slot_key']
      WHEN 'running' THEN ARRAY['provider_resource_id']
      WHEN 'terminal' THEN ARRAY['terminal_status']
      WHEN 'uncertain' THEN ARRAY['uncertainty']
      ELSE ARRAY[]::text[] END),
    spend_field_error(r, 'operation_id', 'hex64'),
    spend_field_error(r, 'from_state', 'state'),
    spend_field_error(r, 'to_state', 'state'),
    spend_field_error(r, 'actor_role', 'role'),
    CASE v_to
      WHEN 'launching' THEN spend_field_error(r, 'slot_key', 'key')
      WHEN 'running' THEN spend_field_error(r, 'provider_resource_id', 'identifier')
      WHEN 'terminal' THEN spend_field_error(r, 'terminal_status', 'terminal_status')
      WHEN 'uncertain' THEN spend_field_error(r, 'uncertainty', 'uncertainty')
    END
  );
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;

  SELECT * INTO v_operation FROM operations WHERE operation_id = r ->> 'operation_id' FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN spend_refusal('unknown_operation');
  END IF;
  v_state := spend_operation_state(v_operation.operation_id);
  IF r ->> 'from_state' <> v_state OR (v_state, v_to) NOT IN (
    ('prepared', 'launching'),
    ('launching', 'running'),
    ('launching', 'terminal'),
    ('running', 'terminal'),
    ('launching', 'uncertain'),
    ('running', 'uncertain')
  ) THEN
    RETURN spend_refusal('invalid_transition', NULL, jsonb_build_object('current_state', v_state));
  END IF;

  IF v_to = 'launching' THEN
    IF spend_halted() THEN
      RETURN spend_refusal('pool_halted');
    END IF;
    v_slot := r ->> 'slot_key';
    PERFORM 1 FROM execution_slot WHERE slot_key = v_slot FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RETURN spend_refusal('unknown_slot');
    END IF;
    IF spend_slot_holder(v_slot) IS DISTINCT FROM v_operation.root_execution_id THEN
      RETURN spend_refusal('slot_not_held');
    END IF;
  ELSE
    v_slot := (SELECT slot_key FROM operation_events
               WHERE operation_id = v_operation.operation_id AND to_state = 'launching');
    PERFORM 1 FROM execution_slot WHERE slot_key = v_slot FOR NO KEY UPDATE;
  END IF;

  INSERT INTO operation_events (
    operation_id, prior_seq, from_state, to_state, cause, slot_key,
    provider_resource_id, terminal_status, uncertainty, actor_role, recorded_at
  ) VALUES (
    v_operation.operation_id, spend_operation_last_event(v_operation.operation_id), v_state, v_to, 'transition',
    CASE WHEN v_to = 'launching' THEN v_slot END,
    r ->> 'provider_resource_id', r ->> 'terminal_status', r ->> 'uncertainty', r ->> 'actor_role', v_now
  ) RETURNING seq INTO v_seq;

  IF v_to = 'running' THEN
    INSERT INTO slot_children (
      slot_key, root_execution_id, provider, resource_id, operation_id, execution_id, kind, source, actor_role, recorded_at
    ) VALUES (
      v_slot, v_operation.root_execution_id, v_operation.provider, r ->> 'provider_resource_id',
      v_operation.operation_id, v_operation.execution_id, v_operation.kind, 'transition', r ->> 'actor_role', v_now
    ) ON CONFLICT (root_execution_id, provider, resource_id) DO NOTHING;
  ELSIF v_to = 'terminal' THEN
    -- The provider's terminal status confirms the resources this operation named as running
    -- (by its running transition or a found_running reconciliation), and no others.
    INSERT INTO slot_child_confirmations (child_seq, terminal_status, evidence, source, actor_role, recorded_at)
    SELECT c.seq, r ->> 'terminal_status', NULL, 'transition', r ->> 'actor_role', v_now
    FROM slot_children c
    WHERE c.root_execution_id = v_operation.root_execution_id
      AND c.provider = v_operation.provider
      AND c.resource_id IN (
        SELECT e.provider_resource_id FROM operation_events e
        WHERE e.operation_id = v_operation.operation_id AND e.provider_resource_id IS NOT NULL
        UNION
        SELECT id.value FROM reconciliations rc, jsonb_array_elements_text(rc.provider_resource_ids) id(value)
        WHERE rc.operation_id = v_operation.operation_id AND rc.decision = 'found_running'
      )
      AND NOT EXISTS (SELECT 1 FROM slot_child_confirmations x WHERE x.child_seq = c.seq)
    ORDER BY c.seq;
  END IF;

  RETURN jsonb_build_object('ok', true, 'operation_id', v_operation.operation_id, 'state', v_to, 'seq', v_seq);
END
$$;

-- Settlement ----------------------------------------------------------------------------------

CREATE FUNCTION spend_settlement_result(p_operation text, p_replay boolean) RETURNS jsonb LANGUAGE sql
BEGIN ATOMIC
  SELECT jsonb_build_object(
    'ok', true,
    'replay', p_replay,
    'operation_id', s.operation_id,
    'state', spend_operation_state(s.operation_id),
    'settled_microusd', s.settled_microusd::text,
    'retained_microusd', s.retained_microusd::text,
    'released_microusd', s.released_microusd::text,
    'over_envelope', s.over_envelope
  )
  FROM settlements s WHERE s.operation_id = p_operation;
END;

CREATE FUNCTION spend_settle(p_request jsonb, p_now text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path FROM CURRENT AS $$
DECLARE
  r jsonb := p_request;
  v_now timestamptz := spend_parse_time(p_now);
  v_err text;
  v_lines jsonb := p_request -> 'service_lines';
  v_line jsonb;
  v_operation operations%ROWTYPE;
  v_state text;
  v_usage text;
  v_unknown_lines integer;
  v_matched record;
  v_actual bigint;
  v_quantity bigint;
  v_retained bigint;
  v_known numeric := 0;
  v_unknown numeric := 0;
  v_close numeric;
  v_release numeric;
  v_over boolean := false;
BEGIN
  PERFORM spend_require_read_committed();
  IF v_now IS NULL THEN
    RETURN spend_invalid('now must be a UTC RFC3339 time ending in Z');
  END IF;
  v_err := coalesce(
    spend_keys_error(r, ARRAY[
      'schema_version', 'operation_id', 'runtime_profile_sha256', 'rate_sheet_sha256', 'reserved_microusd',
      'service_lines', 'usage_state', 'terminal_evidence_key', 'terminal_evidence_sha256'
    ]),
    spend_field_error(r, 'schema_version', 'schema_version'),
    spend_field_error(r, 'operation_id', 'hex64'),
    spend_field_error(r, 'runtime_profile_sha256', 'hex64'),
    spend_field_error(r, 'rate_sheet_sha256', 'hex64'),
    spend_field_error(r, 'reserved_microusd', 'safe_int'),
    spend_field_error(r, 'usage_state', 'usage_state'),
    spend_field_error(r, 'terminal_evidence_key', 'identifier', true),
    spend_field_error(r, 'terminal_evidence_sha256', 'hex64', true),
    CASE WHEN (jsonb_typeof(r -> 'terminal_evidence_key') = 'null') <> (jsonb_typeof(r -> 'terminal_evidence_sha256') = 'null')
         THEN 'terminal_evidence_key and terminal_evidence_sha256 must both be null or both be present' END,
    CASE WHEN jsonb_typeof(v_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(v_lines) = 0
         THEN 'service_lines must be a non-empty array' END
  );
  IF v_err IS NULL THEN
    FOR v_line IN SELECT e FROM jsonb_array_elements(v_lines) e LOOP
      v_err := coalesce(
        spend_keys_error(v_line, ARRAY['service', 'unit', 'actual_quantity', 'actual_microusd', 'retained_microusd']),
        spend_field_error(v_line, 'service', 'label'),
        spend_field_error(v_line, 'unit', 'label'),
        spend_field_error(v_line, 'actual_quantity', 'safe_int', true),
        spend_field_error(v_line, 'actual_microusd', 'safe_int', true),
        spend_field_error(v_line, 'retained_microusd', 'safe_int')
      );
      IF v_err IS NOT NULL THEN
        v_err := 'service_lines: ' || v_err;
        EXIT;
      END IF;
    END LOOP;
  END IF;
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;

  SELECT * INTO v_operation FROM operations WHERE operation_id = r ->> 'operation_id';
  IF NOT FOUND THEN
    RETURN spend_refusal('unknown_operation');
  END IF;
  PERFORM 1 FROM pools WHERE pool_key = v_operation.pool_key FOR NO KEY UPDATE;
  PERFORM 1 FROM operations WHERE operation_id = v_operation.operation_id FOR NO KEY UPDATE;

  IF EXISTS (SELECT 1 FROM settlements WHERE operation_id = v_operation.operation_id) THEN
    IF (SELECT content FROM settlements WHERE operation_id = v_operation.operation_id) = r THEN
      RETURN spend_settlement_result(v_operation.operation_id, true);
    END IF;
    RETURN spend_refusal('already_settled');
  END IF;

  v_state := spend_operation_state(v_operation.operation_id);
  IF v_state <> 'terminal' THEN
    RETURN spend_refusal('invalid_transition', NULL, jsonb_build_object('current_state', v_state));
  END IF;
  IF r ->> 'runtime_profile_sha256' <> v_operation.runtime_profile_sha256
     OR r ->> 'rate_sheet_sha256' <> v_operation.rate_sheet_sha256 THEN
    RETURN spend_invalid('runtime_profile_sha256 and rate_sheet_sha256 must equal the reservation''s');
  END IF;
  IF (r ->> 'reserved_microusd')::bigint <> v_operation.worst_case_microusd THEN
    RETURN spend_invalid('reserved_microusd must equal the reservation');
  END IF;
  IF jsonb_array_length(v_lines) <> (SELECT count(*) FROM operation_lines WHERE operation_id = v_operation.operation_id)
     OR EXISTS (
       SELECT 1 FROM operation_lines l
       WHERE l.operation_id = v_operation.operation_id
         AND (SELECT count(*) FROM jsonb_array_elements(v_lines) e
              WHERE e ->> 'service' = l.service AND e ->> 'unit' = l.unit) <> 1
     ) THEN
    RETURN spend_invalid('service_lines must match the envelope''s (service, unit) pairs one to one');
  END IF;
  v_unknown_lines := (SELECT count(*) FROM jsonb_array_elements(v_lines) e WHERE jsonb_typeof(e -> 'actual_microusd') = 'null');
  v_usage := CASE WHEN v_unknown_lines = 0 THEN 'known'
                  WHEN v_unknown_lines = jsonb_array_length(v_lines) THEN 'unknown'
                  ELSE 'partly_unknown' END;
  IF r ->> 'usage_state' <> v_usage THEN
    RETURN spend_invalid('usage_state must be ' || v_usage || ' for these service_lines');
  END IF;

  FOR v_matched IN
    SELECT l.*, e AS line
    FROM operation_lines l
    JOIN jsonb_array_elements(v_lines) e ON e ->> 'service' = l.service AND e ->> 'unit' = l.unit
    WHERE l.operation_id = v_operation.operation_id
    ORDER BY l.line_no
  LOOP
    v_actual := spend_safe_int(v_matched.line -> 'actual_microusd');
    v_retained := spend_safe_int(v_matched.line -> 'retained_microusd');
    IF v_actual IS NOT NULL THEN
      IF v_retained <> 0 THEN
        RETURN spend_invalid('a line with a known amount retains 0');
      END IF;
      v_known := v_known + v_actual;
    ELSE
      IF v_retained <> v_matched.worst_case_microusd THEN
        RETURN spend_invalid('a line with an unknown amount retains its full worst case');
      END IF;
      v_unknown := v_unknown + v_matched.worst_case_microusd;
    END IF;
  END LOOP;

  -- Unknown lines stay committed at their full worst case; only the rest of the reservation closes.
  v_close := v_operation.worst_case_microusd - v_unknown;
  v_release := greatest(v_close - v_known, 0);

  FOR v_matched IN
    SELECT l.*, e AS line
    FROM operation_lines l
    JOIN jsonb_array_elements(v_lines) e ON e ->> 'service' = l.service AND e ->> 'unit' = l.unit
    WHERE l.operation_id = v_operation.operation_id
    ORDER BY l.line_no
  LOOP
    v_actual := spend_safe_int(v_matched.line -> 'actual_microusd');
    v_quantity := spend_safe_int(v_matched.line -> 'actual_quantity');
    IF v_actual > v_matched.worst_case_microusd THEN
      v_over := true;
      PERFORM spend_observe_overrun(v_operation.operation_id, v_operation.pool_key, 'settlement',
        v_matched.service, v_matched.unit, 'microusd', v_actual, v_matched.worst_case_microusd, v_now);
    END IF;
    IF v_quantity > v_matched.limit_quantity THEN
      v_over := true;
      PERFORM spend_observe_overrun(v_operation.operation_id, v_operation.pool_key, 'settlement',
        v_matched.service, v_matched.unit, 'quantity', v_quantity, v_matched.limit_quantity, v_now);
    END IF;
  END LOOP;

  INSERT INTO settlements (operation_id, content, usage_state, settled_microusd, retained_microusd, released_microusd, over_envelope, recorded_at)
  VALUES (v_operation.operation_id, r, v_usage, v_known, v_unknown, v_release, v_over, v_now);
  INSERT INTO spend (operation_id, pool_key, allocation_key, kind, amount_microusd, source, recorded_at)
  SELECT v_operation.operation_id, v_operation.pool_key, v_operation.allocation_key, m.kind, m.amount, 'settlement', v_now
  FROM (
    -- One settle row per known line, so a total beyond 2^53 - 1 is still recorded in full.
    SELECT l.line_no AS n, 'settle' AS kind, (e ->> 'actual_microusd')::numeric AS amount
    FROM operation_lines l
    JOIN jsonb_array_elements(v_lines) e ON e ->> 'service' = l.service AND e ->> 'unit' = l.unit
    WHERE l.operation_id = v_operation.operation_id AND jsonb_typeof(e -> 'actual_microusd') = 'number'
    UNION ALL
    VALUES (1000001, 'close', v_close), (1000002, 'release', v_release)
  ) AS m
  WHERE m.amount > 0
  ORDER BY m.n;

  IF v_usage = 'known' THEN
    INSERT INTO operation_events (operation_id, prior_seq, from_state, to_state, cause, actor_role, recorded_at)
    VALUES (v_operation.operation_id, spend_operation_last_event(v_operation.operation_id),
            'terminal', 'reconciled', 'settlement', 'settlement', v_now);
  END IF;
  RETURN spend_settlement_result(v_operation.operation_id, false);
END
$$;

-- Manual reconciliation -----------------------------------------------------------------------

CREATE FUNCTION spend_reconcile(p_request jsonb, p_now text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path FROM CURRENT AS $$
DECLARE
  r jsonb := p_request;
  v_now timestamptz := spend_parse_time(p_now);
  v_err text;
  v_operation operations%ROWTYPE;
  v_state text;
  v_decision text := r ->> 'decision';
  v_ids jsonb := r -> 'provider_resource_ids';
  v_totals record;
  v_open numeric;
  v_retained bigint;
  v_released bigint;
  v_over boolean := false;
  v_slot text;
  v_to text;
BEGIN
  PERFORM spend_require_read_committed();
  IF v_now IS NULL THEN
    RETURN spend_invalid('now must be a UTC RFC3339 time ending in Z');
  END IF;
  v_err := coalesce(
    spend_keys_error(r, ARRAY[
      'schema_version', 'operation_id', 'previous_state', 'evidence', 'provider_resource_ids', 'recorded_at',
      'actor_role', 'decision', 'retained_microusd', 'released_microusd', 'reason'
    ]),
    spend_field_error(r, 'schema_version', 'schema_version'),
    spend_field_error(r, 'operation_id', 'hex64'),
    spend_field_error(r, 'previous_state', 'state'),
    spend_field_error(r, 'evidence', 'evidence_list'),
    CASE WHEN jsonb_typeof(v_ids) IS DISTINCT FROM 'array'
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_ids) = 'array' THEN v_ids ELSE '[]' END) e
                      WHERE NOT spend_is_identifier(spend_text(e)))
         THEN 'provider_resource_ids must be an array of non-empty identifiers' END,
    spend_field_error(r, 'recorded_at', 'time'),
    spend_field_error(r, 'actor_role', 'role'),
    spend_field_error(r, 'decision', 'decision'),
    spend_field_error(r, 'retained_microusd', 'safe_int'),
    spend_field_error(r, 'released_microusd', 'safe_int'),
    spend_field_error(r, 'reason', 'reason'),
    spend_role_error(r ->> 'actor_role', ARRAY['owner', 'operator'])
  );
  IF v_err IS NULL AND (SELECT count(*) <> count(DISTINCT e) FROM jsonb_array_elements(v_ids) e) THEN
    v_err := 'provider_resource_ids must be distinct';
  END IF;
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;

  SELECT * INTO v_operation FROM operations WHERE operation_id = r ->> 'operation_id';
  IF NOT FOUND THEN
    RETURN spend_refusal('unknown_operation');
  END IF;
  PERFORM 1 FROM pools WHERE pool_key = v_operation.pool_key FOR NO KEY UPDATE;
  PERFORM 1 FROM operations WHERE operation_id = v_operation.operation_id FOR NO KEY UPDATE;

  v_state := spend_operation_state(v_operation.operation_id);
  IF r ->> 'previous_state' <> v_state OR (v_decision, v_state) NOT IN (
    ('found_running', 'launching'),
    ('found_running', 'uncertain'),
    ('confirm_no_launch', 'prepared'),
    ('confirm_no_launch', 'launching'),
    ('confirm_no_launch', 'uncertain'),
    ('accept_complete', 'launching'),
    ('accept_complete', 'running'),
    ('accept_complete', 'uncertain'),
    ('accept_complete', 'terminal'),
    ('confirm_stopped_incomplete', 'launching'),
    ('confirm_stopped_incomplete', 'running'),
    ('confirm_stopped_incomplete', 'uncertain'),
    ('confirm_stopped_incomplete', 'terminal')
  ) THEN
    RETURN spend_refusal('invalid_transition', NULL, jsonb_build_object('current_state', v_state));
  END IF;

  SELECT * INTO v_totals FROM spend_operation_totals(v_operation.operation_id);
  v_open := v_totals.reserved - v_totals.closed;
  v_retained := (r ->> 'retained_microusd')::bigint;
  v_released := (r ->> 'released_microusd')::bigint;

  IF v_decision = 'found_running' THEN
    IF jsonb_array_length(v_ids) = 0 THEN
      RETURN spend_invalid('found_running lists at least one provider resource ID');
    END IF;
    IF v_retained <> v_open OR v_released <> 0 THEN
      RETURN spend_invalid('found_running retains the whole open amount and releases nothing');
    END IF;
  ELSE
    IF v_decision = 'confirm_no_launch' AND jsonb_array_length(v_ids) > 0 THEN
      RETURN spend_invalid('confirm_no_launch lists no provider resources');
    END IF;
    IF v_retained + v_released = v_open THEN
      v_over := false;
    ELSIF v_released = 0 AND v_retained > v_open THEN
      v_over := true;
    ELSE
      RETURN spend_invalid('retained_microusd + released_microusd must equal the open amount '
        || v_open::text || ', or released 0 with retained above it when evidenced usage exceeds it');
    END IF;
  END IF;

  v_slot := (SELECT slot_key FROM operation_events
             WHERE operation_id = v_operation.operation_id AND to_state = 'launching');
  IF v_slot IS NOT NULL THEN
    PERFORM 1 FROM execution_slot WHERE slot_key = v_slot FOR NO KEY UPDATE;
  END IF;

  INSERT INTO reconciliations (
    operation_id, previous_state, decision, evidence, provider_resource_ids, recorded_at, actor_role,
    open_microusd, retained_microusd, released_microusd, over_envelope, reason, content, logged_at
  ) VALUES (
    v_operation.operation_id, v_state, v_decision, r -> 'evidence', v_ids, (r ->> 'recorded_at')::timestamptz,
    r ->> 'actor_role', v_open, v_retained, v_released, v_over, r ->> 'reason', r, v_now
  );

  v_to := CASE WHEN v_decision = 'found_running' THEN 'running' ELSE 'reconciled' END;
  INSERT INTO operation_events (operation_id, prior_seq, from_state, to_state, cause, actor_role, recorded_at)
  VALUES (v_operation.operation_id, spend_operation_last_event(v_operation.operation_id),
          v_state, v_to, 'reconciliation', r ->> 'actor_role', v_now);

  INSERT INTO slot_children (
    slot_key, root_execution_id, provider, resource_id, operation_id, execution_id, kind, source, actor_role, recorded_at
  )
  SELECT v_slot, v_operation.root_execution_id, v_operation.provider, id.value, v_operation.operation_id,
         v_operation.execution_id, v_operation.kind, 'reconciliation', r ->> 'actor_role', v_now
  FROM jsonb_array_elements_text(v_ids) WITH ORDINALITY AS id(value, n)
  ORDER BY id.n
  ON CONFLICT (root_execution_id, provider, resource_id) DO NOTHING;

  IF v_decision <> 'found_running' THEN
    INSERT INTO slot_child_confirmations (child_seq, terminal_status, evidence, source, actor_role, recorded_at)
    SELECT c.seq, NULL, r -> 'evidence', 'reconciliation', r ->> 'actor_role', v_now
    FROM slot_children c
    JOIN jsonb_array_elements_text(v_ids) id(value) ON c.resource_id = id.value
    WHERE c.root_execution_id = v_operation.root_execution_id AND c.provider = v_operation.provider
      AND NOT EXISTS (SELECT 1 FROM slot_child_confirmations x WHERE x.child_seq = c.seq)
    ORDER BY c.seq;

    INSERT INTO spend (operation_id, pool_key, allocation_key, kind, amount_microusd, source, recorded_at)
    SELECT v_operation.operation_id, v_operation.pool_key, v_operation.allocation_key, m.kind, m.amount, 'reconciliation', v_now
    FROM (VALUES (1, 'close', v_open), (2, 'settle', v_retained::numeric), (3, 'release', v_released::numeric)) AS m(n, kind, amount)
    WHERE m.amount > 0
    ORDER BY m.n;

    IF v_over THEN
      PERFORM spend_observe_overrun(v_operation.operation_id, v_operation.pool_key, 'reconciliation',
        NULL, NULL, 'microusd', v_retained, v_open, v_now);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'operation_id', v_operation.operation_id,
    'state', v_to,
    'retained_microusd', v_retained::text,
    'released_microusd', v_released::text,
    'over_envelope', v_over
  );
END
$$;

-- Serial execution slot -----------------------------------------------------------------------

CREATE FUNCTION spend_slot_acquire(p_request jsonb, p_now text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path FROM CURRENT AS $$
DECLARE
  r jsonb := p_request;
  v_now timestamptz := spend_parse_time(p_now);
  v_err text;
  v_slot text := r ->> 'slot_key';
  v_root text := r ->> 'root_execution_id';
  v_holder text;
BEGIN
  PERFORM spend_require_read_committed();
  IF v_now IS NULL THEN
    RETURN spend_invalid('now must be a UTC RFC3339 time ending in Z');
  END IF;
  v_err := coalesce(
    spend_keys_error(r, ARRAY['slot_key', 'root_execution_id', 'actor_role']),
    spend_field_error(r, 'slot_key', 'key'),
    spend_field_error(r, 'root_execution_id', 'uuid'),
    spend_field_error(r, 'actor_role', 'role')
  );
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;
  -- Serializes acquire, release and child records on this key; later statements see fresh rows.
  PERFORM 1 FROM execution_slot WHERE slot_key = v_slot FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN spend_refusal('unknown_slot');
  END IF;
  v_holder := spend_slot_holder(v_slot);
  IF v_holder = v_root THEN
    RETURN jsonb_build_object('ok', true, 'replay', true, 'slot_key', v_slot, 'holder', v_holder);
  END IF;
  IF v_holder IS NOT NULL THEN
    RETURN spend_refusal('slot_held', NULL, jsonb_build_object('holder', v_holder));
  END IF;
  INSERT INTO slot_events (slot_key, prior_seq, kind, root_execution_id, actor_role, recorded_at)
  VALUES (v_slot, spend_slot_last_event(v_slot), 'acquire', v_root, r ->> 'actor_role', v_now);
  RETURN jsonb_build_object('ok', true, 'replay', false, 'slot_key', v_slot, 'holder', v_root);
END
$$;

CREATE FUNCTION spend_slot_record_child(p_request jsonb, p_now text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path FROM CURRENT AS $$
DECLARE
  r jsonb := p_request;
  v_now timestamptz := spend_parse_time(p_now);
  v_err text;
  v_slot text := r ->> 'slot_key';
  v_root text := r ->> 'root_execution_id';
  v_existing slot_children%ROWTYPE;
  v_seq bigint;
BEGIN
  PERFORM spend_require_read_committed();
  IF v_now IS NULL THEN
    RETURN spend_invalid('now must be a UTC RFC3339 time ending in Z');
  END IF;
  v_err := coalesce(
    spend_keys_error(r, ARRAY['slot_key', 'root_execution_id', 'provider', 'resource_id', 'operation_id', 'execution_id', 'kind', 'actor_role']),
    spend_field_error(r, 'slot_key', 'key'),
    spend_field_error(r, 'root_execution_id', 'uuid'),
    spend_field_error(r, 'provider', 'label'),
    spend_field_error(r, 'resource_id', 'identifier'),
    spend_field_error(r, 'operation_id', 'hex64', true),
    spend_field_error(r, 'execution_id', 'uuid', true),
    spend_field_error(r, 'kind', 'label'),
    spend_field_error(r, 'actor_role', 'role')
  );
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;
  PERFORM 1 FROM execution_slot WHERE slot_key = v_slot FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN spend_refusal('unknown_slot');
  END IF;
  IF spend_slot_holder(v_slot) IS DISTINCT FROM v_root THEN
    RETURN spend_refusal('slot_not_held');
  END IF;
  IF r ->> 'operation_id' IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM operations WHERE operation_id = r ->> 'operation_id') THEN
      RETURN spend_refusal('unknown_operation');
    END IF;
    IF (SELECT root_execution_id FROM operations WHERE operation_id = r ->> 'operation_id') <> v_root THEN
      RETURN spend_invalid('operation_id belongs to another root execution');
    END IF;
  END IF;
  SELECT * INTO v_existing FROM slot_children
  WHERE root_execution_id = v_root AND provider = r ->> 'provider' AND resource_id = r ->> 'resource_id';
  IF FOUND THEN
    IF v_existing.slot_key = v_slot AND v_existing.kind = r ->> 'kind'
       AND v_existing.operation_id IS NOT DISTINCT FROM r ->> 'operation_id'
       AND v_existing.execution_id IS NOT DISTINCT FROM r ->> 'execution_id'
       AND v_existing.actor_role = r ->> 'actor_role' THEN
      RETURN jsonb_build_object('ok', true, 'replay', true, 'seq', v_existing.seq);
    END IF;
    RETURN spend_invalid('child resource already recorded with different details');
  END IF;
  INSERT INTO slot_children (
    slot_key, root_execution_id, provider, resource_id, operation_id, execution_id, kind, source, actor_role, recorded_at
  ) VALUES (
    v_slot, v_root, r ->> 'provider', r ->> 'resource_id', r ->> 'operation_id', r ->> 'execution_id',
    r ->> 'kind', 'holder', r ->> 'actor_role', v_now
  ) RETURNING seq INTO v_seq;
  RETURN jsonb_build_object('ok', true, 'replay', false, 'seq', v_seq);
END
$$;

CREATE FUNCTION spend_slot_confirm_child(p_request jsonb, p_now text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path FROM CURRENT AS $$
DECLARE
  r jsonb := p_request;
  v_now timestamptz := spend_parse_time(p_now);
  v_err text;
  v_slot text := r ->> 'slot_key';
  v_root text := r ->> 'root_execution_id';
  v_child bigint;
  v_seq bigint;
  v_prior slot_child_confirmations%ROWTYPE;
BEGIN
  PERFORM spend_require_read_committed();
  IF v_now IS NULL THEN
    RETURN spend_invalid('now must be a UTC RFC3339 time ending in Z');
  END IF;
  v_err := coalesce(
    spend_keys_error(r, ARRAY['slot_key', 'root_execution_id', 'provider', 'resource_id', 'terminal_status', 'evidence', 'actor_role']),
    spend_field_error(r, 'slot_key', 'key'),
    spend_field_error(r, 'root_execution_id', 'uuid'),
    spend_field_error(r, 'provider', 'label'),
    spend_field_error(r, 'resource_id', 'identifier'),
    spend_field_error(r, 'terminal_status', 'terminal_status'),
    spend_field_error(r, 'evidence', 'evidence'),
    spend_field_error(r, 'actor_role', 'role')
  );
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;
  PERFORM 1 FROM execution_slot WHERE slot_key = v_slot FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN spend_refusal('unknown_slot');
  END IF;
  IF spend_slot_holder(v_slot) IS DISTINCT FROM v_root THEN
    RETURN spend_refusal('slot_not_held');
  END IF;
  SELECT seq INTO v_child FROM slot_children
  WHERE slot_key = v_slot AND root_execution_id = v_root
    AND provider = r ->> 'provider' AND resource_id = r ->> 'resource_id';
  IF v_child IS NULL THEN
    RETURN spend_invalid('no such child resource is recorded for this root and slot');
  END IF;
  SELECT * INTO v_prior FROM slot_child_confirmations WHERE child_seq = v_child;
  IF FOUND THEN
    IF v_prior.terminal_status = r ->> 'terminal_status'
      AND v_prior.evidence = jsonb_build_array(r -> 'evidence')
      AND v_prior.actor_role = r ->> 'actor_role' THEN
      RETURN jsonb_build_object('ok', true, 'replay', true, 'seq', v_prior.seq);
    END IF;
    RETURN spend_refusal('confirmation_conflict');
  END IF;
  INSERT INTO slot_child_confirmations (child_seq, terminal_status, evidence, source, actor_role, recorded_at)
  VALUES (v_child, r ->> 'terminal_status', jsonb_build_array(r -> 'evidence'), 'holder', r ->> 'actor_role', v_now)
  RETURNING seq INTO v_seq;
  RETURN jsonb_build_object('ok', true, 'replay', false, 'seq', v_seq);
END
$$;

CREATE FUNCTION spend_slot_release(p_request jsonb, p_now text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path FROM CURRENT AS $$
DECLARE
  r jsonb := p_request;
  v_now timestamptz := spend_parse_time(p_now);
  v_err text;
  v_slot text := r ->> 'slot_key';
  v_root text := r ->> 'root_execution_id';
  v_blockers jsonb;
  v_seq bigint;
BEGIN
  PERFORM spend_require_read_committed();
  IF v_now IS NULL THEN
    RETURN spend_invalid('now must be a UTC RFC3339 time ending in Z');
  END IF;
  v_err := coalesce(
    spend_keys_error(r, ARRAY['slot_key', 'root_execution_id', 'actor_role', 'evidence', 'reason']),
    spend_field_error(r, 'slot_key', 'key'),
    spend_field_error(r, 'root_execution_id', 'uuid'),
    spend_field_error(r, 'actor_role', 'role'),
    spend_field_error(r, 'evidence', 'evidence_list', true),
    spend_field_error(r, 'reason', 'reason', true),
    CASE WHEN r ->> 'actor_role' IN ('owner', 'operator')
              AND (jsonb_typeof(r -> 'evidence') = 'null' OR jsonb_typeof(r -> 'reason') = 'null')
         THEN 'a release by an owner or operator needs evidence and a reason' END
  );
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;
  PERFORM 1 FROM execution_slot WHERE slot_key = v_slot FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN spend_refusal('unknown_slot');
  END IF;
  IF spend_slot_holder(v_slot) IS DISTINCT FROM v_root THEN
    RETURN spend_refusal('slot_not_held');
  END IF;
  v_blockers := spend_slot_blockers(v_slot, v_root);
  IF jsonb_array_length(v_blockers -> 'child_resources') > 0 OR jsonb_array_length(v_blockers -> 'operation_ids') > 0 THEN
    RETURN spend_refusal('slot_release_blocked', NULL, jsonb_build_object(
      'blocking_child_resources', v_blockers -> 'child_resources',
      'blocking_operation_ids', v_blockers -> 'operation_ids'
    ));
  END IF;
  INSERT INTO slot_events (slot_key, prior_seq, kind, root_execution_id, actor_role, evidence, reason, recorded_at)
  VALUES (v_slot, spend_slot_last_event(v_slot), 'release', v_root, r ->> 'actor_role',
          CASE WHEN jsonb_typeof(r -> 'evidence') = 'null' THEN NULL ELSE r -> 'evidence' END, r ->> 'reason', v_now)
  RETURNING seq INTO v_seq;
  RETURN jsonb_build_object('ok', true, 'seq', v_seq);
END
$$;

-- Read-only status ----------------------------------------------------------------------------

CREATE FUNCTION spend_halt_status(p_request jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path FROM CURRENT AS $$
DECLARE
  v_err text := spend_keys_error(p_request, ARRAY[]::text[]);
  v_resume bigint;
BEGIN
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;
  v_resume := coalesce((SELECT max(seq) FROM halt_resumes), 0);
  RETURN jsonb_build_object(
    'ok', true,
    'halted', spend_halted(),
    'observations', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'seq', o.seq,
        'operation_id', o.operation_id,
        'pool_key', o.pool_key,
        'source', o.source,
        'service', o.service,
        'unit', o.unit,
        'observed_microusd', CASE WHEN o.measure = 'microusd' THEN o.observed::text END,
        'bound_microusd', CASE WHEN o.measure = 'microusd' THEN o.bound::text END,
        'observed_quantity', CASE WHEN o.measure = 'quantity' THEN o.observed::text END,
        'bound_quantity', CASE WHEN o.measure = 'quantity' THEN o.bound::text END
      ) ORDER BY o.seq)
      FROM halt_observations o WHERE o.seq > v_resume
    ), '[]'::jsonb)
  );
END
$$;

CREATE FUNCTION spend_pool_status(p_request jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path FROM CURRENT AS $$
DECLARE
  v_err text := coalesce(spend_keys_error(p_request, ARRAY['pool_key']), spend_field_error(p_request, 'pool_key', 'key'));
  v_pool text := p_request ->> 'pool_key';
  v_cap numeric;
  v_totals record;
BEGIN
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pools WHERE pool_key = v_pool) THEN
    RETURN spend_refusal('unknown_pool');
  END IF;
  v_cap := spend_pool_cap(v_pool);
  SELECT * INTO v_totals FROM spend_pool_totals(v_pool, NULL);
  RETURN jsonb_build_object(
    'ok', true,
    'pool_key', v_pool,
    'cap_microusd', v_cap::text,
    'settled_microusd', v_totals.settled::text,
    'open_microusd', v_totals.open::text,
    'committed_microusd', (v_totals.settled + v_totals.open)::text,
    'available_microusd', (v_cap - v_totals.settled - v_totals.open)::text,
    'allocations', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'allocation_key', a.allocation_key,
        'limit_microusd', a.limit_microusd::text,
        'settled_microusd', t.settled::text,
        'open_microusd', t.open::text,
        'committed_microusd', (t.settled + t.open)::text,
        'available_microusd', (a.limit_microusd - t.settled - t.open)::text
      ) ORDER BY a.allocation_key)
      FROM (SELECT allocation_key, spend_allocation_limit(pool_key, allocation_key) AS limit_microusd
            FROM pool_allocations WHERE pool_key = v_pool) a
      CROSS JOIN LATERAL spend_pool_totals(v_pool, a.allocation_key) t
    ), '[]'::jsonb)
  );
END
$$;

CREATE FUNCTION spend_operation_status(p_request jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path FROM CURRENT AS $$
DECLARE
  v_err text := coalesce(spend_keys_error(p_request, ARRAY['operation_id']), spend_field_error(p_request, 'operation_id', 'hex64'));
  v_operation operations%ROWTYPE;
  v_totals record;
BEGIN
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;
  SELECT * INTO v_operation FROM operations WHERE operation_id = p_request ->> 'operation_id';
  IF NOT FOUND THEN
    RETURN spend_refusal('unknown_operation');
  END IF;
  SELECT * INTO v_totals FROM spend_operation_totals(v_operation.operation_id);
  RETURN jsonb_build_object(
    'ok', true,
    'operation_id', v_operation.operation_id,
    'state', spend_operation_state(v_operation.operation_id),
    'pool_key', v_operation.pool_key,
    'allocation_key', v_operation.allocation_key,
    'reserved_microusd', v_totals.reserved::text,
    'settled_microusd', v_totals.settled::text,
    'open_microusd', (v_totals.reserved - v_totals.closed)::text,
    'released_microusd', v_totals.released::text
  );
END
$$;

CREATE FUNCTION spend_slot_status(p_request jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path FROM CURRENT AS $$
DECLARE
  v_err text := coalesce(spend_keys_error(p_request, ARRAY['slot_key']), spend_field_error(p_request, 'slot_key', 'key'));
  v_slot text := p_request ->> 'slot_key';
  v_holder text;
BEGIN
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM execution_slot WHERE slot_key = v_slot) THEN
    RETURN spend_refusal('unknown_slot');
  END IF;
  v_holder := spend_slot_holder(v_slot);
  RETURN jsonb_build_object(
    'ok', true,
    'slot_key', v_slot,
    'holder', v_holder,
    'children', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'provider', c.provider,
        'resource_id', c.resource_id,
        'operation_id', c.operation_id,
        'execution_id', c.execution_id,
        'kind', c.kind,
        'confirmed', x.seq IS NOT NULL,
        'terminal_status', x.terminal_status
      ) ORDER BY c.seq)
      FROM slot_children c
      LEFT JOIN slot_child_confirmations x ON x.child_seq = c.seq
      WHERE c.slot_key = v_slot AND c.root_execution_id = v_holder
    ), '[]'::jsonb),
    'release_blockers', CASE WHEN v_holder IS NULL
                             THEN jsonb_build_object('child_resources', '[]'::jsonb, 'operation_ids', '[]'::jsonb)
                             ELSE spend_slot_blockers(v_slot, v_holder) END
  );
END
$$;

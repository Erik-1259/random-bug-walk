-- Validation run details and keyed event reads.
--
-- Forward-only. factory_validations gains each run's host, acceptance time, package hashes,
-- harness identity and copy count, which the worker needs to price a run, time its window and
-- answer every read about it. factory_record_validation_body, factory_validation_json and
-- factory_validation_read (0006) are replaced; validation events are now read with their event
-- keys. factory_request_events_read is added: a request's events with their keys, for writers
-- that check which keyed events exist (factory_request_read keeps the contract's event shape).
--
-- 0006's insert-only, no-truncate and api-only row triggers cover the new columns, and the
-- factory_record_validation entry point calls its body by name, so neither needs a change.

-- The table is insert-only, so a run recorded before this migration could never gain its
-- details. Refuse rather than invent them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM factory_validations) THEN
    RAISE EXCEPTION 'factory_validations already holds validation runs, which lack the details this migration requires'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END
$$;

ALTER TABLE factory_validations
  ADD COLUMN host_id spend_key NOT NULL,
  ADD COLUMN accepted_at timestamptz NOT NULL,
  ADD COLUMN bug_case_sha256 spend_hex64 NOT NULL,
  ADD COLUMN validator_sha256 spend_hex64 NOT NULL,
  ADD COLUMN harness_name text NOT NULL CONSTRAINT factory_validations_harness_name CHECK (harness_name = 'rbw-validate'),
  ADD COLUMN harness_version text NOT NULL
    CONSTRAINT factory_validations_harness_version CHECK (spend_is_identifier(harness_version)),
  ADD COLUMN copies integer NOT NULL CONSTRAINT factory_validations_copies CHECK (copies >= 3);

-- As in 0006, with the run's details. accepted_at is not compared on replay: a start retried
-- after its reservation replayed sends a later acceptance time, and the run keeps the first.
CREATE OR REPLACE FUNCTION factory_record_validation_body(p_request jsonb, p_now text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path FROM CURRENT AS $$
DECLARE
  r jsonb := p_request;
  v_now timestamptz := spend_parse_time(p_now);
  v_packages jsonb := p_request -> 'package_sha256';
  v_harness jsonb := p_request -> 'harness';
  v_err text;
  v_existing factory_validations%ROWTYPE;
BEGIN
  PERFORM spend_require_read_committed();
  IF v_now IS NULL THEN
    RETURN spend_invalid('now must be a UTC RFC3339 time ending in Z');
  END IF;
  v_err := coalesce(
    spend_keys_error(r, ARRAY['validation_id', 'request_id', 'case_id', 'root_execution_id', 'host_id', 'accepted_at',
                              'package_sha256', 'harness', 'copies']),
    spend_field_error(r, 'validation_id', 'uuid'),
    spend_field_error(r, 'request_id', 'uuid'),
    spend_field_error(r, 'case_id', 'hex64'),
    spend_field_error(r, 'root_execution_id', 'uuid'),
    spend_field_error(r, 'host_id', 'key'),
    spend_field_error(r, 'accepted_at', 'time'),
    CASE WHEN jsonb_typeof(v_packages) IS DISTINCT FROM 'object' THEN 'package_sha256 must be a JSON object' END,
    'package_sha256: ' || spend_keys_error(v_packages, ARRAY['bug_case', 'validator']),
    'package_sha256.' || spend_field_error(v_packages, 'bug_case', 'hex64'),
    'package_sha256.' || spend_field_error(v_packages, 'validator', 'hex64'),
    CASE WHEN jsonb_typeof(v_harness) IS DISTINCT FROM 'object' THEN 'harness must be a JSON object' END,
    'harness: ' || spend_keys_error(v_harness, ARRAY['name', 'version']),
    CASE WHEN spend_text(v_harness -> 'name') IS DISTINCT FROM 'rbw-validate' THEN 'harness.name must be rbw-validate' END,
    'harness.' || spend_field_error(v_harness, 'version', 'identifier'),
    factory_range_error(r, 'copies', 3, 2147483647)
  );
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;
  -- A validation ID is scoped to (request_id, case_id) and checked across every request. Its root
  -- takes the root lock of budget creation and validation reservations, so the root checks below
  -- see every concurrent claim on it, and two runs claiming one root get idempotency_conflict.
  PERFORM pg_advisory_xact_lock(hashtext('factory_validation'), hashtext(r ->> 'validation_id'));
  PERFORM pg_advisory_xact_lock(hashtext('spend_budget_root'), hashtext(r ->> 'root_execution_id'));
  SELECT * INTO v_existing FROM factory_validations WHERE validation_id = r ->> 'validation_id';
  IF FOUND THEN
    IF (v_existing.request_id, v_existing.case_id, v_existing.root_execution_id, v_existing.host_id,
        v_existing.bug_case_sha256, v_existing.validator_sha256, v_existing.harness_name, v_existing.harness_version,
        v_existing.copies)
       = (r ->> 'request_id', r ->> 'case_id', r ->> 'root_execution_id', r ->> 'host_id',
          v_packages ->> 'bug_case', v_packages ->> 'validator', v_harness ->> 'name', v_harness ->> 'version',
          (r ->> 'copies')::integer) THEN
      RETURN jsonb_build_object('ok', true, 'replay', true, 'recorded_at', factory_time(v_existing.recorded_at));
    END IF;
    RETURN spend_refusal('idempotency_conflict',
      'the validation ID is used with another request, case, root, host, package, harness or copy count');
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
  INSERT INTO factory_validations (validation_id, request_id, case_id, root_execution_id, host_id, accepted_at,
                                   bug_case_sha256, validator_sha256, harness_name, harness_version, copies, recorded_at)
  VALUES (r ->> 'validation_id', r ->> 'request_id', r ->> 'case_id', r ->> 'root_execution_id', r ->> 'host_id',
          spend_parse_time(r ->> 'accepted_at'), v_packages ->> 'bug_case', v_packages ->> 'validator',
          v_harness ->> 'name', v_harness ->> 'version', (r ->> 'copies')::integer, v_now);
  RETURN jsonb_build_object('ok', true, 'replay', false, 'recorded_at', factory_time(v_now));
END
$$;

CREATE OR REPLACE FUNCTION factory_validation_json(v factory_validations) RETURNS jsonb LANGUAGE sql STABLE
RETURN jsonb_build_object(
  'validation_id', v.validation_id, 'request_id', v.request_id, 'case_id', v.case_id,
  'root_execution_id', v.root_execution_id, 'recorded_at', factory_time(v.recorded_at),
  'last_heartbeat_at', factory_last_heartbeat(v.request_id, v.validation_id),
  'host_id', v.host_id, 'accepted_at', factory_time(v.accepted_at),
  'package_sha256', jsonb_build_object('bug_case', v.bug_case_sha256, 'validator', v.validator_sha256),
  'harness', jsonb_build_object('name', v.harness_name, 'version', v.harness_version),
  'copies', v.copies
);

-- As in 0006, with each event's key.
CREATE OR REPLACE FUNCTION factory_validation_read(p_request jsonb) RETURNS jsonb
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
  SELECT coalesce(jsonb_agg(jsonb_build_object('seq', e.seq, 'at', factory_time(e.recorded_at), 'event_key', e.event_key,
                                               'type', e.type, 'data', e.data) ORDER BY e.seq), '[]'::jsonb) INTO v_events
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

-- A request's events after `after`, at most `limit`, each as factory_request_read returns it plus
-- its event key. The function is STABLE, so the events and last_seq come from the calling
-- statement's one snapshot.
CREATE FUNCTION factory_request_events_read(p_request jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path FROM CURRENT AS $$
DECLARE
  r jsonb := p_request;
  v_err text := coalesce(
    spend_keys_error(r, ARRAY['request_id', 'after', 'limit']),
    spend_field_error(r, 'request_id', 'uuid'),
    spend_field_error(r, 'after', 'safe_int'),
    factory_range_error(r, 'limit', 1, 1000)
  );
  v_events jsonb;
BEGIN
  IF v_err IS NOT NULL THEN
    RETURN spend_invalid(v_err);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM factory_requests WHERE request_id = r ->> 'request_id') THEN
    RETURN spend_refusal('unknown_request');
  END IF;
  SELECT coalesce(jsonb_agg(e.doc ORDER BY e.seq), '[]'::jsonb) INTO v_events
  FROM (SELECT f.seq, factory_event_json(f) || jsonb_build_object('event_key', f.event_key) AS doc
        FROM factory_events f
        WHERE f.request_id = r ->> 'request_id' AND f.seq > (r ->> 'after')::bigint
        ORDER BY f.seq LIMIT (r ->> 'limit')::bigint) e;
  RETURN jsonb_build_object(
    'ok', true,
    'events', v_events,
    'next_after', coalesce((v_events -> -1 ->> 'seq')::bigint, (r ->> 'after')::bigint),
    'last_seq', coalesce((SELECT max(seq) FROM factory_events WHERE request_id = r ->> 'request_id'), 0)
  );
END
$$;

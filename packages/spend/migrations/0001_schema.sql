-- Spend pool and serial execution slot: tables, constraints and invariant triggers.
--
-- Forward-only. Names no schema: the migration runner sets search_path for the transaction,
-- and every PL/pgSQL function captures it with SET search_path FROM CURRENT, so callers never
-- depend on session state.
--
-- Every table is insert-only. Current state (operation state, slot holder, pool totals, halt)
-- is derived from the rows; nothing is ever updated, deleted or expired.

-- Format predicates ---------------------------------------------------------------------------

CREATE FUNCTION spend_is_hex64(p text) RETURNS boolean LANGUAGE sql IMMUTABLE
RETURN coalesce(p ~ '^[0-9a-f]{64}$', false);

CREATE FUNCTION spend_is_uuid(p text) RETURNS boolean LANGUAGE sql IMMUTABLE
RETURN coalesce(p ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false);

-- Pool, allocation and slot keys: lowercase letters, digits and hyphens.
CREATE FUNCTION spend_is_key(p text) RETURNS boolean LANGUAGE sql IMMUTABLE
RETURN coalesce(p ~ '^[a-z0-9][a-z0-9-]{0,63}$', false);

-- Service, kind, call name and provider labels.
CREATE FUNCTION spend_is_label(p text) RETURNS boolean LANGUAGE sql IMMUTABLE
RETURN coalesce(p ~ '^[a-z0-9._-]{1,64}$', false);

-- Role labels such as owner, operator or workflow; never a person's name or account.
CREATE FUNCTION spend_is_role(p text) RETURNS boolean LANGUAGE sql IMMUTABLE
RETURN coalesce(p ~ '^[a-z][a-z0-9_-]{0,63}$', false);

-- Identifiers chosen elsewhere (resource IDs, evidence keys, replay keys): no control characters.
CREATE FUNCTION spend_is_identifier(p text) RETURNS boolean LANGUAGE sql IMMUTABLE
RETURN coalesce(p ~ '^[^[:cntrl:]]+$' AND length(p) <= 512, false);

-- Free-text reasons: not blank, at most 2,000 characters.
CREATE FUNCTION spend_is_reason(p text) RETURNS boolean LANGUAGE sql IMMUTABLE
RETURN coalesce(btrim(p) <> '' AND length(p) <= 2000, false);

-- One evidence reference: exactly {key, sha256}. Never NULL: every malformed value, `{}` included, is false.
CREATE FUNCTION spend_is_evidence(p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path FROM CURRENT AS $$
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;
  IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['key', 'sha256'] THEN
    RETURN false;
  END IF;
  RETURN coalesce(
    jsonb_typeof(p -> 'key') = 'string' AND jsonb_typeof(p -> 'sha256') = 'string'
    AND spend_is_identifier(p ->> 'key') AND spend_is_hex64(p ->> 'sha256'),
    false);
END
$$;

-- A non-empty JSON array of evidence references; every element must be true.
CREATE FUNCTION spend_is_evidence_list(p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path FROM CURRENT AS $$
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'array' OR jsonb_array_length(p) = 0 THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p) e WHERE spend_is_evidence(e) IS NOT TRUE);
END
$$;

CREATE DOMAIN spend_hex64 AS text CHECK (VALUE IS NULL OR spend_is_hex64(VALUE));
CREATE DOMAIN spend_uuid AS text CHECK (VALUE IS NULL OR spend_is_uuid(VALUE));
CREATE DOMAIN spend_key AS text CHECK (VALUE IS NULL OR spend_is_key(VALUE));
CREATE DOMAIN spend_label AS text CHECK (VALUE IS NULL OR spend_is_label(VALUE));
CREATE DOMAIN spend_role AS text CHECK (VALUE IS NULL OR spend_is_role(VALUE));
-- Money (micro-USD) and quantities: integers from 0 to 2^53 - 1.
CREATE DOMAIN spend_safe_int AS bigint CHECK (VALUE IS NULL OR VALUE BETWEEN 0 AND 9007199254740991);

-- Orders every event; times are recorded but never used for ordering.
CREATE SEQUENCE spend_event_seq;

-- Guards --------------------------------------------------------------------------------------

CREATE FUNCTION spend_reject_change() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'table % is insert-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

-- Check-and-reserve relies on each statement seeing rows committed while it waited for a lock,
-- which only READ COMMITTED provides. Every operation refuses to run under another level.
CREATE FUNCTION spend_require_read_committed() RETURNS void
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'spend operations require READ COMMITTED isolation, not %',
      current_setting('transaction_isolation')
      USING ERRCODE = 'invalid_transaction_state';
  END IF;
END
$$;

-- Closed lists --------------------------------------------------------------------------------

CREATE TABLE units (
  unit text PRIMARY KEY CHECK (unit ~ '^[a-z][a-z0-9_]{0,63}$'),
  description text NOT NULL
);

INSERT INTO units (unit, description) VALUES
  ('input_token', 'Model input tokens'),
  ('output_token', 'Model output tokens'),
  ('call', 'Provider calls, retries included'),
  ('creation', 'Resource creations'),
  ('step', 'Agent or workflow steps'),
  ('operation', 'Provider operations billed per request'),
  ('credit', 'Provider credits'),
  ('vcpu_second', 'Compute: vCPU count times seconds'),
  ('memory_gb_second', 'Compute: memory in GB times seconds'),
  ('byte', 'Stored or transferred bytes'),
  ('allowance', 'One unit per fixed allowance (shutdown, hosting, storage, billing minimums)');

CREATE TABLE enforcement_methods (
  enforced_by text PRIMARY KEY CHECK (enforced_by ~ '^[a-z][a-z0-9_]{0,63}$'),
  description text NOT NULL
);

INSERT INTO enforcement_methods (enforced_by, description) VALUES
  ('request_parameter', 'A request parameter caps the quantity (for example a max token setting)'),
  ('client_counter', 'The caller counts and stops at the limit (for example calls and retries)'),
  ('provider_timeout', 'A provider-side timeout bounds the duration'),
  ('provider_quota', 'A provider-side quota or spend limit bounds the quantity'),
  ('fixed_allowance', 'A fixed amount set aside, not metered per unit');

-- Pools ---------------------------------------------------------------------------------------

CREATE TABLE pools (
  pool_key spend_key PRIMARY KEY,
  seq bigint NOT NULL UNIQUE DEFAULT nextval('spend_event_seq'),
  actor_role spend_role NOT NULL CHECK (actor_role = 'owner'),
  reason text NOT NULL CHECK (spend_is_reason(reason)),
  recorded_at timestamptz NOT NULL
);

CREATE TABLE pool_allocations (
  pool_key spend_key NOT NULL REFERENCES pools,
  allocation_key spend_key NOT NULL,
  initial_limit_microusd spend_safe_int NOT NULL,
  seq bigint NOT NULL UNIQUE DEFAULT nextval('spend_event_seq'),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (pool_key, allocation_key)
);

-- A pool's cap is the sum of its initial row and every raise. Nothing lowers or resets it.
CREATE TABLE pool_cap_changes (
  seq bigint PRIMARY KEY DEFAULT nextval('spend_event_seq'),
  pool_key spend_key NOT NULL REFERENCES pools,
  kind text NOT NULL CHECK (kind IN ('initial', 'raise')),
  amount_microusd spend_safe_int NOT NULL,
  actor_role spend_role NOT NULL CHECK (actor_role = 'owner'),
  reason text NOT NULL CHECK (spend_is_reason(reason)),
  recorded_at timestamptz NOT NULL,
  CHECK (kind = 'initial' OR amount_microusd > 0)
);

CREATE UNIQUE INDEX pool_cap_changes_one_initial ON pool_cap_changes (pool_key) WHERE kind = 'initial';

-- The only transfer that exists: public to judge in judge-demo.
CREATE TABLE allocation_transfers (
  seq bigint PRIMARY KEY DEFAULT nextval('spend_event_seq'),
  pool_key spend_key NOT NULL,
  from_allocation_key spend_key NOT NULL,
  to_allocation_key spend_key NOT NULL,
  amount_microusd spend_safe_int NOT NULL CHECK (amount_microusd > 0),
  actor_role spend_role NOT NULL CHECK (actor_role IN ('owner', 'operator')),
  reason text NOT NULL CHECK (spend_is_reason(reason)),
  recorded_at timestamptz NOT NULL,
  FOREIGN KEY (pool_key, from_allocation_key) REFERENCES pool_allocations,
  FOREIGN KEY (pool_key, to_allocation_key) REFERENCES pool_allocations,
  CONSTRAINT allocation_transfers_public_to_judge_only
    CHECK (pool_key = 'judge-demo' AND from_allocation_key = 'public' AND to_allocation_key = 'judge')
);

CREATE FUNCTION spend_pool_cap(p_pool text) RETURNS numeric LANGUAGE sql
BEGIN ATOMIC
  SELECT coalesce(sum(amount_microusd), 0) FROM pool_cap_changes WHERE pool_key = p_pool;
END;

CREATE FUNCTION spend_allocation_limit(p_pool text, p_allocation text) RETURNS numeric LANGUAGE sql
BEGIN ATOMIC
  SELECT a.initial_limit_microusd
    + coalesce((SELECT sum(t.amount_microusd) FROM allocation_transfers t
                WHERE t.pool_key = p_pool AND t.to_allocation_key = p_allocation), 0)
    - coalesce((SELECT sum(t.amount_microusd) FROM allocation_transfers t
                WHERE t.pool_key = p_pool AND t.from_allocation_key = p_allocation), 0)
  FROM pool_allocations a
  WHERE a.pool_key = p_pool AND a.allocation_key = p_allocation;
END;

-- Allocation limits always sum to the cap. Checked at commit, so a pool and its allocations
-- can be inserted in one transaction.
CREATE FUNCTION spend_check_allocation_sum() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  v_sum numeric;
BEGIN
  IF EXISTS (SELECT 1 FROM pool_allocations WHERE pool_key = NEW.pool_key) THEN
    SELECT sum(spend_allocation_limit(pool_key, allocation_key)) INTO v_sum
    FROM pool_allocations WHERE pool_key = NEW.pool_key;
    IF v_sum <> spend_pool_cap(NEW.pool_key) THEN
      RAISE EXCEPTION 'allocation limits of pool % must sum to its cap', NEW.pool_key
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER pool_allocations_sum_to_cap AFTER INSERT ON pool_allocations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION spend_check_allocation_sum();
CREATE CONSTRAINT TRIGGER pool_cap_changes_sum_to_cap AFTER INSERT ON pool_cap_changes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION spend_check_allocation_sum();
CREATE CONSTRAINT TRIGGER allocation_transfers_sum_to_cap AFTER INSERT ON allocation_transfers
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION spend_check_allocation_sum();

-- Execution slot keys -------------------------------------------------------------------------

CREATE TABLE execution_slot (
  slot_key spend_key PRIMARY KEY,
  seq bigint NOT NULL UNIQUE DEFAULT nextval('spend_event_seq'),
  actor_role spend_role NOT NULL CHECK (actor_role = 'owner'),
  reason text NOT NULL CHECK (spend_is_reason(reason)),
  recorded_at timestamptz NOT NULL
);

-- Operations ----------------------------------------------------------------------------------

-- Immutable intent of one metered call. Its state is derived from operation_events.
CREATE TABLE operations (
  operation_id spend_hex64 PRIMARY KEY,
  seq bigint NOT NULL UNIQUE DEFAULT nextval('spend_event_seq'),
  payload_hash spend_hex64 NOT NULL,
  attempt_ordinal bigint NOT NULL CHECK (attempt_ordinal BETWEEN 1 AND 9007199254740991),
  previous_operation_id spend_hex64 REFERENCES operations,
  project_id spend_uuid NOT NULL,
  project_policy_sha256 spend_hex64 NOT NULL,
  batch_id spend_uuid,
  task_revision spend_hex64 NOT NULL,
  root_execution_id spend_uuid NOT NULL,
  execution_id spend_uuid NOT NULL,
  parent_execution_id spend_uuid,
  kind spend_label NOT NULL,
  call_name spend_label NOT NULL,
  provider spend_label NOT NULL,
  provider_replay_key text CHECK (provider_replay_key IS NULL OR spend_is_identifier(provider_replay_key)),
  pool_key spend_key NOT NULL REFERENCES pools,
  allocation_key spend_key,
  runtime_profile_sha256 spend_hex64 NOT NULL,
  rate_sheet_sha256 spend_hex64 NOT NULL,
  worst_case_microusd spend_safe_int NOT NULL,
  -- The request as received, compared on replay.
  intent jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  FOREIGN KEY (pool_key, allocation_key) REFERENCES pool_allocations,
  CHECK ((attempt_ordinal = 1) = (previous_operation_id IS NULL)),
  CHECK ((execution_id = root_execution_id) = (parent_execution_id IS NULL))
);

CREATE INDEX operations_by_root ON operations (root_execution_id);

-- One line of the frozen, priced envelope.
CREATE TABLE operation_lines (
  operation_id spend_hex64 NOT NULL REFERENCES operations,
  line_no integer NOT NULL CHECK (line_no >= 1),
  service spend_label NOT NULL,
  unit text NOT NULL REFERENCES units,
  limit_quantity spend_safe_int NOT NULL,
  enforced_by text NOT NULL REFERENCES enforcement_methods,
  price_microusd spend_safe_int NOT NULL,
  price_per_units bigint NOT NULL CHECK (price_per_units BETWEEN 1 AND 9007199254740991),
  worst_case_microusd spend_safe_int NOT NULL,
  PRIMARY KEY (operation_id, line_no),
  UNIQUE (operation_id, service, unit),
  CONSTRAINT operation_lines_worst_case_rounds_up CHECK (
    worst_case_microusd = div(limit_quantity::numeric * price_microusd + price_per_units - 1, price_per_units)
  )
);

CREATE TABLE operation_events (
  seq bigint PRIMARY KEY DEFAULT nextval('spend_event_seq'),
  operation_id spend_hex64 NOT NULL REFERENCES operations,
  prior_seq bigint REFERENCES operation_events,
  from_state text NOT NULL,
  to_state text NOT NULL,
  cause text NOT NULL CHECK (cause IN ('transition', 'settlement', 'reconciliation')),
  slot_key spend_key REFERENCES execution_slot,
  provider_resource_id text CHECK (provider_resource_id IS NULL OR spend_is_identifier(provider_resource_id)),
  terminal_status text CHECK (terminal_status IN ('completed', 'failed', 'cancelled')),
  uncertainty text CHECK (uncertainty IN ('lost_response', 'unknown_status')),
  actor_role spend_role NOT NULL,
  recorded_at timestamptz NOT NULL,
  -- Each event follows exactly one predecessor, so concurrent writers cannot fork the history.
  CONSTRAINT operation_events_linear UNIQUE NULLS NOT DISTINCT (operation_id, prior_seq),
  CONSTRAINT operation_events_allowed CHECK ((from_state, to_state) IN (
    ('prepared', 'launching'),
    ('prepared', 'reconciled'),
    ('launching', 'running'),
    ('launching', 'terminal'),
    ('launching', 'uncertain'),
    ('launching', 'reconciled'),
    ('running', 'terminal'),
    ('running', 'uncertain'),
    ('running', 'reconciled'),
    ('uncertain', 'running'),
    ('uncertain', 'reconciled'),
    ('terminal', 'reconciled')
  )),
  CHECK ((to_state = 'launching') = (slot_key IS NOT NULL)),
  CHECK ((cause = 'transition' AND to_state = 'terminal') = (terminal_status IS NOT NULL)),
  CHECK ((to_state = 'uncertain') = (uncertainty IS NOT NULL)),
  CHECK ((cause = 'transition' AND to_state = 'running') = (provider_resource_id IS NOT NULL)),
  CHECK (cause = 'reconciliation' OR to_state <> 'reconciled' OR from_state = 'terminal'),
  CHECK (cause <> 'settlement' OR (from_state, to_state) = ('terminal', 'reconciled'))
);

-- An operation enters launching at most once, ever.
CREATE UNIQUE INDEX operation_events_launch_once ON operation_events (operation_id) WHERE to_state = 'launching';
CREATE INDEX operation_events_by_operation ON operation_events (operation_id, seq);

CREATE FUNCTION spend_operation_last_event(p_operation text) RETURNS bigint LANGUAGE sql
BEGIN ATOMIC
  SELECT max(seq) FROM operation_events WHERE operation_id = p_operation;
END;

CREATE FUNCTION spend_operation_state(p_operation text) RETURNS text LANGUAGE sql
BEGIN ATOMIC
  SELECT coalesce(
    (SELECT to_state FROM operation_events WHERE operation_id = p_operation ORDER BY seq DESC LIMIT 1),
    'prepared'
  );
END;

-- A state event must start from the operation's current state and follow its latest event.
CREATE FUNCTION spend_check_operation_event() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.prior_seq IS DISTINCT FROM spend_operation_last_event(NEW.operation_id) THEN
    RAISE EXCEPTION 'state event for % does not follow its latest event', NEW.operation_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.from_state <> spend_operation_state(NEW.operation_id) THEN
    RAISE EXCEPTION 'operation % is not in state %', NEW.operation_id, NEW.from_state
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER operation_events_follow_state BEFORE INSERT ON operation_events
  FOR EACH ROW EXECUTE FUNCTION spend_check_operation_event();

-- A reservation against a pool with allocations names exactly one of them; otherwise none.
-- A later attempt needs its predecessor (one ordinal lower) to be terminal or reconciled.
CREATE FUNCTION spend_check_operation() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pool_allocations WHERE pool_key = NEW.pool_key) <> (NEW.allocation_key IS NOT NULL) THEN
    RAISE EXCEPTION 'operation % must name an allocation exactly when its pool has allocations', NEW.operation_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.attempt_ordinal > 1 AND NOT EXISTS (
    SELECT 1 FROM operations p
    WHERE p.operation_id = NEW.previous_operation_id
      AND p.attempt_ordinal = NEW.attempt_ordinal - 1
      AND spend_operation_state(p.operation_id) IN ('terminal', 'reconciled')
  ) THEN
    RAISE EXCEPTION 'previous attempt of operation % is unresolved', NEW.operation_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER operations_check BEFORE INSERT ON operations
  FOR EACH ROW EXECUTE FUNCTION spend_check_operation();

-- The spend ledger ----------------------------------------------------------------------------
--
-- reserve: opens the whole worst case (open += amount)
-- close:   ends part of the open amount (open -= amount)
-- settle:  records spend (settled += amount)
-- release: the part of a close returned to the pool (reporting only; release <= close)
--
-- committed = settled + open; available = cap (or allocation limit) - committed.
CREATE TABLE spend (
  seq bigint PRIMARY KEY DEFAULT nextval('spend_event_seq'),
  operation_id spend_hex64 NOT NULL REFERENCES operations,
  pool_key spend_key NOT NULL REFERENCES pools,
  allocation_key spend_key,
  kind text NOT NULL CHECK (kind IN ('reserve', 'close', 'settle', 'release')),
  amount_microusd spend_safe_int NOT NULL,
  source text NOT NULL CHECK (source IN ('reservation', 'settlement', 'reconciliation')),
  recorded_at timestamptz NOT NULL,
  CHECK ((kind = 'reserve') = (source = 'reservation'))
);

CREATE UNIQUE INDEX spend_one_reservation ON spend (operation_id) WHERE kind = 'reserve';
CREATE INDEX spend_by_pool ON spend (pool_key, allocation_key);
CREATE INDEX spend_by_operation ON spend (operation_id);

CREATE FUNCTION spend_check_ledger_row() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  v_operation operations%ROWTYPE;
BEGIN
  SELECT * INTO v_operation FROM operations WHERE operation_id = NEW.operation_id;
  IF NEW.pool_key <> v_operation.pool_key OR NEW.allocation_key IS DISTINCT FROM v_operation.allocation_key THEN
    RAISE EXCEPTION 'ledger row for % must use the operation''s pool and allocation', NEW.operation_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind = 'reserve' AND NEW.amount_microusd <> v_operation.worst_case_microusd THEN
    RAISE EXCEPTION 'reservation for % must equal its worst case', NEW.operation_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER spend_ledger_row BEFORE INSERT ON spend
  FOR EACH ROW EXECUTE FUNCTION spend_check_ledger_row();

CREATE FUNCTION spend_operation_totals(
  p_operation text,
  OUT reserved numeric, OUT closed numeric, OUT settled numeric, OUT released numeric
) LANGUAGE sql
BEGIN ATOMIC
  SELECT coalesce(sum(amount_microusd) FILTER (WHERE kind = 'reserve'), 0),
         coalesce(sum(amount_microusd) FILTER (WHERE kind = 'close'), 0),
         coalesce(sum(amount_microusd) FILTER (WHERE kind = 'settle'), 0),
         coalesce(sum(amount_microusd) FILTER (WHERE kind = 'release'), 0)
  FROM spend WHERE operation_id = p_operation;
END;

-- Per operation: nothing closes more than was reserved, and nothing releases more than closed.
CREATE FUNCTION spend_check_operation_ledger() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  v record;
BEGIN
  SELECT * INTO v FROM spend_operation_totals(NEW.operation_id);
  IF v.closed > v.reserved OR v.released > v.closed THEN
    RAISE EXCEPTION 'ledger for operation % closes or releases more than it reserved', NEW.operation_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM spend WHERE operation_id = NEW.operation_id AND kind = 'reserve') THEN
    RAISE EXCEPTION 'operation % has no reservation', NEW.operation_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER spend_operation_ledger AFTER INSERT ON spend
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION spend_check_operation_ledger();

-- An operation's worst case is the sum of its lines, and it has exactly one reservation.
CREATE FUNCTION spend_check_operation_envelope() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.worst_case_microusd <> (
    SELECT coalesce(sum(worst_case_microusd), -1) FROM operation_lines WHERE operation_id = NEW.operation_id
  ) THEN
    RAISE EXCEPTION 'worst case of operation % must equal the sum of its lines', NEW.operation_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM spend WHERE operation_id = NEW.operation_id AND kind = 'reserve') THEN
    RAISE EXCEPTION 'operation % has no reservation', NEW.operation_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER operations_envelope AFTER INSERT ON operations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION spend_check_operation_envelope();

CREATE FUNCTION spend_pool_totals(
  p_pool text, p_allocation text,
  OUT settled numeric, OUT open numeric
) LANGUAGE sql
BEGIN ATOMIC
  SELECT coalesce(sum(amount_microusd) FILTER (WHERE kind = 'settle'), 0),
         coalesce(sum(amount_microusd) FILTER (WHERE kind = 'reserve'), 0)
           - coalesce(sum(amount_microusd) FILTER (WHERE kind = 'close'), 0)
  FROM spend
  WHERE pool_key = p_pool AND (p_allocation IS NULL OR allocation_key = p_allocation);
END;

-- Available amount of a pool (p_allocation NULL) or of one allocation. May be negative.
CREATE FUNCTION spend_available(p_pool text, p_allocation text) RETURNS numeric LANGUAGE sql
BEGIN ATOMIC
  SELECT CASE WHEN p_allocation IS NULL THEN spend_pool_cap(p_pool)
              ELSE spend_allocation_limit(p_pool, p_allocation) END
         - t.settled - t.open
  FROM spend_pool_totals(p_pool, p_allocation) t;
END;

CREATE TABLE settlements (
  operation_id spend_hex64 PRIMARY KEY REFERENCES operations,
  seq bigint NOT NULL UNIQUE DEFAULT nextval('spend_event_seq'),
  content jsonb NOT NULL,
  usage_state text NOT NULL CHECK (usage_state IN ('known', 'partly_unknown', 'unknown')),
  settled_microusd bigint NOT NULL CHECK (settled_microusd >= 0),
  retained_microusd bigint NOT NULL CHECK (retained_microusd >= 0),
  released_microusd bigint NOT NULL CHECK (released_microusd >= 0),
  over_envelope boolean NOT NULL,
  recorded_at timestamptz NOT NULL
);

CREATE TABLE reconciliations (
  seq bigint PRIMARY KEY DEFAULT nextval('spend_event_seq'),
  operation_id spend_hex64 NOT NULL REFERENCES operations,
  previous_state text NOT NULL,
  decision text NOT NULL,
  evidence jsonb NOT NULL CHECK (spend_is_evidence_list(evidence)),
  provider_resource_ids jsonb NOT NULL CHECK (jsonb_typeof(provider_resource_ids) = 'array'),
  -- The time the operator gives in the record; logged_at is the event time.
  recorded_at timestamptz NOT NULL,
  actor_role spend_role NOT NULL CHECK (actor_role IN ('owner', 'operator')),
  open_microusd bigint NOT NULL CHECK (open_microusd >= 0),
  retained_microusd spend_safe_int NOT NULL,
  released_microusd spend_safe_int NOT NULL,
  over_envelope boolean NOT NULL,
  reason text NOT NULL CHECK (spend_is_reason(reason)),
  content jsonb NOT NULL,
  logged_at timestamptz NOT NULL,
  CONSTRAINT reconciliations_decision_state CHECK ((decision, previous_state) IN (
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
  )),
  CONSTRAINT reconciliations_money CHECK (CASE
    WHEN decision = 'found_running' THEN retained_microusd = open_microusd AND released_microusd = 0
    ELSE (retained_microusd + released_microusd = open_microusd AND NOT over_envelope)
      OR (released_microusd = 0 AND retained_microusd > open_microusd AND over_envelope)
  END)
);

-- Refused reservations, so a report can say why work stopped.
CREATE TABLE reservation_refusals (
  seq bigint PRIMARY KEY DEFAULT nextval('spend_event_seq'),
  operation_id spend_hex64 NOT NULL,
  pool_key spend_key NOT NULL REFERENCES pools,
  allocation_key spend_key,
  code text NOT NULL CHECK (code IN ('insufficient_funds', 'pool_halted')),
  requested_microusd spend_safe_int NOT NULL,
  pool_available_microusd bigint NOT NULL,
  allocation_available_microusd bigint,
  recorded_at timestamptz NOT NULL
);

-- Over-envelope observations and resumes ------------------------------------------------------
--
-- New work is halted while any observation is newer, by sequence, than the latest resume.
CREATE TABLE halt_observations (
  seq bigint PRIMARY KEY DEFAULT nextval('spend_event_seq'),
  operation_id spend_hex64 NOT NULL REFERENCES operations,
  pool_key spend_key NOT NULL REFERENCES pools,
  source text NOT NULL CHECK (source IN ('settlement', 'reconciliation')),
  service spend_label,
  unit text REFERENCES units,
  measure text NOT NULL CHECK (measure IN ('microusd', 'quantity')),
  observed bigint NOT NULL,
  bound bigint NOT NULL,
  recorded_at timestamptz NOT NULL,
  CHECK (observed > bound)
);

CREATE TABLE halt_resumes (
  seq bigint PRIMARY KEY DEFAULT nextval('spend_event_seq'),
  actor_role spend_role NOT NULL CHECK (actor_role IN ('owner', 'operator')),
  evidence jsonb NOT NULL CHECK (spend_is_evidence_list(evidence)),
  reason text NOT NULL CHECK (spend_is_reason(reason)),
  recorded_at timestamptz NOT NULL
);

CREATE FUNCTION spend_halted() RETURNS boolean LANGUAGE sql
BEGIN ATOMIC
  SELECT coalesce((SELECT max(seq) FROM halt_observations), 0)
       > coalesce((SELECT max(seq) FROM halt_resumes), 0);
END;

CREATE FUNCTION spend_check_resume() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NOT spend_halted() THEN
    RAISE EXCEPTION 'nothing is halted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER halt_resumes_only_when_halted BEFORE INSERT ON halt_resumes
  FOR EACH ROW EXECUTE FUNCTION spend_check_resume();

-- Slot events and child resources -------------------------------------------------------------

CREATE TABLE slot_events (
  seq bigint PRIMARY KEY DEFAULT nextval('spend_event_seq'),
  slot_key spend_key NOT NULL REFERENCES execution_slot,
  prior_seq bigint REFERENCES slot_events,
  kind text NOT NULL CHECK (kind IN ('acquire', 'release')),
  root_execution_id spend_uuid NOT NULL,
  actor_role spend_role NOT NULL,
  evidence jsonb CHECK (evidence IS NULL OR spend_is_evidence_list(evidence)),
  reason text CHECK (reason IS NULL OR spend_is_reason(reason)),
  recorded_at timestamptz NOT NULL,
  CONSTRAINT slot_events_linear UNIQUE NULLS NOT DISTINCT (slot_key, prior_seq),
  CHECK (kind = 'release' OR (evidence IS NULL AND reason IS NULL)),
  CHECK (kind = 'acquire' OR actor_role NOT IN ('owner', 'operator') OR (evidence IS NOT NULL AND reason IS NOT NULL))
);

CREATE INDEX slot_events_by_slot ON slot_events (slot_key, seq);

CREATE TABLE slot_children (
  seq bigint PRIMARY KEY DEFAULT nextval('spend_event_seq'),
  slot_key spend_key NOT NULL REFERENCES execution_slot,
  root_execution_id spend_uuid NOT NULL,
  provider spend_label NOT NULL,
  resource_id text NOT NULL CHECK (spend_is_identifier(resource_id)),
  operation_id spend_hex64 REFERENCES operations,
  execution_id spend_uuid,
  kind spend_label NOT NULL,
  source text NOT NULL CHECK (source IN ('holder', 'transition', 'reconciliation')),
  actor_role spend_role NOT NULL,
  recorded_at timestamptz NOT NULL,
  UNIQUE (root_execution_id, provider, resource_id)
);

CREATE INDEX slot_children_by_operation ON slot_children (operation_id);

CREATE TABLE slot_child_confirmations (
  seq bigint PRIMARY KEY DEFAULT nextval('spend_event_seq'),
  child_seq bigint NOT NULL UNIQUE REFERENCES slot_children,
  terminal_status text CHECK (terminal_status IN ('completed', 'failed', 'cancelled')),
  evidence jsonb CHECK (evidence IS NULL OR spend_is_evidence_list(evidence)),
  source text NOT NULL CHECK (source IN ('holder', 'transition', 'reconciliation')),
  actor_role spend_role NOT NULL,
  recorded_at timestamptz NOT NULL,
  CHECK (source = 'reconciliation' OR terminal_status IS NOT NULL),
  CHECK (source = 'transition' OR evidence IS NOT NULL)
);

CREATE FUNCTION spend_slot_last_event(p_slot text) RETURNS bigint LANGUAGE sql
BEGIN ATOMIC
  SELECT max(seq) FROM slot_events WHERE slot_key = p_slot;
END;

CREATE FUNCTION spend_slot_holder(p_slot text) RETURNS text LANGUAGE sql
BEGIN ATOMIC
  SELECT CASE WHEN kind = 'acquire' THEN root_execution_id END
  FROM slot_events WHERE slot_key = p_slot ORDER BY seq DESC LIMIT 1;
END;

-- What stops a root from releasing a slot: unconfirmed child resources and unresolved operations.
CREATE FUNCTION spend_slot_blockers(p_slot text, p_root text) RETURNS jsonb LANGUAGE sql
BEGIN ATOMIC
  SELECT jsonb_build_object(
    'child_resources', coalesce((
      SELECT jsonb_agg(jsonb_build_object('provider', c.provider, 'resource_id', c.resource_id) ORDER BY c.seq)
      FROM slot_children c
      WHERE c.slot_key = p_slot AND c.root_execution_id = p_root
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

-- At most one holder per slot key, and a release only by the holder with nothing blocking it.
CREATE FUNCTION spend_check_slot_event() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  v_holder text := spend_slot_holder(NEW.slot_key);
  v_blockers jsonb;
BEGIN
  IF NEW.prior_seq IS DISTINCT FROM spend_slot_last_event(NEW.slot_key) THEN
    RAISE EXCEPTION 'slot event for % does not follow its latest event', NEW.slot_key
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind = 'acquire' AND v_holder IS NOT NULL THEN
    RAISE EXCEPTION 'slot % is already held', NEW.slot_key USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind = 'release' THEN
    IF v_holder IS DISTINCT FROM NEW.root_execution_id THEN
      RAISE EXCEPTION 'slot % is not held by the releasing root', NEW.slot_key USING ERRCODE = 'check_violation';
    END IF;
    v_blockers := spend_slot_blockers(NEW.slot_key, NEW.root_execution_id);
    IF jsonb_array_length(v_blockers -> 'child_resources') > 0 OR jsonb_array_length(v_blockers -> 'operation_ids') > 0 THEN
      RAISE EXCEPTION 'slot % release is blocked', NEW.slot_key USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER slot_events_single_holder BEFORE INSERT ON slot_events
  FOR EACH ROW EXECUTE FUNCTION spend_check_slot_event();

-- Children are recorded under a held slot. Reconciliation may record resources it confirms
-- after the root has released the slot.
CREATE FUNCTION spend_check_slot_child() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.source <> 'reconciliation' AND spend_slot_holder(NEW.slot_key) IS DISTINCT FROM NEW.root_execution_id THEN
    RAISE EXCEPTION 'slot % is not held by root %', NEW.slot_key, NEW.root_execution_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER slot_children_under_held_slot BEFORE INSERT ON slot_children
  FOR EACH ROW EXECUTE FUNCTION spend_check_slot_child();

-- Insert-only enforcement on every table ------------------------------------------------------

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
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION spend_reject_change()',
      v_table || '_insert_only', v_table
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION spend_reject_change()',
      v_table || '_no_truncate', v_table
    );
  END LOOP;
END
$$;

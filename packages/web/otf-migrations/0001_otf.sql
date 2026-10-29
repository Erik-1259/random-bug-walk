-- On-the-fly bug creation (OTF): the jobs, their events, the delivered bundles, validations, the
-- builder heartbeat and the builder machine's single power row. Everything lives in the schema
-- `otf`, apart from the spend ledger: no table, function or grant of the ledger is read or changed
-- here. An operator applies this file once per environment; it is idempotent, so applying it again
-- changes nothing. src/otf/store.ts is the only code that reads or writes these tables.

CREATE SCHEMA IF NOT EXISTS otf;

CREATE TABLE IF NOT EXISTS otf.jobs (
  job_id uuid PRIMARY KEY,
  client_key uuid NOT NULL UNIQUE,
  create_sha256 text NOT NULL CHECK (create_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  host_id text NOT NULL CHECK (host_id IN ('task-report', 'umami')),
  criterion_id text NOT NULL,
  sentence text NOT NULL,
  spec jsonb NOT NULL,
  spec_sha256 text NOT NULL CHECK (spec_sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('queued', 'starting_builder', 'building', 'finished')),
  outcome text CHECK (outcome IN ('delivered', 'not_qualified', 'time_limit', 'spend_limit', 'cancelled', 'builder_start_failed', 'builder_unavailable', 'builder_lost', 'error')),
  reason text,
  claimed_by text,
  claimed_at timestamptz,
  lease_until timestamptz,
  deadline_at timestamptz,
  last_builder_post_at timestamptz,
  stop_requested_at timestamptz,
  stop_reason text CHECK (stop_reason IN ('customer', 'deadline', 'spend_cap')),
  winner_lane text,
  winner_model text,
  model_microusd bigint NOT NULL DEFAULT 0 CHECK (model_microusd >= 0),
  catalog_request_id uuid,
  certificate jsonb,
  finished_at timestamptz,
  -- The last public event seq and the last builder_seq stored for this job.
  last_seq integer NOT NULL DEFAULT 0,
  last_builder_seq integer NOT NULL DEFAULT 0,
  CHECK ((state = 'finished') = (outcome IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS jobs_state_created ON otf.jobs (state, created_at);
CREATE INDEX IF NOT EXISTS jobs_state_host ON otf.jobs (state, host_id, created_at);
CREATE INDEX IF NOT EXISTS jobs_created ON otf.jobs (created_at);

CREATE TABLE IF NOT EXISTS otf.events (
  job_id uuid NOT NULL REFERENCES otf.jobs (job_id),
  seq integer NOT NULL CHECK (seq >= 1),
  -- The event time as posted (ISO 8601 UTC), kept as text so it reads back unchanged.
  at text NOT NULL,
  lane_id text,
  type text NOT NULL,
  data jsonb NOT NULL,
  -- Builder events only: the builder's own counter and the canonical bytes a repeat is compared by.
  builder_seq integer,
  builder_bytes text,
  PRIMARY KEY (job_id, seq),
  UNIQUE (job_id, builder_seq),
  CHECK ((builder_seq IS NULL) = (builder_bytes IS NULL))
);

CREATE TABLE IF NOT EXISTS otf.artifacts (
  job_id uuid NOT NULL REFERENCES otf.jobs (job_id),
  part text NOT NULL CHECK (part IN ('agent', 'grader', 'certificate')),
  filename text NOT NULL,
  media_type text NOT NULL CHECK (media_type IN ('application/gzip', 'application/json')),
  size integer NOT NULL CHECK (size >= 1 AND size <= 2097152),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes bytea NOT NULL,
  PRIMARY KEY (job_id, part),
  CHECK (octet_length(bytes) = size)
);

CREATE TABLE IF NOT EXISTS otf.validations (
  validation_id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES otf.jobs (job_id),
  state text NOT NULL CHECK (state IN ('queued', 'running', 'passed', 'failed', 'error')),
  cells jsonb,
  -- Admission hosts (Umami): the validation's admission result; null on tier-B hosts and while open.
  admission jsonb,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  claimed_by text
);
CREATE INDEX IF NOT EXISTS validations_job ON otf.validations (job_id, started_at);
CREATE INDEX IF NOT EXISTS validations_state ON otf.validations (state, started_at);

CREATE TABLE IF NOT EXISTS otf.builders (
  builder_id text PRIMARY KEY,
  builder_revision text NOT NULL,
  boot_id text NOT NULL,
  booted_at text NOT NULL,
  -- The hosts the last heartbeat (ClaimRequest.ready_hosts) said this boot can build.
  ready_hosts text[] NOT NULL DEFAULT '{}',
  last_seen_at timestamptz NOT NULL
);

-- The builder machine's power row: exactly one, id 1. hold_until is set by an operator script only.
CREATE TABLE IF NOT EXISTS otf.power (
  id integer PRIMARY KEY CHECK (id = 1),
  state text NOT NULL CHECK (state IN ('running', 'starting', 'stopped', 'stopping', 'unknown')),
  since timestamptz NOT NULL,
  preset text,
  instance_state text CHECK (instance_state IN ('RUNNING', 'STOPPED', 'STARTING', 'STOPPING', 'OTHER')),
  last_api_call_at timestamptz,
  last_start_at timestamptz,
  last_stop_at timestamptz,
  start_failures integer NOT NULL DEFAULT 0 CHECK (start_failures >= 0),
  running_since timestamptz,
  last_job_finished_at timestamptz,
  vm_seconds_today integer NOT NULL DEFAULT 0 CHECK (vm_seconds_today >= 0),
  vm_day date NOT NULL,
  hold_until timestamptz
);
INSERT INTO otf.power (id, state, since, vm_day)
VALUES (1, 'unknown', now(), (now() AT TIME ZONE 'UTC')::date)
ON CONFLICT (id) DO NOTHING;

-- Every power action production takes or allows, for the operator's machine log after judging.
CREATE TABLE IF NOT EXISTS otf.power_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL,
  actor text NOT NULL CHECK (actor IN ('create', 'watchdog', 'builder', 'operator')),
  action text NOT NULL CHECK (action IN ('start', 'stop', 'get')),
  before text,
  after text,
  operation_id text
);

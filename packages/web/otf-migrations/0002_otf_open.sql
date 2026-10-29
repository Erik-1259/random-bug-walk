-- On-the-fly open behaviors (docs/otf/SPEC.md section 8): the rule an open-criterion job is graded
-- by. Additive and idempotent: apply it after 0001_otf.sql, once per environment; applying it again
-- changes nothing. The column stays null on every proven-criterion job, including all existing rows.

ALTER TABLE otf.jobs ADD COLUMN IF NOT EXISTS rule jsonb;

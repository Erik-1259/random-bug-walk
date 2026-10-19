CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  note  text NOT NULL DEFAULT '' CHECK (char_length(note) <= 10000),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now());
CREATE TABLE completions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  completed_at timestamptz(3) NOT NULL);
CREATE INDEX completions_completed_at_idx ON completions (completed_at);
CREATE INDEX completions_task_id_idx ON completions (task_id);
-- schema_migrations(version text PK, sha256 char(64), applied_at timestamptz) is managed by the migrator

GRANT SELECT, INSERT, UPDATE, DELETE ON tasks, completions TO taskapp_app;
GRANT SELECT ON schema_migrations TO taskapp_app;

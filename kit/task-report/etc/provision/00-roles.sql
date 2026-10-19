-- Provisioning of one fresh instance before the app's own migration, run by the copy driver as the
-- superuser through the Unix socket, connected to database postgres. Adapted from the custom host
-- harness at baseline 2: the same roles and database; the owner and gate roles get no password
-- because they connect only through the socket, which the app user cannot reach.
--
-- taskapp_owner  owns database taskapp; runs the app's migration.
-- taskapp_app    the only role the running app uses (its privileges come from the app's migration).
-- taskapp_gate   the row-lock gate's role; 10-after-migrate.sql grants it SELECT and UPDATE on
--                tasks. It is not the app role, and the app role cannot end its session.

CREATE ROLE taskapp_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE taskapp_app LOGIN PASSWORD 'synthetic-taskapp-app-password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE taskapp_gate LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;

CREATE DATABASE taskapp OWNER taskapp_owner;
REVOKE ALL ON DATABASE taskapp FROM PUBLIC;
GRANT CONNECT ON DATABASE taskapp TO taskapp_app, taskapp_gate;

-- The app role must not be able to signal (cancel or terminate) another role's backend, the
-- gate's included.
DO $$
BEGIN
  IF pg_has_role('taskapp_app', 'pg_signal_backend', 'MEMBER') THEN
    RAISE EXCEPTION 'provision: taskapp_app is a member of pg_signal_backend';
  END IF;
END
$$;

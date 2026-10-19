-- Provisioning after the app's own migration, run by the copy driver as the superuser, connected
-- to database taskapp. The gate holds SELECT ... FOR UPDATE on task rows, which needs UPDATE as
-- well as SELECT. It never writes.
GRANT SELECT, UPDATE ON tasks TO taskapp_gate;

-- Roles and database, run once by rbw-db-init as the bootstrap superuser.
-- umami_owner owns the schema and runs migrations and fixture resets.
-- umami_app is what Umami connects as: data access only.
CREATE ROLE umami_owner LOGIN NOSUPERUSER CREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE umami_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-umami-app-password';
CREATE DATABASE umami OWNER umami_owner TEMPLATE template0 ENCODING 'UTF8' LOCALE 'C';
REVOKE ALL ON DATABASE umami FROM PUBLIC;
GRANT CONNECT ON DATABASE umami TO umami_app;
\connect umami
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO umami_app;
ALTER DEFAULT PRIVILEGES FOR ROLE umami_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO umami_app;
ALTER DEFAULT PRIVILEGES FOR ROLE umami_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO umami_app;

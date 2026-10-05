-- Run after migrations: the app role may read the migration history but not change it.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON _prisma_migrations FROM umami_app;

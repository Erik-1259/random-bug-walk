-- Seeded pools. Caps and allocation limits are integer micro-USD (1 USD = 1,000,000).

INSERT INTO pools (pool_key, actor_role, reason, recorded_at) VALUES
  ('development', 'owner', 'seeded by migration', now()),
  ('judge-demo', 'owner', 'seeded by migration', now());

INSERT INTO pool_cap_changes (pool_key, kind, amount_microusd, actor_role, reason, recorded_at) VALUES
  ('development', 'initial', 1000000000, 'owner', 'seeded by migration', now()),
  ('judge-demo', 'initial', 200000000, 'owner', 'seeded by migration', now());

INSERT INTO pool_allocations (pool_key, allocation_key, initial_limit_microusd, recorded_at) VALUES
  -- Anonymous use.
  ('judge-demo', 'public', 50000000, now()),
  -- Protected for judges.
  ('judge-demo', 'judge', 150000000, now());

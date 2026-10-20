import { log } from './log.ts';

type ServiceConfig = {
  host: string;
  port: number;
  poolMax: number;
  databaseUrl: string;
};

function fail(variable: string): never {
  log('error', 'config_error', { variable });
  process.exit(1);
}

function integer(variable: string, fallback: number, min: number, max: number): number {
  const raw = process.env[variable];
  if (raw === undefined) return fallback;
  if (!/^\d{1,9}$/.test(raw)) fail(variable);
  const value = Number(raw);
  if (value < min || value > max) fail(variable);
  return value;
}

function url(variable: string): string {
  const raw = process.env[variable];
  if (raw === undefined || !URL.canParse(raw)) fail(variable);
  return raw;
}

export function loadServiceConfig(): ServiceConfig {
  const host = process.env.HOST ?? '127.0.0.1';
  if (host === '') fail('HOST');
  return {
    host,
    port: integer('PORT', 3000, 1, 65535),
    poolMax: integer('DB_POOL_MAX', 10, 2, 100),
    databaseUrl: url('DATABASE_URL'),
  };
}

export function loadMigrationUrl(command: string | undefined): { command: 'apply' | 'verify'; databaseUrl: string } {
  if (command === 'apply') return { command, databaseUrl: url('MIGRATION_DATABASE_URL') };
  if (command === 'verify') return { command, databaseUrl: url('DATABASE_URL') };
  return fail('command');
}

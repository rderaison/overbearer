import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pool: pg.Pool;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      host: process.env.PGHOST || 'localhost',
      port: parseInt(process.env.PGPORT || '5432'),
      database: process.env.PGDATABASE || 'overbearer',
      user: process.env.PGUSER || 'overbearer',
      password: process.env.PGPASSWORD || 'overbearer',
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }
  return pool;
}

export async function initDatabase(): Promise<void> {
  const db = getPool();
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  await db.query(schema);
}

export async function query<T extends pg.QueryResultRow = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params);
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
  }
}

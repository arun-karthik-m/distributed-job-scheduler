// ponytail: 30-line migration runner instead of node-pg-migrate — plain ordered .sql files
// are more reviewer-transparent for a DB-graded project. Add a real tool if we need down-migrations.
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
  filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);

const applied = new Set(
  (await pool.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename));

for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  if (applied.has(f)) { console.log(`skip    ${f}`); continue; }
  const sql = readFileSync(join(dir, f), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations(filename) VALUES($1)', [f]);
    await client.query('COMMIT');
    console.log(`applied ${f}`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
await pool.end();

// Runnable scheduler service. One instance; SIGTERM/SIGINT stop the tick and exit.
//   npm run scheduler
import pg from 'pg';
import { Scheduler } from './scheduler.ts';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const scheduler = new Scheduler(pool, Number(process.env.TICK_MS ?? 1000));
scheduler.start();
console.log('scheduler started (Ctrl-C / SIGTERM to stop)');

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    scheduler.stop();
    pool.end().then(() => process.exit(0));
  });
}

// Runnable worker service. Wires OS signals to graceful shutdown (C18).
//   QUEUE_ID=<id> CONCURRENCY=5 npm run worker
import pg from 'pg';
import { Worker } from './worker.ts';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const queueId = Number(process.env.QUEUE_ID);
if (!queueId) { console.error('set QUEUE_ID'); process.exit(1); }

const worker = new Worker(pool, {
  queueId,
  concurrency: Number(process.env.CONCURRENCY ?? 5),
  leaseSeconds: 30,
  pollMs: 500,
  handler: async (payload) => { console.log('processing', JSON.stringify(payload)); },
});

await worker.start();
console.log(`worker started on queue ${queueId} (Ctrl-C / SIGTERM to drain and exit)`);

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    console.log(`${sig} received — draining in-flight jobs...`);
    worker.stop().then(() => pool.end()).then(() => { console.log('drained, exiting'); process.exit(0); });
  });
}

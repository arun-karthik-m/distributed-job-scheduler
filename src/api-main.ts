// Runnable API server.  npm run api
import pg from 'pg';
import { buildApp } from './api.ts';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = buildApp(pool, { logger: true });   // pino request logging (B7)

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '0.0.0.0' });

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => { app.close().then(() => pool.end()).then(() => process.exit(0)); });
}

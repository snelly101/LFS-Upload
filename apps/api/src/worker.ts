import { createContext } from './bootstrap.js';
import { Worker } from './worker/run.js';

async function main() {
  const ctx = await createContext();
  const worker = new Worker(ctx);
  const shutdown = () => {
    worker.stop();
    setTimeout(() => process.exit(0), 15_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  await worker.start();
  await ctx.db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext } from './bootstrap.js';
import { buildApp } from './app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const ctx = await createContext();
  const webDist = process.env.WEB_DIST ?? path.resolve(here, '../../web/dist');
  const app = await buildApp(ctx, { serveWeb: webDist });
  await app.listen({ port: ctx.config.PORT, host: ctx.config.HOST });
  ctx.log.info({ url: ctx.config.publicUrl.toString(), port: ctx.config.PORT }, 'api listening');
  const shutdown = async () => {
    ctx.log.info('shutting down');
    await app.close();
    await ctx.db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

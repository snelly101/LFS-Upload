import { createContext } from './bootstrap.js';
import { migrate } from './migrate.js';
import { hashPassword, passwordProblems } from './auth/passwords.js';
import { audit } from './lib/audit.js';
import { randomToken, sha256 } from './lib/crypto.js';
import { seedDevelopment } from './seed.js';

/**
 * CLI: migrate | bootstrap-admin <email> | seed
 * bootstrap-admin creates the first administrator ONLY when no admin exists. It prints a one-time
 * invitation link (no default credentials are ever shipped); the admin sets a password and MFA via that link.
 */
async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const ctx = await createContext({ runMigrations: cmd !== 'migrate' });
  try {
    switch (cmd) {
      case 'migrate': {
        const applied = await migrate(ctx.db);
        console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
        break;
      }
      case 'bootstrap-admin': {
        const email = (args[0] ?? '').toLowerCase();
        if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error('usage: bootstrap-admin <email> [--password <pw>]');
        const existing = await ctx.db.query(`SELECT 1 FROM users WHERE role = 'admin' AND status <> 'disabled' AND NOT ($1 = 'force')`, [args.includes('--force') ? 'force' : '']);
        if (existing.rowCount) throw new Error('An administrator already exists. Use the Administration UI to invite more, or pass --force for emergency access (audited).');
        const pwIdx = args.indexOf('--password');
        const password = pwIdx >= 0 ? args[pwIdx + 1] : undefined;
        await ctx.db.tx(async (c) => {
          const u = await c.query<{ id: string }>(`INSERT INTO users(email, display_name, role, auth_kind, status) VALUES ($1, $2, 'admin', 'local', $3) ON CONFLICT (email) DO UPDATE SET role = 'admin', status = EXCLUDED.status RETURNING id`, [email, 'Administrator', password ? 'active' : 'invited']);
          const id = u.rows[0]!.id;
          if (password) {
            const problems = passwordProblems(password, email);
            if (problems.length) throw new Error(problems.join(' '));
            await c.query(`INSERT INTO local_credentials(user_id, password_hash, email_verified_at, password_changed_at) VALUES ($1, $2, now(), now()) ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, email_verified_at = now()`, [id, await hashPassword(password)]);
            console.log(`Administrator ${email} created. Sign in and enrol MFA immediately; admin actions are blocked until MFA is enrolled.`);
          } else {
            await c.query(`INSERT INTO local_credentials(user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
            const token = randomToken(32);
            await c.query(`INSERT INTO account_tokens(user_id, kind, token_hash, expires_at) VALUES ($1, 'invite', $2, now() + interval '24 hours')`, [id, sha256(token)]);
            console.log(`Administrator ${email} invited. Open this one-time link within 24 hours to set a password and MFA:\n${new URL(`/invite/${token}`, ctx.config.publicUrl)}`);
          }
          await audit(c, { actorKind: 'system', eventType: 'user.bootstrap_admin', targetUserId: id, details: { email, emergency: args.includes('--force') } });
        });
        break;
      }
      case 'seed': {
        if (ctx.config.isProd) throw new Error('Refusing to seed a production database');
        await seedDevelopment(ctx);
        console.log('Development seed data created (see docs/DEVELOPMENT.md for accounts).');
        break;
      }
      default:
        console.log('usage: cli <migrate|bootstrap-admin <email> [--password pw]|seed>');
    }
  } finally {
    await ctx.db.close();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});

# Emergency access procedure

Use when no administrator can sign in (all admins lost their factors, the only admin left, SSO enforced
with a broken IdP). Every step is audited (`user.bootstrap_admin` with `emergency: true`) and requires shell
access to the server, which is itself a privileged position that should be logged by the host.

1. Confirm the situation and record it (ticket). Two people should be involved where possible.
2. On the server: `cd /opt/snelson-send`.
3. Create or elevate an administrator with a one-time invitation:
   ```bash
   docker compose -f deploy/docker-compose.yml run --rm --no-deps api node dist/cli.js bootstrap-admin ops@example.com --force
   ```
   `--force` is required because an administrator already exists. The command prints a single-use link
   valid for 24 hours. Open it: set a password, then enrol a passkey or authenticator app. Administration
   is unusable until MFA enrolment completes; there is no way to skip it.
4. If SSO is enforced and broken, the invited local account can still sign in only if local login is
   enabled. Temporarily enable it directly in the database (audited by the change you make next in the UI):
   ```bash
   docker compose -f deploy/docker-compose.yml exec db psql -U snelson -d snelson \
     -c "UPDATE settings SET value = jsonb_set(jsonb_set(value,'{ssoEnforced}','false'),'{localLoginEnabled}','true') WHERE key='identity';"
   ```
   Then fix the SSO configuration in Identity & access, run the SSO test, and re-enforce.
5. Afterwards: disable or delete the emergency account if it is no longer needed, review the audit trail for
   the period, and write up the incident.

No default credentials exist at any point; the only bootstrap mechanism is this CLI, which cannot be
reached over the network.

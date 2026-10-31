-- Snelson Send initial schema. All timestamps are timestamptz (UTC).
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------- users & auth
CREATE TYPE user_role AS ENUM ('sender', 'auditor', 'admin');
CREATE TYPE user_auth_kind AS ENUM ('local', 'sso');
CREATE TYPE user_status AS ENUM ('invited', 'active', 'disabled');

CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              citext NOT NULL UNIQUE,
  display_name       text NOT NULL DEFAULT '',
  role               user_role NOT NULL DEFAULT 'sender',
  auth_kind          user_auth_kind NOT NULL,
  status             user_status NOT NULL DEFAULT 'invited',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  disabled_at        timestamptz,
  last_login_at      timestamptz,
  notification_prefs jsonb NOT NULL DEFAULT '{}'::jsonb,
  quota_bytes        bigint,
  time_zone          text NOT NULL DEFAULT 'Europe/London'
);

CREATE TABLE local_credentials (
  user_id           uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash     text,
  email_verified_at timestamptz,
  password_changed_at timestamptz,
  failed_attempts   int NOT NULL DEFAULT 0,
  locked_until      timestamptz
);

-- single-use tokens for invitations, email verification, password reset
CREATE TYPE account_token_kind AS ENUM ('invite', 'email_verify', 'password_reset');
CREATE TABLE account_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        account_token_kind NOT NULL,
  token_hash  bytea NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mfa_totp (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_enc    bytea NOT NULL,          -- encrypted with server key
  confirmed_at  timestamptz,
  last_used_step bigint,                 -- replay protection
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mfa_webauthn_credentials (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id  text NOT NULL UNIQUE,   -- base64url
  public_key     bytea NOT NULL,
  counter        bigint NOT NULL DEFAULT 0,
  transports     text[] NOT NULL DEFAULT '{}',
  aaguid         text,
  backed_up      boolean NOT NULL DEFAULT false,
  label          text NOT NULL DEFAULT 'Passkey',
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz
);
CREATE INDEX ON mfa_webauthn_credentials(user_id);

CREATE TABLE mfa_recovery_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   text NOT NULL,             -- argon2id
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON mfa_recovery_codes(user_id) WHERE used_at IS NULL;

-- short-lived challenges for webauthn / pending MFA flows
CREATE TABLE auth_challenges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  purpose     text NOT NULL,             -- webauthn_register | webauthn_auth | oidc_login
  challenge   text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE TABLE sso_identities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issuer      text NOT NULL,
  subject     text NOT NULL,
  tenant_id   text,
  last_claims jsonb NOT NULL DEFAULT '{}'::jsonb,  -- redacted: oid, tid, groups count, amr
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  UNIQUE (issuer, subject)
);

CREATE TYPE auth_level AS ENUM ('password_only', 'full');
CREATE TABLE sessions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash           bytea NOT NULL UNIQUE,
  auth_level           auth_level NOT NULL DEFAULT 'password_only',
  auth_method          text NOT NULL,          -- local | sso
  mfa_method           text,                   -- totp | webauthn | recovery | idp
  created_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  last_strong_auth_at  timestamptz,
  idle_expires_at      timestamptz NOT NULL,
  absolute_expires_at  timestamptz NOT NULL,
  revoked_at           timestamptz,
  revoked_reason       text,
  ip_prefix            text,
  user_agent           text
);
CREATE INDEX ON sessions(user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------- settings & policy
CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  version     int NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES users(id)
);

CREATE TABLE policy_versions (
  id          bigserial PRIMARY KEY,
  policy      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id),
  reason      text
);

-- ---------------------------------------------------------------- transfers
CREATE TYPE transfer_status AS ENUM ('draft','uploading','scanning','ready','sending','active','expired','revoked');
CREATE TYPE deletion_status AS ENUM ('none','pending','in_progress','deleted','failed');
CREATE TYPE verification_mode AS ENUM ('required','bearer');

CREATE TABLE transfers (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id              uuid NOT NULL REFERENCES users(id),
  sender_email_at_event  citext NOT NULL,
  title                  text NOT NULL DEFAULT '',
  message                text NOT NULL DEFAULT '',
  status                 transfer_status NOT NULL DEFAULT 'draft',
  verification_mode      verification_mode NOT NULL DEFAULT 'required',
  expires_at             timestamptz NOT NULL,
  sent_at                timestamptz,
  revoked_at             timestamptz,
  revoked_by             uuid REFERENCES users(id),
  expired_at             timestamptz,            -- when the sweep recorded expiry (access denial is time-based)
  download_limit_per_recipient int,              -- NULL = unlimited
  notify_prefs           jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy_version_id      bigint REFERENCES policy_versions(id),
  effective_policy       jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_bytes            bigint NOT NULL DEFAULT 0,
  file_count             int NOT NULL DEFAULT 0,
  deletion_status        deletion_status NOT NULL DEFAULT 'none',
  deletion_requested_at  timestamptz,
  deletion_started_at    timestamptz,
  deletion_completed_at  timestamptz,
  deletion_attempts      int NOT NULL DEFAULT 0,
  deletion_last_error    text,
  metadata_purged_at     timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  search_text            text NOT NULL DEFAULT ''
);
CREATE INDEX ON transfers(sender_id, created_at DESC);
CREATE INDEX ON transfers(expires_at) WHERE status IN ('active','ready','sending');
CREATE INDEX ON transfers(deletion_status) WHERE deletion_status IN ('pending','failed','in_progress');

CREATE TYPE upload_status AS ENUM ('pending','uploading','finalised','abandoned');
CREATE TYPE scan_status AS ENUM ('pending','scanning','clean','infected','error','unavailable','oversized','timeout','skipped');
CREATE TYPE storage_state AS ENUM ('none','incoming','quarantine','released','deleted');

CREATE TABLE transfer_files (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id    uuid NOT NULL REFERENCES transfers(id),
  upload_id      text UNIQUE,                       -- tus id (random, server-generated)
  display_name   text NOT NULL,
  original_name  text NOT NULL,
  size_bytes     bigint NOT NULL CHECK (size_bytes >= 0),
  content_type   text NOT NULL DEFAULT 'application/octet-stream',
  upload_status  upload_status NOT NULL DEFAULT 'pending',
  scan_status    scan_status NOT NULL DEFAULT 'pending',
  scan_detail    text,
  scan_engine    text,
  scanned_at     timestamptz,
  storage_state  storage_state NOT NULL DEFAULT 'none',
  sha256         bytea,
  uploaded_bytes bigint NOT NULL DEFAULT 0,
  upload_started_at   timestamptz,
  upload_finished_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON transfer_files(transfer_id);

-- quota reservations (bytes reserved while uploading; released on finalise/abandon)
CREATE TABLE storage_reservations (
  file_id     uuid PRIMARY KEY REFERENCES transfer_files(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id),
  bytes       bigint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE grant_status AS ENUM ('pending','invited','revoked');
CREATE TABLE recipient_grants (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id          uuid NOT NULL REFERENCES transfers(id),
  email                citext NOT NULL,
  token_hash           bytea NOT NULL UNIQUE,
  status               grant_status NOT NULL DEFAULT 'pending',
  invited_at           timestamptz,
  revoked_at           timestamptz,
  revoked_by           uuid REFERENCES users(id),
  added_by             uuid REFERENCES users(id),
  added_after_send     boolean NOT NULL DEFAULT false,
  downloads_used       int NOT NULL DEFAULT 0,
  first_link_seen_at   timestamptz,
  first_verified_at    timestamptz,
  last_verified_at     timestamptz,
  all_files_completed_at timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transfer_id, email)
);
CREATE INDEX ON recipient_grants(transfer_id);

CREATE TABLE recipient_verifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id      uuid NOT NULL REFERENCES recipient_grants(id) ON DELETE CASCADE,
  code_hash     bytea NOT NULL,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  attempts      int NOT NULL DEFAULT 0,
  max_attempts  int NOT NULL,
  consumed_at   timestamptz,
  superseded_at timestamptz,
  locked_at     timestamptz,
  ip_prefix     text
);
CREATE INDEX ON recipient_verifications(grant_id, issued_at DESC);

CREATE TABLE recipient_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id      uuid NOT NULL REFERENCES recipient_grants(id) ON DELETE CASCADE,
  transfer_id   uuid NOT NULL REFERENCES transfers(id),
  token_hash    bytea NOT NULL UNIQUE,
  verified_email citext,                      -- NULL for bearer-mode sessions
  mode          verification_mode NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  ip_prefix     text
);
CREATE INDEX ON recipient_sessions(grant_id) WHERE revoked_at IS NULL;

CREATE TABLE download_attempts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id           uuid NOT NULL REFERENCES recipient_grants(id),
  session_id         uuid NOT NULL REFERENCES recipient_sessions(id),
  file_id            uuid REFERENCES transfer_files(id),     -- NULL for zip-all attempts
  kind               text NOT NULL DEFAULT 'file',           -- file | zip
  started_at         timestamptz NOT NULL DEFAULT now(),
  last_activity_at   timestamptz NOT NULL DEFAULT now(),
  covered            int8range[] NOT NULL DEFAULT '{}',      -- merged byte ranges served
  bytes_served       bigint NOT NULL DEFAULT 0,
  request_count      int NOT NULL DEFAULT 0,
  completed_at       timestamptz,
  interrupted_at     timestamptz,
  client_ack_at      timestamptz,
  allowance_consumed boolean NOT NULL DEFAULT false
);
CREATE INDEX ON download_attempts(grant_id, file_id);

-- per recipient-file completion (derived but stored for fast "all files downloaded")
CREATE TABLE recipient_file_completion (
  grant_id      uuid NOT NULL REFERENCES recipient_grants(id),
  file_id       uuid NOT NULL REFERENCES transfer_files(id),
  completed_at  timestamptz NOT NULL,
  PRIMARY KEY (grant_id, file_id)
);

-- ---------------------------------------------------------------- jobs, outbox, notifications
CREATE TYPE job_state AS ENUM ('queued','running','done','dead');
CREATE TABLE jobs (
  id               bigserial PRIMARY KEY,
  kind             text NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key  text UNIQUE,
  priority         int NOT NULL DEFAULT 100,        -- lower runs first
  run_at           timestamptz NOT NULL DEFAULT now(),
  state            job_state NOT NULL DEFAULT 'queued',
  attempts         int NOT NULL DEFAULT 0,
  max_attempts     int NOT NULL DEFAULT 8,
  locked_at        timestamptz,
  locked_by        text,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz
);
CREATE INDEX ON jobs(state, run_at, priority) WHERE state = 'queued';
CREATE INDEX ON jobs(kind, state);

CREATE TYPE outbox_status AS ENUM ('queued','sending','sent','failed','suppressed');
CREATE TABLE outbox_messages (
  id              bigserial PRIMARY KEY,
  kind            text NOT NULL,                 -- template key
  to_email        citext NOT NULL,
  to_user_id      uuid REFERENCES users(id),
  transfer_id     uuid REFERENCES transfers(id),
  grant_id        uuid REFERENCES recipient_grants(id),
  data            jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key      text UNIQUE,
  status          outbox_status NOT NULL DEFAULT 'queued',
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  provider_response text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);
CREATE INDEX ON outbox_messages(status, next_attempt_at) WHERE status IN ('queued','failed');

CREATE TABLE in_app_notifications (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  title       text NOT NULL,
  body        text NOT NULL DEFAULT '',
  transfer_id uuid REFERENCES transfers(id),
  dedupe_key  text UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz
);
CREATE INDEX ON in_app_notifications(user_id, created_at DESC);

-- operational alerts for admins (deletion failures, low disk, scanner down...)
CREATE TABLE operational_alerts (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL,
  severity    text NOT NULL DEFAULT 'warning',
  message     text NOT NULL,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  notified_at timestamptz
);
CREATE UNIQUE INDEX ON operational_alerts(dedupe_key) WHERE resolved_at IS NULL;

CREATE TABLE worker_heartbeats (
  worker_id   text PRIMARY KEY,
  last_seen   timestamptz NOT NULL,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- ---------------------------------------------------------------- audit (append-only)
CREATE TABLE audit_events (
  id              bigserial PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  event_type      text NOT NULL,
  correlation_id  uuid,
  actor_kind      text NOT NULL,           -- user | recipient | system | anonymous
  actor_user_id   uuid,
  actor_email     citext,                  -- email at event; not FK so renames don't rewrite history
  actor_session_id uuid,
  transfer_id     uuid,
  file_id         uuid,
  grant_id        uuid,
  target_user_id  uuid,
  outcome         text NOT NULL DEFAULT 'success',   -- success | denied | failure | info
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_prefix       text,
  user_agent_hash text,
  prev_hash       bytea,
  hash            bytea NOT NULL
);
CREATE INDEX ON audit_events(occurred_at DESC);
CREATE INDEX ON audit_events(transfer_id) WHERE transfer_id IS NOT NULL;
CREATE INDEX ON audit_events(actor_user_id) WHERE actor_user_id IS NOT NULL;
CREATE INDEX ON audit_events(event_type);

CREATE OR REPLACE FUNCTION audit_events_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_block_mutation();
-- Purge after retention is done by a SECURITY DEFINER function that temporarily disables the trigger
-- (see 0002). TRUNCATE is denied by not granting it to the application role.

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql;
CREATE TRIGGER transfers_touch BEFORE UPDATE ON transfers FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER transfer_files_touch BEFORE UPDATE ON transfer_files FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- access change notifications for live stream termination
CREATE OR REPLACE FUNCTION notify_access_changed() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('snelson_access_changed', json_build_object('table', TG_TABLE_NAME, 'id', NEW.id)::text);
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER transfers_access_changed AFTER UPDATE OF status, revoked_at, expires_at, deletion_status ON transfers
  FOR EACH ROW EXECUTE FUNCTION notify_access_changed();
CREATE TRIGGER grants_access_changed AFTER UPDATE OF status, revoked_at ON recipient_grants
  FOR EACH ROW EXECUTE FUNCTION notify_access_changed();
CREATE TRIGGER rsessions_access_changed AFTER UPDATE OF revoked_at ON recipient_sessions
  FOR EACH ROW EXECUTE FUNCTION notify_access_changed();

-- Live updates for the staff UI. Every audit event about a transfer, and every new in-app
-- notification, emits a small NOTIFY carrying only ids (no content, no addresses).
CREATE OR REPLACE FUNCTION notify_transfer_event() RETURNS trigger AS $$
DECLARE owner uuid;
BEGIN
  IF NEW.transfer_id IS NOT NULL THEN
    SELECT sender_id INTO owner FROM transfers WHERE id = NEW.transfer_id;
    IF owner IS NOT NULL THEN
      PERFORM pg_notify('securesend_events', json_build_object('k', 'transfer', 'id', NEW.transfer_id, 'u', owner)::text);
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_events_notify AFTER INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION notify_transfer_event();

CREATE OR REPLACE FUNCTION notify_inapp_event() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('securesend_events', json_build_object('k', 'notification', 'u', NEW.user_id)::text);
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER in_app_notifications_notify AFTER INSERT ON in_app_notifications
  FOR EACH ROW EXECUTE FUNCTION notify_inapp_event();

-- Fast path for the per-transfer "latest activity" lookup used by list pages.
CREATE INDEX IF NOT EXISTS audit_events_transfer_latest ON audit_events(transfer_id, id DESC) WHERE transfer_id IS NOT NULL;
-- Contacts lookup (a sender's past recipients).
CREATE INDEX IF NOT EXISTS recipient_grants_email ON recipient_grants(email);

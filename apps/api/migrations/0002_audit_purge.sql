-- Retention purge for audit metadata. Runs with the trigger disabled inside a single function so
-- ordinary application code can never UPDATE/DELETE audit rows.
CREATE OR REPLACE FUNCTION audit_purge_before(cutoff timestamptz) RETURNS bigint AS $$
DECLARE n bigint;
BEGIN
  ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update;
  DELETE FROM audit_events WHERE occurred_at < cutoff;
  GET DIAGNOSTICS n = ROW_COUNT;
  ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update;
  RETURN n;
END $$ LANGUAGE plpgsql SECURITY DEFINER;

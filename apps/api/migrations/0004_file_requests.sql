-- File requests: a member of staff asks named external people to send files in. Modelled as an
-- "inbound" transfer so scanning, expiry, deletion, audit and retention are the same code paths.
CREATE TYPE transfer_direction AS ENUM ('outbound', 'inbound');
ALTER TABLE transfers
  ADD COLUMN direction transfer_direction NOT NULL DEFAULT 'outbound',
  ADD COLUMN closed_at timestamptz;            -- inbound only: no longer accepting uploads
ALTER TABLE transfer_files
  ADD COLUMN uploaded_by_grant_id uuid REFERENCES recipient_grants(id);   -- inbound only: which contributor sent it
CREATE INDEX transfer_files_uploaded_by ON transfer_files(uploaded_by_grant_id) WHERE uploaded_by_grant_id IS NOT NULL;

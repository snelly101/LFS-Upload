# Privacy and data-protection decisions still required

The application provides controls; it does not make Snelsonserver Ltd compliant with UK GDPR by itself.
Decisions an accountable person must take and record:

1. **Lawful basis and purpose** for processing recipient email addresses, sender identities, filenames and
   activity records (likely legitimate interests or contract). Document it in the record of processing.
2. **Retention**: choose and justify `Transfer policy → default/max expiry`, `Audit & privacy → audit
   retention days` (default 365) and `metadata retention days` (default 90 after deletion, after which
   filenames, titles, messages and recipient addresses are anonymised). Shorter is easier to defend.
3. **Processors**: the SMTP relay and the identity provider (Entra ID) receive personal data (addresses,
   names, codes). Confirm processor agreements and their retention.
4. **DPIA**: likely warranted given special-category or confidential documents may be transferred. Reuse
   docs/THREAT-MODEL.md as input.
5. **Transparency**: tell recipients (invitation email footer, branding support details) who sends, why
   their address was used, and how long data is kept. Edit the templates' footer text in Branding settings.
6. **Subject access and erasure**: use Audit search/export by recipient address; erasure of content happens
   at expiry/revocation; metadata anonymisation happens at the retention boundary or can be forced by
   shortening it. There is no per-person "forget" button; document the manual procedure.
7. **Logging of IP data**: audit rows store a /24 or /48 prefix and a hashed user agent, not full addresses.
   Decide whether even that is necessary for your abuse controls.
8. **Backups**: database dumps contain personal data; apply the same retention and access controls (docs/RUNBOOK-BACKUP-RESTORE.md).
9. **International transfers**: none by the application; your SMTP/IdP providers may process abroad.
10. **Breach response**: `SERVER_SECRET_KEY` or database compromise exposes addresses, filenames and encrypted
    secrets; define the notification procedure.

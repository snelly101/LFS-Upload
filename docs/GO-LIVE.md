# Go-live checklist

From the LAN-only test install to a public service, in order. Each step says how to prove it worked.
Commands run as root on the server from `/opt/securesend/deploy` unless stated.

**Starting point this checklist assumes** (the state of `hq-dmz-lfs-01`, 10.199.200.99, when it was written):
Ubuntu Server 26.04 minimized; LUKS volumes mounted at `/srv/securesend/db` and `/srv/securesend/content`
with key files in `/etc/securesend/luks`; the stack installed and running from `/opt/securesend`;
`TLS_MODE=internal` (Caddy's test certificate, trusted by hand on test PCs); outbound SMTP to the mail
provider on 2525 working; ClamAV signatures downloading; Entra single sign-on working.

Nothing here has been run for you. Tick each line yourself.

## 1. Firewall

Inbound to 10.199.200.99:

| From | Port | Why |
|---|---|---|
| Internet | TCP 80 | Let's Encrypt HTTP validation and the redirect to HTTPS |
| Internet | TCP 443 | the service |
| Internet | UDP 443 | optional, HTTP/3 |
| Management subnet only | TCP 22 | SSH |

Do not restrict 80/443 by country or source range: Let's Encrypt validates from several networks that it
does not publish, and recipients can be anywhere.

Outbound from 10.199.200.99 (containers are NATed to this address):

| Destination | Port | Needed for | Without it |
|---|---|---|---|
| your mail provider's SMTP host (currently `mail-eu.smtp2go.com`) | TCP 2525 (or 587) | every invitation, code and notification | nobody can be invited or verify |
| `database.clamav.net` | TCP 443 | virus signature updates | signatures go stale; the scanner keeps working on old signatures |
| `acme-v02.api.letsencrypt.org` | TCP 443 | certificate issue and renewal | no public certificate; renewal fails after about 60 days |
| `login.microsoftonline.com` | TCP 443 | Entra sign-in (discovery, token exchange, signing keys) | staff cannot sign in with SSO |
| `github.com` | TCP 443 | `git pull` of this repository | no upgrades |
| `ghcr.io`, `pkg-containers.githubusercontent.com` | TCP 443 | pulling the published application image (only if `SECURESEND_IMAGE` is set) | upgrades must build on the server |
| `registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com` | TCP 443 | the pinned Caddy, PostgreSQL and ClamAV images | those images cannot be updated |
| `registry.npmjs.org` | TCP 443 | only when the image is built on the server (`SECURESEND_IMAGE` empty) | local builds fail |
| `archive.ubuntu.com`, `security.ubuntu.com`, `download.docker.com` | TCP 80/443 | Ubuntu security updates and Docker Engine packages | the host stops receiving patches |
| your NTP source | UDP 123 | correct time | expiry times, emailed codes and authenticator codes drift |

Use FQDN objects where the firewall supports them; several of these providers rotate addresses.

- [ ] Inbound and outbound rules in place.
- [ ] Prove outbound: `curl -sS -m 10 -o /dev/null -w '%{http_code}\n' https://acme-v02.api.letsencrypt.org/directory` prints `200`.
- [ ] Prove SMTP: `curl -v --max-time 10 telnet://mail-eu.smtp2go.com:2525 </dev/null 2>&1 | grep '^< 220'` prints a greeting.

## 2. Public DNS

- [ ] `A` record for the public hostname (`PUBLIC_HOST` in `deploy/.env`) pointing at the public address that
      is NATed to 10.199.200.99. Add `AAAA` only if IPv6 is really routed to the server.
- [ ] If the domain has `CAA` records, they allow `letsencrypt.org`.
- [ ] Staff inside the network resolve the same name to an address that reaches the server (the public
      address with hairpin NAT, or 10.199.200.99 through internal DNS).
- [ ] Prove it from outside your network: `nslookup <PUBLIC_HOST>` returns the public address.

## 3. Switch to the public certificate

```bash
cd /opt/securesend/deploy
sed -i 's|^TLS_MODE=.*|TLS_MODE=acme|' .env
docker compose up -d caddy
docker compose logs --tail=40 caddy        # look for "certificate obtained successfully"
```

- [ ] From a device that never had the test certificate, `https://<PUBLIC_HOST>` opens without a warning.
- [ ] `sudo ./monitor-check.sh` shows `tls=ok`.
- [ ] Remove the test set-up from every PC that had it: the hosts-file line for the hostname, and the
      "Caddy Local Authority" certificate from Trusted Root Certification Authorities. Leaving that root
      installed means the PC keeps trusting a certificate authority whose key sits on the server.

If issuance fails, the Caddy log names the reason. The usual ones: port 80/443 not reachable from the
internet, DNS not yet pointing at the server, or a `CAA` record that excludes Let's Encrypt. Caddy
retries by itself; do not restart it in a loop (Let's Encrypt rate-limits failed validations).

## 4. Email that lands in the inbox

Recipients get a one-time code by email. If it goes to spam the service looks broken.

- [ ] In the mail provider's console, add and verify the sending domain (the domain of `SMTP_FROM` /
      the From address in Administration → Notifications).
- [ ] Publish every DNS record the provider shows for that domain. They are normally `CNAME` records
      that delegate DKIM signing and the return-path (bounce) domain to the provider, which is what makes
      SPF and DKIM align with your domain. Publish exactly what the console shows; do not hand-write an
      SPF record from a guide.
- [ ] DMARC: the domain already has a `_dmarc` policy or you publish one. If none exists, start with
      `v=DMARC1; p=none; rua=mailto:<a mailbox you read>` and tighten it once reports are clean.
- [ ] Use a From address on that domain that is not a person's mailbox, for example
      `securesend@<your domain>`.
- [ ] Prove it: Administration → Notifications → Send test message to an external mailbox (Gmail and
      Outlook.com). Open the message source and find `spf=pass`, `dkim=pass` and `dmarc=pass`.

## 5. Sign-in

Follow docs/ENTRA-SETUP.md. For go-live specifically:

- [ ] The app registration's redirect URI is `https://<PUBLIC_HOST>/api/auth/sso/callback`.
- [ ] A Conditional Access policy targets the enterprise application and requires multifactor
      authentication (or an authentication strength).
- [ ] Administration → Identity & access → the "require the IdP to report MFA" check ticked, then one more
      test sign-in. If that sign-in is refused because the identity provider did not report multi-factor
      authentication, untick it and rely on the Conditional Access policy; note why.
- [ ] Sender, administrator and auditor group IDs entered; a second administrator exists through the
      admin group, not only your own account.
- [ ] Session limits set for an SSO tenant: idle 30 minutes, absolute 8 hours.
- [ ] A local break-glass administrator still works (password, second factor and recovery codes stored in
      the vault; procedure in docs/EMERGENCY-ACCESS.md). Test it in a private window.
- [ ] Only then: run **Test SSO configuration**, and switch on the enforce-SSO setting (it hides local sign-in).
- [ ] If the Conditional Access policy requires a compliant device: Apple devices satisfy it only with
      the Microsoft Enterprise SSO plug-in deployed through your MDM. Decide whether this application's
      policy requires compliance or MFA only.

## 6. The server looks after itself

```bash
sudo ./harden-host.sh          # must end with "0 problem(s)"
```

- [ ] `harden-host.sh` reports no problems: swap off or encrypted, core dumps disabled, clock
      synchronised, both volumes on LUKS devices.
- [ ] Backup key pair created on an admin workstation (`age-keygen -o securesend-backup.key`), public key
      in `BACKUP_AGE_RECIPIENT`, private key in the vault. Decide whether a copy of the private key lives on
      the server (`BACKUP_AGE_IDENTITY_FILE`); the trade-off is in docs/RUNBOOK-BACKUP-RESTORE.md.
- [ ] `sudo ./install-timers.sh`, then run both once:
      `systemctl start securesend-backup.service && systemctl start securesend-restore-check.service`.
- [ ] `ls -l /var/backups/securesend` shows a `securesend-db-<stamp>.dump.age` and a `securesend-env-<stamp>.age`.
- [ ] Administration → System health → Backup verification shows today's date and the note written by
      the restore check.
- [ ] Optional off-host copy: `BACKUP_RSYNC_TARGET` set, root's SSH key authorised on the target, and the
      next backup run copies the files there.

## 7. Monitoring

- [ ] `sudo ./monitor-check.sh` prints `SECURESEND OK | ...` and exits 0. (It warns while
      `TLS_MODE=internal`, so do step 3 first.)
- [ ] In NinjaOne, a scheduled script on this device runs `/opt/securesend/deploy/monitor-check.sh` as
      root every 5 minutes and raises an alert on a non-zero exit code: exit `2` critical, exit `1` a
      ticket. Have the alert include the script output; the lines after the first say what to do.
- [ ] Prove the alert path once: `docker compose stop worker`, wait for the alert, `docker compose start worker`.
- [ ] Administration → Notifications → operational alert recipients is a mailbox that is read.

## 8. Things only you hold

Copies in your secrets vault, not on the server and not in a backup of the server:

- [ ] `/etc/securesend/luks/db.key` and `/etc/securesend/luks/content.key` (`base64 <file>`). Without them
      a rebuilt host cannot unlock the volumes.
- [ ] `deploy/.env` (it contains `SERVER_SECRET_KEY`; without it a restored database cannot decrypt
      authenticator seeds, the SMTP password or the SSO client secret).
- [ ] The backup age private key.
- [ ] The break-glass administrator's credentials and recovery codes.

## 9. Patching and virtual-machine backups

- [ ] The device is excluded from automatic patch reboots in NinjaOne. Security updates install
      themselves; reboots happen in a maintenance window you choose, because a reboot cuts live transfers.
      To let the server reboot itself at 03:30 when an update needs it:
      `sudo ./harden-host.sh --enable-reboot-window`.
- [ ] The hypervisor's backup and snapshot jobs exclude the content disk (the 500 GiB disk). A VM-level
      backup or snapshot of that disk keeps deleted files recoverable for as long as the backup is kept,
      which defeats the deletion guarantee (docs/THREAT-MODEL.md). Backing up the system disk is fine,
      with one caveat: it contains the LUKS key files, so protect those backups like the keys.
- [ ] Monthly maintenance window agreed: OS reboot if pending, Docker Engine update, application
      upgrade (docs/UPGRADE.md).

## 10. Acceptance test

Run this on the public hostname before telling staff. It takes about ten minutes and needs two external
mailboxes you control (A and B) and a phone on mobile data.

1. **Send.** Sign in through SSO. Send a small file to mailbox A. Expected: "Sent to …", and the
   transfer shows the invitation as sent.
2. **Receive.** On the phone (mobile data, not office Wi-Fi), open the invitation. Expected: no warning,
   no file names or sender shown, only a masked address and a button to request a code. Request the code,
   enter it, download. Expected in the app: Sent → Opened → Downloaded for mailbox A.
3. **Forwarded link is refused.** Forward the invitation from A to B and open it from B. Request a code.
   Expected: the code arrives at A, never at B; B cannot get in.
4. **Stop sharing kills access.** Start a download of a larger file on the phone, then press Stop sharing
   in the app. Expected: the download breaks within about five seconds and reloading the recipient page
   shows the transfer is no longer available.
5. **Malware is blocked.** Create a text file containing exactly the EICAR test string
   `X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*` and upload it (your PC's antivirus
   may delete the file first; that is the same result by another route). Expected: "Blocked: malware
   detected" and the Send button stays disabled.
6. **Expiry deletes.** Send a transfer with the shortest expiry your policy allows and leave it.
   Expected after expiry: the recipient page says expired, and within a few minutes the transfer shows
   "Files deleted" with a verification time.
7. **The record is intact.** Administration → System health: scanner reachable, worker heartbeat, no
   deletion backlog, audit chain intact, no open alerts.

- [ ] All seven pass. Record the date and who ran it.

## 11. Optional: stop building on the production server

- [ ] Merge the working branch to `main` (or push a `v*` tag). GitHub Actions then runs the tests and
      publishes `ghcr.io/snelly101/lfs-upload`.
- [ ] `docker login ghcr.io` on the server with a read-only token, set `SECURESEND_IMAGE` to a version
      tag, and upgrade as in docs/UPGRADE.md. The npm registry rule in step 1 can then be removed.

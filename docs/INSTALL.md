# Installation (Ubuntu 24.04 or 26.04 LTS, single host)

This installs Together Housing Secure File Send with Docker Compose: Caddy (TLS), API, worker, PostgreSQL 16 and an
isolated ClamAV container. Only ports 80/443 are published. Expect downtime during upgrades; this
is a deliberate single-host design (docs/OPERATIONS.md).

## 1. Host prerequisites

| Item | Minimum | Notes |
|---|---|---|
| OS | Ubuntu Server 26.04.1 LTS (recommended) or 24.04 LTS, x86-64, minimal install with OpenSSH | 26.04 is supported to 2031; Docker publishes packages for both. The installer was authored against 24.04; report any package-name difference. |
| CPU / RAM | 4 vCPU / 8 GiB | ClamAV alone needs ~3 GiB resident; 16 GiB recommended |
| System disk | 40 GiB | OS, Docker images, logs |
| Content volume | see docs/OPERATIONS.md sizing | **LUKS-encrypted**, mounted at `/srv/snelson/content`, excluded from backups and snapshots |
| Database volume | 20 GiB+ | **LUKS-encrypted**, mounted at `/srv/snelson/db` |
| Network | outbound 443 to database.clamav.net (signatures), Let's Encrypt, your SMTP relay and IdP | inbound 80/443 only |

### 1.1 DNS and TLS
Create an A (and AAAA) record for the public host, e.g. `send.example.com`, pointing at the server.
Caddy obtains and renews certificates automatically via Let's Encrypt (`ACME_EMAIL`). For an
internal CA, replace the `tls` directive in `deploy/Caddyfile` with `tls /etc/caddy/cert.pem /etc/caddy/key.pem`
and mount the files. TLS 1.2+ only is Caddy's default.

### 1.2 Disk layout and encryption at rest
Content and database volumes must be separate block devices (or LVM volumes) encrypted with LUKS2.
Volume encryption protects powered-off or removed storage. It does **not** isolate content from a
compromised running host: once unlocked, root can read everything. Do not describe it as end-to-end
encryption.

```bash
# Example for a dedicated content disk /dev/sdb and database disk /dev/sdc
apt-get install -y cryptsetup
cryptsetup luksFormat --type luks2 /dev/sdb      # choose a strong passphrase; store it in your secrets manager
cryptsetup luksFormat --type luks2 /dev/sdc
cryptsetup open /dev/sdb snelson-content
cryptsetup open /dev/sdc snelson-db
mkfs.xfs /dev/mapper/snelson-content
mkfs.xfs /dev/mapper/snelson-db
mkdir -p /srv/snelson/content /srv/snelson/db
# /etc/crypttab (unlock at boot with a key file on the encrypted root, or interactively)
echo "snelson-content /dev/sdb none luks,discard" >> /etc/crypttab
echo "snelson-db      /dev/sdc none luks,discard" >> /etc/crypttab
# /etc/fstab
echo "/dev/mapper/snelson-content /srv/snelson/content xfs defaults,nodev,nosuid,noexec 0 2" >> /etc/fstab
echo "/dev/mapper/snelson-db      /srv/snelson/db      xfs defaults,nodev,nosuid,noexec 0 2" >> /etc/fstab
mount -a
```

Also protect places where plaintext could leak out of the encrypted volumes:

```bash
# Swap: either disable it or encrypt it with a random key each boot
swapoff -a && sed -i '/ swap /d' /etc/fstab            # option A: no swap
# option B: echo "cryptswap /dev/sdX /dev/urandom swap,cipher=aes-xts-plain64,size=256" >> /etc/crypttab

# Core dumps: never write process memory (which may contain file bytes) to disk
cat > /etc/sysctl.d/90-snelson.conf <<'S'
kernel.core_pattern=|/bin/false
fs.suid_dumpable=0
S
sysctl --system
mkdir -p /etc/systemd/system.conf.d
printf '[Manager]\nDefaultLimitCORE=0\n' > /etc/systemd/system.conf.d/no-core.conf
systemctl daemon-reexec
# ClamAV and the API use tmpfs /tmp inside their containers (compose `tmpfs:`), so scanner scratch
# never touches an unencrypted disk. Keep Docker's data root on the (encrypted) system disk or a
# LUKS volume as well: /var/lib/docker holds container logs.
```

If the host is a VM: hypervisor snapshots and storage-array snapshots copy the *unlocked* volumes'
blocks. Disable automatic snapshots for the content disk, or accept and document that snapshot
retention defeats the deletion guarantee for its lifetime (docs/THREAT-MODEL.md, "Residual risks").

### 1.3 Firewall
```bash
ufw default deny incoming; ufw allow 22/tcp; ufw allow 80/tcp; ufw allow 443/tcp; ufw allow 443/udp; ufw enable
```

## 2. Install

```bash
git clone <your fork> /opt/snelson-send && cd /opt/snelson-send
sudo deploy/install.sh                    # first run: installs Docker, creates deploy/.env with generated secrets
sudo nano deploy/.env                     # set PUBLIC_HOST, PUBLIC_URL, ACME_EMAIL, SMTP_URL/SMTP_FROM
sudo deploy/install.sh admin@example.com  # builds, migrates, starts, prints a one-time admin invitation link
```

The invitation link is printed once and expires in 24 hours. Opening it sets the password, then the
browser immediately requires MFA enrolment (passkey or authenticator app) before any administration is
possible. No default credentials exist.

### 2.1 SMTP
Either set `SMTP_URL` in `deploy/.env` or (preferred, so the password is stored encrypted and can be
rotated without a restart) configure Administration → Notifications → SMTP and use **Send test
message** to an address you own. Use an authenticated submission account with a dedicated sender
address; the application sends from `SMTP_FROM` / the configured From address only. SPF/DKIM for that
address are your mail platform's responsibility.

### 2.2 ClamAV signatures
On first start the `clamav` container downloads the full signature set (hundreds of MB, several
minutes); its health check allows 5 minutes. `freshclam` inside the container updates every 2 hours.
If outbound access to `database.clamav.net` is blocked, run a private mirror (cvdupdate) and point
`/etc/clamav/freshclam.conf` at it. While the scanner is unavailable, uploads stay quarantined and the
sender sees "scan unavailable"; nothing is released.

## 3. Reverse proxy notes

`deploy/Caddyfile` (default) streams bodies without buffering, sets security headers and redacts
recipient tokens from access logs. For nginx see `deploy/nginx.conf.example`. Whatever proxy you use:

* No request-body buffering to disk (`proxy_request_buffering off` in nginx; Caddy default), otherwise a
  plaintext copy of every upload lands in the proxy's temp directory.
* No response buffering; timeouts long enough for multi-hour transfers.
* Strip or redact `/r/<token>` paths from access logs; never log Cookie headers.
* Set `TRUST_PROXY=true` in `.env` so rate limiting sees client addresses.

## 4. Verification checklist

```bash
docker compose -f deploy/docker-compose.yml ps                         # all services Up/healthy
curl -fsS https://send.example.com/healthz && curl -fsS https://send.example.com/readyz
docker compose -f deploy/docker-compose.yml exec clamav clamdscan --version   # signature date in output
docker compose -f deploy/docker-compose.yml logs worker | tail             # "worker starting", heartbeat
```
Then in the UI: Administration → System health (scanner OK, worker alive, disk, SMTP test), send a
test transfer to yourself, verify the code, download, revoke, and confirm "deleted" within the target.
Record the result in Administration → Storage & deletion → "Backup verified" after a restore drill
(docs/RUNBOOK-BACKUP-RESTORE.md).

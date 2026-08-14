# Backups, and getting a shop back

One command backs up everything that matters, **together**:

```
npm run backup
# = node --env-file=.env scripts/backup.mjs
```

Each run writes a stamped folder under `backups/` (or `BACKUP_DIR`):

```
backups/
  2026-08-14_0300/
    site-1-ody10000_master.sql.gz
    site-2-ody10001_master.sql.gz
    control-odyssey_tickets.sql.gz
    uploads.tar.gz
    manifest.json          ← per-target ok/bytes/error for THIS run
  manifest.json            ← always the latest run — what you monitor
```

**Why one folder holds everything:** document bytes live in `uploads/` while
their rows live in the databases (see `sql/site/031`). Restoring one without
the other gives a shop whose attachments 404, or rows that point at nothing.
One stamped folder is one consistent moment.

## Scheduling

Windows Task Scheduler, daily at 03:00:

```
schtasks /create /tn "OdysseyAI backup" /sc daily /st 03:00 ^
  /tr "cmd /c cd /d C:\path\to\OdysseyAI && node --env-file=.env scripts\backup.mjs"
```

cron:

```
0 3 * * * cd /path/to/OdysseyAI && node --env-file=.env scripts/backup.mjs
```

The exit code is 1 when anything failed, and `backups/manifest.json` says
what. A healthy manifest has `"ok": true` and a recent `finishedAt` — check
its age, because the failure mode of a scheduler is silence.

Retention: folders older than `BACKUP_RETENTION_DAYS` (default 14) are
deleted at the end of each run.

**The `backups/` directory on the same disk is not disaster recovery.** Copy
the stamped folders off the machine — a synced drive, object storage, a USB
disk that leaves the building. Test the copy occasionally by restoring it.

## The two secrets that make a backup restorable

The dumps alone are **not** a backup of the system:

- **`ENCRYPTION_KEY`** — the control dump stores site-database passwords (and
  gateway credentials) as `enc:v1:` envelopes. Without this key they are
  unreadable and every site connection has to be re-entered by hand.
- **`SESSION_SECRET`** — signs sessions, pay links, store tokens. Losing it
  logs everyone out and breaks every printed store QR code.

Keep a secure copy of `.env` **separately** from the backups (a password
manager entry is fine). Never commit it.

## Restore, step by step

1. Install the app, put the saved `.env` in place.
2. Restore the control database first:
   ```
   mysql -e "CREATE DATABASE odyssey_tickets"
   gunzip -c control-odyssey_tickets.sql.gz | mysql odyssey_tickets
   ```
3. Restore each site database the same way, using the database names from the
   filenames.
4. Unpack the uploads **with** the databases:
   ```
   mkdir -p uploads && tar -xzf uploads.tar.gz -C uploads
   ```
5. Verify each site connects and its schema is current:
   ```
   node --env-file=.env scripts/site-migrate.mjs 1 --probe
   ```
6. Open `/setup/reconciliation` — the invariants screen — before letting
   anyone trade. A clean restore reconciles clean.

Notes:
- `mysqldump` is used with `--single-transaction`, so backups run against a
  live shop without locking it. On MariaDB hosts the binary may be called
  `mariadb-dump`; point `MYSQLDUMP_PATH` at it.
- Keep the host on NTP. Backups are stamped by clock, and two-factor sign-in
  (TOTP) drifts with it — more than ±90 seconds of drift locks people out.

## Two-factor lockout, the last resort

An owner clears a colleague's lost authenticator from **Setup → Users →
Clear two-factor**. If the *last* owner locks themselves out, the manual
recovery is one row in the control database:

```
DELETE FROM cp2_user_totp WHERE user_id = <their cp2_users id>;
```

They then sign in with password alone and re-enrol.

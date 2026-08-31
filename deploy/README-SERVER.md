# OdysseyAI — server-side notes

This is the folder you copied across. Everything below runs **on the VM**.

## Deploy

Double-click **`update.bat`**.

It stops the app, swaps in the new build, puts your `.env` and `uploads` back,
starts the app again, and then checks that `http://127.0.0.1:4100/api/health`
answers before it claims success.

## First time only

1. Run **`iis-setup.ps1` as Administrator.** It installs nothing — it checks
   that URL Rewrite and ARR are there, turns on the ARR proxy, creates the IIS
   site, and registers the boot task.
2. Create `C:\inetpub\odyssey_ai\app\.env` from `app\.env.example`.
   The app cannot reach a database without it. At minimum:
   `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `SESSION_SECRET`,
   `ENCRYPTION_KEY`, `APP_URL`.
3. Run `update.bat`.

Do **not** put `PORT` in `.env` and expect it to move the listener — the
standalone server reads `PORT` before `.env` is loaded. Port and hostname live
in `app\ecosystem.config.js`.

## What is where

```
C:\inetpub\odyssey_ai\
  app\          the running app — server.js, .next, node_modules, sql, scripts
    .env        YOURS. Never shipped, never overwritten by a deploy.
    uploads\    YOURS. Customer paperwork. Preserved across deploys.
    logs\       out.log / error.log
  pm2\          the bundled process manager
  .pm2\         PM2's home for THIS app only (see below)
  site\         the IIS site's physical path — web.config and nothing else
```

## PM2

This app has its own `PM2_HOME`, so it has its own daemon, separate from
Odyssey_bind's. That is deliberate: Odyssey_bind's deploy runs `pm2 kill`,
which would otherwise stop this app too.

Every PM2 command therefore needs the home set:

```powershell
$env:PM2_HOME = 'C:\inetpub\odyssey_ai\.pm2'
$pm2 = 'C:\inetpub\odyssey_ai\pm2\node_modules\.bin\pm2.cmd'

& $pm2 list
& $pm2 logs odyssey-ai
& $pm2 restart odyssey-ai --update-env   # after editing .env
```

`--update-env` matters after an `.env` edit: a plain restart reuses PM2's
cached environment and silently keeps the old settings.

## Migrations

> **`odyssey_tickets` is shared with the live Odyssey_Bind backend.** It owns
> `cp2_devices` in its own `schema.sql` and reads it in `pos/licence.ts` and
> `pos/bootstrap.ts`, among others — and two of the migrations here are *not*
> additive to it:
>
> | Migration | Does |
> |---|---|
> | `005_pos_device_licensing.sql` | `ALTER TABLE cp2_devices`, `DROP INDEX idx_cp2_devices_serial`, `UPDATE cp2_devices` |
> | `007_device_serial_per_site.sql` | `ALTER TABLE cp2_devices`, `DROP INDEX uq_cp2_devices_serial`, `DROP INDEX ix_cp2_devices_site_serial`, `UPDATE cp2_devices` |
>
> Dropping a unique index on a table another live application relies on is a
> change to *that* application, made from here. **Always `--dry-run` first.** If
> it lists nothing, these already ran against this database and there is nothing
> to weigh. If it lists them, stop and decide deliberately — with a backup.
>
> Deploying does not run migrations. `update.bat` never touches the database;
> this is a separate, manual step.

Applied by hand, from the app folder, because the database grants are
whitelisted to this machine:

```powershell
cd C:\inetpub\odyssey_ai\app

# Control database (odyssey_tickets)
node --env-file=.env scripts\tickets-migrate.mjs --dry-run
node --env-file=.env scripts\tickets-migrate.mjs

# One site's trading database
node --env-file=.env scripts\site-migrate.mjs <siteId> --probe
node --env-file=.env scripts\site-migrate.mjs <siteId>
```

## When it does not work

| What you see | Where to look |
|---|---|
| Browser shows a 502 | The app is not up. `app\logs\error.log`, then `pm2 logs odyssey-ai`. |
| `curl 127.0.0.1:4100/api/health` works but the site does not | IIS. ARR proxy not enabled, or the site is bound to the wrong host/port. Re-run `iis-setup.ps1`. |
| Pages render but every save fails | ARR is not preserving the host header. Re-run `iis-setup.ps1`. |
| Unstyled page, no JavaScript | `app\.next\static` is missing — the staged folder was built by something other than `deploy-local.ps1`. |
| `Cannot find module '.next\server\chunks\...'` | The staged folder is a raw copy of `.next\standalone`, which is missing Turbopack's server chunks. Re-stage with `deploy-local.ps1`. |
| PM2 says `online`, nothing answers, log says `Cannot find module 'next/dist/compiled/next-server/...'` | The staged folder is missing Next's server runtimes. Re-stage with `deploy-local.ps1`; do not try to patch it here. |
| App connects to the wrong database | A stray `app\.env.local` — it overrides `.env`. Delete it. |

# Publishing OdysseyAI to the server

Same workflow as Odyssey_bind: build and stage on your PC, copy one folder to
the VM, double-click one file there. The *shape* of the staged folder is
different, because the two apps are different animals.

| | Odyssey_bind | OdysseyAI |
|---|---|---|
| Frontend | Vite static files, served by IIS | served by the Node process |
| Backend | Express on :3001, proxied at `/api` | the same Node process |
| IIS does | serves the site, proxies `/api` | proxies everything |
| Live at | `C:\inetpub\odyssey_bind` | `C:\inetpub\odyssey_ai` |
| Port | 3001 | 4100 (loopback only) |
| PM2 process | `odyssey-api` | `odyssey-ai` |

There is no split to make here. A Next app renders on the server, so `/setup`
and `/api/health` are the same process, and IIS's job shrinks to one rewrite
rule.

## On your PC

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\deploy-local.ps1
```

Builds the **web** app (`npm run build`, not `build:desktop` — `APP_MODE` is
baked in at build time and a desktop bundle on a server renders the
Electron-only paths), then fills `deploy\staged\`:

```
deploy\staged\
  app\                  the deployable app
    server.js           Next's standalone entry point
    .next\              the REAL build output, less dev\ cache\ standalone\
    node_modules\       only what the build traced — ~1,340 files, not 34,000
    public\
    sql\                tickets + site migrations
    scripts\            tickets-migrate.mjs, site-migrate.mjs, box-migrate.mjs
    electron\           siteMigrate.js — site-migrate.mjs imports it
    ecosystem.config.js
    .env.example
  pm2\                  bundled process manager
  site\                 web.config — the IIS site is this one file
  update.bat
  update-on-server.ps1
  iis-setup.ps1
  README-SERVER.md
```

The last thing the script does is copy the staged app to `%TEMP%`, start it on
port 4198, and request both `/api/health` and `/`. If either fails it refuses to
finish. The copy is not incidental — see "the smoke test has to run outside the
repo" below.

Server source maps are excluded by default (~124MB against ~90MB for everything
else). Pass `-WithSourceMaps` while chasing a fault, to get stack traces in
`app\logs\error.log` that name a line in `src\`.

Then copy `staged` to the VM and follow `README-SERVER.md` (first time:
`iis-setup.ps1` as Administrator, write `.env`; every time: `update.bat`).

## Five things that will bite if they get changed

**`output: 'standalone'` in `next.config.mjs`.** The whole deploy rests on it.
Without it there is no `server.js` and no traced `node_modules`, and the server
would need `npm install` — over an internet connection it does not have.

**But `.next\standalone` is not itself deployable.** This app builds with
Turbopack, and a standalone build does *not* trace Turbopack's server chunks:
`.next\standalone\.next\server\chunks` came out with 3 files where the real
build has 1,095. Deploy that and the app starts, reports healthy on a folder
inspection, and then 500s on `/api/health` and on every page with `Cannot find
module '.next\server\chunks\[root-of-the-server]__*.js'`. So `deploy-local.ps1`
ships the **real** `.next` and takes only `node_modules` from standalone —
`electron-builder.yml` hit the same wall and splits it the same way. If a later
Next fixes this, verify the fix by serving a page, not by comparing folder
sizes: that is exactly what a size diff cannot see.

**`PORT` and `HOSTNAME` live in `ecosystem.config.js`, not `.env`.** The
standalone `server.js` reads `process.env.PORT` on its first executable line,
before Next loads any `.env`. A `PORT` in `.env` is read too late: the app comes
up on 3000, IIS keeps proxying to 4100, and the site 502s while the logs say the
app started fine.

**The trace also misses Next's own server runtimes.** The same gap, one level
down: the traced `next\dist\compiled\next-server` carries 3 of the 13
`.runtime.prod.js` files. The app then starts, prints "Ready", reports `online`
under PM2 — and answers nothing, logging `Cannot find module
'next/dist/compiled/next-server/app-route-turbo.runtime.prod.js'` on every
request. `deploy-local.ps1` copies all thirteen (4.1MB) over the traced set.

**The smoke test has to run outside the repo.** Node resolves a missing module
by walking *up* the directory tree, so a staged app tested in place at
`deploy\staged\app` finds `OdysseyAI\node_modules` two levels above it and runs
perfectly on modules that were never staged. That is precisely how the missing
runtimes above passed a green smoke test and then failed on the first machine
that had no repository to fall back on. The test copies to `%TEMP%` first, and
that copy is the whole point of it.

**The staged app must not carry a `.env` or `.env.local`.** Next's file tracer
copies whatever sits beside `next.config.mjs`, dev credentials included. Those
files would also *override* the server's own `.env` — so the live site would
quietly read and write the dev database. `deploy-local.ps1` deletes them from
`staged`; if that step is ever moved, it must not be dropped.

## What is not shipped, and why

- **`.env`** — the server keeps its own. See above.
- **`uploads\`** — customer paperwork; it only exists on the server, and
  `update-on-server.ps1` stashes and restores it around every deploy.
- **The Electron/Capacitor halves** — `electron\`, `android\`, `release\`, and
  `vendor\mariadb` are excluded from the trace in `next.config.mjs`. Desktop and
  mobile builds ship through `npm run dist`, not through here. The one exception
  is `electron\siteMigrate.js`, staged by hand because the migration runner
  imports it.

## Rolling back

`deploy\staged\` is a complete, self-contained copy of a build. Keep the last
known-good one (zip it, or rename it `staged-2026-08-31`), copy it across, and
run its `update.bat`. Nothing in the app folder is stateful — `.env` and
`uploads` are preserved by the updater and the database is untouched, so a
rollback is a straight file swap.

Migrations are the exception: they are forward-only and applied by hand, so a
rollback across a migration needs the SQL reverted deliberately.

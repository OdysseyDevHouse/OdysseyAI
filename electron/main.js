// Electron shell. In dev it points at the running `next dev` server; in a
// packaged build it boots Next's production server in-process and loads
// localhost. Either way the app is the same Next build as the web deployment —
// that's the whole point of this shell.
const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron')
const path = require('node:path')
const http = require('node:http')
const runtimeConfig = require('./runtimeConfig')
const localDb = require('./localDb')
const mariaService = require('./mariaService')
const replicationTunnel = require('./replicationTunnel')
const { isPos, isDatabaseSetup, startPath, posNavigation, setupNavigation } = require('./appRole')
/* Why the .exe never resumes a session. See the file. */
const { signOutOnLaunch } = require('./signOutOnLaunch')
const dbSetupBridge = require('./dbSetupBridge')
const { applyMigrations } = require('./siteMigrate')
const log = require('./log')
const updater = require('./updater')
const printing = require('./printing')
const licenceRefresh = require('./licenceRefresh')
const { appRequire } = require('./appModules')

/* ── THE SHOP'S DATA DIRECTORY IS NAMED HERE, NOT INHERITED ─────────────────
 *
 * Electron derives userData from package.json — `productName` if there is one,
 * otherwise `name`. That makes the shop's machine config a hostage of the
 * packaging: change either field and %APPDATA%\odyssey-ai moves, taking with it
 * which backend this install uses, the sealed database password and the site
 * id. There is no migration for that and no error either. It presents as a
 * machine that has to be provisioned from scratch, on a morning when nobody
 * touched it.
 *
 * The three builds now carry DIFFERENT package names — see build-config/*.yml,
 * where electron-updater's download cache had to be split per product. Naming
 * the directory here is what makes that safe, and keeps it safe for whichever
 * packaging change comes next.
 *
 * Before app.getPath('userData') is first called, which is the only ordering
 * requirement: every caller in electron/ is inside a function reached after
 * `ready`.
 */
app.setName('odyssey-ai')

const DEV_URL = process.env.ELECTRON_DEV_URL
const PORT = Number(process.env.PORT || 4100)

let mainWindow = null
let nextServer = null

/**
 * The origin this app serves itself from, fixed once at startup.
 *
 * NOT read back from the window. During startup the window is showing
 * starting.html, whose origin is the string 'null', so anything comparing
 * against `webContents.getURL()` concludes that our own app is a foreign site —
 * and a guard acting on that would open the shop in the user's browser.
 *
 * Today nothing navigates that early, so the bug is latent rather than live.
 * Anchoring it here means it stays that way.
 */
let appOrigin = null

/**
 * 'local' or 'cloud', as resolveEnv() decided at startup.
 *
 * Held because the licence refresh timer needs it AFTER the window has loaded,
 * and prepareRuntime is the only thing that knows it.
 */
let runtimeMode = null

/**
 * Is this URL the till?
 *
 * Matched on the app's OWN origin as well as the path, so that a link to
 * somebody else's `/pos` — a supplier's site, a documentation page — still goes
 * to the browser rather than being adopted as our point of sale. The URL is
 * whatever the renderer asked to open, so it is not trusted to be ours.
 *
 * `/pos` and everything under it: the till redirects to `/pos-unlock` when the
 * session has expired, and that screen belongs in the same window as the till
 * it is unlocking.
 */
/**
 * What this window is called, which is the one place the three builds announce
 * themselves to the operating system — taskbar, alt-tab, and the title bar a
 * technician reads before deciding they opened the wrong program.
 */
function windowTitle() {
  if (isPos()) return 'Odyssey POS'
  if (isDatabaseSetup()) return 'Odyssey Database Setup'
  return 'Odyssey Backoffice'
}

function isTillUrl(url) {
  try {
    const target = new URL(url)
    const own = new URL(mainWindow.webContents.getURL())
    if (target.origin !== own.origin) return false
    return target.pathname === '/pos' || target.pathname.startsWith('/pos-')
  } catch {
    return false
  }
}

function waitForServer(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      http
        .get(url, (res) => {
          res.resume()
          resolve()
        })
        .on('error', () => {
          if (Date.now() > deadline) reject(new Error(`Timed out waiting for ${url}`))
          else setTimeout(attempt, 300)
        })
    }
    attempt()
  })
}

/**
 * Everything that must be true before the Next server may start.
 *
 * ── ORDER MATTERS HERE ──────────────────────────────────────────────────────
 *
 * The Next server reads its database settings off process.env the moment it
 * handles a request, and src/lib/crypto/secrets.ts THROWS when ENCRYPTION_KEY
 * is missing. So the environment has to be complete before prepare(), and on a
 * local install the database has to be listening before the first query — not
 * merely installed.
 *
 * A packaged build had none of this: main.js never loaded a .env, so `npm run
 * dist` produced an app that could not open a connection at all.
 */
/**
 * Bring an ADOPTED shop's own database up to this build's schema.
 *
 * ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
 *
 * Odyssey Database Setup applies sql/site/*.sql when it adopts a machine, and
 * until now that was the ONLY thing that ever did. So every migration written
 * after a shop was set up was stranded: the Back Office shipped with the files
 * in resources/sql, read none of them, and the shop stayed on the schema it had
 * on the day it was installed. The only way to move it forward was for somebody
 * to re-run Setup's "Retrieve new details" — which nobody would think to do,
 * because nothing says a schema is behind.
 *
 * It surfaced the first time a back-office feature depended on a new table: the
 * offline site-profile mirror (sql/site/238) exists in the installer, is never
 * applied, and a shop with no line then fails on the very screen the mirror was
 * written to keep working.
 *
 * ── WHY IT IS SAFE TO RUN ON EVERY START ────────────────────────────────────
 *
 * applyMigrations is incremental: it records each file in `schema_migrations`
 * and applies only what is missing, which is exactly what `npm run
 * test:site-migrate` asserts by running it twice. On a shop that is up to date
 * this is one indexed SELECT and nothing else.
 *
 * ── AND WHY A FAILURE DOES NOT STOP THE APP ─────────────────────────────────
 *
 * Deliberate, and the opposite of what Setup does. Setup is a technician
 * standing at a machine who can act on "migration 137 failed"; this is a shop
 * opening at seven in the morning. A schema that could not be moved forward is
 * a degraded feature; a Back Office that refuses to start is a shop that cannot
 * trade. So it is logged, the run is retried on the next start, and every
 * reader of a new table is written to tolerate its absence.
 */
async function migrateAdoptedSite(onProgress) {
  const host = process.env.ODYSSEY_SITE_DB_HOST;
  const name = process.env.ODYSSEY_SITE_DB_NAME;
  const user = process.env.ODYSSEY_SITE_DB_USER;
  const password = process.env.ODYSSEY_SITE_DB_PASSWORD;
  /* Only the adopted model sets all four. A self-provisioning install has no
     ODYSSEY_SITE_DB_* at all — its site databases are described in its own
     local control database, and Setup never touched it. */
  if (!host || !name || !user || password === undefined) return;

  const mysql = require('mysql2/promise');
  let conn;
  try {
    conn = await mysql.createConnection({
      host,
      port: Number(process.env.ODYSSEY_SITE_DB_PORT) || 3306,
      user,
      password,
      database: name,
      /* Migration files hold several statements each, exactly as
         dbSetupBridge opens its own connection. */
      multipleStatements: true,
    });
    const ran = await applyMigrations(conn, {
      /* Silent when there is nothing to do — a shop opening should not be told
         about a schema that did not change. */
      onProgress: (m) => onProgress?.(m),
    });
    if (ran) console.log(`[schema] applied ${ran} site migration(s).`);
  } catch (err) {
    console.error('[schema] could not bring the shop database up to date:', err.message);
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

async function prepareRuntime(onProgress) {
  const { env, mode } = runtimeConfig.resolveEnv()
  Object.assign(process.env, env)

  if (mode !== 'local') return { mode }

  /* ── AN ADOPTED INSTALL DOES NOT OWN THE SERVER ─────────────────────────────
   *
   * Odyssey Database Setup registered MariaDB as a Windows service, running as
   * the machine and started at boot. This app connects to it and nothing more:
   * it must not try to start a server it did not install, and it must certainly
   * not initialise a data directory that already holds the shop's trading
   * history.
   *
   * The check is for the SERVICE rather than for our own config, because the
   * service is the thing that either answers or does not. If it is registered
   * but stopped — a machine that has just booted, or somebody who stopped it —
   * say so plainly rather than failing later with a connection error that names
   * nothing.
   */
  const serviceState = await mariaService.status()
  if (serviceState !== 'absent') {
    if (serviceState === 'stopped') {
      onProgress?.('Waiting for the database service…')
      /* Not started from here: this app is not elevated and has no business
         being. Windows starts it at boot; a stopped one is a support question,
         not something to paper over. */
    }
    /* ── THE SHOP'S PORT, NOT THE CONTROL DATABASE'S ──────────────────────
     *
     * This read DB_PORT until the adopted branch of resolveEnv() stopped
     * setting it — see the "NO DB_* HERE ANY MORE" note there. An adopted
     * install has no control connection on this machine at all now; the only
     * database here is the shop's own, and its port is ODYSSEY_SITE_DB_PORT.
     * migrateAdoptedSite() below was already reading that, which is why the
     * schema step was fine and only the wait in front of it was not.
     *
     * The result was loud for a user and invisible to a developer:
     * Number(undefined) is NaN, so a shop was told the service "is not
     * answering on port undefined" and sent to Services to start something that
     * was running perfectly well on the port its own config named.
     *
     * DB_PORT is still consulted second, for the older self-provisioning local
     * backend, which does set it and could in principle be on a machine that
     * also has the service registered.
     */
    const dbPort = Number(process.env.ODYSSEY_SITE_DB_PORT || process.env.DB_PORT)
    if (!Number.isInteger(dbPort) || dbPort <= 0 || dbPort > 65535) {
      /* Said now rather than after sixty seconds of dialling NaN. A port this
         install cannot name is a machine-config problem, and sending somebody
         to Services for it wastes the one support call they were going to
         make. */
      throw new Error(
        'This installation does not know which port the shop database is on. ' +
          `Its configuration is at ${runtimeConfig.configPath()} — run Odyssey ` +
          'Database Setup again to rebuild it.',
      )
    }

    onProgress?.('Connecting to the shop’s database…')
    await mariaService.waitForPort(dbPort).catch(() => {
      throw new Error(
        `The Odyssey Database service is not answering on port ${dbPort}. ` +
          `Open Services, start "${mariaService.SERVICE_NAME}", and try again.`,
      )
    })

    await migrateAdoptedSite(onProgress)
    return { mode }
  }

  /* No service on this machine: the older self-provisioning local backend, where
     this app does own the server. See docs/local-backend.md. */
  const secrets = runtimeConfig.revealSecrets()
  await localDb.ensureRunning({
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    controlDbName: process.env.DB_NAME,
    /* Only used on a first run, to take away root's passwordless access once
       the app's own user exists. Escrowed to the control panel so support can
       still get in without the customer ever holding it. */
    rootPassword: secrets.rootPassword,
    /* The cloud replica's account. Applied on every start rather than only the
       first, so a password rotated from the control panel takes effect when
       the shop next opens. */
    replicationUser: secrets.replicationUser,
    replicationPassword: secrets.replicationPassword,
    onProgress,
  })

  /* The cloud replica reads the binary log back down a connection the SHOP
     opens, because nothing on the internet can dial into a PC behind a
     domestic router. Started after the database is up and deliberately not
     awaited: a shop whose line is down must still open, and the tunnel's only
     correct response to that is to keep trying quietly in the background. */
  const cfg = runtimeConfig.readConfig()
  replicationTunnel.start({
    url: cfg.replicationUrl || process.env.ODYSSEY_REPLICATION_URL || '',
    token: secrets.replicationPassword,
    siteId: cfg.siteId ?? null,
    deviceSerial: cfg.deviceSerial ?? null,
    dbPort: Number(process.env.DB_PORT),
  })

  return { mode }
}

async function startNextServer() {
  // Packaged: run Next's own server against the prebuilt .next output. app.asar
  // is read-only, so the build must already exist — `npm run dist` handles that.
  const next = appRequire('next')
  const appDir = app.isPackaged ? path.join(process.resourcesPath, 'app') : path.join(__dirname, '..')

  /* ── HAND NEXT THE CONFIG INSTEAD OF LETTING IT GO AND READ ONE ──────────
   *
   * next({ dev: false }) would otherwise load next.config.mjs from disk at
   * startup, and loading a config means loadWebpackHook() — webpack, @babel
   * /runtime, and the rest of Next's BUILD toolchain. None of that is in
   * app/node_modules, because appModules.js points us at the traced tree and
   * the trace is of the SERVER, which never reads a config.
   *
   * So prepare() threw, in a packaged build only, before the listener was ever
   * created. The shell waits on /api/health to decide the app is up, so the
   * window simply never opened — no error on screen, nothing in the app's own
   * log, because none of our code had run yet.
   *
   * Next expects this. config.js swallows the loadWebpackHook failure — but
   * only when this variable is set:
   *
   *     } catch (err) {
   *       // this can fail in standalone mode as the files aren't traced/included
   *       if (!process.env.__NEXT_PRIVATE_STANDALONE_CONFIG) { throw err }
   *     }
   *
   * and then uses the parsed value as the config, applying no defaults because
   * they are already baked in. `.next/required-server-files.json` is where
   * `next build` writes exactly that resolved config; Next's own standalone
   * server.js does the same thing with a copy inlined into itself. Reading the
   * file instead of inlining it means the config can never drift from the build
   * sitting next to it.
   *
   * Not gated on app.isPackaged: a dev checkout resolves the whole toolchain
   * from the repository and would work either way, and a startup path that
   * differs between dev and packaged is one that gets tested in the wrong one. */
  const { config } = require(path.join(appDir, '.next', 'required-server-files.json'))
  process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(config)

  const nextApp = next({ dev: false, dir: appDir })
  await nextApp.prepare()
  const handle = nextApp.getRequestHandler()

  nextServer = http.createServer((req, res) => handle(req, res))
  await new Promise((resolve) => nextServer.listen(PORT, '127.0.0.1', resolve))

  return `http://127.0.0.1:${PORT}`
}

/**
 * No File / Edit / View / Window / Help.
 *
 * ── WHY THE DEFAULT MENU IS WRONG HERE ─────────────────────────────────────
 *
 * Electron ships one when an app sets none, and it is built for a general
 * desktop program: Reload, Force Reload, Toggle Developer Tools, Zoom,
 * Minimise. On a till it is a row of ways for somebody standing at a counter
 * to make the screen behave strangely, and none of them are things a cashier
 * should be doing mid-sale. It also makes the app look like a browser, which is
 * exactly what a point of sale should not look like.
 *
 * ── EXCEPT THE ONE THING WORTH KEEPING ─────────────────────────────────────
 *
 * Developer tools. Removing the menu removes its accelerator with it, and that
 * is the difference between diagnosing a customer's screen over the telephone
 * and asking them to send a log file. So the shortcut is re-registered on the
 * window itself — the tools stay reachable by somebody who knows the keys, and
 * invisible to somebody who does not.
 *
 * Cut, copy and paste are untouched: Chromium handles those in text fields
 * itself on Windows, without a menu to hang them from.
 */
function hideApplicationMenu(win) {
  Menu.setApplicationMenu(null)
  win.setMenuBarVisibility(false)
  win.autoHideMenuBar = true

  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return
    const devtools =
      input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')
    if (devtools) win.webContents.toggleDevTools()
  })
}

/* ── THE WINDOW ICON, WHICH ONLY AN UNPACKAGED RUN NEEDS ────────────────────
 *
 * A packaged Windows build takes its title-bar and taskbar icon straight out of
 * the .exe, where electron-builder has embedded build/icon.ico — seven sizes,
 * and Windows picks the right one per surface. Passing a path here would
 * override that correctly sized set with one bitmap scaled to whatever is
 * asked for, so it is deliberately left alone.
 *
 * Unpackaged there is no .exe of ours to read from, and the window wears the
 * stock Electron atom unless it is told otherwise. The source artwork is the
 * same one scripts/make-icons.mjs builds the .ico from, so the two cannot
 * drift.
 */
function devWindowIcon() {
  if (app.isPackaged) return undefined
  return path.join(__dirname, '..', 'public', 'logo-icon.png')
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#0f1216',
    title: windowTitle(),
    icon: devWindowIcon(),
    /* Belt and braces with hideApplicationMenu below: this stops the bar being
       painted for the moment between the window appearing and the menu being
       cleared, which is visible as a flicker on a slow machine. */
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      /* ── WITHOUT THIS THE PRELOAD DOES NOT RUN AT ALL ──────────────────────
       *
       * Electron has sandboxed renderers by DEFAULT since v20, and a sandboxed
       * preload gets a polyfilled `require` that knows `electron` and little
       * else — no node:fs, no node:crypto, no relative files. preload.js needs
       * all three: machineId() writes the device id, and appRole() reads the
       * baked role out of package.json.
       *
       * So it threw on its first require and never reached
       * exposeInMainWorld, leaving `window.odyssey` undefined in every
       * PACKAGED build. Nothing complained, because everything reading it
       * treats absence as "this is a browser" — a legal state with a sensible
       * fallback. The cost was silent: the till build showed back-office
       * buttons it should have hidden, and the device id fell back to a
       * browser-generated one that a cleared profile would change.
       *
       * contextIsolation stays ON, which is the protection that matters: the
       * renderer still cannot touch Node, and reaches only the named surface
       * preload exposes. Turning the sandbox off gives the PRELOAD Node back,
       * not the page.
       */
      sandbox: false,
    },
  })

  hideApplicationMenu(mainWindow)

  /* Belt and braces. createWindow() shows the window itself as soon as the
     splash is loaded, because a first-run database init takes long enough that
     waiting for the app proper would look like a hang. This stays for the path
     where that never happens. */
  mainWindow.once('ready-to-show', () => mainWindow?.show())

  /*
   * Where a `window.open` goes.
   *
   * THE TILL gets its own window inside the shell: it is a second screen the
   * shop runs alongside the back office, and a cashier must not lose a
   * half-scanned basket because somebody looked up a supplier invoice. Handing
   * it to `shell.openExternal` would boot it into Chrome, where it is a
   * different browser profile — different session cookie, different device id
   * in localStorage, no offline outbox — so it would land on the clerk PIN gate
   * as an unlicensed machine. That is why this cannot just fall through to the
   * external branch below.
   *
   * Everything else — a supplier's website, a help link — still opens in the
   * user's own browser rather than inside the app.
   */
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    /* On the TILL build the main window already IS the till, so a second one
       would be a duplicate of the screen the cashier is looking at — with its
       own claim on a table and its own half-scanned basket. Everything external
       still goes to the browser, via the branch below. */
    /* The setup wizard is excluded alongside the till, for the opposite
       reason: the till already IS the till, and this build has no till to open
       — nor a shop to open it against, until it has finished running. */
    if (isTillUrl(url) && !isPos() && !isDatabaseSetup()) {
      /* One till, not one per press: the link carries a NAMED target, and a
         named target reuses the window already opened under that name. */
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1400,
          height: 900,
          minWidth: 1024,
          minHeight: 640,
          backgroundColor: '#0f1216',
          title: 'Odyssey POS',
          icon: devWindowIcon(),
          webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
          },
        },
      }
    }

    shell.openExternal(url)
    return { action: 'deny' }
  })

  /*
   * The till window inherits none of the above — a window created by the open
   * handler is a fresh `webContents` with the DEFAULT behaviour, which is to
   * open any further `window.open` as another plain in-app window. So a help or
   * supplier link followed FROM the till would spawn a chrome-less window with
   * no way back, rather than going to the browser like everywhere else.
   *
   * `did-create-window` is where that window is handed over, so the same rule is
   * applied to it. The till itself never re-opens the till, so this branch only
   * has the external case to deal with.
   */
  mainWindow.webContents.on('did-create-window', (child) => {
    child.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url)
      return { action: 'deny' }
    })
  })

  /*
   * The till build may not leave the till.
   *
   * `will-navigate` fires for a link followed IN the window — the case
   * setWindowOpenHandler never sees, because nothing is being opened. Without
   * this, a link to a back-office screen from inside the till would simply
   * replace it, and the cashier would be sitting in front of stock adjustments
   * with no way back and a basket lost.
   *
   * Deliberately NOT a security boundary: the packaged window has no address
   * bar, but the server still serves those routes and a browser elsewhere can
   * reach them. actorForModule / requireModuleCapability remain the real
   * guard. This keeps the machine's PURPOSE unambiguous — see appRole.js.
   *
   * An off-limits target still opens in the user's own browser rather than
   * being silently swallowed: a waiter following a help link should get the
   * help page, just not inside the till.
   */
  /* Odyssey Database Setup is guarded for the same reason and by the same
     shape of rule: it ships without a back office, so a link into one must not
     open a screen this machine has no business showing. */
  const guard = isPos() ? posNavigation : isDatabaseSetup() ? setupNavigation : null
  if (guard) {
    mainWindow.webContents.on('will-navigate', (event, url) => {
      const verdict = guard(url, appOrigin)
      if (verdict === 'allow') return

      event.preventDefault()
      if (verdict === 'external') shell.openExternal(url)
    })
  }

  let url
  try {
    /* First run on a local backend initialises a database — tens of seconds of
       work with nothing on screen. Show the window early and narrate it, or the
       customer's first experience of the product is a machine that appears to
       have hung. */
    mainWindow.show()
    await mainWindow.loadFile(path.join(__dirname, 'starting.html'))

    /* ── BEFORE THE SERVER STARTS, NOT AFTER ──────────────────────────────
     *
     * The wizard's routes authenticate on a key held in the environment the
     * Next server inherits. Minting it afterwards would leave the server
     * reading an unset variable, and every setup call would 404 against its own
     * front end. Only this build mints one, which is also what decides that
     * only this build HAS those routes.
     */
    if (isDatabaseSetup()) {
      dbSetupBridge.installKey(process.env)
      dbSetupBridge.register({
        getOrigin: () => appOrigin,
        getWindow: () => mainWindow,
      })
    }

    runtimeMode = (
      await prepareRuntime((message) => {
        /* Best-effort: a progress line that cannot be delivered must never be the
           thing that stops the app from starting. */
        mainWindow?.webContents
          ?.executeJavaScript(`window.setStatus?.(${JSON.stringify(String(message))})`)
          .catch(() => {})
      })
    )?.mode

    url = DEV_URL || (await startNextServer())
    /* Fixed before anything can navigate. See the note on appOrigin. */
    try {
      appOrigin = new URL(url).origin
    } catch {
      appOrigin = null
    }
    await waitForServer(`${url}/api/health`)
  } catch (err) {
    dialog.showErrorBox('Odyssey could not start', String(err?.message || err))
    app.quit()
    return
  }

  /* ── OPENING THE APP IS SIGNING IN ───────────────────────────────────────
   *
   * Before the window is pointed at the app, never after: the cookie has to be
   * gone by the time the first request is made, or the root route reads the
   * session that is still there, renders the dashboard, and the login screen
   * only appears on a reload nobody performs.
   *
   * The database-setup build is exempt because it has no session to clear and
   * nothing to sign into — its whole life happens before a shop exists.
   *
   * See signOutOnLaunch.js for why a shared shop PC cannot keep the web's
   * twelve-hour session, and why this is the shell's job rather than the
   * server's.
   */
  if (!isDatabaseSetup()) {
    await signOutOnLaunch(mainWindow.webContents.session, appOrigin || url)
  }

  /* The till lands on /pos, the setup wizard on /database-setup, the back
     office on the root. See appRole.startPath for why neither of the first two
     goes to a sign-in page first. */
  await mainWindow.loadURL(`${url}${startPath()}`.replace(/\/$/, ''))

  /* ── KEEP THE LICENCE LEASE FRESH ────────────────────────────────────────
   *
   * Started after the window is up, never before: this is the least urgent
   * thing the app does, and it must not compete with the first page for a line
   * that may already be slow. A cloud install returns immediately — it keeps no
   * lease. See licenceRefresh.js. */
  licenceRefresh.start(appOrigin, runtimeMode)
}

// Single instance only — two shells would fight over the same port.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    /* Which of the three builds this is. Named once here because the log line
       below and the diagnostics beneath it both want the same answer. */
    const role = isPos() ? 'pos' : isDatabaseSetup() ? 'database' : 'backoffice'

    /* ── BEFORE THE WINDOW, AND BEFORE THE SERVER ──────────────────────────
     *
     * A packaged Windows app has no console, so console.error — which is how
     * Next reports a server component that threw — goes nowhere. The customer
     * sees "A server error occurred" and a digest number, and that is the whole
     * of the evidence.
     *
     * Started here rather than at the top of the file because it needs
     * app.getPath, which is only meaningful once the app is ready. */
    const file = log.start(app.getPath('userData'), {
      role,
      version: app.getVersion(),
      electron: process.versions.electron,
      platform: `${process.platform} ${process.arch}`,
    })
    if (file) console.log(`[odyssey] logging to ${file}`)

    /* ── LET THE ERROR SCREEN SHOW THE ERROR ────────────────────────────────
     *
     * Next strips a server error's message before the browser sees it, leaving
     * a digest number. That is right for a public web app, where the reader
     * might be anybody. Here the only person who can read the screen is the one
     * standing at the machine — hiding the cause from them buys nothing and
     * costs a phone call.
     *
     * Over IPC rather than an HTTP route, deliberately: a route that serves log
     * text would be readable by anything else on the machine that can reach
     * localhost, and this is only ever for the app's own error screen.
     */
    ipcMain.handle('diagnostics:recent-errors', () => log.recent())
    ipcMain.handle('diagnostics:log-path', () => log.pathOf())
    ipcMain.handle('diagnostics:open-log', () => {
      const file = log.pathOf()
      if (file) shell.showItemInFolder(file)
      return file
    })

    /* ── THE PRINT ENGINE ──────────────────────────────────────────────
     *
     * Registered unconditionally, like diagnostics:* and unlike dbSetupBridge:
     * the Back Office and the till both print, and the Database Setup build
     * simply never calls a verb. A missing bridge is harder to diagnose than a
     * refused call — preload.js makes the same argument for the same reason.
     *
     * Thunks rather than values because neither is known yet: appOrigin is
     * fixed when the server URL resolves, and mainWindow is created below.
     *
     * The hidden render window it owns is created IN MAIN, which is why it never
     * reaches the setWindowOpenHandler above and why the till build's
     * will-navigate guard — attached to mainWindow.webContents alone — does not
     * apply to it. That is a consequence to rely on, not an accident. */
    printing.register({
      getOrigin: () => appOrigin,
      getWindow: () => mainWindow,
    })

    /* Started after the window, deliberately: the first half-minute belongs to
       opening the shop. A download competing with the Next server starting is
       felt on a counter PC. */
    updater.start({
      onStatus: (message) => {
        if (message) console.log('[updater]', message)
      },
    })

    return createWindow()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  /*
   * Shut the database down politely.
   *
   * InnoDB survives a hard kill, but it recovers on the next start, and
   * recovery is slow and alarming — the customer experiences it as the app
   * taking a minute to open after a power cut. `before-quit` is asynchronous
   * here, so the quit is held until the server is down or the timeout passes.
   */
  let shuttingDown = false
  app.on('before-quit', async (event) => {
    if (nextServer) nextServer.close()
    /* Before the early return below: a cloud install never started one, and
       stopping a timer that does not exist is free. */
    licenceRefresh.stop()
    /* Also before the early return: a held webContents keeps the process alive
       past the point where the Next server has closed, and a till that will not
       shut down is a till somebody power-cycles. */
    printing.shutdown()

    if (shuttingDown || runtimeConfig.backendMode() !== 'local') return
    event.preventDefault()
    shuttingDown = true
    /* The tunnel first: it holds a socket to the server we are about to stop,
       and closing it politely saves the far end from reading a truncated
       stream and treating it as an error worth alerting on. */
    try {
      replicationTunnel.stop()
    } catch (err) {
      console.error('[replication] shutdown failed', err)
    }
    try {
      await localDb.stop(Number(process.env.DB_PORT))
    } catch (err) {
      console.error('[mariadb] shutdown failed', err)
    }
    app.quit()
  })
}

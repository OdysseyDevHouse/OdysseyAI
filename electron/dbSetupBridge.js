// The wizard's main-process half.
//
// ── WHY THE SEQUENCE LIVES HERE AND NOT IN THE RENDERER ─────────────────────
//
// Because the shop's database password passes through it. `SetupPlan` carries
// it in the clear — the type says so — and a renderer is a browser: what it
// holds can be read from a devtools window, and would sit in a crash report.
//
// So the screen sends what a person typed, and receives progress lines and a
// REDACTED plan. The plan itself is fetched here, kept here, and used here. It
// never crosses back over the bridge.
//
// ── THE KEY ─────────────────────────────────────────────────────────────────
//
// /api/db-setup would otherwise be an unauthenticated way to read a database
// password off localhost, because the wizard runs before there is any session
// to authenticate with. A random key minted at startup and put in the
// environment the Next server inherits means only this process can ask. See the
// route for why a caller without it gets 404 rather than 403.
const { ipcMain } = require('electron')
const crypto = require('node:crypto')
const localDb = require('./localDb')
const { applyMigrations } = require('./siteMigrate')
const machineConfig = require('./machineConfig')
const mariaService = require('./mariaService')
const posApi = require('./posApi')
const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

/**
 * What the wizard has established so far.
 *
 * Deliberately process-memory and deliberately not persisted: a half-finished
 * provisioning run is not a thing to resume after a crash. Somebody starts
 * again, which is safe because every statement involved is CREATE-IF-NOT-EXISTS
 * or ALTER and the migrations are recorded one at a time.
 */
const state = {
  key: null,
  /** Everything POST /login answered with. Held for the length of the wizard. */
  payload: null,
  email: null,
  /** The full plan, password and all. Never sent to the renderer. */
  plan: null,
  /** Built by the route from that plan; likewise never crosses back. */
  statements: [],
}

/**
 * This machine's own id, sent with the sign-in.
 *
 * The API records it against the attempt so support can answer "which machine
 * signed in, and when". It is deliberately NOT checked against device records —
 * an unknown serial never blocks a sign-in, because a till being in our records
 * is an administrative fact and must never be the reason a shop cannot open.
 *
 * The same file preload.js writes, so the wizard and the app agree about which
 * machine this is. Absent is fine: it is a nicety for support, not a credential.
 */
function machineSerial() {
  try {
    const file = path.join(app.getPath('userData'), 'device-id')
    return fs.readFileSync(file, 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * Mint the key, before the Next server starts and inherits the environment.
 *
 * ── EXCEPT IN DEVELOPMENT, WHERE THERE IS NOTHING TO INHERIT ────────────────
 *
 * Packaged, the Next server runs IN THIS PROCESS, so writing the key to
 * process.env is all it takes for the route to see it.
 *
 * `npm run dev:setup` is two processes: Electron here, `next dev` alongside it.
 * A key minted here reaches nothing, the route finds none, and every call
 * answers 404 — which this file then reports as "not started as Odyssey
 * Database Setup", because from its side that is indistinguishable.
 *
 * So an existing value wins, exactly as resolveEnv lets the real environment
 * win over stored config. Put the same ODYSSEY_SETUP_KEY in .env.local and both
 * processes agree. Absent — which is every packaged build — one is minted, and
 * a random 32 bytes per launch is what makes the guard worth having.
 */
function installKey(env = process.env) {
  let shared = String(env.ODYSSEY_SETUP_KEY || '').trim()

  /* ── ELECTRON DOES NOT READ .env FILES ────────────────────────────────────
   *
   * `next dev` loads .env.local by itself, so putting the key there gives the
   * ROUTE one — and left this side still minting a random one, which is the
   * same disagreement in the other direction. Electron has no such loader and
   * is not given one here: this reads exactly one variable, only when running
   * from source, so a dev checkout is not quietly running on half a .env it
   * never declared.
   */
  if (!shared && !app.isPackaged) {
    for (const file of ['.env.local', '.env']) {
      try {
        const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
        const found = /^ODYSSEY_SETUP_KEY\s*=\s*(.+)$/m.exec(text)
        if (found) {
          shared = found[1].trim().replace(/^["']|["']$/g, '')
          break
        }
      } catch {
        /* No such file. The next one, or a minted key. */
      }
    }
  }

  state.key = shared || crypto.randomBytes(32).toString('hex')
  env.ODYSSEY_SETUP_KEY = state.key
  return state.key
}

/** Ask our own in-process Next server. */
async function call(origin, action, payload = {}) {
  const res = await fetch(`${origin}/api/db-setup`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-odyssey-setup-key': state.key || '',
    },
    body: JSON.stringify({ action, ...payload }),
  })
  if (!res.ok) {
    /* 404 here means the key did not match, which is a wiring fault rather than
       anything a technician can fix — say so, instead of letting it surface as
       "unexpected end of JSON input" three frames later. */
    throw new Error(
      res.status === 404
        ? 'The setup service did not recognise this app. In a packaged build that means it was ' +
          'not started as Odyssey Database Setup; running from source it usually means ' +
          'ODYSSEY_SETUP_KEY is missing from .env.local, so the two dev processes disagree.'
        : `Setup service returned ${res.status}.`,
    )
  }
  return res.json()
}

/**
 * Wire the channels.
 *
 * `getOrigin` is a function rather than a value because the server's origin is
 * not known when this runs — the window is created, and narrated, before the
 * port is bound.
 *
 * `send` delivers progress to whichever window is showing the wizard. Progress
 * that cannot be delivered must never be the thing that fails a provisioning
 * run, so every send is best-effort.
 */
function register({ getOrigin, getWindow }) {
  const progress = (message) => {
    try {
      getWindow()?.webContents.send('db-setup:progress', String(message))
    } catch {
      /* The window went away mid-run. The database work continues; there is
         simply nobody watching it. */
    }
  }

  /* ── SIGN IN AGAINST THE CONTROL PANEL'S API, NOT ITS DATABASE ────────────
   *
   * This used to open a MySQL connection to port 3306 on the control server,
   * with credentials baked into the installer. It worked in an office whose IP
   * was whitelisted and refused everywhere else — which is every shop we would
   * ever install in.
   *
   * One HTTPS call now answers the whole wizard: who this person is, which
   * stores they may open, and for each store its database, its modules and its
   * devices. Nothing further is asked of the network until MariaDB is being
   * installed on this machine. See electron/posApi.js.
   */
  ipcMain.handle('db-setup:sign-in', async (_e, { email, password }) => {
    try {
      const payload = await posApi.login(email, password, machineSerial())
      state.payload = payload
      state.email = payload?.user?.email || email
      return {
        ok: true,
        email: state.email,
        fullName: payload?.user?.fullName ?? null,
        /* Carried through so the wizard can say so rather than leaving somebody
           to wonder why the shop they were told about is not in the list. */
        mustChangePassword: Boolean(payload?.user?.mustChangePassword),
      }
    } catch (err) {
      /* posApi has already turned the API's error code into a sentence written
         for the technician standing here — see describe(). */
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('db-setup:sites', async () => {
    if (!state.payload) return { ok: false, error: 'Sign in first.' }
    const stores = Array.isArray(state.payload.stores) ? state.payload.stores : []

    /* A store the login is linked to is ALWAYS returned by the API, suspended or
       not, so that the wizard can say WHICH kind of no it is. Offering a
       suspended one here would only move the refusal to the next screen, so they
       are filtered — but an empty result then has to distinguish "you have no
       stores" from "all of yours are suspended", because those send a person to
       opposite ends of a support call. */
    const open = stores.filter((s) => s.isAccessible)
    if (!open.length) {
      const suspended = stores.length > 0
      return {
        ok: false,
        error: suspended
          ? 'Every shop on this login is suspended. Contact Odyssey support.'
          : 'This login has no shops attached to it yet. Contact Odyssey support.',
      }
    }

    return {
      ok: true,
      sites: open.map((s) => ({
        id: s.siteId,
        code: s.siteCode,
        displayName: s.tradingName || s.companyName,
      })),
    }
  })

  ipcMain.handle('db-setup:plan', async (_e, { siteId, allowFrom }) => {
    if (!state.payload) return { action: 'refuse', reason: 'Sign in first.' }

    const store = (state.payload.stores || []).find((s) => s.siteId === Number(siteId))
    if (!store) return { action: 'refuse', reason: 'That shop is not on this login.' }
    if (!store.isAccessible) {
      return {
        action: 'refuse',
        reason:
          store.status === 'suspended'
            ? 'This shop is suspended. Contact Odyssey support.'
            : 'Your access to this shop has been suspended.',
      }
    }

    /* A cloud site is not an error and must not read like one: there is
       genuinely nothing to install, and putting a database on this machine
       would leave one nothing ever connects to. */
    if (store.connectionType === 'cloud') {
      return {
        action: 'nothing',
        siteId: store.siteId,
        siteCode: store.siteCode,
        siteName: store.tradingName || store.companyName,
        reason: 'This shop keeps its data in the cloud, so there is no database to install here.',
      }
    }

    /* A hybrid box holds open tabs under its own purpose; a local site's shop
       IS the master. Named rather than sorted to — see site-migrate.mjs for the
       bug that taught us the difference. */
    const purpose = store.connectionType === 'hybrid' ? 'hybrid' : 'master'
    const db = posApi.databaseFor(store, purpose)
    if (!db) {
      return {
        action: 'refuse',
        reason: `${store.siteCode} has no active "${purpose}" database configured. Contact Odyssey support.`,
      }
    }

    let password
    try {
      password = db.password ? posApi.openEnvelope(db.password) : ''
    } catch (err) {
      return { action: 'refuse', reason: `Could not read the database password: ${err.message}` }
    }
    if (!password) {
      /* hasPassword true with no password means the control panel holds one it
         could not prepare. Said plainly: it is a record to be fixed rather than
         anything the technician can do here. */
      return {
        action: 'refuse',
        reason:
          db.passwordError === 'unavailable'
            ? `Odyssey could not supply the password for ${db.databaseName}. Contact support — the record needs fixing.`
            : `No password is configured for ${db.databaseName}.`,
      }
    }

    const plan = {
      action: 'provision',
      siteId: store.siteId,
      siteCode: store.siteCode,
      siteName: store.tradingName || store.companyName,
      connectionType: store.connectionType,
      purpose,
      /* Loopback, whatever the control panel says. `localhost` there means
         "localhost of the database server", and after this runs that server is
         this machine — but the word resolves against whoever reads it. */
      host: '127.0.0.1',
      port: db.serverPort || 3306,
      databaseName: db.databaseName,
      username: db.dbUsername,
      password,
      /* A fact about the MACHINE, which the control panel deliberately cannot
         see. It changes the wording, never the decision. */
      alreadyInstalled: mariaService.isInitialised(),
    }

    /* The SQL is still generated by the app's own builder rather than here:
       writing GRANTs is the one thing a second copy would be dangerous to get
       subtly different. */
    const { statements } = await call(getOrigin(), 'statements', {
      databaseName: plan.databaseName,
      username: plan.username,
      password: plan.password,
      allowFrom: allowFrom || '',
    })

    state.plan = plan
    state.statements = statements || []

    /* ── THE SCREEN IS TOLD WHICH SHOP, AND NOTHING ELSE ──────────────────
     *
     * Not merely the password: the host, port, database name and username do
     * not cross either. A technician confirming "yes, this is Tiaan VM" needs
     * the shop; they do not need an address on somebody's network, and the
     * person leaning over their shoulder needs it even less.
     *
     * Withheld rather than hidden. A renderer cannot leak — to a screenshot, a
     * devtools window, a crash report — what it was never sent. The full plan
     * stays in this process, which is the only place that has to act on it.
     *
     * When something fails, the error names what it needs to and the log file
     * has the rest. That is the right place for it: a file support asks for,
     * rather than a screen anybody can photograph. */
    return {
      action: 'provision',
      siteId: plan.siteId,
      siteCode: plan.siteCode,
      siteName: plan.siteName,
      connectionType: plan.connectionType,
      alreadyInstalled: plan.alreadyInstalled,
    }
  })

  ipcMain.handle('db-setup:provision', async () => {
    const plan = state.plan
    if (!plan || plan.action !== 'provision') {
      return { ok: false, error: 'There is nothing to install. Choose a shop first.' }
    }

    try {
      /* ── 1. THE SERVER, AS A MACHINE-LEVEL SERVICE ────────────────────
       *
       * Not a child process. A database that is a child of whichever app
       * happened to start it stops existing when somebody closes a window, and
       * the till that opens at 07:00 must not depend on anybody having opened
       * the back office first. See electron/mariaService.js.
       */
      if (!(await mariaService.isElevated())) {
        return {
          ok: false,
          error:
            'Installing the database service needs administrator rights. Close this, right-click ' +
            'Odyssey Database Setup and choose "Run as administrator", then try again.',
        }
      }

      const bundled = app.isPackaged
        ? path.join(process.resourcesPath, 'mariadb')
        : path.join(__dirname, '..', 'vendor', 'mariadb')

      await mariaService.installBinaries(bundled, progress)
      mariaService.writeConfig({ port: plan.port, lan: plan.connectionType === 'hybrid' })
      await mariaService.initialise(progress)
      await mariaService.install(progress)
      await mariaService.startService(progress)
      progress('Waiting for the database to answer…')
      await mariaService.waitForPort(plan.port)

      /* The database, the user and the grants — applied through the client
         against the running service, one statement at a time so a failure names
         the statement rather than the batch. */
      progress('Applying the shop’s settings…')
      for (const statement of state.statements) {
        await mariaService.run(mariaService.exe('mariadb'), [
          '--protocol=TCP',
          '-h',
          '127.0.0.1',
          '-P',
          String(plan.port),
          '-u',
          'root',
          '-e',
          statement,
        ])
      }

      /* 2. The schema. Without this the database exists and is empty, which
            looks exactly like success until somebody opens a screen. */
      progress('Installing the shop’s tables…')
      const mysql = require('mysql2/promise')
      const conn = await mysql.createConnection({
        host: '127.0.0.1',
        port: plan.port,
        user: plan.username,
        password: plan.password,
        database: plan.databaseName,
        multipleStatements: true,
      })
      try {
        const ran = await applyMigrations(conn, { onProgress: progress })
        progress(ran ? `${ran} migrations applied.` : 'Schema already up to date.')
      } finally {
        await conn.end().catch(() => {})
      }

      /* 3. Leave the connection where Odyssey Back Office will find it.
       *
       * The two are separate installers with separate userData directories, so
       * this is the only handoff between them — and without it the Back Office
       * would have a database on the machine and no idea how to reach it,
       * because looking it up means asking the control panel. See
       * electron/machineConfig.js for why it is written in the clear. */
      progress('Recording the connection for Odyssey Back Office…')
      machineConfig.write({
        siteId: plan.siteId,
        siteCode: plan.siteCode,
        /* Loopback, not plan.host. The control panel stores `localhost`
           meaning "localhost OF THE DATABASE SERVER", and this machine is now
           that server — but the Back Office reading the word `localhost` would
           resolve it against itself, which is only accidentally the same thing
           and stops being true the moment anything else reads this file. */
        host: '127.0.0.1',
        port: plan.port,
        databaseName: plan.databaseName,
        username: plan.username,
        password: plan.password,
      })

      /* ── TELL OUR OWN SERVER WHERE THE SHOP NOW LIVES ──────────────────
       *
       * The two steps left — has-users and create-owner — act on the shop's
       * own database, and siteDb resolves that by reading cp2_site_databases
       * unless the environment already says. The wizard runs as a CLOUD client
       * by design, so nothing had set it, and both fell back to a MySQL query
       * against the control server: the exact connection this whole change
       * exists to stop needing, failing at the very last step.
       *
       * The Next server runs IN THIS PROCESS, so setting them here is all it
       * takes — givenConnection() in siteDb.ts reads them on the next call.
       * Done after provisioning rather than before, because until now there was
       * no database to describe.
       */
      process.env.ODYSSEY_SITE_ID = String(plan.siteId)
      process.env.ODYSSEY_SITE_DB_HOST = plan.host
      process.env.ODYSSEY_SITE_DB_PORT = String(plan.port)
      process.env.ODYSSEY_SITE_DB_NAME = plan.databaseName
      process.env.ODYSSEY_SITE_DB_USER = plan.username
      process.env.ODYSSEY_SITE_DB_PASSWORD = plan.password

      const any = await call(getOrigin(), 'has-users', { siteId: plan.siteId })
      return { ok: true, siteId: plan.siteId, needsOwner: !any.any }
    } catch (err) {
      /* The message names the statement or the migration that failed — see
         siteMigrate.applyMigrations. That is the difference between a
         technician knowing what to fix and knowing only that "setup failed". */
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('db-setup:create-owner', async (_e, { name, pin }) => {
    const plan = state.plan
    if (!plan || plan.action !== 'provision') {
      return { ok: false, error: 'Install the database first.' }
    }
    return call(getOrigin(), 'create-owner', { siteId: plan.siteId, name, pin })
  })
}

module.exports = { register, installKey }

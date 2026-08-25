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
  userId: null,
  email: null,
  /** The full plan, password and all. Never sent to the renderer. */
  plan: null,
  /** Built by the route from that plan; likewise never crosses back. */
  statements: [],
}

/** Mint the key, before the Next server starts and inherits the environment. */
function installKey(env = process.env) {
  state.key = crypto.randomBytes(32).toString('hex')
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
        ? 'The setup service is not reachable. This build was not started as Odyssey Database Setup.'
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

  ipcMain.handle('db-setup:sign-in', async (_e, { email, password }) => {
    const result = await call(getOrigin(), 'sign-in', { email, password })
    if (result.ok) {
      state.userId = result.userId
      state.email = result.email
    }
    return result
  })

  ipcMain.handle('db-setup:sites', async () => {
    if (state.userId === null) return { ok: false, error: 'Sign in first.' }
    return call(getOrigin(), 'sites', { userId: state.userId })
  })

  ipcMain.handle('db-setup:plan', async (_e, { siteId, allowFrom }) => {
    if (state.userId === null) return { action: 'refuse', reason: 'Sign in first.' }
    const { plan, safe, statements } = await call(getOrigin(), 'plan', {
      userId: state.userId,
      siteId,
      /* Blank for a local site, which serves only itself. A hybrid box needs
         the shop's subnet, and the wizard asks for it — see the route. */
      allowFrom: allowFrom || '',
      /* A fact about the MACHINE, which the server deliberately cannot see —
         see plan.ts. It changes the wording, never the decision. */
      alreadyInstalled: localDb.isInitialised(),
    })
    state.plan = plan
    state.statements = statements || []
    /* Only the redacted half crosses back. */
    return safe
  })

  ipcMain.handle('db-setup:provision', async () => {
    const plan = state.plan
    if (!plan || plan.action !== 'provision') {
      return { ok: false, error: 'There is nothing to install. Choose a shop first.' }
    }

    try {
      /* 1. The server, the database, the user and the grants. */
      await localDb.provisionForPlan({
        port: plan.port,
        statements: state.statements,
        onProgress: progress,
      })

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

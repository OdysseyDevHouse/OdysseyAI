// Electron shell. In dev it points at the running `next dev` server; in a
// packaged build it boots Next's production server in-process and loads
// localhost. Either way the app is the same Next build as the web deployment —
// that's the whole point of this shell.
const { app, BrowserWindow, shell, dialog } = require('electron')
const path = require('node:path')
const http = require('node:http')
const runtimeConfig = require('./runtimeConfig')
const localDb = require('./localDb')

const DEV_URL = process.env.ELECTRON_DEV_URL
const PORT = Number(process.env.PORT || 4100)

let mainWindow = null
let nextServer = null

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
async function prepareRuntime(onProgress) {
  const { env, mode } = runtimeConfig.resolveEnv()
  Object.assign(process.env, env)

  if (mode !== 'local') return { mode }

  /* A local backend brings its own server up. Provisioning is idempotent and
     cheap after the first run: an existing data directory is detected and
     started, never re-initialised, because re-initialising is indistinguishable
     from erasing the shop's trading history. */
  await localDb.ensureRunning({
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    controlDbName: process.env.DB_NAME,
    /* Only used on a first run, to take away root's passwordless access once
       the app's own user exists. Escrowed to the control panel so support can
       still get in without the customer ever holding it. */
    rootPassword: runtimeConfig.revealSecrets().rootPassword,
    onProgress,
  })

  return { mode }
}

async function startNextServer() {
  // Packaged: run Next's own server against the prebuilt .next output. app.asar
  // is read-only, so the build must already exist — `npm run dist` handles that.
  const next = require('next')
  const appDir = app.isPackaged ? path.join(process.resourcesPath, 'app') : path.join(__dirname, '..')

  const nextApp = next({ dev: false, dir: appDir })
  await nextApp.prepare()
  const handle = nextApp.getRequestHandler()

  nextServer = http.createServer((req, res) => handle(req, res))
  await new Promise((resolve) => nextServer.listen(PORT, '127.0.0.1', resolve))

  return `http://127.0.0.1:${PORT}`
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#0f1216',
    title: 'OdysseyAI Back Office',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

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
    if (isTillUrl(url)) {
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
          title: 'OdysseyAI Point of Sale',
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

  let url
  try {
    /* First run on a local backend initialises a database — tens of seconds of
       work with nothing on screen. Show the window early and narrate it, or the
       customer's first experience of the product is a machine that appears to
       have hung. */
    mainWindow.show()
    await mainWindow.loadFile(path.join(__dirname, 'starting.html'))

    await prepareRuntime((message) => {
      /* Best-effort: a progress line that cannot be delivered must never be the
         thing that stops the app from starting. */
      mainWindow?.webContents
        ?.executeJavaScript(`window.setStatus?.(${JSON.stringify(String(message))})`)
        .catch(() => {})
    })

    url = DEV_URL || (await startNextServer())
    await waitForServer(`${url}/api/health`)
  } catch (err) {
    dialog.showErrorBox('OdysseyAI could not start', String(err?.message || err))
    app.quit()
    return
  }

  await mainWindow.loadURL(url)
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

  app.whenReady().then(createWindow)

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

    if (shuttingDown || runtimeConfig.backendMode() !== 'local') return
    event.preventDefault()
    shuttingDown = true
    try {
      await localDb.stop(Number(process.env.DB_PORT))
    } catch (err) {
      console.error('[mariadb] shutdown failed', err)
    }
    app.quit()
  })
}

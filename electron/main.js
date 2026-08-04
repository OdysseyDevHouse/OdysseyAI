// Electron shell. In dev it points at the running `next dev` server; in a
// packaged build it boots Next's production server in-process and loads
// localhost. Either way the app is the same Next build as the web deployment —
// that's the whole point of this shell.
const { app, BrowserWindow, shell, dialog } = require('electron')
const path = require('node:path')
const http = require('node:http')

const DEV_URL = process.env.ELECTRON_DEV_URL
const PORT = Number(process.env.PORT || 4100)

let mainWindow = null
let nextServer = null

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

  mainWindow.once('ready-to-show', () => mainWindow.show())

  // External links open in the user's browser, not inside the shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  let url
  try {
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

  app.on('before-quit', () => {
    if (nextServer) nextServer.close()
  })
}

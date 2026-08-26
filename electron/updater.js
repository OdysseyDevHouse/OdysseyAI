// Keeping a shop's Odyssey current, without anybody visiting the shop.
//
// ── WHY THIS IS NOT A NICE-TO-HAVE ──────────────────────────────────────────
//
// Every secret baked into an installer is permanent until the machines holding
// it can be given a new one. Without an updater, "rotate the API client secret"
// means walking a thousand shops through a download, so in practice it means
// never — and a key that cannot be rotated is a key that stays leaked.
//
// It also removes the most dangerous thing a technician currently does. Today
// the way to apply a new version is to uninstall Odyssey and install the newer
// one, which is an ordinary act with an unrecoverable failure mode one wrong
// click away. With updates, nobody uninstalls anything.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
//
// It never restarts the app by itself. A till does not stop mid-sale and a back
// office does not vanish mid-invoice because a release landed: the download
// happens quietly and the new version is applied when somebody closes the app,
// which on a shop machine is at the end of a day.
//
// It also never touches the database. Updates replace the application
// directory; the shop's data lives in ProgramData and the service that serves
// it keeps running throughout — see electron/mariaService.js.
const { app, dialog } = require('electron')

/** Where releases are published. Baked at build time, empty on a dev checkout. */
function feedUrl() {
  return String(process.env.ODYSSEY_UPDATE_URL || '').trim()
}

let started = false

/**
 * Start checking, quietly.
 *
 * `onStatus` is for a screen that wants to say something; everything works
 * without one. Failures are reported and swallowed: a shop whose line is down,
 * or whose update server is having a bad morning, must open exactly as it
 * always does. An updater that can stop the app starting is worse than no
 * updater.
 */
function start({ onStatus } = {}) {
  if (started) return
  started = true

  const url = feedUrl()
  if (!url) {
    /* A dev checkout, or a build made before the feed was configured. Say so
       once rather than failing silently every four hours — "why are they not
       updating" is a question somebody will eventually ask. */
    onStatus?.('No update server configured for this build.')
    return
  }

  let autoUpdater
  try {
    ;({ autoUpdater } = require('electron-updater'))
  } catch {
    onStatus?.('Updater unavailable in this build.')
    return
  }

  autoUpdater.setFeedURL({ provider: 'generic', url })

  /* Downloaded in the background, applied on quit. Never mid-shift. */
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  /* An unsigned build cannot be verified, and refusing to update one would mean
     no updates at all until code signing is in place. Said out loud here rather
     than discovered as a silent no-op: once the installers are signed, this
     line should go. */
  autoUpdater.allowDowngrade = false

  autoUpdater.on('checking-for-update', () => onStatus?.('Checking for updates…'))
  autoUpdater.on('update-not-available', () => onStatus?.('Odyssey is up to date.'))
  autoUpdater.on('update-available', (info) =>
    onStatus?.(`Downloading Odyssey ${info?.version ?? ''}…`),
  )
  autoUpdater.on('download-progress', (p) =>
    onStatus?.(`Downloading update… ${Math.round(p?.percent ?? 0)}%`),
  )
  autoUpdater.on('update-downloaded', (info) => {
    onStatus?.(`Odyssey ${info?.version ?? ''} will be installed when you close the app.`)
  })
  autoUpdater.on('error', (err) => {
    /* Logged, never shown. The person at a counter can do nothing about a
       failed update check, and a dialog about one during a queue is worse than
       the stale version they already had. */
    console.error('[updater]', err?.message || err)
    onStatus?.(null)
  })

  const check = () => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[updater] check failed', err?.message || err)
    })
  }

  /* Not at the instant of launch: the first thirty seconds belong to opening
     the shop, and a download competing with the Next server starting is felt.
     Then every four hours, which on a machine left on all week is enough and on
     one switched on each morning happens once. */
  setTimeout(check, 30_000)
  setInterval(check, 4 * 60 * 60 * 1000)
}

/**
 * Check because a person asked, and tell them the answer either way.
 *
 * The one place a dialog is right: somebody chose Help → Check for updates and
 * is owed a response, including "you are already current".
 */
async function checkNow() {
  const url = feedUrl()
  if (!url) {
    await dialog.showMessageBox({
      type: 'info',
      message: 'Updates are not configured for this build.',
      detail: 'Contact Odyssey support for the current version.',
    })
    return
  }

  let autoUpdater
  try {
    ;({ autoUpdater } = require('electron-updater'))
  } catch {
    return
  }

  try {
    const result = await autoUpdater.checkForUpdates()
    const version = result?.updateInfo?.version
    const newer = version && version !== app.getVersion()
    await dialog.showMessageBox({
      type: 'info',
      message: newer ? `Odyssey ${version} is downloading` : 'Odyssey is up to date',
      detail: newer
        ? 'It will be installed the next time you close the app. Your data is not affected.'
        : `You are running version ${app.getVersion()}.`,
    })
  } catch (err) {
    await dialog.showMessageBox({
      type: 'warning',
      message: 'Could not check for updates',
      detail: String(err?.message || err),
    })
  }
}

module.exports = { start, checkNow, feedUrl }

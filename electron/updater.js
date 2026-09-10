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
// It never restarts the app BY ITSELF. A till does not stop mid-sale and a back
// office does not vanish mid-invoice because a release landed: the download
// happens quietly and the new version is applied when somebody closes the app,
// which on a shop machine is at the end of a day.
//
// installNow() is the one deliberate exception, and only a person can reach it
// — see the note there.
//
// It also never touches the database. Updates replace the application
// directory; the shop's data lives in ProgramData and the service that serves
// it keeps running throughout — see electron/mariaService.js.
const { app } = require('electron')
const { appRole } = require('./appRole')
const updateChannel = require('./updateChannel')

/**
 * The host releases are published to, without the per-build folder.
 *
 * ── READ FROM buildDefaults, NOT FROM process.env ───────────────────────────
 *
 * It used to read process.env.ODYSSEY_UPDATE_URL, and that made the whole
 * feature a no-op in every packaged build ever cut. runtimeConfig.resolveEnv()
 * is what puts the baked value into the environment, and it is called from
 * prepareRuntime() inside createWindow() — which main.js reaches AFTER
 * updater.start(). So start() read an empty string, said "No update server
 * configured for this build", and set `started` so nothing would ever try
 * again. The URL was present the whole time, half a second too late.
 *
 * Reading the baked file directly removes the ordering entirely: this module
 * no longer cares what has or has not run before it. The environment is still
 * consulted FIRST, because that is the support engineer's override and the
 * only thing that makes the updater exercisable on a dev checkout.
 */
function baseUrl() {
  const fromEnv = String(process.env.ODYSSEY_UPDATE_URL || '').trim()
  if (fromEnv) return fromEnv
  try {
    // eslint-disable-next-line global-require
    return String(require('./buildDefaults.json').ODYSSEY_UPDATE_URL || '').trim()
  } catch {
    /* A dev checkout that has never run `npm run build:defaults`. */
    return ''
  }
}

/**
 * Where THIS build's releases are published.
 *
 * ── ONE HOST, THREE FOLDERS ────────────────────────────────────────────────
 *
 * electron-builder writes the update manifest as `latest.yml`, and the name is
 * not derived from the product — so Back Office, POS and Database Setup each
 * produce a file called `latest.yml`. Published to one folder, the last build
 * uploaded wins and the other two products are handed a manifest describing
 * somebody else's installer. (The download would then fail its checksum rather
 * than install the wrong thing, so the symptom is not a corrupted till: it is
 * three products that quietly never update.)
 *
 * The role already distinguishes them — it is baked into package.json by
 * `extraMetadata` and is the same string the build config uses — so the feed is
 * simply the host plus that folder. Nothing new has to be kept in step.
 */
function feedUrl() {
  const base = baseUrl()
  if (!base) return ''
  return `${base.replace(/\/+$/, '')}/${appRole()}/`
}

let started = false

/**
 * The one autoUpdater this process uses, and what it last told us.
 *
 * ── WHY STATE LIVES HERE RATHER THAN IN THE SCREEN ──────────────────────────
 *
 * The background timer and the Updates screen are the same updater looking at
 * the same machine, and the screen can be opened halfway through a download the
 * timer started. If the screen kept its own idea of progress it would open
 * blank, report "nothing happening" over a download in flight, and offer a
 * Check button that started a second one.
 *
 * So the events write here, once, and the screen reads a snapshot. A screen
 * opened at any moment shows what is actually happening — including a download
 * that finished before anybody looked.
 */
const state = {
  /* idle | checking | up-to-date | downloading | downloaded | error */
  status: 'idle',
  message: null,
  availableVersion: null,
  percent: 0,
  lastCheckedAt: null,
  error: null,
}

let instance = null

/**
 * How to reach the app's own server, remembered from start().
 *
 * checkNow() is called by the timer AND by an IPC handler that has no idea what
 * the server URL is, so the getter is stored rather than passed. Null until
 * start() runs, which is harmless: updateChannel.refresh(null) returns the
 * cached channel without asking anybody.
 */
let originOf = null

/**
 * Everything the Updates screen needs, in one object.
 *
 * The version and the channel are read at call time rather than cached: a
 * machine is moved between channels while it is running, and a snapshot that
 * says 'stable' because that was true at launch is the kind of wrong that sends
 * somebody looking in the wrong place.
 */
function snapshot() {
  const url = feedUrl()
  return {
    ...state,
    currentVersion: app.getVersion(),
    channel: updateChannel.current(),
    feedUrl: url || null,
    /* The screen disables its buttons on this rather than inferring it from the
       other fields — "there is no update server" and "nothing has happened yet"
       are both `status: 'idle'` and mean very different things. */
    configured: Boolean(url),
  }
}

/**
 * Load electron-updater and wire it up, once.
 *
 * Returns null when this build has no feed or no updater — a dev checkout, or
 * one built before ODYSSEY_UPDATE_URL was configured. Callers treat null as
 * "nothing to do" rather than as a failure, because for those builds it is not
 * one.
 */
function loadUpdater({ onStatus } = {}) {
  if (instance) return instance

  const url = feedUrl()
  if (!url) return null

  let autoUpdater
  try {
    ;({ autoUpdater } = require('electron-updater'))
  } catch {
    return null
  }

  autoUpdater.setFeedURL({ provider: 'generic', url })

  /* Downloaded in the background, applied on quit. Never mid-shift — unless a
     person deliberately asks, which is what installNow() is for. */
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  /* ── THIS BUILD SHIPS A FULL INSTALLER, AND ONLY THAT ───────────────────
   *
   * electron-updater warns about this on every run because the default is
   * about to change: leaving it false says "a web installer may turn up in
   * this feed", and it would then hand one to a shop if a manifest ever named
   * one. Nothing here publishes one — build-config targets nsis alone, and
   * scripts/publish-release.mjs uploads the single .exe the manifest names.
   *
   * Said out loud rather than left to the default, so the day the default
   * flips nothing about a customer's update changes. */
  autoUpdater.disableWebInstaller = true

  /* Both the timer and the screen report through here, so a message raised by
     one is visible to the other. */
  const say = (status, message, extra = {}) => {
    state.status = status
    state.message = message
    Object.assign(state, extra)
    if (message) onStatus?.(message)
  }

  autoUpdater.on('checking-for-update', () => {
    say('checking', 'Checking for updates…', { error: null })
  })
  autoUpdater.on('update-not-available', () => {
    say('up-to-date', 'Odyssey is up to date.', {
      availableVersion: null,
      lastCheckedAt: new Date().toISOString(),
    })
  })
  autoUpdater.on('update-available', (info) => {
    say('downloading', `Downloading Odyssey ${info?.version ?? ''}…`, {
      availableVersion: info?.version ?? null,
      percent: 0,
      lastCheckedAt: new Date().toISOString(),
    })
  })
  autoUpdater.on('download-progress', (p) => {
    const percent = Math.round(p?.percent ?? 0)
    say('downloading', `Downloading update… ${percent}%`, { percent })
  })
  autoUpdater.on('update-downloaded', (info) => {
    say('downloaded', `Odyssey ${info?.version ?? ''} will be installed when you close the app.`, {
      availableVersion: info?.version ?? null,
      percent: 100,
    })
  })
  autoUpdater.on('error', (err) => {
    /* Logged, never shown UNPROMPTED. The person at a counter can do nothing
       about a failed check, and a dialog about one during a queue is worse than
       the stale version they already had — but somebody who OPENED the Updates
       screen asked, and is owed the reason. So it is recorded rather than
       swallowed, and only that screen reads it. */
    const message = String(err?.message || err)
    console.error('[updater]', message)
    say('error', null, { error: message })
    onStatus?.(null)
  })

  instance = autoUpdater
  return instance
}

/**
 * ── FORWARD ONLY, AND ON THE BETA PATH ESPECIALLY ──────────────────────────
 *
 * This is not merely a default being restated. Assigning `autoUpdater.channel`
 * — which this does on every machine the control panel has put on a test build
 * — sets allowDowngrade to TRUE as a side effect (see the setter in
 * electron-updater's AppUpdater.js). That would let a machine taken OFF beta
 * walk backwards from 0.2.0-beta.1 to whatever stable currently is.
 *
 * A downgrade is not survivable here. sql/site migrations are forward-only and
 * applied once, so an older app would open a database that is already ahead of
 * it — with no failure at the moment it happens and no way back.
 *
 * So allowDowngrade is set AFTER the channel, every time, and the way off beta
 * is FORWARD: semver puts 0.2.0-beta.1 below 0.2.0, so a machine on beta lands
 * on the stable release that supersedes it. scripts/publish-release.mjs
 * promotes each stable release onto beta.yml precisely so that release exists
 * to land on.
 */
function applyChannel(autoUpdater) {
  const channel = updateChannel.feedChannel(updateChannel.current())
  if (channel) autoUpdater.channel = channel
  autoUpdater.allowDowngrade = false
}

/**
 * Start checking, quietly.
 *
 * `onStatus` is for a screen that wants to say something; everything works
 * without one. `getOrigin` is how this reaches the app's own server to ask
 * which channel this machine is on — a getter rather than a value because
 * start() is called before the Next server has a URL, and the first check is
 * thirty seconds later.
 *
 * Failures are reported and swallowed: a shop whose line is down, or whose
 * update server is having a bad morning, must open exactly as it always does.
 * An updater that can stop the app starting is worse than no updater.
 */
function start({ onStatus, getOrigin } = {}) {
  if (started) return
  started = true

  originOf = getOrigin ?? originOf

  const autoUpdater = loadUpdater({ onStatus })
  if (!autoUpdater) {
    /* A dev checkout, or a build made before the feed was configured. Say so
       once rather than failing silently every four hours — "why are they not
       updating" is a question somebody will eventually ask. */
    onStatus?.('No update server configured for this build.')
    return
  }

  applyChannel(autoUpdater)

  /* Not at the instant of launch: the first thirty seconds belong to opening
     the shop, and a download competing with the Next server starting is felt.
     Then every four hours, which on a machine left on all week is enough and on
     one switched on each morning happens once. */
  setTimeout(() => void checkNow(), 30_000)
  setInterval(() => void checkNow(), 4 * 60 * 60 * 1000)
}

/**
 * Check now — because a timer said so, or because somebody pressed a button.
 *
 * ── ONE PATH, NOT TWO ───────────────────────────────────────────────────────
 *
 * The manual check used to be a separate function with its own dialog, its own
 * channel handling and its own error reporting. Two implementations of "check
 * for updates" is two things to keep in step, and the one a human drives is
 * exactly the one that must not report something different from the one that
 * runs all day. So the button and the timer call this.
 *
 * Never throws. Returns the snapshot, so an IPC caller gets the answer without
 * a second round trip.
 */
async function checkNow() {
  const autoUpdater = loadUpdater()
  if (!autoUpdater) return snapshot()

  /* Re-asked before every check rather than once at launch, because a machine
     is moved between channels while it is RUNNING — a till left on all week
     would otherwise never hear about it. The fetch fails safe to whatever this
     machine already knew, so a check never waits on the portal to happen. */
  await updateChannel.refresh(originOf?.() ?? null)
  applyChannel(autoUpdater)

  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    /* The 'error' event has usually fired already and recorded the reason; this
       catches the case where the promise rejects without one, so the screen
       never sits on "Checking…" for ever. */
    const message = String(err?.message || err)
    console.error('[updater] check failed', message)
    state.status = 'error'
    state.error = message
  }
  return snapshot()
}

/**
 * Apply a downloaded update NOW, restarting the app.
 *
 * ── THE ONE PLACE THAT IS ALLOWED TO INTERRUPT ──────────────────────────────
 *
 * Everything else here is built so a shop never notices an update: the download
 * is quiet and the install waits for somebody to close the app, which on a
 * counter machine is the end of a day. This is the deliberate exception, and it
 * exists because the alternative is worse — a technician who has just pushed a
 * fix, standing at the machine, being told to close the app and open it again
 * is being asked to do by hand exactly what this does properly.
 *
 * It refuses unless an update is actually staged. quitAndInstall with nothing
 * downloaded closes the app and installs nothing, which from the far end of a
 * phone call is indistinguishable from a crash.
 *
 * The SCREEN is responsible for asking first. This confirms nothing: by the
 * time it is called the decision is made, and a dialog raised from the main
 * process here would appear after the renderer has already said goodbye.
 */
function installNow() {
  if (state.status !== 'downloaded') {
    return { ok: false, error: 'No update has finished downloading yet.' }
  }
  const autoUpdater = loadUpdater()
  if (!autoUpdater) return { ok: false, error: 'Updates are not configured for this build.' }

  console.log('[updater] installing on request, restarting')
  /* Deferred a beat so the IPC reply reaches the renderer before the app starts
     tearing down — otherwise the screen's await never settles and the last
     thing the technician sees is a button stuck mid-press.
     Not silent: the NSIS installer's own progress is the only feedback during
     the seconds the app is gone, and a technician watching a black screen
     wonders whether it worked. The second `true` runs the app again after. */
  setTimeout(() => autoUpdater.quitAndInstall(false, true), 250)
  return { ok: true }
}

module.exports = { start, checkNow, installNow, snapshot, feedUrl }

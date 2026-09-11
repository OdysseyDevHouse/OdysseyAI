// The app reopens the way the shop left it.
//
// ── WHY THIS IS NOT A SYSTEM SETTING ────────────────────────────────────────
//
// Some shops want the app maximised on a counter all-in-one; others keep it
// windowed beside a supplier's website. That is a real split, and the obvious
// answer is a setting somebody ticks.
//
// But the setting is worse than remembering. A customer who wants it maximised
// already knows how to say so — they maximise the window. Asking them to ALSO
// find a preference screen and agree with themselves is a second way to express
// the same wish, and the two can disagree: an app pinned "always maximised"
// fights the person dragging it smaller, and one pinned "never" un-maximises
// itself every morning on the machine whose owner maximises it every morning.
//
// So the window is the setting. Maximise it and it opens maximised, from now
// on; restore it down and it opens where you left it, at the size you left it.
// Nothing to explain over the telephone, and nothing to get wrong.
//
// ── WHERE IT IS KEPT ────────────────────────────────────────────────────────
//
// runtime-config.json in userData, beside the rest of this install's state and
// through the same readConfig/writeConfig — so it survives an update, which
// replaces the app directory wholesale, and stays per Windows account. Two
// people sharing a shop PC each get their own answer, which is right: it is a
// preference about their screen, not about the shop.
//
// Nothing here is sealed. A window position is not a secret, and it is written
// on a close that may be a power cut — a plain value that fails to parse costs
// a default-sized window, where a failed decrypt would cost the same and look
// like a credential problem.
const { screen } = require('electron')
const { readConfig, writeConfig } = require('./runtimeConfig')

const KEY = 'windowState'

/* The size a machine that has never been told anything opens at. Kept here
   rather than at the call site so that "what we default to" and "what we treat
   as too small to restore" cannot drift apart. */
const DEFAULTS = { width: 1400, height: 900 }
const MIN = { width: 1024, height: 640 }

/**
 * What was saved, or null when this is the first run.
 *
 * Null rather than the defaults: the caller has to tell the difference between
 * "open it maximised because they left it maximised" and "nobody has said", and
 * a filled-in default erases that distinction.
 */
function read() {
  const saved = readConfig()[KEY]
  if (!saved || typeof saved !== 'object') return null

  const { width, height, x, y, maximized } = saved

  /* Maximised is the one state that survives without bounds. A window that was
     maximised on a 4K screen and is now opening on a laptop has no meaningful
     size to restore — but "they want it maximised" is still true, and is the
     part worth keeping. */
  const state = { maximized: maximized === true }

  if (Number.isFinite(width) && Number.isFinite(height)) {
    /* Below the minimum means a corrupt or truncated write, not a wish. The
       window has minWidth/minHeight anyway, so honouring it would produce a
       window that silently disagrees with what we recorded. */
    if (width >= MIN.width && height >= MIN.height) {
      state.width = Math.round(width)
      state.height = Math.round(height)
    }
  }

  /* ── A POSITION IS ONLY VALID ON A SCREEN THAT STILL EXISTS ──────────────
   *
   * The case that matters: a shop runs the back office on a second monitor,
   * the monitor is unplugged (or the machine is a laptop taken home), and the
   * saved x/y point into space that is no longer displayed. Electron will
   * happily place a window there, and the customer opens the app to nothing at
   * all — the taskbar says it is running and the screen is empty.
   *
   * So the position is kept only if some display still contains it. Dropped,
   * the window is centred by Electron, which is the right recovery: visible,
   * on a screen they have.
   */
  if (Number.isFinite(x) && Number.isFinite(y) && onSomeDisplay(x, y)) {
    state.x = Math.round(x)
    state.y = Math.round(y)
  }

  return state
}

/** Is this point inside a display that is currently attached? */
function onSomeDisplay(x, y) {
  try {
    return screen.getAllDisplays().some((display) => {
      const b = display.workArea
      return x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height
    })
  } catch {
    /* screen is unavailable before app.whenReady(). Treating that as "not
       visible" drops the position and centres the window, which is the safe
       direction to fail in. */
    return false
  }
}

/**
 * The options to hand BrowserWindow, merged over the defaults.
 *
 * Note what is NOT returned: `maximized`. A window cannot be born maximised
 * through the constructor — it has to be told after it exists — so that half is
 * applied by apply() below, and leaving it out of here keeps it impossible to
 * pass a key BrowserWindow would ignore and believe it took effect.
 */
function bounds() {
  const saved = read()
  if (!saved) return { ...DEFAULTS }

  return {
    width: saved.width ?? DEFAULTS.width,
    height: saved.height ?? DEFAULTS.height,
    ...(saved.x !== undefined ? { x: saved.x } : {}),
    ...(saved.y !== undefined ? { y: saved.y } : {}),
  }
}

/**
 * Put the window into the state it was left in, and keep it written down.
 *
 * Called once, straight after the window is constructed.
 */
function apply(win) {
  if (!win) return

  const saved = read()
  if (saved?.maximized) win.maximize()

  track(win)
}

/**
 * Record what the window is doing, as it does it.
 *
 * ── WHY NOT JUST SAVE ON 'close' ────────────────────────────────────────────
 *
 * Because the close we most want to survive is the one that never fires it. A
 * shop PC is switched off at the wall, and a counter machine is force-quit by
 * somebody who thinks it has hung; neither delivers a clean 'close'. Saving as
 * we go means the worst case is losing the last few seconds of resizing, rather
 * than losing the customer's preference entirely on the exact machines most
 * likely to be turned off rudely.
 *
 * Debounced because 'resize' fires continuously while a window is dragged, and
 * this writes a file.
 */
function track(win) {
  let timer = null

  const save = () => {
    clearTimeout(timer)
    timer = setTimeout(() => persist(win), 400)
  }

  win.on('resize', save)
  win.on('move', save)
  /* Not covered by resize/move on every platform — Windows reports a maximise
     as a resize, but leaning on that would make this silently platform-
     dependent. */
  win.on('maximize', save)
  win.on('unmaximize', save)

  /* The clean exit still gets a synchronous, un-debounced write: it is the
     common path, and it must not lose a maximise performed in the last
     fraction of a second before closing. */
  win.on('close', () => {
    clearTimeout(timer)
    persist(win)
  })
}

/**
 * Write the window's current state.
 *
 * Best-effort throughout. This runs on 'close', where a throw would come from
 * a disk that is full or a config being written by something else — and none of
 * that is worth stopping the app from closing over. Losing a remembered window
 * size is a small cost; a shop that cannot shut the app down is not.
 */
function persist(win) {
  try {
    if (!win || win.isDestroyed()) return

    const maximized = win.isMaximized()

    /* ── THE SIZE UNDER A MAXIMISED WINDOW, NOT THE SCREEN ───────────────────
     *
     * getBounds() on a maximised window returns the screen. Saving that would
     * mean a customer who maximises once can never get their old window size
     * back by restoring down — it would restore to full-screen-sized, which
     * looks like the un-maximise did nothing.
     *
     * getNormalBounds() is the size the window would return to, which is
     * exactly the thing worth remembering alongside the maximised flag.
     */
    const b = win.getNormalBounds()

    const cfg = readConfig()
    cfg[KEY] = {
      width: b.width,
      height: b.height,
      x: b.x,
      y: b.y,
      maximized,
    }
    writeConfig(cfg)
  } catch {
    /* See the docblock. */
  }
}

module.exports = { bounds, apply, read }

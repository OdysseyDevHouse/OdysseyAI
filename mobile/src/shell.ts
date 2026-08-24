import { App } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { APP_URL, ensureSession, enrol, isEnrolled, signOut, unlock } from './auth'

/**
 * What the app does between being tapped and showing the dashboard.
 *
 * ── THE ORDER MATTERS ───────────────────────────────────────────────────────
 *
 *   1. unlock       — the device's own biometry, before anything is read
 *   2. ensureSession — trade the stored token for a fresh session cookie
 *   3. navigate      — hand the WebView the real app, already signed in
 *
 * Nothing is shown between 1 and 3 except the shell's own splash. The single
 * thing that would give the wrapper away is a login form appearing inside the
 * WebView, so the web layer must never be reached without a session — which is
 * why the exchange happens HERE and not in a page.
 *
 * ── RESUMING IS A COLD START ────────────────────────────────────────────────
 *
 * A phone left in a pocket for a day comes back with an expired session, so
 * `appStateChange` re-runs the exchange rather than trusting what the WebView
 * still holds. Cheap — one request — and it is the difference between opening
 * the app to yesterday's dashboard and opening it to a login screen.
 */

export type ShellState =
  /** No token stored: show the login form. */
  | { screen: 'login' }
  /** Signed in and pointed at the app. */
  | { screen: 'app'; siteName: string }
  /** Biometry refused, or cancelled. */
  | { screen: 'locked' }
  /** Enrolled, but the server could not be reached. */
  | { screen: 'offline' }

export function platform(): 'ios' | 'android' {
  return Capacitor.getPlatform() === 'ios' ? 'ios' : 'android'
}

/**
 * Something the owner will recognise in the revoke list.
 *
 * The device's real name needs a permission on both platforms and would be one
 * more prompt at first run for a cosmetic gain, so this is derived from what is
 * free. A person with two phones sees "iPhone" twice and renames neither — but
 * they can still tell them apart by the "last used" line beside each, which is
 * the thing that actually answers "which one did I lose".
 */
export function deviceLabel(): string {
  return platform() === 'ios' ? 'iPhone or iPad' : 'Android device'
}

/**
 * Bring the app to a usable state. Called on launch and on resume.
 *
 * `skipUnlock` is for the resume path: re-prompting for a face every time
 * somebody glances at another app and comes back is how a security feature
 * becomes the reason people stop using the product. The launch path always
 * asks.
 */
export async function start(options: { skipUnlock?: boolean } = {}): Promise<ShellState> {
  if (!(await isEnrolled())) return { screen: 'login' }

  if (!options.skipUnlock && !(await unlock())) return { screen: 'locked' }

  const session = await ensureSession()
  if (!session) {
    /* Two very different causes, and the difference is knowable: the token was
       revoked (the exchange 401s and clears it) or the network is down (it does
       not). isEnrolled() answers which — a cleared token means revoked. */
    return (await isEnrolled()) ? { screen: 'offline' } : { screen: 'login' }
  }

  return { screen: 'app', siteName: session.site.name }
}

/** First run: enrol, then go straight in rather than asking to sign in again. */
export async function signInAndStart(
  email: string,
  password: string,
): Promise<{ ok: true; state: ShellState } | { ok: false; error: string }> {
  const result = await enrol(email, password, platform(), deviceLabel())
  if (!result.ok) return result

  /* No unlock prompt here: they have just proved who they are with a password,
     and asking for a fingerprint one second later is theatre. */
  return { ok: true, state: await start({ skipUnlock: true }) }
}

export async function signOutAndReset(): Promise<ShellState> {
  await signOut()
  return { screen: 'login' }
}

/**
 * Wire the app's lifecycle up.
 *
 * Returns the first state so the caller can paint something immediately rather
 * than waiting on a callback.
 */
export async function attach(onState: (state: ShellState) => void): Promise<ShellState> {
  App.addListener('appStateChange', ({ isActive }) => {
    if (!isActive) return
    /* Resume: re-mint quietly. skipUnlock, per the note on `start` — this fires
       when somebody switches back from their camera roll, not only after a day. */
    void start({ skipUnlock: true }).then(onState)
  })

  /*
   * Android's back gesture.
   *
   * Without this, back at the top level closes the app from anywhere — including
   * three screens deep, which reads as a crash. The WebView's own history is
   * the right thing to walk, and only when it is exhausted does back mean exit.
   */
  App.addListener('backButton', ({ canGoBack }) => {
    if (canGoBack) window.history.back()
    else void App.exitApp()
  })

  return start()
}

/** Where the WebView should point once there is a session. */
export function appUrl(): string {
  return APP_URL
}

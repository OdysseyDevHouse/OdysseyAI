import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin'
import { NativeBiometric, BiometryType } from '@capgo/capacitor-native-biometric'

/**
 * How the app stays signed in.
 *
 * ── THE SHAPE OF IT ─────────────────────────────────────────────────────────
 *
 *   first run   →  email + password  →  /api/mobile/auth/login  →  refresh token
 *   every run   →  refresh token     →  /api/mobile/auth/session →  session cookie
 *   sign out    →  refresh token     →  /api/mobile/auth/revoke
 *
 * The refresh token is the long-lived credential and never leaves the device;
 * the session cookie it buys is the same twelve-hour one a browser gets. That
 * split is what lets the app open straight onto the dashboard while the thing
 * an attacker could steal from the server side stays short-lived.
 *
 * ── WHY THE EXCHANGE RUNS ON EVERY COLD START ───────────────────────────────
 *
 * Not as a fallback — as the normal path. WKWebView's cookie store is not
 * reliable across restarts and ITP can evict cookies on its own schedule, so an
 * app that trusted a persisted cookie would show a login form at unpredictable
 * intervals with nothing to explain it. Re-minting costs one request and makes
 * the state deterministic.
 *
 * It also has to happen mid-session: twelve hours is shorter than a shift, so
 * `ensureSession` is called again whenever a request comes back 401.
 */

const TOKEN_KEY = 'odyssey.refresh.token'

/** Where the app talks to. Injected at build time — see capacitor.config.ts. */
export const APP_URL: string =
  (globalThis as { __ODYSSEY_APP_URL__?: string }).__ODYSSEY_APP_URL__ ??
  'https://app.odyssey.co.za'

export type SessionInfo = {
  site: { id: number; name: string; code: string }
  sites: { id: number; name: string; code: string }[]
  user: { name: string }
}

export type LoginOutcome =
  | { ok: true }
  /** The server refused, with a sentence worth showing. */
  | { ok: false; error: string }

/**
 * Read the stored token.
 *
 * Returns null rather than throwing when nothing is stored: "not signed in yet"
 * is the ordinary first-run state, not an error to report.
 */
async function readToken(): Promise<string | null> {
  try {
    const { value } = await SecureStoragePlugin.get({ key: TOKEN_KEY })
    return value || null
  } catch {
    /* The plugin throws rather than returning empty when the key is absent. */
    return null
  }
}

async function writeToken(token: string): Promise<void> {
  await SecureStoragePlugin.set({ key: TOKEN_KEY, value: token })
}

async function clearToken(): Promise<void> {
  try {
    await SecureStoragePlugin.remove({ key: TOKEN_KEY })
  } catch {
    /* Already gone is the outcome we wanted. */
  }
}

/** Has this device ever been enrolled? Decides login screen vs straight in. */
export async function isEnrolled(): Promise<boolean> {
  return (await readToken()) !== null
}

/**
 * Enrol this device: the one time the app asks for a password.
 *
 * The platform and a device label go with it so the revoke list in the back
 * office can say "Tiaan's iPhone" rather than showing a row of identical
 * entries that nobody can tell apart when one of them needs cutting off.
 */
export async function enrol(
  email: string,
  password: string,
  platform: 'ios' | 'android',
  label: string,
): Promise<LoginOutcome> {
  let res: Response
  try {
    res = await fetch(`${APP_URL}/api/mobile/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, platform, label }),
    })
  } catch {
    return { ok: false, error: 'Could not reach the server. Check your connection.' }
  }

  const body = (await res.json().catch(() => null)) as { token?: string; error?: string } | null

  if (!res.ok || !body?.token) {
    /* The server's own sentence. It already distinguishes a locked account from
       a wrong password, and says plainly when 2FA or a forced password change
       means this has to be done on the web instead. Rewriting it here would be
       a second, worse policy on what a stranger gets told. */
    return { ok: false, error: body?.error ?? 'Could not sign in.' }
  }

  await writeToken(body.token)
  return { ok: true }
}

/**
 * Trade the stored token for a live session cookie.
 *
 * Returns null when there is nothing stored or the token has been revoked — in
 * both cases the shell shows the login screen, because both mean the same thing
 * to the person holding the phone.
 *
 * A revoked token CLEARS itself here. Leaving it would make every launch spend
 * a request proving the same thing, and would leave a dead credential sitting
 * in the keystore of a phone that may since have been sold.
 */
export async function ensureSession(siteId?: number): Promise<SessionInfo | null> {
  const token = await readToken()
  if (!token) return null

  let res: Response
  try {
    res = await fetch(`${APP_URL}/api/mobile/auth/session`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        /* So the server renders the phone's chrome rather than the desktop
           sidebar. The proxy turns this into a cookie, which is what keeps the
           layout right on navigations the PAGE starts — a WebView does not
           attach custom headers to those. */
        'x-odyssey-shell': 'mobile',
      },
      body: JSON.stringify(siteId ? { siteId } : {}),
      /* The Set-Cookie has to land in the WebView's jar, not just this fetch. */
      credentials: 'include',
    })
  } catch {
    return null
  }

  if (res.status === 401) {
    await clearToken()
    return null
  }
  if (!res.ok) return null

  return (await res.json().catch(() => null)) as SessionInfo | null
}

/**
 * Sign out on this device.
 *
 * Tells the server first, so the token dies even if the app is deleted straight
 * afterwards — then clears locally regardless of what the server said. A failed
 * request must not leave somebody apparently signed in on a phone they are
 * handing to somebody else.
 */
export async function signOut(): Promise<void> {
  const token = await readToken()
  if (token) {
    try {
      await fetch(`${APP_URL}/api/mobile/auth/revoke`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
    } catch {
      /* Offline. The local clear below still happens — see above. */
    }
  }
  await clearToken()
}

/**
 * The device's own unlock, before the stored token is used.
 *
 * ── WHAT THIS IS AND IS NOT ─────────────────────────────────────────────────
 *
 * It is a gate on THIS APP, not a second factor: the token sits in the
 * Keychain/Keystore either way and the server never learns whether a face was
 * checked. What it buys is that a phone picked up off a table does not show
 * last month's turnover to whoever picked it up.
 *
 * Fails OPEN when the device has no biometry configured, deliberately. A phone
 * with no fingerprint enrolled would otherwise be permanently locked out of an
 * app it is entitled to run, and the honest fallback — the device passcode — is
 * exactly what `NativeBiometric` falls back to when asked to.
 */
export async function unlock(): Promise<boolean> {
  let available = false
  try {
    const result = await NativeBiometric.isAvailable({ useFallback: true })
    available = result.isAvailable && result.biometryType !== BiometryType.NONE
  } catch {
    available = false
  }

  if (!available) return true

  try {
    await NativeBiometric.verifyIdentity({
      reason: 'Open Odyssey',
      title: 'Unlock Odyssey',
      subtitle: '',
      description: '',
      /* iOS only, both of them: the device passcode when a finger or a face
         will not read. Android ignores them — BiometricPrompt cannot offer a
         device-credential fallback and a cancel button at once. */
      useFallback: true,
      fallbackTitle: 'Use passcode',
      /* So Android has an answer to the same problem. Without retries a wet
         thumb on a rainy morning is a locked-out manager, and the plugin's
         default is a single attempt. */
      maxAttempts: 3,
    })
    return true
  } catch {
    /* Cancelled, or failed too many times. Not an error to report — the person
       chose not to open the app. */
    return false
  }
}

'use client'

/**
 * The setup wizard's half of the Electron bridge, typed.
 *
 * `electron/preload.js` exposes these under `window.odyssey.dbSetup`. Reaching
 * into `window` untyped at each call site would mean the screen and the bridge
 * could drift silently — a renamed channel would surface as `undefined is not a
 * function` in front of a technician, mid-install.
 *
 * Every method here answers rather than throws, because a wizard has to put a
 * failure on a screen rather than take the window down with it.
 *
 * Note what is NOT here: no way to read the plan in full. `plan()` answers what
 * `redact()` produced, and the shop's database password stays in the main
 * process. See electron/dbSetupBridge.js.
 */

export type SetupSignIn =
  | { ok: true; userId: number; email: string; fullName: string | null }
  | { ok: false; error: string }

export type SetupSite = { id: number; code: string; displayName: string }

/** `redact(plan)` — the same three shapes, with the password replaced. */
export type SafePlan =
  | {
      action: 'provision'
      siteId: number
      siteCode: string
      siteName: string
      connectionType: 'hybrid' | 'local'
      purpose: string
      host: string
      port: number
      databaseName: string
      username: string
      password: string
      alreadyInstalled: boolean
    }
  | { action: 'nothing'; siteId: number; siteCode: string; siteName: string; reason: string }
  | { action: 'refuse'; reason: string }

export type ProvisionResult =
  | { ok: true; siteId: number; needsOwner: boolean }
  | { ok: false; error: string }

export type OwnerResult = { ok: true; id: number } | { ok: false; error: string }

type DbSetupBridge = {
  signIn(email: string, password: string): Promise<SetupSignIn>
  sites(): Promise<{ ok: true; sites: SetupSite[] } | { ok: false; error: string }>
  plan(siteId: number, allowFrom?: string): Promise<SafePlan>
  provision(): Promise<ProvisionResult>
  createOwner(name: string, pin: string): Promise<OwnerResult>
  onProgress(callback: (message: string) => void): () => void
}

/**
 * The bridge, or null in a browser.
 *
 * Null is a real state rather than a defensive one: `npm run dev` serves this
 * route in a plain browser with no preload attached, and the screen says so
 * instead of failing at the first click.
 */
export function dbSetup(): DbSetupBridge | null {
  if (typeof window === 'undefined') return null
  const bridge = (window as unknown as { odyssey?: { dbSetup?: DbSetupBridge } }).odyssey
  return bridge?.dbSetup ?? null
}

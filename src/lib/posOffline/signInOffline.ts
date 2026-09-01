'use client'

import { deriveVerifier, verifierMatches } from '../offlinePin'
import { currentWindowId, ensureWindowId, windowMatches } from '../windowSession'
import { KV } from './db'
import { kvGet, kvPut } from './store'
import { storedOperators } from './catalog'
import type { OfflineOperator } from '../site/offlineOperators'

/**
 * Signing in at a till with no database.
 *
 * ── WHAT THIS CAN AND CANNOT DECIDE ───────────────────────────────────────
 *
 * It decides WHO IS STANDING HERE, which is all a till needs to start selling and
 * to attribute what it sells. It does not decide what that person may do: the
 * capabilities come from the catalog, resolved server-side from their role, and are
 * re-derived server-side AGAIN at sync. A till that decided its own permissions
 * would be a till somebody could grant themselves a void on.
 *
 * ── WHY EVERY OPERATOR IS TRIED ───────────────────────────────────────────
 *
 * A cashier types a PIN, not a name — the same as online, where `signInWithPin`
 * loops every user for exactly this reason. So this derives a verifier per operator
 * and compares. At 2.4M iterations that is ~240ms EACH, so a shop with twelve till
 * users costs up to ~3s for a wrong PIN.
 *
 * That is the cost of not making cashiers pick their name off a list first, and it
 * is paid only on a MISS: a correct PIN usually matches within the first few, and
 * the loop stops there. It is also why the derivation is not parallelised — twelve
 * concurrent PBKDF2 derivations on a cheap till would freeze the UI thread, and a
 * frozen till reads as broken where a slow one reads as thinking.
 *
 * ── RATE LIMITING IS LOCAL, AND THAT IS A REAL LIMIT ──────────────────────
 *
 * The lockout lives in IndexedDB, so somebody with DevTools can clear it. It is
 * therefore a guard against a person guessing at a counter, not against an attacker
 * holding the machine — the thing that actually protects the verifier is the 2.4M
 * iteration cost and a salt they cannot construct. Stated plainly here so nobody
 * mistakes this for the security boundary.
 */

export const MAX_ATTEMPTS = 5
export const LOCKOUT_MS = 60_000

export type Attempts = { count: number; lockedUntil: number | null }

/**
 * What a wrong PIN does to the attempt counter.
 *
 * Pure, and exported, because it is the whole of the lockout policy and the rest of
 * this module needs IndexedDB to run. A rule that can only be exercised in a browser
 * is a rule nobody exercises — and getting the reset-on-lockout wrong (leaving the
 * count at 5 rather than zeroing it) would lock a cashier out permanently after their
 * first mistake past the threshold.
 */
export function afterWrongPin(attempts: Attempts, now: number): Attempts {
  const count = attempts.count + 1
  return count >= MAX_ATTEMPTS
    ? // Zeroed, not left at the ceiling: the lockout IS the punishment, and the
      // next window starts fresh so one slow-fingered morning does not compound.
      { count: 0, lockedUntil: now + LOCKOUT_MS }
    : { count, lockedUntil: null }
}

/** Whether the pad should refuse outright, and for how long. */
export function lockoutRemaining(attempts: Attempts | null, now: number): number {
  if (!attempts?.lockedUntil || attempts.lockedUntil <= now) return 0
  return Math.ceil((attempts.lockedUntil - now) / 1000)
}

const ATTEMPTS_KEY = 'pinAttempts'

export type OfflineSignIn =
  | {
      ok: true
      operator: { userId: number; name: string; capabilities: string[] }
    }
  | { ok: false; error: string; lockedForSeconds?: number }

/** The offline session, mirroring what the till cookie carries online. */
export type OfflineSession = {
  userId: number
  name: string
  capabilities: string[]
  signedInAt: string
  /** 8h, matching TILL_COOKIE — a shift, not a day. */
  expiresAt: string
  /**
   * The TAB this was signed in on — the offline half of the same rule the till
   * cookie follows. See `src/lib/windowSession.ts`.
   *
   * It matters MORE here than online, not less. IndexedDB is shared across every
   * tab on the origin and survives a browser restart outright, so without this an
   * offline session is the most durable identity in the app — a till closed at
   * 17:00 would still be that cashier at 21:00 for anyone who reopened it.
   *
   * Optional for the same reason `wid` is optional on the cookie: a session
   * written by an earlier build carries none, and refusing those would sign a
   * shop's till out the moment it updated.
   */
  wid?: string
}

const SESSION_HOURS = 8

/**
 * Checks a typed PIN against the verifiers this device holds.
 *
 * Returns the operator rather than storing anything, so the caller decides what a
 * successful sign-in means. `startOfflineSession` is the usual next step.
 */
export async function signInOffline(siteId: number, pin: string): Promise<OfflineSignIn> {
  const attempts = (await kvGet<Attempts>(siteId, ATTEMPTS_KEY)) ?? { count: 0, lockedUntil: null }

  const locked = lockoutRemaining(attempts, Date.now())
  if (locked > 0) {
    return {
      ok: false,
      error: 'Too many wrong PINs. Wait a moment and try again.',
      lockedForSeconds: locked,
    }
  }

  const operators = await storedOperators(siteId)
  if (operators.length === 0) {
    return {
      ok: false,
      /* Named precisely, because the fix is specific and somebody has to know it:
         this till has never pulled a catalog, so it holds no verifiers at all. */
      error: 'This till has no offline sign-in details yet. Connect once, then it will work offline.',
    }
  }

  const ready = operators.filter((o) => o.offlineReady)
  if (ready.length === 0) {
    return {
      ok: false,
      // Distinct from the message above: the catalog IS here, but nobody has set a
      // PIN since offline sign-in was switched on.
      error: 'Nobody has signed in on this machine yet. Each person needs to enter their PIN once while online.',
    }
  }

  const match = await findOperator(ready, pin)

  if (!match) {
    const next = afterWrongPin(attempts, Date.now())
    await kvPut(siteId, ATTEMPTS_KEY, next)

    /*
     * Names nobody. "That PIN was not recognised" rather than "wrong PIN for Ruth" —
     * a lock screen that confirms which PINs exist is a lock screen that helps
     * somebody guess, and the till's own operator list is not public information.
     */
    return next.lockedUntil
      ? {
          ok: false,
          error: 'Too many wrong PINs. Wait a minute and try again.',
          lockedForSeconds: LOCKOUT_MS / 1000,
        }
      : { ok: false, error: 'That PIN was not recognised.' }
  }

  await kvPut(siteId, ATTEMPTS_KEY, { count: 0, lockedUntil: null } satisfies Attempts)
  return {
    ok: true,
    operator: { userId: match.userId, name: match.name, capabilities: match.capabilities },
  }
}

/**
 * The operator whose verifier this PIN reproduces, or null.
 *
 * Sequential on purpose — see the module note on why this is not parallelised.
 *
 * Exported so it can be tested in Node: it needs only WebCrypto, unlike everything
 * around it, and it is the assertion that actually matters — that a PIN matches
 * exactly one person, and a wrong one matches nobody.
 */
export async function findOperator(
  operators: readonly OfflineOperator[],
  pin: string,
): Promise<OfflineOperator | null> {
  for (const operator of operators) {
    const derived = await deriveVerifier(pin, operator.saltB64, operator.iterations)
    // Constant-time compare. The timing leak it closes is small, but the fix is one
    // function call and the alternative is arguing about how small.
    if (verifierMatches(derived, operator.verifier)) return operator
  }
  return null
}

export type OfflineOverride =
  | { ok: true; userId: number; name: string }
  | { ok: false; error: string; lockedForSeconds?: number }

/**
 * A supervisor authorising ONE action, offline.
 *
 * Same PIN check, same lockout counter as signing in — it is the same guessing
 * surface, and splitting the counters would double the guesses. The stored
 * capability list is only as fresh as the last catalog; the SERVER re-derives
 * the authoriser's rights at sync (offlineSync's override step), which is the
 * check that actually counts. This one exists so the refusal happens at the
 * counter rather than in tomorrow's exception list.
 */
export async function overrideOffline(
  siteId: number,
  pin: string,
  capability: string,
): Promise<OfflineOverride> {
  const result = await signInOffline(siteId, pin)
  if (!result.ok) return result
  if (!result.operator.capabilities.includes(capability)) {
    return { ok: false, error: `${result.operator.name} cannot authorise that either.` }
  }
  return { ok: true, userId: result.operator.userId, name: result.operator.name }
}

/* ── The session ─────────────────────────────────────────────────────────── */

/**
 * Records who is at the till, offline.
 *
 * Not a cookie — httpOnly needs a server. Eight hours to match `TILL_COOKIE`, so an
 * offline session expires on the same schedule as an online one and a till left
 * unlocked overnight asks again in the morning.
 */
export async function startOfflineSession(
  siteId: number,
  operator: { userId: number; name: string; capabilities: string[] },
): Promise<OfflineSession> {
  const now = new Date()
  const session: OfflineSession = {
    userId: operator.userId,
    name: operator.name,
    capabilities: operator.capabilities,
    signedInAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_HOURS * 3_600_000).toISOString(),
    /* Bound to this tab, so closing the window ends the shift here too. Unset
       rather than '' when the browser forbids sessionStorage — `windowMatches`
       reads an absent claim as unbound, which keeps such a till trading on the
       eight-hour rule instead of refusing every sign-in it makes. */
    wid: ensureWindowId() || undefined,
  }
  await kvPut(siteId, KV.operator, session)
  return session
}

/**
 * The offline session, or null when there is none, it has expired, or it
 * belongs to a window that has since been closed.
 */
export async function offlineSession(siteId: number): Promise<OfflineSession | null> {
  const session = await kvGet<OfflineSession>(siteId, KV.operator)
  if (!session) return null
  if (Date.parse(session.expiresAt) <= Date.now()) return null
  /* `currentWindowId`, NOT `ensureWindowId`: minting an id while READING would
     hand a fresh tab an id and then compare it against the stored one — always a
     mismatch, so it would happen to work, but by accident. Worse, it would write
     a cookie on a page load that never signed anybody in. Reading asks; only
     signing in mints. */
  if (!windowMatches(session.wid, currentWindowId() || null)) return null
  return session
}

export async function endOfflineSession(siteId: number): Promise<void> {
  await kvPut(siteId, KV.operator, null)
}

/**
 * Whether this till could sign anybody in with the network gone.
 *
 * Read before offering the PIN pad as an offline option, so a till that cannot do it
 * says so rather than accepting a correct PIN and refusing it.
 */
export async function canSignInOffline(siteId: number): Promise<boolean> {
  const operators = await storedOperators(siteId)
  return operators.some((o) => o.offlineReady)
}

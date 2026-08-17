import { MODULE_KEYS, type ModuleKey, type AccountStatus } from '@/lib/control/modules'
import type { LicenceRefusal } from '@/lib/control/devices'

/**
 * The lease RULES: what a lease means, with no database attached.
 *
 * Split from lease.ts deliberately. That file is `server-only` because it opens
 * a connection; this one decides whether a shop may trade, which is the part
 * worth being able to test exhaustively without a MySQL server, and the part
 * that must never quietly change.
 *
 * Nothing here does I/O and nothing here reads a clock it was not handed. Every
 * function takes `now`, so one decision uses one instant throughout rather than
 * sampling the clock three times and landing either side of a boundary.
 */

/** How long a successful check buys. The rule the customer agreed to. */
export const LEASE_DAYS = 7

/** How long an offline unlock buys. Longer, because it is a real interruption. */
export const UNLOCK_GRANT_DAYS = 14

const DAY_MS = 86_400_000

export type Lease = {
  siteId: number
  deviceSerial: string | null
  licenceStatus: 'licensed' | LicenceRefusal
  held: ReadonlySet<ModuleKey>
  endingOn: ReadonlyMap<ModuleKey, string>
  accountStatus: AccountStatus | null
  /** The last time the control panel actually answered. Moves on nothing else. */
  checkedAt: Date
  expiresAt: Date
  unlockCounter: number
  lastUnlockAt: Date | null
}

export type LeaseState =
  /** Confirmed recently enough. Trade normally. */
  | { status: 'current'; lease: Lease }
  /**
   * Past expiry with no contact. The machine locks.
   *
   * Carries the lease so the locked screen can say what it last knew: "your
   * subscription lapsed" and "we have not been able to check" are two different
   * conversations, and a screen that cannot tell them apart sends every
   * customer to the wrong one.
   */
  | { status: 'expired'; lease: Lease }
  /**
   * No lease was ever written — mid-install, or restored from a backup.
   *
   * Deliberately NOT a lock. Locking here would mean a fresh install could
   * never complete its first check, and it is the one state where there is
   * nothing yet to be dishonest about.
   */
  | { status: 'none' }

/** Is this machine still inside its lease? */
export function leaseState(lease: Lease | null, now: Date = new Date()): LeaseState {
  if (!lease) return { status: 'none' }
  return lease.expiresAt.getTime() > now.getTime()
    ? { status: 'current', lease }
    : { status: 'expired', lease }
}

/** Whole days left, floored, for "locks in 3 days". Never negative. */
export function daysRemaining(lease: Lease, now: Date = new Date()): number {
  const ms = lease.expiresAt.getTime() - now.getTime()
  return ms <= 0 ? 0 : Math.floor(ms / DAY_MS)
}

/** How long a machine has been unable to reach us — what support wants to know. */
export function daysSinceCheck(lease: Lease, now: Date = new Date()): number {
  const ms = now.getTime() - lease.checkedAt.getTime()
  return ms <= 0 ? 0 : Math.floor(ms / DAY_MS)
}

/** When a check now would push the lease out to. */
export function leaseExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + LEASE_DAYS * DAY_MS)
}

/** When an unlock granted now would push the lease out to. */
export function unlockExpiryFrom(now: Date, days: number = UNLOCK_GRANT_DAYS): Date {
  return new Date(now.getTime() + days * DAY_MS)
}

/**
 * Should the machine warn before it locks?
 *
 * A shop must never be surprised by a locked till. Two days is enough to ring
 * somebody without being so early it becomes background noise the staff learn
 * to dismiss.
 */
export const WARN_WITHIN_DAYS = 2

export function shouldWarn(state: LeaseState, now: Date = new Date()): boolean {
  return state.status === 'current' && daysRemaining(state.lease, now) <= WARN_WITHIN_DAYS
}

/**
 * Parse the stored module list.
 *
 * Filtered against the live catalogue: a lease written by an older build may
 * name a module this one has never heard of, and an unknown key must not
 * become a permission just because it was once written to disk.
 */
export function parseModules(json: string | null): Set<ModuleKey> {
  if (!json) return new Set()
  try {
    const raw: unknown = JSON.parse(json)
    if (!Array.isArray(raw)) return new Set()
    return new Set(raw.filter((k): k is ModuleKey => (MODULE_KEYS as readonly unknown[]).includes(k)))
  } catch {
    return new Set()
  }
}

/** Parse module -> last day. A malformed blob costs a chip on a screen, not access. */
export function parseEndingOn(json: string | null): Map<ModuleKey, string> {
  const out = new Map<ModuleKey, string>()
  if (!json) return out
  try {
    const raw: unknown = JSON.parse(json)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if ((MODULE_KEYS as readonly string[]).includes(k)) out.set(k as ModuleKey, String(v).slice(0, 10))
    }
  } catch {
    /* deliberately swallowed */
  }
  return out
}

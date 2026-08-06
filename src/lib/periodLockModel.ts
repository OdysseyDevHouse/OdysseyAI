/**
 * Accounting-period facts shared by the server and the browser.
 *
 * No `server-only` marker and no database import, because the Periods screen
 * runs in the browser and needs these labels and this shape. Importing the
 * server module for a constant would drag mysql2 — and therefore `net` and
 * `tls` — into the client bundle, which fails the build outright.
 *
 * The enforcement stays on the server: lib/site/periodLocks.ts is what
 * actually refuses a posting into a locked period.
 */

export type LockType = 'soft' | 'hard'
export type LockScope = 'all' | 'sales' | 'purchases' | 'ledger' | 'stock'

export const LOCK_SCOPES: LockScope[] = ['all', 'sales', 'purchases', 'ledger', 'stock']

export const SCOPE_LABELS: Record<LockScope, string> = {
  all: 'Everything',
  sales: 'Sales and invoicing',
  purchases: 'Purchasing and GRVs',
  ledger: 'Customer and supplier ledgers',
  stock: 'Stock movements',
}

export type PeriodLock = {
  id: number
  periodFrom: string
  periodTo: string
  lockType: LockType
  scope: LockScope
  scopeLabel: string
  reason: string | null
  lockedAt: Date
  lockedBy: string
  unlockedAt: Date | null
  unlockedBy: string | null
  unlockReason: string | null
  /** False once unlocked — the row is kept for the audit trail. */
  active: boolean
}

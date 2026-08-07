import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteExecute, siteQuery } from '../siteDb'

/**
 * The audit trail — what PEOPLE did.
 *
 * Not the ledger. When the sub-ledger lands, customer_transactions will record
 * what MONEY did; these two answer different questions and the account screen
 * shows them on separate tabs. "Who put this on hold?" is here. "What is this
 * balance made of?" is not.
 *
 * Writes never throw. An audit line failing must not roll back the change it
 * was describing — losing the log entry is bad, losing the edit is worse.
 */

export type ActivityEntity =
  | 'customer'
  | 'supplier'
  | 'product'
  | 'department'
  /* Not a record with an id — settings changes log with entityId null. Worth
     auditing anyway: opening a public storefront is the single most
     consequential switch in the app. */
  | 'online_store'
  /* A bank or cash account: captures, matches, reconciliation sign-offs and
     statement imports. Money moving is the thing most worth an audit trail. */
  | 'bank'
  /* Closing and reopening an accounting period. entityId is the lock's id —
     "who reopened February" is the question this exists to answer. */
  | 'period'
  /* Spending that is not stock: bills, direct payments, categories and the
     recurring schedules that generate them. */
  | 'expense'
  /* The general ledger: accounts, journals, mappings and year end. Anything
     that changes what the financial statements say. */
  | 'gl'
  /* Chasing money that is owed: dunning runs and their levels, promises to
     pay, and the credit holds collections places on an account. entityId is
     the customer for anything account-level, the run for anything batch-level.
     "Who released the final demands" and "who took this account off hold" both
     live here. */
  | 'credit'

export type ActivityEvent = {
  id: number
  entity: string
  entityId: number | null
  action: string
  detail: string | null
  changes: Record<string, { from: unknown; to: unknown }> | null
  userId: number | null
  userName: string
  createdAt: Date
}

type Row = RowDataPacket & Record<string, unknown>

function mapEvent(r: Row): ActivityEvent {
  return {
    id: Number(r.id),
    entity: String(r.entity),
    entityId: r.entity_id === null ? null : Number(r.entity_id),
    action: String(r.action),
    detail: (r.detail as string | null) ?? null,
    // mysql2 parses a JSON column for us, but a hand-written row could hold a
    // string — normalise rather than trusting the driver's shape.
    changes: parseChanges(r.changes),
    userId: r.user_id === null ? null : Number(r.user_id),
    userName: String(r.user_name ?? ''),
    createdAt: r.created_at as Date,
  }
}

function parseChanges(value: unknown): ActivityEvent['changes'] {
  if (!value) return null
  if (typeof value === 'object') return value as ActivityEvent['changes']
  try {
    return JSON.parse(String(value))
  } catch {
    return null
  }
}

/** Who is acting. Threaded from the session — see requireSession() in lib/auth. */
export type Actor = { userId: number; userName: string }

export type ActivityInput = {
  entity: ActivityEntity
  entityId: number | null
  action: string
  detail?: string | null
  changes?: Record<string, { from: unknown; to: unknown }> | null
}

/**
 * Record one event.
 *
 * Swallows its own errors on purpose: this is called after the write it
 * describes has already succeeded, so throwing here would fail an operation
 * that actually worked. A missing audit row is visible on the Activity tab; a
 * spurious "could not save" is not recoverable by the user.
 */
export async function logActivity(
  siteId: number,
  actor: Actor,
  input: ActivityInput,
): Promise<void> {
  try {
    await siteExecute(
      siteId,
      `INSERT INTO activity_log (entity, entity_id, action, detail, changes, user_id, user_name)
       VALUES (?,?,?,?,?,?,?)`,
      [
        input.entity,
        input.entityId,
        input.action,
        input.detail?.slice(0, 400) ?? null,
        input.changes ? JSON.stringify(input.changes) : null,
        actor.userId,
        actor.userName.slice(0, 120),
      ],
    )
  } catch (error) {
    console.error('activity_log write failed', error)
  }
}

/**
 * Record an event on a connection that is already in a transaction.
 *
 * Use this when the audit row must live or die with the change — a bulk status
 * update, a ledger posting. Unlike logActivity it does NOT swallow errors,
 * because inside a transaction a silent failure would commit the change
 * without its trail.
 */
export async function logActivityTx(
  tx: PoolConnection,
  actor: Actor,
  input: ActivityInput,
): Promise<void> {
  await tx.execute(
    `INSERT INTO activity_log (entity, entity_id, action, detail, changes, user_id, user_name)
     VALUES (?,?,?,?,?,?,?)`,
    [
      input.entity,
      input.entityId,
      input.action,
      input.detail?.slice(0, 400) ?? null,
      input.changes ? JSON.stringify(input.changes) : null,
      actor.userId,
      actor.userName.slice(0, 120),
    ] as never,
  )
}

const SELECT_ACTIVITY = `
  SELECT id, entity, entity_id, action, detail, changes, user_id, user_name, created_at
    FROM activity_log
`

/** One record's history, newest first. Drives the account screen's Activity tab. */
export async function listActivity(
  siteId: number,
  entity: ActivityEntity,
  entityId: number,
  limit = 100,
): Promise<ActivityEvent[]> {
  const capped = Math.min(Math.max(limit, 1), 500)
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_ACTIVITY}
      WHERE entity = ? AND entity_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ${capped}`,
    [entity, entityId],
  )
  return rows.map(mapEvent)
}

/**
 * Field-level differences between two versions of a record.
 *
 * Only changed fields appear, so an edit that touched one field logs one field
 * rather than a wall of unchanged values. Returns null when nothing moved —
 * the caller then skips the log entirely rather than writing "updated" against
 * a save that changed nothing.
 */
export function diffFields<T extends Record<string, unknown>>(
  before: T,
  after: T,
  fields: readonly (keyof T)[],
): Record<string, { from: unknown; to: unknown }> | null {
  const changes: Record<string, { from: unknown; to: unknown }> = {}

  for (const field of fields) {
    const from = before[field] ?? null
    const to = after[field] ?? null
    // Loose compare via String(): a form sends "30" where the row holds 30, and
    // reporting that as a change would make every save look like an edit.
    if (String(from) !== String(to)) {
      changes[String(field)] = { from, to }
    }
  }

  return Object.keys(changes).length > 0 ? changes : null
}

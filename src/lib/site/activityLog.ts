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
  /* A promotion. Worth auditing because it changes what things sell for
     without anyone touching a price: "why did this go out at R75" needs an
     answer, and so does "who switched that off". */
  | 'special'
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
  /* Files attached to a record — the supplier PDF behind a GRV, the receipt
     behind an expense. entityId is the record the file hangs on, not the file,
     because "what happened to GRV-00412" is the question being asked. Worth an
     audit trail on its own: a deleted attachment is a deleted piece of
     evidence. */
  | 'attachment'
  /* The loyalty programme: its rates, tiers, punch cards, and every manual
     movement of points or wallet money. entityId is the CUSTOMER for anything
     touching a member's balance, and null for programme-level settings.

     Points earned and spent by a sale are deliberately NOT logged here — the
     loyalty ledger is already an immutable record of those, and duplicating
     every till transaction into the audit trail would bury the thing this is
     for: "who gave that customer 5 000 points, and why". */
  | 'loyalty'
  /* A scheduled price change: building one, approving it, the moment it fires,
     and putting it back. The firing is logged by a CRON with no person behind
     it, which is exactly why it must be recorded — "why did everything go up on
     Monday" has no other answer, and product_prices keeps no history of its
     own. entityId is the schedule. */
  | 'price_schedule'
  /* A table booking: taking one, confirming it, seating the party, and the two
     ways it can end badly. entityId is the reservation. Worth an audit trail
     because a booking is a promise made to somebody who is not in the room —
     "who cancelled the party of twelve on Saturday" has no other answer, and
     the guest will certainly be asking. */
  | 'reservation'
  /* A job card: who it was assigned to, every status it moved through, and every
     commercial decision taken on its lines. entityId is the job, and null for
     workflow-level settings like the statuses themselves.

     The line decisions are the reason this is here. "Who wrote off the R4 200
     compressor, and why" is the question an owner asks first, and a job card is
     the one record in the app where somebody with no financial permission
     records a cost that somebody else later decides not to charge for. Both
     halves of that need a name against them. */
  | 'job_card'
  /* A support ticket (165). Separate from job_card because it is a separate
     module: a ticket has no money on it, and the questions its trail answers
     are different ones — who picked this up, who had it while the clock ran,
     and who moved it to done.

     The MOVE is the interesting row, because on a ticket a move is also the
     timing act: dragging a card into a running lane opens a time segment. So
     "who started the clock" and "who moved it" are the same question, and this
     is where it is answered. */
  | 'ticket'
  /* A lane on the ticket board: created, renamed, or given one of the exclusive
     flags. Worth auditing because moving the start flag from one lane to
     another silently changes what every future drag does to the clock. */
  | 'ticket_status'
  /* A supervisor authorising one refused action at the till — a discount over
     the cap, a void, a return. The MANAGER is the actor: "who authorised" is
     the question this row answers, and the cashier, the action, the amount and
     the till live in `changes`. entityId is the sale when one exists. Logged at
     authorisation, not at use — a manager who typed their PIN authorised
     something even if the sale then died, and the trail must say so. */
  | 'pos_override'
  /* A line taken back off a basket at the till, before anything posted.

     Separate from `pos_override` because nobody authorised it: an undo is a
     cashier acting within their own rights, and filing it under overrides would
     put a routine mis-scan correction in the list a manager reads to find out
     what they approved. The question THIS answers is different and quieter —
     "what was rung up and then removed" — which is the shape of both an honest
     correction and a cashier walking goods out, and only volume tells them
     apart. So every undo is logged, including the ones inside the limit.

     entityId is the sale's draft document when it has one, and null otherwise:
     an unsaved basket has no id, and most baskets are undone before they get
     one. The product, the quantity, the line's value and how many undos this
     basket had already used live in `changes`. */
  | 'pos_undo'
  /* A gift card event outside a sale — generation, adjustment, void, the
     expiry sweep. Sales-side traffic already lives on the document's own
     audit; this covers the management actions where a balance moves with no
     document behind it, which is exactly where a trail matters most. */
  | 'gift_card'
  /* A back-office user account — access granted, a PIN or 2FA cleared. The
     question this answers is "who changed who could get in", which is the
     first question after anything goes wrong. */
  | 'user'
  /* A piece of customer equipment. Worth auditing separately from the jobs done
     on it, because the questions differ: the job log answers what was done, this
     answers who changed the warranty date, who moved it to another site, and who
     retired it. A warranty expiry quietly edited is a dispute waiting to happen. */
  | 'customer_asset'
  /* The machine door: an API key minted or revoked, a webhook endpoint added
     or its secret rotated. Standing access with no person behind it is
     exactly what a trail must record the granting of. */
  | 'setting'
  /* A field the business defined for itself. entityId is the definition, and
     null when one is deleted — the row it pointed at is gone by then.

     Only the DEFINITION is logged, never the values. A value changing is
     ordinary editing of a record that has its own audit trail; a field being
     added, retired or having its type changed alters what every record of that
     kind is asked for, and "who added a required field that now blocks every
     save" has no other answer. */
  | 'custom_field'

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

/* ── The global audit screen (154) ────────────────────────────────────────── */

export type ActivityLogFilter = {
  entity?: ActivityEntity
  userId?: number
  /** One search box: matches the action exactly OR the detail by LIKE. */
  search?: string
  /** 'YYYY-MM-DD', both inclusive. */
  from?: string
  to?: string
  /** Keyset cursor: strictly older than this row. Never OFFSET. */
  before?: { createdAt: string; id: number }
  limit?: number
}

/**
 * Everything that happened, filtered — the site-wide answer where
 * listActivity answers for one record. Keyset-paginated because a busy site
 * writes this table constantly and OFFSET degrades linearly into it.
 */
export async function listActivityLog(
  siteId: number,
  filter: ActivityLogFilter = {},
): Promise<{ events: ActivityEvent[]; hasMore: boolean }> {
  const where: string[] = []
  const params: unknown[] = []

  if (filter.entity) {
    where.push('entity = ?')
    params.push(filter.entity)
  }
  if (filter.userId) {
    where.push('user_id = ?')
    params.push(filter.userId)
  }
  if (filter.search?.trim()) {
    const term = filter.search.trim()
    where.push('(action = ? OR detail LIKE ?)')
    params.push(term, `%${term}%`)
  }
  if (filter.from && /^\d{4}-\d{2}-\d{2}$/.test(filter.from)) {
    where.push('created_at >= ?')
    params.push(`${filter.from} 00:00:00`)
  }
  if (filter.to && /^\d{4}-\d{2}-\d{2}$/.test(filter.to)) {
    where.push('created_at < DATE_ADD(?, INTERVAL 1 DAY)')
    params.push(filter.to)
  }
  if (filter.before) {
    where.push('(created_at < ? OR (created_at = ? AND id < ?))')
    params.push(filter.before.createdAt, filter.before.createdAt, filter.before.id)
  }

  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200)
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_ACTIVITY}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit + 1}`,
    params,
  )
  return {
    events: rows.slice(0, limit).map(mapEvent),
    hasMore: rows.length > limit,
  }
}

/** Distinct actors seen in the log, for the user filter dropdown. */
export async function listActivityActors(
  siteId: number,
): Promise<Array<{ userId: number | null; userName: string }>> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT user_id, user_name, MAX(created_at) AS last_seen
       FROM activity_log
      GROUP BY user_id, user_name
      ORDER BY last_seen DESC
      LIMIT 100`,
  )
  return rows.map((r) => ({
    userId: r.user_id === null ? null : Number(r.user_id),
    userName: String(r.user_name ?? ''),
  }))
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

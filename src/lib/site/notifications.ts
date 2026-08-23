import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'
import type { Capability, CapabilitySet } from './permissions'

/**
 * In-app notifications — what somebody should HEAR about, behind the bell.
 *
 * One row per EVENT with an audience capability; read state per person in
 * notification_reads. Who may see a row is decided at READ time from the
 * capabilities the request already resolved — so a role change moves what a
 * person sees immediately, with no stale fan-out copies to chase.
 *
 * Not the audit trail: activity_log records what people did, capability-gated
 * as a whole. This is targeted and dismissible. What carries over from there
 * is the fail-soft doctrine — notify() swallows its own errors, because a
 * missed bell must never fail the sale, the receipt or the order it rides on.
 */

export type NotificationEvent =
  | 'online_order_placed'
  | 'sale_voided'
  | 'grv_received'
  | 'low_stock'
  /** A technician asked for a part that is not on the shelf (162). */
  | 'job_part_requested'
  /** The part somebody asked for has arrived. Addressed to them by name. */
  | 'job_part_received'
  /** A promise was missed and nobody has replied yet (164). To one manager. */
  | 'sla_escalation'
  /**
   * Something happened on a job somebody is on — assigned, moved, closed.
   *
   * ONE event for every job notice rather than one per kind, on the same
   * reasoning as `alert_fired` below: which kind it was is the sender's
   * business, and what the bell needs is a title, a line and somewhere to go.
   * The kind is preserved with full fidelity in job_notifications.event (219),
   * which is where an audit reads it from.
   *
   * Always addressed to a named person. The audience for "you have been given
   * this job" is one technician, and a capability-wide row would put it in
   * front of everybody who can see job cards.
   */
  | 'job_notice'
  /**
   * An alert rule found something. Always addressed to a named person: a rule
   * NAMES its recipients, so an audience-wide row would tell the whole shop
   * about something one person asked to watch.
   *
   * One event for every rule kind rather than one per kind, because the kind is
   * the rule's business and not the bell's — what the bell needs is a title, a
   * line and somewhere to go, and all three come from the rule's own message.
   */
  | 'alert_fired'

export type NotificationInput = {
  event: NotificationEvent
  /** Capability that may see it, or null for everyone with a session. */
  audience: Capability | null
  /**
   * Narrows to one person and wins over audience.
   *
   * First producer: `job_part_received` (162), which tells the technician who
   * ASKED that their part has arrived. That is a message for one person — the
   * shop at large does not need it, and an audience-wide version would be noise
   * everyone learns to ignore.
   */
  userId?: number | null
  title: string
  body?: string | null
  href?: string | null
}

/** How long a notification stays before the lazy prune removes it. */
const RETENTION_DAYS = 90

/**
 * Writes one notification. NEVER throws — called from post-commit tails where
 * an error would misreport work that already committed.
 */
export async function notify(siteId: number, input: NotificationInput): Promise<void> {
  try {
    await siteExecute(
      siteId,
      `INSERT INTO notifications (event, audience, user_id, title, body, href)
       VALUES (?,?,?,?,?,?)`,
      [
        input.event,
        input.audience,
        input.userId ?? null,
        input.title.slice(0, 160),
        input.body ? input.body.slice(0, 400) : null,
        input.href ? input.href.slice(0, 190) : null,
      ],
    )
    // Lazy retention: each write sweeps a bounded slice of the tail, so the
    // table cannot grow without bound and no cron is needed.
    await siteExecute(
      siteId,
      `DELETE FROM notifications
        WHERE created_at < DATE_SUB(NOW(), INTERVAL ${RETENTION_DAYS} DAY)
        LIMIT 200`,
    )
  } catch (error) {
    console.error('notify failed (notification dropped):', error)
  }
}

export type Notification = {
  id: number
  event: string
  title: string
  body: string | null
  href: string | null
  createdAt: Date
  readAt: Date | null
}

type Row = RowDataPacket & Record<string, unknown>

/**
 * The visibility clause: rows targeted at this person, plus audience rows
 * their capabilities admit. Owners see every audience (can() semantics); a
 * role-less user sees only audience-null rows.
 */
function visibility(
  userId: number,
  capabilities: CapabilitySet,
): { clause: string; params: unknown[] } {
  const target = '(n.user_id IS NULL OR n.user_id = ?)'
  if (capabilities.isOwner) return { clause: target, params: [userId] }
  const granted = [...capabilities.granted]
  if (granted.length === 0) {
    return { clause: `${target} AND n.audience IS NULL`, params: [userId] }
  }
  return {
    clause: `${target} AND (n.audience IS NULL OR n.audience IN (${granted.map(() => '?').join(',')}))`,
    params: [userId, ...granted],
  }
}

export async function listNotifications(
  siteId: number,
  userId: number,
  capabilities: CapabilitySet,
  opts: { limit?: number } = {},
): Promise<Notification[]> {
  const limit = Math.min(Math.max(opts.limit ?? 15, 1), 100)
  const { clause, params } = visibility(userId, capabilities)
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT n.id, n.event, n.title, n.body, n.href, n.created_at, r.read_at
       FROM notifications n
       LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = ?
      WHERE ${clause}
      ORDER BY n.id DESC
      LIMIT ${limit}`,
    [userId, ...params],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    event: String(r.event),
    title: String(r.title),
    body: (r.body as string | null) ?? null,
    href: (r.href as string | null) ?? null,
    createdAt: r.created_at as Date,
    readAt: (r.read_at as Date | null) ?? null,
  }))
}

export async function unreadCount(
  siteId: number,
  userId: number,
  capabilities: CapabilitySet,
): Promise<number> {
  const { clause, params } = visibility(userId, capabilities)
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT COUNT(*) AS n
       FROM notifications n
       LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = ?
      WHERE ${clause} AND r.user_id IS NULL`,
    [userId, ...params],
  )
  return Number(row?.n ?? 0)
}

/** Idempotent; a vanished notification id is swallowed, not an error. */
export async function markRead(siteId: number, userId: number, notificationId: number): Promise<void> {
  try {
    await siteExecute(
      siteId,
      'INSERT IGNORE INTO notification_reads (notification_id, user_id) VALUES (?,?)',
      [notificationId, userId],
    )
  } catch {
    // FK violation when the row was pruned between render and click — the
    // outcome the user wanted (it is gone) already holds.
  }
}

/** Marks every VISIBLE unread row read — out-of-audience rows stay unread. */
export async function markAllRead(
  siteId: number,
  userId: number,
  capabilities: CapabilitySet,
): Promise<void> {
  const { clause, params } = visibility(userId, capabilities)
  await siteExecute(
    siteId,
    `INSERT IGNORE INTO notification_reads (notification_id, user_id)
     SELECT n.id, ? FROM notifications n
       LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = ?
      WHERE ${clause} AND r.user_id IS NULL`,
    [userId, userId, ...params],
  )
}

/**
 * The order-status MODEL — shared by the server and the browser.
 *
 * Deliberately free of `server-only` and of any database import, because the
 * setup screen is a client component and needs the same labels, roles and
 * notification kinds the server uses. Importing them from site/onlineStore.ts
 * would drag mysql2 into the browser bundle — which is exactly what happened
 * before this file existed.
 *
 * The reading and writing half lives in site/onlineStore.ts.
 */

export type StatusTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger'
export type StatusRole = '' | 'new' | 'completed' | 'cancelled' | 'dispatched'

/** The moments a shopper actually wants to hear about. */
export const STATUS_NOTIFY_KINDS = ['accepted', 'ready', 'on_the_way', 'cancelled'] as const
export type StatusNotifyKind = '' | (typeof STATUS_NOTIFY_KINDS)[number]

/**
 * What each standard message says, as the shop chooses it.
 *
 * Full sentences rather than short labels: the owner is choosing what their
 * customer will read, so the option should BE that rather than a name for it.
 */
export const NOTIFY_KIND_LABEL: Record<Exclude<StatusNotifyKind, ''>, string> = {
  accepted: "We've got your order and we're getting it ready",
  ready: 'Your order is ready',
  on_the_way: 'Your order is on its way',
  cancelled: 'Your order has been cancelled',
}

/**
 * What a status DOES, so code can find the right one without knowing what a
 * particular shop calls it.
 *
 * These three must always exist somewhere: an order has to land somewhere when
 * it arrives, and there has to be a way to say it is done or that it is off.
 * `dispatched` is optional — plenty of shops never deliver.
 */
export const REQUIRED_ROLES = ['new', 'completed', 'cancelled'] as const

export const ROLE_LABEL: Record<Exclude<StatusRole, ''>, string> = {
  new: 'New orders start here',
  completed: 'The order is complete',
  cancelled: 'The order was cancelled',
  dispatched: 'Out for delivery',
}

/** How a refusal describes a role, mid-sentence. */
export function roleMeaning(role: StatusRole): string {
  switch (role) {
    case 'new':
      return 'a new order has just come in'
    case 'completed':
      return 'the order is complete'
    case 'cancelled':
      return 'the order was cancelled'
    case 'dispatched':
      return 'the order is out for delivery'
    default:
      return ''
  }
}

export type OrderStatus = {
  id: number
  code: string
  name: string
  tone: StatusTone
  sortOrder: number
  role: StatusRole
  isActive: boolean
  /**
   * The standard message to send when an order reaches this status, or '' for
   * none. Ignored entirely when `useTemplate` is on.
   */
  notifyKind: StatusNotifyKind
  /**
   * Send the shop's own email instead of a standard message.
   *
   * An explicit flag rather than "is emailHtml empty", so a template can be
   * drafted and parked without going out on every order in the meantime.
   */
  useTemplate: boolean
  emailSubject: string
  emailHtml: string
}

export type OrderStatusInput = {
  /** Null to create. */
  id: number | null
  name: string
  tone: StatusTone
  role: StatusRole
  isActive: boolean
  notifyKind: StatusNotifyKind
  useTemplate: boolean
  emailSubject: string
  emailHtml: string
}

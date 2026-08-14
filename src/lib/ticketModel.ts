/**
 * What a ticket is, expressed without a database.
 *
 * Browser-safe on purpose, mirroring `jobStatusModel`: no `server-only`, no
 * `siteDb` import, so a screen can validate a lane before it saves and get the
 * same answer the action will give. Two copies of a rule are two rules.
 */

export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
export type TicketPriority = (typeof TICKET_PRIORITIES)[number]

/** The same four words job cards use. See 165 for why they are not a new set. */
export const TICKET_PRIORITY_LABEL: Record<TicketPriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
}

export const TICKET_PRIORITY_TONE: Record<TicketPriority, string> = {
  low: 'neutral',
  normal: 'brand',
  high: 'warning',
  urgent: 'danger',
}

export const TICKET_SOURCES = [
  'manual',
  'phone',
  'email',
  'walk_in',
  'internal',
  'portal',
  'public_form',
] as const
export type TicketSource = (typeof TICKET_SOURCES)[number]

export const TICKET_SOURCE_LABEL: Record<TicketSource, string> = {
  manual: 'Logged by us',
  phone: 'Phone',
  email: 'Email',
  walk_in: 'Walk-in',
  internal: 'Internal',
  portal: 'Customer portal',
  public_form: 'Web form',
}

/** open | closed | cancelled — the derived state, never typed by anyone. */
export const TICKET_STATES = ['open', 'closed', 'cancelled'] as const
export type TicketState = (typeof TICKET_STATES)[number]

/**
 * What dragging a ticket into a lane does to its clock.
 *
 * ── ONE VALUE, NOT THREE FLAGS ─────────────────────────────────────────────
 *
 * Three booleans would allow `start` and `end` on the same lane, which is a
 * shape no screen can render and no arithmetic can resolve. The same reasoning
 * makes `job_statuses.role` a single enum.
 *
 * `''` means the lane does nothing to the clock, and that is most lanes.
 */
export const CLOCK_ACTIONS = ['', 'start', 'pause', 'end'] as const
export type ClockAction = (typeof CLOCK_ACTIONS)[number]

export const CLOCK_LABEL: Record<ClockAction, string> = {
  '': 'Leaves the clock alone',
  start: 'Starts the clock',
  pause: 'Pauses the clock',
  end: 'Ends the clock',
}

/**
 * Which clock actions may be held by AT MOST ONE lane.
 *
 * All three of them, and the constraint is enforced in code rather than by a
 * unique key — because `''` must be allowed on many lanes, and a unique index
 * cannot say "unique except for one value". `setLaneClock` clears the flag from
 * whichever lane had it, exactly as job statuses do for `role`.
 */
export const EXCLUSIVE_CLOCK_ACTIONS: readonly ClockAction[] = ['start', 'pause', 'end']

export function isClockAction(value: string): value is ClockAction {
  return (CLOCK_ACTIONS as readonly string[]).includes(value)
}

export function isTicketPriority(value: string): value is TicketPriority {
  return (TICKET_PRIORITIES as readonly string[]).includes(value)
}

export function isTicketSource(value: string): value is TicketSource {
  return (TICKET_SOURCES as readonly string[]).includes(value)
}

/** A lane, as the pure rules below need to see it. */
export type LaneShape = {
  id: number
  clock: ClockAction
  isLanding: boolean
  isClosedStage: boolean
  isCancelledStage: boolean
  isActive: boolean
}

/**
 * What is wrong with a set of lanes, or null.
 *
 * ── THE THREE CARDINALITIES ARE DIFFERENT, AND THAT IS THE POINT ───────────
 *
 *   landing   EXACTLY ONE   — where a new ticket goes; two answers is no answer
 *   clock     AT MOST ONE   — per action; none is fine, and common
 *   closed    ONE OR MORE   — a team may finish in both Resolved and Closed
 *
 * The closed rule is the one that differs from job cards, where nothing
 * requires a closed stage to exist. Here a board with none is a queue nothing
 * can leave, so it is refused.
 *
 * Pure and exported so the setup screen refuses exactly what the action
 * refuses.
 */
export function validateLanes(lanes: readonly LaneShape[]): string | null {
  const live = lanes.filter((l) => l.isActive)
  if (live.length === 0) return 'A board needs at least one lane.'

  const landing = live.filter((l) => l.isLanding)
  if (landing.length === 0) return 'One lane has to be where new tickets land.'
  if (landing.length > 1) {
    return 'Only one lane can be where new tickets land — a second would make it a question with two answers.'
  }

  const closed = live.filter((l) => l.isClosedStage)
  if (closed.length === 0) {
    return 'At least one lane has to count as done, or nothing can ever leave the board.'
  }

  for (const action of EXCLUSIVE_CLOCK_ACTIONS) {
    const holders = live.filter((l) => l.clock === action)
    if (holders.length > 1) {
      return `Only one lane can ${CLOCK_LABEL[action].toLowerCase()}.`
    }
  }

  /*
   * A landing lane that starts the clock would time a ticket nobody has picked
   * up. Refused rather than allowed-and-surprising: the whole model is that a
   * running clock means somebody is working, and this would break that on the
   * very first lane.
   */
  if (landing[0]!.clock === 'start') {
    return 'The landing lane cannot start the clock — a ticket nobody has picked up is not being worked on.'
  }

  return null
}

/**
 * What a move does to the clock: close the open segment, open a new one, or
 * both.
 *
 * Pure, so the transaction that moves a ticket can ask once and act, and so the
 * test can prove every combination without a database.
 *
 *   from ''      to 'start'  →  open
 *   from 'start' to 'pause'  →  close
 *   from 'start' to 'start'  →  nothing (same lane, or two running lanes, which
 *                               validateLanes already refuses)
 *   from 'start' to 'end'    →  close
 *   anything     to ''       →  close, if one is open
 *
 * `end` and `pause` differ on the TICKET, not on the ledger: both stop the
 * clock, and what separates them is that an `end` lane is normally also a
 * closed stage. Keeping that distinction out of here means the ledger has one
 * job.
 */
export function clockTransition(
  from: ClockAction,
  to: ClockAction,
): { close: boolean; open: boolean } {
  const wasRunning = from === 'start'
  const willRun = to === 'start'
  if (wasRunning && willRun) return { close: false, open: false }
  return { close: wasRunning, open: willRun }
}

'use server'

import { revalidatePath } from 'next/cache'
import { actorFor, actorForOrThrow } from '@/lib/auth'
import {
  saveTicket,
  moveTicket,
  assignTicket,
  linkToJob,
  saveLane,
  deleteLane,
  type TicketInput,
  type TicketSaveResult,
  type TicketActionResult,
  type MoveResult,
  type LaneInput,
  type LaneResult,
} from '@/lib/site/tickets'
import { createComment, type SaveResult } from '@/lib/site/partyComments'
import { setSetting } from '@/lib/site/settings'
import { searchCustomersForTill, type TillCustomer } from '@/lib/site/tillCustomers'

/**
 * The ticket module's server actions.
 *
 * Thin, like the job module's: a guard, a call into src/lib/site, a revalidate.
 * Validation, SQL and the audit trail live in the data layer so the test can
 * prove them without a request, and so the board and the detail screen cannot
 * get different answers from the same act.
 *
 * ── WHY THE CAPABILITIES DIFFER PER ACTION ─────────────────────────────────
 *
 * `tickets.assign` is split from `tickets.edit` for a reason specific to this
 * module: assigning decides whose TIME a running clock is credited to. On a job
 * card that split is about responsibility; here it is also about whose
 * productivity figure moves.
 */

function revalidateTickets(id?: number) {
  revalidatePath('/tickets')
  revalidatePath('/tickets/board')
  if (id) revalidatePath(`/tickets/${id}`)
}

export async function saveTicketAction(input: TicketInput): Promise<TicketSaveResult> {
  const ctx = await actorFor('tickets.edit')
  if ('ok' in ctx) return ctx

  const result = await saveTicket(ctx.siteId, ctx.actor, input)
  if (result.ok) revalidateTickets(result.id)
  return result
}

/**
 * Move a ticket to a lane — which is also the timing act.
 *
 * `tickets.edit`, not a separate capability: dragging a card IS the day job of
 * a support desk, and a right to work on tickets that did not include moving
 * them would leave somebody able to comment and nothing else.
 *
 * The refusals this can return are worth passing through verbatim rather than
 * flattening to "could not move": "needs somebody assigned first" and "already
 * has 2 running: TK000014, TK000021" each tell the person what to do next.
 */
export async function moveTicketAction(
  ticketId: number,
  toStatusId: number,
): Promise<MoveResult> {
  const ctx = await actorFor('tickets.edit')
  if ('ok' in ctx) return ctx

  const result = await moveTicket(ctx.siteId, ctx.actor, ticketId, toStatusId)
  if (result.ok) revalidateTickets(ticketId)
  return result
}

export async function assignTicketAction(
  ticketId: number,
  userId: number | null,
  userName: string,
): Promise<TicketActionResult> {
  const ctx = await actorFor('tickets.assign')
  if ('ok' in ctx) return ctx

  const result = await assignTicket(ctx.siteId, ctx.actor, ticketId, userId, userName)
  if (result.ok) revalidateTickets(ticketId)
  return result
}

/**
 * Link a ticket to the job it became.
 *
 * Needs BOTH rights: `tickets.edit` to change the ticket, and `jobs.view` to
 * name a job — otherwise somebody who cannot see jobs could probe for job ids
 * by watching which ones the link accepts.
 */
export async function linkToJobAction(
  ticketId: number,
  jobCardId: number | null,
): Promise<TicketActionResult> {
  const ctx = await actorFor('tickets.edit')
  if ('ok' in ctx) return ctx
  if (jobCardId !== null) {
    const jobCtx = await actorFor('jobs.view')
    if ('ok' in jobCtx) return { ok: false, error: 'You cannot see job cards, so you cannot link one.' }
  }

  const result = await linkToJob(ctx.siteId, ctx.actor, ticketId, jobCardId)
  if (result.ok) {
    revalidateTickets(ticketId)
    if (jobCardId) revalidatePath(`/jobs/${jobCardId}`)
  }
  return result
}

/**
 * A comment on a ticket.
 *
 * Reuses `party_comments` through the widened `CommentEntity` — no ticket
 * comment table, because three copies would be three places for an internal
 * note to leak, and 131 has only just finished making that split trustworthy.
 */
export async function commentOnTicketAction(
  ticketId: number,
  body: string,
): Promise<SaveResult> {
  const ctx = await actorFor('tickets.edit')
  if ('ok' in ctx) return ctx

  const result = await createComment(ctx.siteId, ctx.actor, 'ticket', ticketId, body)
  if (result.ok) revalidateTickets(ticketId)
  return result
}

/* ── Lanes ─────────────────────────────────────────────────────────────────── */

export async function saveLaneAction(input: LaneInput): Promise<LaneResult> {
  const ctx = await actorFor('tickets.setup')
  if ('ok' in ctx) return ctx

  const result = await saveLane(ctx.siteId, ctx.actor, input)
  if (result.ok) {
    revalidateTickets()
    revalidatePath('/setup/tickets')
  }
  return result
}

export async function saveTicketSettingsAction(input: {
  maxRunningPerUser: number
}): Promise<TicketActionResult> {
  const ctx = await actorFor('tickets.setup')
  if ('ok' in ctx) return ctx

  const n = Math.max(0, Math.floor(input.maxRunningPerUser))
  if (!Number.isFinite(n)) return { ok: false, error: 'That is not a number.' }
  // A cap in the hundreds is a typo, not a policy. Refused rather than stored,
  // because a nonsense limit reads as "no limit" and hides the mistake.
  if (n > 50) return { ok: false, error: 'That limit is higher than anybody could work at once.' }

  await setSetting(ctx.siteId, 'ticket_max_running_per_user', String(n))
  revalidatePath('/setup/tickets')
  revalidateTickets()
  return { ok: true }
}

export async function deleteLaneAction(id: number): Promise<TicketActionResult> {
  const ctx = await actorFor('tickets.setup')
  if ('ok' in ctx) return ctx

  const result = await deleteLane(ctx.siteId, ctx.actor, id)
  if (result.ok) {
    revalidateTickets()
    revalidatePath('/setup/tickets')
  }
  return result
}

/**
 * Customer type-ahead for the ticket form.
 *
 * actorForOrThrow because the return type has no room for a refusal: a
 * type-ahead returns a list, and an empty list would read as "no such customer"
 * rather than "you may not look".
 */
export async function searchTicketCustomersAction(term: string): Promise<TillCustomer[]> {
  const ctx = await actorForOrThrow('tickets.edit')
  return searchCustomersForTill(ctx.siteId, term)
}

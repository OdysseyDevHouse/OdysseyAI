import 'server-only'
import { requireSiteUser, withTillOperator } from '@/lib/auth'
import type { CapabilitySet } from '@/lib/site/permissions'

/**
 * Who is standing at the trade counter, and what they may do.
 *
 * ── WHY THE BROWSER SESSION IS THE WRONG ANSWER HERE ──────────────────────
 *
 * This window is a COUNTER, not a back office. `layout.tsx` says so at length:
 * the browser session decides which shop is open and lasts twelve hours, while
 * the counter itself changes hands several times a day, so the layout puts a
 * PIN gate in front of everything and mints the same `odyssey_till` cookie the
 * POS uses. The strip along the top names that person.
 *
 * The layout resolved their rights and then spent them on ONE thing —
 * `canCashup` — and every screen underneath went on asking `requireSiteUser`.
 * So the window named the clerk in its header and handed them the rights of
 * whoever had opened the browser that morning. On a shop floor that is nearly
 * always a manager, which is why the product's own discount ceiling could not
 * bite here however it was set: the person it applied to was never the person
 * being asked about.
 *
 * It was not only permission. `repsForLines` pre-selects a salesperson from
 * this actor, and `sales_document_lines.sales_rep_user_id` is what commission
 * is paid on — so every invoice typed at the counter paid the browser user.
 * That is the exact failure `withTillOperator`'s own docblock was written
 * about when the till had it; this window simply never got the fix.
 *
 * ── WHY IT STILL GATES ON THE SESSION ─────────────────────────────────────
 *
 * The `sales.view` gate stays where it was, on the browser session, and only
 * the ANSWER moves to the operator — the same order the till's actions use
 * (`actorFor` then `withTillOperator`). A shop puts a machine on the counter
 * and signs it in once; holding every clerk to a second set of back-office
 * rights just to reach the screen would lock the counter out of its own
 * window. What the operator's role decides is what they may DO once there:
 * override a price, exceed a discount ceiling, see cost.
 *
 * With no till session — which the layout does not allow, but a direct call
 * might — this is the browser session untouched, exactly as before.
 */
export async function counterActor(): Promise<{
  siteId: number
  actor: { userId: number; userName: string }
  capabilities: CapabilitySet
}> {
  const { site, user, capabilities } = await requireSiteUser()
  return withTillOperator({
    siteId: site.id,
    actor: { userId: user.id, userName: user.name },
    capabilities,
  })
}

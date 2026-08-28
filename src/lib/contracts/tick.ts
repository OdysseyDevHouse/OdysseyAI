import 'server-only'
import { generateDue } from '../site/contracts'
import { sendPending } from '../site/contractSend'
import type { IssuingSite } from '../invoices/build'
import type { Actor } from '../site/activityLog'

/**
 * One site's contract billing run.
 *
 * Split out from the route so the route stays about AUTHORISATION and the work
 * itself is callable from a screen ("run billing now") and from a test. The same
 * split lib/reportSchedules/tick.ts already uses.
 *
 * ── BILL FIRST, THEN SEND ────────────────────────────────────────────────
 *
 * Two passes, deliberately. Billing decides what the customer owes and moves the
 * ledger; sending only tells them about it. Running them as one loop would mean
 * a mail server timing out mid-run leaves later contracts unbilled — the money
 * consequence of an email problem.
 *
 * Sending picks up EVERY posted-but-unsent invoice, not just the ones this run
 * created, so an invoice whose send failed yesterday goes out today without
 * anybody re-billing anything.
 */

/** Nobody is signed in at 05:00. The ledger records what did the work. */
const CRON_ACTOR: Actor = { userId: 0, userName: 'Contract billing' }

export type TickResult = {
  /** Invoices created this run. */
  billed: number
  /** Of those, how many posted to the customer's account (auto_send on). */
  posted: number
  /** Contracts whose price rose this run. */
  escalated: number
  sent: number
  failed: number
  skipped: number
  /** Anything that could not be billed, so a person can look. */
  problems: string[]
}

export async function tickSite(siteId: number, origin: string): Promise<TickResult> {
  const site = await issuingSite(siteId)

  const generated = await generateDue(siteId, CRON_ACTOR)

  // Sending needs the site's letterhead. A site whose record has vanished from
  // the control database cannot produce an invoice PDF, but it CAN still have
  // billed correctly — so the billing result is reported either way.
  const mail = site
    ? await sendPending(siteId, site, CRON_ACTOR, origin)
    : { sent: 0, failed: 0, skipped: 0 }

  return {
    billed: generated.generated.length,
    posted: generated.generated.filter((g) => g.posted).length,
    escalated: generated.escalated.length,
    sent: mail.sent,
    failed: mail.failed,
    skipped: mail.skipped,
    problems: generated.skipped.map((s) => `${s.name}: ${s.reason}`),
  }
}

/**
 * The letterhead.
 *
 * ── ONE COPY, NOT TWO ───────────────────────────────────────────────────────
 *
 * This was its own SELECT against cp2_sites, duplicating the one in
 * site/invoiceEmail.ts — which is the drift that file's own docblock warns
 * about ("contracts had its own copy, which is how letterheads drift"). The two
 * had already diverged: this one filtered to active sites, that one did not.
 *
 * Now there is one, and it carries the offline fallback with it — a shop whose
 * line is down can still bill its contracts on its own paper, which is the
 * whole point of holding the data locally.
 *
 * Still read per site per run rather than passed in, because the route sweeps
 * every site and each invoice must carry ITS OWN business's name and VAT
 * number. Getting that wrong puts one client's VAT number on another's invoice.
 */
async function issuingSite(siteId: number): Promise<IssuingSite | null> {
  const { issuingSiteFor } = await import('../site/invoiceEmail')
  return issuingSiteFor(siteId)
}

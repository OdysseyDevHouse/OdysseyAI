import 'server-only'
import { queryOne } from '../db'
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
 * The letterhead, from the control database.
 *
 * Read per site per run rather than passed in, because the route sweeps every
 * site and each invoice must carry ITS OWN business's name and VAT number.
 * Getting this wrong would put one client's VAT number on another's invoice.
 */
async function issuingSite(siteId: number): Promise<IssuingSite | null> {
  const row = await queryOne<{
    company_name: string
    trading_name: string | null
    vat_number: string | null
    registration_number: string | null
    address1: string | null
    address2: string | null
    address3: string | null
    postal_code: string | null
    phone: string | null
    email: string | null
  }>(
    `SELECT company_name, trading_name, vat_number, registration_number,
            address1, address2, address3, postal_code, phone, email
       FROM cp2_sites WHERE id = ? AND status = 'active' LIMIT 1`,
    [siteId],
  )
  if (!row) return null

  return {
    displayName: row.trading_name?.trim() || row.company_name,
    vatNumber: row.vat_number,
    registrationNumber: row.registration_number,
    address1: row.address1,
    address2: row.address2,
    address3: row.address3,
    postalCode: row.postal_code,
    phone: row.phone,
    email: row.email,
  }
}

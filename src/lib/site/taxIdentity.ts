import 'server-only'
import { getSetting } from './settings'
import { getSite } from '../sites'
import { listVatRates } from './lookups'

/**
 * What this shop's tax is CALLED, and whether it is registered to charge any.
 *
 * ── TWO FACTS, ONE MODULE, AND THEY LIVE IN DIFFERENT PLACES ────────────────
 *
 * They are read together everywhere and stored apart, which is exactly the kind
 * of split that drifts if each caller resolves it for itself.
 *
 *   THE NUMBER lives in `cp2_sites.vat_number`, the control database. It is
 *   part of the shop's IDENTITY — the same row holding its registered name and
 *   address, which support also maintains — and it prints on tax invoices as a
 *   legal requirement. One place, one answer.
 *
 *   THE LABEL lives in this site's own `settings`. It is a display preference
 *   with no meaning outside this database: the control panel has no use for
 *   knowing that a Canadian shop calls it HST, and putting it there would mean
 *   an offline till could not read what to print on a slip.
 *
 * ── WHY THE NUMBER IS NOT ALSO A SITE SETTING ───────────────────────────────
 *
 * It was, sort of, and that was the bug. `settings.vat_number` existed and was
 * read by the VAT return, while `cp2_sites.vat_number` was read by every
 * document — two copies of one legal number, with nothing keeping them equal
 * and no rule about which one won. The settings copy is gone; this module is
 * the single reader, and vatReturn.ts now comes through it like everything else.
 *
 * ── AND WHY READING IT CANNOT FAIL A PAGE ───────────────────────────────────
 *
 * `getSite` answers from the offline mirror when the control database is
 * unreachable — see lib/site/siteProfile.ts — so a local install with a dead
 * line still knows its own VAT number. A throw here would take down every
 * screen that prints a document, so the catch degrades to "not registered",
 * which is the safe direction: the tax-rate guard below then REFUSES a change
 * rather than permitting one it could not verify.
 */

/** The default when a shop has never chosen one. South Africa, and the app's home. */
export const DEFAULT_TAX_LABEL = 'VAT'

export type TaxIdentity = {
  /** The registered number, or null when this shop is not registered. */
  number: string | null
  /** What to call the tax on screens, documents and reports: VAT, HST, Tax… */
  label: string
  /**
   * Whether this shop may charge tax at all.
   *
   * Exactly `number !== null`, named because that is the question every caller
   * is really asking and `if (identity.number)` reads as a null check rather
   * than as a rule about tax registration.
   */
  registered: boolean
}

/**
 * This shop's tax identity.
 *
 * Not React-cached: `getSite` is already memoised per request and the setting is
 * one indexed single-row select, so a second layer would buy nothing and would
 * behave differently in a test script than in a request — see the note about
 * request-scoped caches in the settings module.
 */
export async function taxIdentity(siteId: number): Promise<TaxIdentity> {
  const [site, label] = await Promise.all([
    getSite(siteId).catch(() => null),
    getSetting(siteId, 'tax_label').catch(() => DEFAULT_TAX_LABEL),
  ])

  const number = site?.vatNumber?.trim() || null
  return {
    number,
    /* An empty setting means "never chosen", not "call it nothing" — a document
       header reading "0.00" with no word in front of it is not a thing anybody
       asked for. */
    label: label.trim() || DEFAULT_TAX_LABEL,
    registered: number !== null,
  }
}

/** Just the word, for the many callers that only need to print it. */
export async function taxLabel(siteId: number): Promise<string> {
  return (await taxIdentity(siteId)).label
}

/**
 * What percentage a vat_rates row actually charges.
 *
 * The product screens carry a rate ID, and the rule below is about the RATE —
 * a shop moving something onto a zero-rated row is doing something legitimate
 * whether it is registered or not, and the id alone cannot say which row that
 * is. Null in, null out: "the site default", which the callers treat as no
 * change to refuse.
 *
 * A row that has been deleted reads as 0 rather than throwing. That is the
 * permissive direction, and deliberately: the write is about to fail on the
 * foreign key anyway, and reporting it as a tax-registration problem would send
 * somebody to the wrong screen.
 */
export async function vatRatePercent(
  siteId: number,
  vatRateId: number | null,
): Promise<number | null> {
  if (vatRateId === null) return null
  const rates = await listVatRates(siteId).catch(() => [])
  return rates.find((r) => r.id === vatRateId)?.rate ?? 0
}

/**
 * May this shop put a product on a rate above zero?
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *
 * A shop with no VAT number is not registered, and a shop that is not
 * registered may not charge VAT. Until now nothing in the product editor said
 * so, so an unregistered shop could set 15% on every line and issue invoices
 * charging a tax it has no right to collect — which is a problem with the
 * revenue service rather than with this software, and is found at an audit.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 *
 * Nothing retrospective. A shop that REMOVES its VAT number keeps every product
 * already sitting at 15% exactly where it is: reverting them would silently
 * reprice the whole catalogue on the strength of one cleared field, and the
 * outcome of that is worse than the thing it corrects. This gate stands at the
 * moment somebody CHANGES a rate, and says why.
 *
 * Zero is always allowed, including for a registered shop — zero-rated goods
 * are real, and a shop that is registered may still sell them.
 *
 * Returns the refusal to show, or null when the change may proceed.
 */
export async function whyTaxRateRefused(
  siteId: number,
  /** The rate being moved to, as a percentage. Null means "the site default". */
  rate: number | null,
): Promise<string | null> {
  /* Nothing being charged, so nothing to refuse — and this is the common path
     for a zero-rated line, so it answers before touching the database. */
  if (rate === null || rate <= 0) return null

  const identity = await taxIdentity(siteId)
  if (identity.registered) return null

  return (
    `This store has no ${identity.label} number, so a product cannot be put on a ` +
    `${identity.label} rate. Add one under Setup › My store information first.`
  )
}

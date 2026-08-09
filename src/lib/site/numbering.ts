import 'server-only'
import { siteQueryOne } from '../siteDb'
import { getSettings, setSetting } from './settings'
import { formatNumber, SITE_SEQUENCE, type NumberSegments } from './sequences'

/**
 * Which numbering scheme a store uses, and how a till's number is composed.
 *
 * Kept apart from sequences.ts on purpose. That module owns the allocation
 * statement and must stay readable as one careful thing; this one owns the
 * store's CHOICE about numbering, which is settings and policy. It also breaks a
 * dependency that would otherwise be circular — sequences.ts is called from
 * inside posting transactions and has no business reading settings.
 *
 * ── THE TWO SCHEMES ──────────────────────────────────────────────────────
 *
 * 'terminal' (the default)
 *   Every till owns its own sequence and numbers INV_01_02_000097. It allocates
 *   locally with nothing reserved, so a till can trade offline for as long as it
 *   has to and can never run out of numbers. Each till's own run is gapless.
 *   There is no single company-wide invoice run.
 *
 * 'site'
 *   One shared sequence, exactly as before per-till numbering existed. A till
 *   then cannot number a sale offline at all. A store that wants one continuous
 *   run and accepts that chooses this.
 *
 * ── WHY THE STORE NUMBER IS A SETTING ────────────────────────────────────
 *
 * Not cp2_sites.id: that is a global counter across every customer of the
 * platform, so a twenty-store group holds ids like 47, 52, 89, 134 — meaningless
 * on a report and impossible to renumber. Not site_code either: it is unique but
 * reads as 'ODY-10000', and INV_ODY-10000_02_000097 is not a number anybody
 * wants on an invoice.
 *
 * And decisively: cp2_sites lives in the CONTROL database while document
 * numbering happens in the site's own, with no cross-database join available. So
 * whatever identifies the store has to BE in the site database.
 */

export type NumberScope = 'terminal' | 'site'

export type NumberingConfig = {
  scope: NumberScope
  /** This store's number inside the group, e.g. '01'. */
  storeNumber: string
}

export async function numberingConfig(siteId: number): Promise<NumberingConfig> {
  const s = await getSettings(siteId, ['sales_number_scope', 'store_number'])
  return {
    // Anything unrecognised folds onto 'site' rather than 'terminal': that is
    // the behaviour every store had before this existed, so a typo in a settings
    // row cannot silently change how a shop numbers its invoices.
    scope: s.sales_number_scope === 'terminal' ? 'terminal' : 'site',
    storeNumber: normaliseSegment(s.store_number, '01'),
  }
}

/**
 * Two digits, zero-padded, digits only.
 *
 * The segment is part of a legal document number, so it is normalised on the way
 * out rather than trusted: a settings row edited by hand to '7' must still
 * produce INV_07_… and not INV_7_…, or the same store issues two different
 * number shapes and neither reprint lookup finds both.
 */
export function normaliseSegment(raw: string | null | undefined, fallback: string): string {
  const digits = String(raw ?? '').replace(/\D/g, '')
  if (!digits) return fallback
  return digits.length >= 2 ? digits : digits.padStart(2, '0')
}

export type SegmentValidation = { ok: true } | { ok: false; error: string }

export function validateStoreNumber(raw: string): SegmentValidation {
  const trimmed = raw.trim()
  if (!/^\d{1,4}$/.test(trimmed)) return { ok: false, error: 'Use 1 to 4 digits, e.g. 01.' }
  if (Number(trimmed) < 1) return { ok: false, error: 'The store number must be 1 or more.' }
  return { ok: true }
}

/** Whether this store has issued anything yet — the store number freezes here. */
export async function hasIssuedDocuments(siteId: number): Promise<boolean> {
  const row = await siteQueryOne<{ n: number }>(
    siteId,
    'SELECT COUNT(*) AS n FROM sales_documents WHERE document_number IS NOT NULL LIMIT 1',
  )
  return Number(row?.n ?? 0) > 0
}

/**
 * Sets the store number, refusing once anything has been issued.
 *
 * Irreversible by design. A store trading as 01 that should have been 07 has
 * already printed 01 on customers' invoices, and there is no correction that
 * does not rewrite history. Worse, the collision it causes is invisible locally:
 * uq_doc_number is per-site, so two branches both numbered 01 issue genuinely
 * duplicate invoice numbers that only surface when group reports are compared.
 */
export async function setStoreNumber(siteId: number, raw: string): Promise<SegmentValidation> {
  const valid = validateStoreNumber(raw)
  if (!valid.ok) return valid
  if (await hasIssuedDocuments(siteId)) {
    return {
      ok: false,
      error:
        'The store number cannot change once documents have been issued — it is printed on invoices customers already hold.',
    }
  }
  await setSetting(siteId, 'store_number', normaliseSegment(raw, '01'))
  return { ok: true }
}

export async function setNumberScope(siteId: number, scope: NumberScope): Promise<void> {
  await setSetting(siteId, 'sales_number_scope', scope)
}

/**
 * The store and till segments for a sale, or undefined when it carries none.
 *
 * Returns undefined — meaning "number this the way it has always been numbered"
 * — in three cases, and each is deliberate:
 *
 *   · the store is on site-wide numbering;
 *   · the document is not an invoice (a credit note, quote or order still
 *     numbers from the shared run);
 *   · the sale has no terminal, which is every invoice captured in the back
 *     office. Those did not come from a register and must not claim to.
 */
export async function numberSegmentsFor(
  siteId: number,
  docType: string,
  terminalId: number | null,
): Promise<{ terminalId: number; segments: NumberSegments } | null> {
  if (docType !== 'invoice' || terminalId == null || terminalId === SITE_SEQUENCE) return null

  const config = await numberingConfig(siteId)
  if (config.scope !== 'terminal') return null

  const till = await tillNumber(siteId, terminalId)
  // A till with no number cannot be numbered per-till. Falling back to the
  // shared sequence would put its sale in the middle of the site-wide run
  // silently, so this refuses instead and the caller surfaces it.
  if (!till) {
    throw new Error(
      `Till ${terminalId} has no till number. Set one on the terminals screen before it can ring up a sale.`,
    )
  }

  return { terminalId, segments: { store: config.storeNumber, till } }
}

/** The printed number of one till, or null when it has not been given one. */
export async function tillNumber(siteId: number, terminalId: number): Promise<string | null> {
  const row = await siteQueryOne<{ till_number: string | null }>(
    siteId,
    'SELECT till_number FROM terminals WHERE id = ? LIMIT 1',
    [terminalId],
  )
  const value = row?.till_number ?? null
  return value ? normaliseSegment(value, value) : null
}

/**
 * The literal prefix every number in one till's run begins with — 'INV_01_02_'.
 *
 * verifySequence needs this to tell that till's documents from its neighbours'
 * without parsing anything: the numbers are matched with a LIKE on exactly this
 * string. Built by formatNumber rather than by string concatenation here, so the
 * separator can never drift from the one the numbers were issued with.
 */
export function tillNumberPrefix(
  prefix: string,
  segments: NumberSegments,
  periodKey: string | null,
): string {
  // Format a sentinel and cut the counter off it. Padding of 1 keeps the
  // sentinel a single character, so the slice is unambiguous.
  const sample = formatNumber(prefix, 0, 1, periodKey, segments)
  return sample.slice(0, sample.length - 1)
}

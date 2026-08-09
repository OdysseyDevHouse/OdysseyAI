/**
 * The SHAPE of a document number — pure, and deliberately NOT `server-only`.
 *
 * Extracted from `site/sequences.ts` so the OFFLINE till can call it. That module
 * owns the allocation statement and needs a database; this function is string
 * formatting and never did.
 *
 * The extraction is what makes an offline number indistinguishable from an online
 * one. A second implementation in the browser is how `INV_01_02_000097` and
 * `INV_01_2_97` end up in the same invoice register, with nothing to say which
 * shape is correct.
 *
 * `sequences.ts` re-exports this, so every existing import keeps working.
 */

/** The store and till segments of a number, when it carries them. */
export type NumberSegments = { store: string; till: string }

/**
 * INV000041 · INV-2026-000041 · INV_01_02_000041 · INV_01_02_2026_000041
 *
 * The year goes in when the counter resets yearly, because otherwise invoice 41 of
 * this year and invoice 41 of last year are the same string — which breaks the
 * unique index and, worse, breaks the customer's reference.
 *
 * The STORE and TILL segments identify which shop and which register issued it.
 * The store segment is not decoration: twenty branches each number their first till
 * 01, so without it every branch issues INV_01_000041 and a group report has twenty
 * rows claiming one invoice number. `uq_doc_number` cannot catch that — each site
 * has its own database and its own copy of that index.
 *
 * Underscores for the segments, not the hyphen the yearly form uses: a hyphen
 * already separates the year, and INV-01-02-2026-000041 gives a reader no clue
 * which field is which.
 *
 * WITH NO SEGMENTS THE OUTPUT IS BYTE-IDENTICAL TO WHAT IT HAS ALWAYS BEEN. That is
 * what leaves twelve of the thirteen callers, and every document already issued,
 * completely untouched.
 */
export function formatNumber(
  prefix: string,
  number: number,
  padding: number,
  periodKey: string | null,
  segments?: NumberSegments,
): string {
  const digits = String(number).padStart(Math.max(padding, 1), '0')
  if (!segments) {
    if (periodKey) return `${prefix}-${periodKey}-${digits}`
    return `${prefix}${digits}`
  }
  const scope = `${prefix}_${segments.store}_${segments.till}`
  if (periodKey) return `${scope}_${periodKey}_${digits}`
  return `${scope}_${digits}`
}

/**
 * The counter out of a formatted number — the inverse of the padding above.
 *
 * Takes the LAST run of digits so it works on every shape this app produces:
 * INV000097, INV-2026-000097, INV_01_02_000097 and INV_01_02_2026_000097 all yield
 * 97. Returns null when there is no digit run to read, rather than 0, because
 * "unparseable" and "number zero" must not be the same answer to a caller about to
 * advance a sequence.
 */
export function numberValueOf(documentNumber: string): number | null {
  const runs = documentNumber.match(/\d+/g)
  if (!runs || runs.length === 0) return null
  const n = Number(runs[runs.length - 1])
  return Number.isFinite(n) ? n : null
}

/*
 * No `'use client'`, deliberately. This module is plain constants, and the
 * doors into the till are a mix of client components (the sidebar, the hub) and
 * SERVER ones (the Orders, Lay-bys and Invoicing buttons). Marking it client
 * would turn these exports into client references and crash the server pages
 * that read them — the same trap `styles.ts` documents for `buttonClass()`.
 */

/**
 * Opening the till, from anywhere in the back office.
 *
 * ── WHY THE TILL IS NOT AN ORDINARY LINK ──────────────────────────────────
 *
 * The POS is not another back-office screen — it is a second thing the same
 * person runs ALONGSIDE the back office. A cashier serving a customer should
 * not lose the till because somebody went to look up a supplier invoice, and
 * getting back to a half-scanned basket via the browser's Back button is not a
 * thing a shop should have to rely on.
 *
 * So `/pos` opens in its own tab (web) or its own window (desktop), and the
 * back office stays exactly where it was.
 *
 * ── WHY THIS IS ONE MODULE RATHER THAN A PROP AT EACH CALL SITE ───────────
 *
 * There are several doors into the till — the sidebar, the hub, and the "start
 * a sale" buttons on Orders, Lay-bys and Invoicing. A `target="_blank"` written
 * out at each of those drifts: the next door someone adds is a plain link, and
 * the till starts replacing the back office again on exactly one route. The
 * rule lives here, and the doors import it.
 */

export const TILL_HREF = '/pos'

/**
 * The till, opened to write a PARTICULAR kind of document.
 *
 * ── WHY THE BACK OFFICE NEEDS THIS ────────────────────────────────────────
 *
 * "New order at the till" used to be a bare link to `/pos`. It handed over
 * nothing, so somebody who pressed it arrived at an ordinary counter screen
 * with no indication of what to do next — and until recently the till could not
 * raise an order at all, so the button led nowhere twice over.
 *
 * With a doc type on the URL the till opens already writing one, which is what
 * the button always claimed to do.
 *
 * ── WHY THE VALUE IS THE STORED ONE ───────────────────────────────────────
 *
 * `sales_order`, not `order`. The till validates this against the same list the
 * database stores, so a prettier word here would need a translation table at
 * both ends — and the first person to add a fifth type would update one of them.
 */
export function tillHrefFor(docType: 'quote' | 'sales_order' | 'invoice' | 'credit_sale'): string {
  return docType === 'invoice' ? TILL_HREF : `${TILL_HREF}?new=${docType}`
}

/**
 * The name of the till's tab/window.
 *
 * NAMED, not `_blank`, and that difference is the whole behaviour: a named
 * target REUSES the tab it already opened. Pressing "Point of sale" twice
 * focuses the till that is already running instead of opening a second copy of
 * it — two tills in two tabs share one device id and one offline outbox, which
 * is a genuinely bad state to be in, not merely untidy.
 */
export const TILL_TARGET = 'odyssey-pos'

/**
 * Link props that open the till beside the back office.
 *
 * ⚠ NO `rel="noopener"`, and that is deliberate rather than an oversight.
 *
 * `noopener` severs the new window's browsing-context NAME. A window opened
 * that way cannot be found again by `TILL_TARGET`, so every press created a
 * fresh anonymous tab — measured: two presses, two `/pos` tabs. Reuse and
 * `noopener` are mutually exclusive, so this is a real choice between them.
 *
 * Reuse wins, because the thing it prevents is worse. Two tills in two tabs
 * share one device id and one offline outbox — the same queued sales syncing
 * from two places — which is a data problem, not an untidy-desktop problem.
 * What `noopener` would buy here is protection from `window.opener`, and both
 * windows are this same app on this same origin: the till is not untrusted
 * content, and it can already reach everything the back office can via its own
 * session.
 */
export const tillLinkProps = {
  target: TILL_TARGET,
} as const

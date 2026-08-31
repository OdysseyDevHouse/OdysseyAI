/**
 * What a QR code on a document points at.
 *
 * ── WHY THE TARGET IS A CHOICE AND NOT A TEXT BOX ─────────────────────────
 *
 * A free URL gives a STATIC code — the same square on every invoice a shop ever
 * prints. That is worth something, but the valuable version varies per
 * document: the customer scans their own invoice and lands on that invoice's
 * tracking page. Only the server can produce those links, because they are
 * signed, so they cannot come from anything a shop types.
 *
 * So a target is a named kind. `custom` is still there for everything else.
 *
 * ── https ONLY, AND WHY THAT IS NOT PARANOIA ──────────────────────────────
 *
 * A printed QR is an outbound surface with no address bar. A customer points a
 * phone at a square and goes wherever it says, having read nothing — so the one
 * defence is that we only ever encode a scheme we are willing to stand behind.
 * `sanitise.ts` already refuses non-https references in templates for the same
 * reason; this is that rule where a link is not a link but a picture of one.
 *
 * ── A QR TO NOWHERE IS WORSE THAN NO QR ───────────────────────────────────
 *
 * Every resolver returns null rather than a guess when it cannot produce a real
 * address — APP_URL unset, no storefront configured, a document with no public
 * page. The block then prints its caption and no square. A code that scans to a
 * dead host is a customer standing in a shop being told the page cannot be
 * found, which is worse than a document that never promised one.
 */

export const QR_TARGETS = ['doc', 'store', 'review', 'custom'] as const
export type QrTarget = (typeof QR_TARGETS)[number]

export type QrTargetDef = {
  target: QrTarget
  label: string
  hint: string
}

export const QR_TARGET_INFO: readonly QrTargetDef[] = [
  {
    target: 'doc',
    label: 'This document',
    hint: 'The customer scans their own invoice and sees it online. Different on every document.',
  },
  {
    target: 'store',
    label: 'Your online store',
    hint: 'Your shop front. The same on every document.',
  },
  {
    target: 'review',
    label: 'Your review page',
    hint: 'Where you ask customers to rate you — set it once in Setup → Online store.',
  },
  {
    target: 'custom',
    label: 'A web address you type',
    hint: 'Anything else. Must start with https.',
  },
]

const TARGET_SET = new Set<string>(QR_TARGETS)

export function isQrTarget(value: unknown): value is QrTarget {
  return typeof value === 'string' && TARGET_SET.has(value)
}

/**
 * A shop-typed address, cleaned, or null.
 *
 * ── WHAT IS REFUSED, AND WHY THE LIST IS SHORT ────────────────────────────
 *
 * Parsed by `new URL` rather than pattern-matched, so a scheme cannot be hidden
 * by whitespace, case or an encoding nobody thought of — `javascript:`,
 * `data:`, `http:` and a bare hostname are all rejected by the same check
 * because none of them parse to an https origin.
 *
 * A missing scheme is the one thing FIXED rather than refused: a shop typing
 * "shop.example.co.za" means https, and refusing that would teach nothing.
 */
export function cleanCustomUrl(raw: string): string | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return null
  if (trimmed.length > 500) return null

  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`

  try {
    const url = new URL(candidate)
    if (url.protocol !== 'https:') return null
    if (!url.hostname) return null
    return url.toString()
  } catch {
    return null
  }
}

/**
 * Everything the resolver needs, gathered by the caller.
 *
 * Passed in rather than read here, because this module is client-safe: the
 * designer validates a target exactly as the server does, and a preview that
 * used different rules from the print would be a preview that lies.
 */
export type QrContext = {
  /** APP_URL, or null when it is not configured. */
  appUrl: string | null
  /** The shop's public storefront address, or null. */
  storeUrl: string | null
  /** The shop's review link, or null. */
  reviewUrl: string | null
  /** This document's own public page, where it has one. */
  documentUrl: string | null
}

/**
 * The address a QR block should encode, or null when there is none.
 *
 * Null is a real answer and every caller treats it as one: no square, and — in
 * the designer — a line saying why.
 */
export function resolveQrUrl(
  target: QrTarget,
  custom: string | undefined,
  ctx: QrContext,
): string | null {
  switch (target) {
    case 'custom':
      return cleanCustomUrl(custom ?? '')
    case 'doc':
      return ctx.documentUrl
    case 'store':
      return ctx.storeUrl
    case 'review':
      return ctx.reviewUrl
    default:
      return null
  }
}

/**
 * Why a target produced nothing, in the shop's words. For the designer only.
 *
 * ── THE 'doc' CASE HAS TO SAY WHICH KIND OF NOTHING ───────────────────────
 *
 * A null documentUrl means one of two very different things, and telling a shop
 * the wrong one costs them the feature.
 *
 *   In the DESIGNER it means "there is no real document here" — the preview runs
 *   on sample data, so there is no invoice to be paid and no link to show. The
 *   square will appear on the real thing. Saying "this document has no page a
 *   customer can open" reads as a permanent refusal and talks somebody out of a
 *   block that would have worked.
 *
 *   On a REAL document it means that document is genuinely not payable — a
 *   credit note, a draft, a purchase order, a delivery note — or pay links are
 *   switched off for its kind.
 *
 * `preview` is what separates them. It defaults to false so every existing
 * caller keeps the honest, cautious wording.
 */
export function whyNoUrl(target: QrTarget, ctx: QrContext, preview = false): string {
  switch (target) {
    case 'custom':
      return 'Type a web address starting with https.'
    case 'doc':
      if (!ctx.appUrl) {
        return 'No web address is set up for this system, so a document link cannot be made.'
      }
      return preview
        ? 'Nothing to show on a sample — this prints a “pay online” code on a real invoice, statement or quote, once pay links are switched on below.'
        : 'This document has no page a customer can open. Credit notes, drafts and cancelled documents never get one.'
    case 'store':
      return 'You have no online store address yet — Setup → Online store.'
    case 'review':
      return 'You have no review link yet — Setup → Online store.'
    default:
      return 'Nothing to point at.'
  }
}

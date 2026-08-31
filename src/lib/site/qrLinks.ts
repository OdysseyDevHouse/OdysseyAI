import 'server-only'
import { getSetting } from './settings'
import { getOnlineSettings } from './onlineStore'
import { appBaseUrl } from '../appUrl'
import { cleanCustomUrl, type QrContext } from '../stationery/qrTarget'

/**
 * Where a QR code on this shop's documents may point.
 *
 * ── ONE BUILDER, BECAUSE IT IS A BOUNDARY ─────────────────────────────────
 *
 * Every renderer refuses to encode anything it was not handed, so this is what
 * decides what a QR can say. Six print paths assembling it by hand would be six
 * chances for one of them to resolve a link the others would have refused — and
 * the failure would be a printed square, on paper, in a customer's hand.
 *
 * ── EVERY FIELD MAY BE NULL, AND THAT IS THE POINT ────────────────────────
 *
 * appBaseUrl() returns null rather than inventing a host; a shop with no
 * storefront has no store link; a shop that has not typed a review address has
 * no review link. A null field means the matching target prints NO SQUARE —
 * see resolveQrUrl. A QR that scans to a dead host is a customer standing in a
 * shop being told the page cannot be found, which is worse than a document that
 * never offered one.
 *
 * Never throws: a settings read that fails yields nulls, so a database blink
 * costs a shop its QR codes and not its invoice.
 */

/**
 * The "this document" URL for a SALES DOCUMENT, or null.
 *
 * ── THE TARGET THAT NEVER RESOLVED ────────────────────────────────────────
 *
 * `documentUrl` has been a parameter of qrContextFor since it was written, and
 * every single caller left it null — so the stationery designer has always
 * offered "This document" as a QR target and always printed nothing for it. A
 * shop could pick it, see the caption, and get a blank space on real paper.
 *
 * This is what finally answers it: the document's PAY link. That is the only
 * per-document page a customer has any business opening — there is no public
 * "view your invoice" page, and inventing one would put a customer's line
 * detail behind a printed square.
 *
 * ── WHICH KIND OF LINK, BY WHAT THE DOCUMENT IS ───────────────────────────
 *
 * An invoice takes a `debtor_invoice` link and asks for what is still owed. A
 * quote or a sales order takes a `document_deposit` link, because neither is a
 * debt yet — see paidLinks.ts on why a paid quote must not invoice itself.
 *
 * Everything else gets null, and that is deliberate rather than unfinished:
 *
 *   a CREDIT NOTE is money owed TO the customer, and a pay button on one asks
 *   them to settle a refund;
 *
 *   a DRAFT has no number and no debt — the business has not raised it yet;
 *
 *   a CANCELLED document must not be payable at all.
 *
 * Never throws. A settings read that fails costs a square, not a document.
 */
export async function documentPayUrl(
  siteId: number,
  document: {
    id: number
    docType: string
    status: string
  },
): Promise<string | null> {
  if (document.status !== 'finalised' && document.status !== 'issued') return null

  const purpose =
    document.docType === 'invoice'
      ? 'debtor_invoice'
      : document.docType === 'quote' || document.docType === 'sales_order'
        ? 'document_deposit'
        : null
  if (!purpose) return null

  try {
    const { payLinkUrl } = await import('./payLinks')
    return await payLinkUrl(siteId, purpose, document.id)
  } catch {
    return null
  }
}

/**
 * A stand-in pay link, for the STATIONERY PREVIEW only.
 *
 * ── WHY THE PREVIEW NEEDS A FAKE ONE ──────────────────────────────────────
 *
 * The designer renders against sample data, so there is no real invoice and
 * therefore no real pay link — which meant a QR block aimed at "this document"
 * drew nothing at all on the one screen whose whole job is showing what the
 * paper will look like. A designer cannot size, place or caption a square they
 * cannot see, and blank space reads as a broken feature rather than an absent
 * sample.
 *
 * So the preview gets a REAL-SHAPED url that resolves to nothing: same origin,
 * same `/p/<site36>-<slug>` shape, so the square has the same module count and
 * visual weight as the one that will print. `SAMPLE` is not base58 — the
 * alphabet excludes it — so it can never collide with a real slug, and anyone
 * scanning a preview off a screen gets a 404 rather than somebody's invoice.
 *
 * It is NOT minted, stored or revocable, and it never leaves the designer.
 */
export function samplePayUrl(siteId: number): string | null {
  const base = appBaseUrl()
  if (!base) return null
  return `${base}/p/${siteId.toString(36)}-SAMPLE0LINK0`
}

export async function qrContextFor(
  siteId: number,
  /** This document's own public page, where the caller has one. */
  documentUrl: string | null = null,
): Promise<QrContext> {
  const appUrl = appBaseUrl()

  let storeUrl: string | null = null
  let reviewUrl: string | null = null

  try {
    const online = await getOnlineSettings(siteId)
    /*
     * The shop's own domain if it has told us one, otherwise this app's — which
     * is where the storefront actually answers. Cleaned through the same
     * function a typed address goes through, so a domain saved before these
     * rules existed cannot produce a link the designer would have refused.
     */
    /*
     * The shop's own domain if it has told us one, otherwise this app's — which
     * is where the storefront actually answers.
     *
     * Both go through cleanCustomUrl, which means an APP_URL of
     * http://localhost:4100 yields NOTHING. That is correct rather than
     * awkward: a QR is scanned by a phone that is not on this machine, so a
     * localhost square is a square that cannot work, and an http one on a real
     * deployment is a link we are not willing to put on a customer's paper. A
     * shop that wants store QR codes needs an https address, and until it has
     * one the block prints its caption and no square.
     */
    storeUrl = online.publicDomain
      ? cleanCustomUrl(online.publicDomain)
      : appUrl
        ? cleanCustomUrl(appUrl)
        : null
  } catch {
    storeUrl = null
  }

  try {
    reviewUrl = cleanCustomUrl((await getSetting(siteId, 'document_review_url')) || '')
  } catch {
    reviewUrl = null
  }

  return { appUrl, storeUrl, reviewUrl, documentUrl }
}

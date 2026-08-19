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

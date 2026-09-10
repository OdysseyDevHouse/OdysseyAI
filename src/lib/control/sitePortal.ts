import 'server-only'
import { portalConfig, send } from './portalApi'
import type { Site } from '../sites'

/**
 * The shop's own cp2_sites row, over HTTPS — one writable field on it.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Setup → My store information is read-only for a local store; its details are
 * mirrored control panel → shop and changed there. The VAT number is the one
 * deliberate exception, because a shop cannot put a product on a tax rate until
 * it has one captured — see LOCAL_EDITABLE in setup/store-info/actions.ts.
 *
 * That exception was written straight to cp2_sites, and a desktop build has no
 * socket to write it with: pool() refuses. The save came back to the shop as
 * "this needs an internet connection", which was not true and could not be
 * detected as untrue — ControlDbUnavailableOnDesktop carries no errno, so
 * isControlUnreachable counts it as offline by design. A shop that owns its own
 * database therefore could not capture its own VAT number by any means.
 *
 * ── WHY ONLY THE VAT NUMBER ─────────────────────────────────────────────────
 *
 * The route accepts that field and no other, and this client cannot ask for
 * more. A site key is a machine credential on a shop counter; the surface it
 * opens is the smallest thing that solves the problem. Everything else on that
 * row stays control-panel-only, which is the rule the screen already draws.
 *
 * ── WHY IT ANSWERS WITH THE WHOLE SITE ──────────────────────────────────────
 *
 * On a desktop install the mirror is the PRIMARY answer — getSite() reads
 * site_profile and never reaches cp2_sites — so nothing would refresh the copy
 * after a successful save and the screen would go on showing the old number.
 * The caller re-mirrors from what the portal says landed rather than from what
 * it asked for, which is the discipline updateSiteDetails already follows when
 * it re-reads after writing, and it reports a truncated value as truncated.
 */

/** Is there anything to ask? Cheap, and read per call so a test can flip it. */
export function portalAvailable(): boolean {
  return portalConfig() !== null
}

/**
 * This shop's own details, as the control panel holds them right now.
 *
 * ── WHY A DESKTOP INSTALL NEEDS TO ASK AT ALL ───────────────────────────────
 *
 * It answers "which shop is this" from site_profile, and that mirror was
 * designed to be rewritten off the back of every successful control read. When
 * the control socket was banned there were no successful control reads left, so
 * the mirror stopped moving: a change made in the control panel never arrived,
 * and the shop went on printing the old details on every document.
 *
 * This is the read that puts that flow back. `null` means it could not be asked
 * — no key, unreachable, refused, or an answer that was not an answer — and the
 * caller keeps the copy it has. A stale mirror is bad; a mirror overwritten
 * with nothing is worse.
 */
export async function fetchSiteDetails(): Promise<Site | null> {
  if (!portalAvailable()) return null

  const res = await send<{ site: Site }>('GET', '/site/details')
  if (!res.ok) {
    if (res.reason === 'refused') {
      console.error(`[portal] site/details refused (${res.code}): ${res.error}`)
    }
    return null
  }
  if (!res.data?.site || typeof res.data.site.id !== 'number') return null
  return res.data.site
}

/**
 * What the portal did with a VAT number.
 *
 * `null` means it could not be asked at all — no key, unreachable, or an answer
 * that was not an answer — and the caller falls back to its own SQL. A refusal
 * is NOT that: the portal decided, and re-running a decided write against the
 * direct connection would let a bad key quietly revert this to the socket all
 * of it exists to stop needing. Same rule as usersPortal.provisionControlAccount.
 */
export type VatSaveResult =
  | { ok: true; site: Site }
  | { ok: false; error: string; archived: boolean }

/**
 * Save this shop's VAT number, as the shop.
 *
 * There is no siteId argument on purpose: the route acts on the site that
 * SIGNED the request and can act on no other, so a caller cannot name a store
 * and this cannot be pointed at the wrong one. The caller checks that the
 * signing site is the one on screen before it asks — see updateSiteVatNumber.
 */
export async function saveVatNumber(vatNumber: string | null): Promise<VatSaveResult | null> {
  if (!portalAvailable()) return null

  const res = await send<{ ok: boolean; site: Site }>('POST', '/site/vat', { vatNumber })
  if (res.ok) {
    /* A 200 whose body is not the shape this destructures is not an answer.
       Treated as "could not ask" rather than as a failed save: the write may
       well have landed, and the fallback below re-reads either way. */
    if (!res.data?.site || typeof res.data.site.id !== 'number') return null
    return { ok: true, site: res.data.site }
  }

  if (res.reason === 'refused') {
    console.error(`[portal] site/vat refused (${res.code}): ${res.error}`)

    /* ── A MISSING ROUTE IS NOT A DECISION ────────────────────────────────
     *
     * send() classifies every non-2xx as a refusal, including a 404 from a
     * portal that has not been deployed with this route yet — and a 404 has
     * decided nothing. Letting it stand as a refusal would block the fallback
     * on a cloud install where the direct connection works perfectly, which is
     * the opposite of what the no-fallback-on-refusal rule is protecting.
     *
     * On desktop the fallback throws either way, so this changes nothing there
     * except which sentence the shop is shown. */
    if (res.status === 404 || res.status === 405) return null

    /* The portal distinguishes "no such row" from "no". Kept apart here because
       the screen says different things about them, and because an archived
       store is not something a shop fixes by trying again. */
    const archived = res.code === 'site_unavailable'
    return {
      ok: false,
      archived,
      error: archived
        ? 'This store could not be updated. It may have been archived.'
        : 'The control panel refused to save this VAT number.',
    }
  }

  return null
}

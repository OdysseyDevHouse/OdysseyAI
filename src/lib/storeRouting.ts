import 'server-only'
import { verifyPublicStoreToken } from './publicStoreToken'
import { groupForSite, membersOfGroup } from './storeGroups'
import { branchPinsFor, type BranchPin } from './control/storeBranches'
import { allHold } from './control/modules'

/**
 * Which shop a storefront URL is talking to — and, for a chain, which branch.
 *
 * A group storefront has two answers where a single shop has one: the CATALOGUE
 * (the group's primary, which owns the product file and the branding) and the
 * BRANCH (the shop that will pack the order and take the money). This module is
 * the one place those are decided, so no route has to work it out for itself.
 *
 * ── PRECEDENCE: TOKEN, THEN COOKIE, THEN ASK ────────────────────────────────
 *
 * A link may name a branch. A returning shopper has one in a cookie. Neither is
 * present on a first visit. They are resolved strictly in that order, because a
 * QR code on a shop's door has to win: somebody standing in Claremont holding
 * their phone must get Claremont, whatever they were browsing last week.
 *
 * ── WHEN GROUP MODE IS OFF, THIS DOES NOTHING ───────────────────────────────
 *
 * A shop in no group, or a group that has not switched the shared storefront on,
 * resolves to itself with `isGroup: false` and every field pointing at the one
 * site. That is every shop today, and it must stay indistinguishable from the
 * behaviour before this file existed.
 */

export type StoreRouting = {
  /** Where the catalogue, branding and pages come from. */
  catalogueSiteId: number
  /** The shop that will fulfil an order placed here. */
  branchSiteId: number
  /** True when this storefront serves a whole group. */
  isGroup: boolean
  /**
   * True when the branch came from the LINK rather than from a cookie or a
   * choice. A pinned visit never prompts for location — someone who scanned the
   * door does not need to be asked where they are.
   */
  isPinned: boolean
  /**
   * True when no branch has been chosen yet and the shopper must be asked. The
   * page still renders — the catalogue is the primary's — but it renders with
   * the picker up and every price marked provisional.
   */
  needsBranchChoice: boolean
  /** Every branch that could be chosen. Empty when this is not a group. */
  branches: BranchPin[]
}

/** What a single shop resolves to. Also the fallback for every refusal below. */
function soloStore(siteId: number): StoreRouting {
  return {
    catalogueSiteId: siteId,
    branchSiteId: siteId,
    isGroup: false,
    isPinned: false,
    needsBranchChoice: false,
    branches: [],
  }
}

/**
 * Resolve a storefront token, and a remembered branch, to a routing decision.
 *
 * `token` is verified first and is the only untrusted input that matters: the
 * cookie can name any site at all, so it is honoured ONLY if it names a member
 * of this group that is open for online orders. A cookie carried over from
 * another shop, or naming a branch that has since left the group or closed, is
 * ignored rather than obeyed — falling back to asking, which is always safe.
 *
 * Returns null when the token itself does not resolve. Callers 404 on that, so a
 * bad token and a closed shop stay indistinguishable from outside.
 */
export async function resolveStoreRouting(
  token: string,
  rememberedBranchId?: number | null,
): Promise<StoreRouting | null> {
  // Also checks the online_store module and fails closed — see that function.
  const tokenSiteId = await verifyPublicStoreToken(token)
  if (tokenSiteId === null) return null

  /*
   * Everything below is an enhancement to a storefront that already works. A
   * control-database hiccup while reading groups must degrade this shop to the
   * single-store behaviour it had last week, not 404 a shop that is open. The
   * token check above is the part that fails closed; this part fails soft.
   */
  try {
    const group = await groupForSite(tokenSiteId)
    if (!group || !group.onlineGroupMode) return soloStore(tokenSiteId)

    // The catalogue is always the group's primary. A member's own token still
    // shows the group's product file — that is what "one storefront" means.
    const catalogueSiteId = group.primarySiteId ?? tokenSiteId

    /*
     * Both ends must hold multi_branch, exactly as linkedStores() requires for
     * product fan-out. A group whose primary declined the module does not get a
     * shared storefront through the back door of a member's link.
     */
    const members = await membersOfGroup(group.id)
    const memberIds = members.filter((m) => m.hasDatabase).map((m) => m.siteId)
    const ids = [...new Set([catalogueSiteId, ...memberIds])]
    const [entitled, shops] = await Promise.all([
      allHold(ids, 'multi_branch'),
      /*
       * A branch also needs its OWN online_store module, because that is what
       * verifyPublicStoreToken checks when the shopper eventually lands on it.
       * Offering a branch here that would 404 the moment it is chosen turns a
       * lapsed subscription into a dead end halfway through a basket, which is
       * worse than never having listed the shop.
       */
      allHold(ids, 'online_store'),
    ])
    if (!entitled.has(catalogueSiteId)) return soloStore(tokenSiteId)

    const openIds = memberIds.filter((id) => entitled.has(id) && shops.has(id))
    // Pins carry the "is this shop open online" copy and the picker's labels.
    const pins = (await branchPinsFor(openIds)).filter((p) => p.acceptsOnline)
    if (pins.length === 0) return soloStore(tokenSiteId)

    const isMember = (id: number) => pins.some((p) => p.siteId === id)

    /*
     * The link named a branch when the token is a member's own rather than the
     * primary's. That is what makes a per-branch QR code work with no second
     * path segment and no cookie write before the first render.
     */
    if (tokenSiteId !== catalogueSiteId && isMember(tokenSiteId)) {
      return {
        catalogueSiteId,
        branchSiteId: tokenSiteId,
        isGroup: true,
        isPinned: true,
        needsBranchChoice: false,
        branches: pins,
      }
    }

    // The remembered choice, honoured only if it is still a real, open member.
    if (rememberedBranchId && isMember(rememberedBranchId)) {
      return {
        catalogueSiteId,
        branchSiteId: rememberedBranchId,
        isGroup: true,
        isPinned: false,
        needsBranchChoice: false,
        branches: pins,
      }
    }

    /*
     * Nothing chosen yet. The branch falls back to the primary so that every
     * downstream read has a real site to work with and the catalogue renders —
     * but needsBranchChoice says the figures are provisional and the shopper
     * must be asked before anything is ordered.
     */
    return {
      catalogueSiteId,
      branchSiteId: catalogueSiteId,
      isGroup: true,
      isPinned: false,
      needsBranchChoice: true,
      branches: pins,
    }
  } catch (e) {
    console.error('[storefront] group routing failed; serving the single store', e)
    return soloStore(tokenSiteId)
  }
}

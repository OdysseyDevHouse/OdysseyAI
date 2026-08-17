import { haversineKm } from './jobStatusModel'

/**
 * Ordering the branches of a chain for a shopper.
 *
 * Pure, and deliberately so: the storefront ranks branches on the server before
 * the first paint, and the picker re-ranks them in the browser the moment a
 * shopper allows their location. Both must produce the same list from the same
 * inputs, which they cannot do if the rule lives in a query.
 *
 * The distance is a straight line, not a drive. That is honest for what it is
 * used for — choosing between shops that are kilometres apart — and pretending
 * otherwise would need a routing provider this app does not have.
 */

/** The shape this module needs. Deliberately narrower than a full BranchPin. */
export type RankableBranch = {
  siteId: number
  latitude: number | null
  longitude: number | null
  displayName: string
  sortOrder: number
}

export type RankedBranch<T extends RankableBranch> = T & {
  /** Straight-line kilometres, or null when the branch has no pin. */
  km: number | null
}

export type Coords = { lat: number; lng: number }

/** Rejects the wrong hemisphere, a swapped pair, and a browser that returned junk. */
export function isUsableFix(fix: Coords | null | undefined): fix is Coords {
  return (
    !!fix &&
    Number.isFinite(fix.lat) &&
    Number.isFinite(fix.lng) &&
    fix.lat >= -90 &&
    fix.lat <= 90 &&
    fix.lng >= -180 &&
    fix.lng <= 180 &&
    // 0,0 is in the Gulf of Guinea and is what a broken geolocation call returns
    // far more often than it is where a shopper is standing.
    !(fix.lat === 0 && fix.lng === 0)
  )
}

/**
 * The branches, nearest first.
 *
 * ── WHAT HAPPENS WITHOUT A FIX ──────────────────────────────────────────────
 *
 * Everything still works. With no fix — the shopper declined, the browser has no
 * location, or the reading was junk — every branch gets `km: null` and the list
 * comes back in the owner's running order. The picker is always usable; GPS only
 * ever REORDERS it. That is why there is no separate "no location" code path to
 * get wrong.
 *
 * ── AND WITHOUT A PIN ───────────────────────────────────────────────────────
 *
 * An unpinned branch sorts last, keeps `km: null`, and is still returned. A
 * group part-way through being set up must not have half its shops vanish from
 * the picker: unfindable by distance is a nuisance, unchoosable is a lost sale.
 *
 * Ties break on the owner's order and then on name, so the list is stable — a
 * shopper who re-opens the picker must not see the same shops in a new order.
 */
export function rankBranches<T extends RankableBranch>(
  branches: readonly T[],
  fix?: Coords | null,
): RankedBranch<T>[] {
  const from = isUsableFix(fix) ? fix : null

  const ranked = branches.map((b) => ({
    ...b,
    km:
      from && b.latitude !== null && b.longitude !== null
        ? haversineKm(from.lat, from.lng, b.latitude, b.longitude)
        : null,
  }))

  return ranked.sort((a, b) => {
    // Unpinned last, whether or not we have a fix at all.
    if (a.km === null && b.km !== null) return 1
    if (a.km !== null && b.km === null) return -1
    if (a.km !== null && b.km !== null && a.km !== b.km) return a.km - b.km
    return a.sortOrder - b.sortOrder || a.displayName.localeCompare(b.displayName)
  })
}

/**
 * The nearest branch, or null when none can be chosen for the shopper.
 *
 * Null is the signal to ASK rather than to guess. It means either that nothing
 * is pinned, or that the closest shop is further away than `maxKm` — someone in
 * Cape Town opening a Johannesburg chain's storefront should be shown a list of
 * cities, not silently allocated to a branch 1,400 km away whose delivery zones
 * will refuse their address at checkout.
 *
 * 150 km by default: comfortably wider than any metro, narrow enough that a
 * different province never auto-selects.
 */
export function nearestBranch<T extends RankableBranch>(
  branches: readonly T[],
  fix: Coords | null | undefined,
  maxKm = 150,
): RankedBranch<T> | null {
  if (!isUsableFix(fix)) return null
  const [closest] = rankBranches(branches, fix)
  if (!closest || closest.km === null) return null
  return closest.km <= maxKm ? closest : null
}

/**
 * A distance a person would say out loud.
 *
 * Two decimals on a straight-line estimate claims a precision the number does
 * not have — the road there is longer than this in a way that varies. Under a
 * kilometre reads in metres, rounded to 50, because "600 m" is useful and
 * "0.6 km" makes a reader do arithmetic.
 */
export function formatKm(km: number | null): string {
  if (km === null || !Number.isFinite(km)) return ''
  if (km < 1) return `${Math.max(50, Math.round((km * 1000) / 50) * 50)} m`
  if (km < 10) return `${km.toFixed(1)} km`
  return `${Math.round(km)} km`
}

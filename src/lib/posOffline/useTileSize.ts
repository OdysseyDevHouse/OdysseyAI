'use client'

import { createContext, useCallback, useContext, useEffect, useState } from 'react'

/**
 * How big the till draws its tiles, remembered per machine.
 *
 * A counter screen is a fixed piece of hardware, and how many products fit on it
 * usefully is a property of THAT screen and the person standing at it — a 1024-wide
 * till in a kiosk and a 27" counter display want different answers, and neither
 * wants the other's. So this is a device preference in localStorage rather than a
 * site setting: it does not belong in the database, it should not sync between
 * tills, and a manager should not have to set it for each one.
 *
 * ── WHY THE DEFAULT IS READ AFTER MOUNT, NOT DURING RENDER ─────────────────
 *
 * localStorage does not exist on the server. Reading it during the first render
 * gives the server one number and the client another, and React then reports a
 * hydration mismatch and discards the client tree — on the till's busiest pane.
 *
 * So the first render ALWAYS uses the default, and the stored value is applied in an
 * effect. The cost is one reflow of the grid on load, which is invisible next to the
 * catalog query that is already in flight. The alternative — suppressHydrationWarning
 * — silences the report without fixing the mismatch.
 */

/** The grid recipe every till pane draws with. Matches TileGrid's own defaults. */
export type TileSize = { width: number; height: number }

/**
 * 190×150 is what the three catalogue grids hardcoded before this existed, so the
 * default changes nothing for a till that has never been adjusted.
 *
 * The range comes from TileGrid's docblock: below ~110 a price and a description
 * stop fitting, above ~420 a tile stops reading as one of a set.
 */
export const TILE_SIZE_DEFAULT: TileSize = { width: 190, height: 150 }
export const TILE_WIDTH_MIN = 110
export const TILE_WIDTH_MAX = 420
export const TILE_HEIGHT_MIN = 80
export const TILE_HEIGHT_MAX = 200

const KEY = 'odyssey.pos.tileSize'

/**
 * Clamped on the way OUT of storage, not just on the way in.
 *
 * A stored value is untrusted input: it may predate a change to these bounds, or
 * have been typed into DevTools. An unclamped 4000 gives one tile per row with the
 * rest of the catalogue below the fold, and the only way back is to know this key
 * exists — so a bad stored value must degrade to a usable grid rather than an
 * unusable one.
 */
function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

export function useTileSize(): {
  size: TileSize
  setSize: (next: TileSize) => void
  reset: () => void
} {
  const [size, setSizeState] = useState<TileSize>(TILE_SIZE_DEFAULT)

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as Partial<TileSize>
      setSizeState({
        width: clamp(parsed?.width, TILE_WIDTH_MIN, TILE_WIDTH_MAX, TILE_SIZE_DEFAULT.width),
        height: clamp(parsed?.height, TILE_HEIGHT_MIN, TILE_HEIGHT_MAX, TILE_SIZE_DEFAULT.height),
      })
    } catch {
      /* Malformed JSON, or storage blocked entirely (private mode, a locked-down
         kiosk profile). Either way the default is a working grid, and a till that
         cannot remember a tile size must still sell. */
    }
  }, [])

  const setSize = useCallback((next: TileSize) => {
    const clamped = {
      width: clamp(next.width, TILE_WIDTH_MIN, TILE_WIDTH_MAX, TILE_SIZE_DEFAULT.width),
      height: clamp(next.height, TILE_HEIGHT_MIN, TILE_HEIGHT_MAX, TILE_SIZE_DEFAULT.height),
    }
    setSizeState(clamped)
    try {
      window.localStorage.setItem(KEY, JSON.stringify(clamped))
    } catch {
      /* Storage full or blocked. The size still applies for this session — losing
         the preference is a far smaller failure than refusing to resize. */
    }
  }, [])

  const reset = useCallback(() => {
    setSizeState(TILE_SIZE_DEFAULT)
    try {
      window.localStorage.removeItem(KEY)
    } catch {
      /* As above. */
    }
  }, [])

  return { size, setSize, reset }
}

/**
 * The size every grid on the till reads.
 *
 * A context rather than a prop because three separate grids inside CatalogPane —
 * the department drill, the search results and the loading skeleton — all have to
 * agree, and the skeleton in particular must match the grid it is standing in for
 * or the tiles visibly jump when the real ones arrive. Threading one number through
 * four components to keep them identical is how they drift apart instead.
 *
 * Defaults rather than throwing when there is no provider: a grid outside the till
 * (the Style Guide, a future setup preview) should draw at the default size, not
 * crash.
 */
export const TileSizeContext = createContext<TileSize>(TILE_SIZE_DEFAULT)

/** The current till tile size. Falls back to the default outside a provider. */
export function useTileSizeValue(): TileSize {
  return useContext(TileSizeContext)
}

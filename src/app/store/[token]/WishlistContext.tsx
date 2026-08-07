'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { MAX_WISHLIST } from '@/lib/wishlist'

/**
 * Things a shopper saved for later.
 *
 * ── localStorage, NOT sessionStorage OR A COOKIE ─────────────────────────
 *
 * The basket uses sessionStorage because a basket is a session's intent — a
 * week-old one at last week's prices is worse than starting fresh. A wishlist
 * is the opposite: surviving the tab is its entire purpose.
 *
 * Not a cookie either. A cookie is sent on every single request, so this would
 * ride along on hundreds of requests that never read it, inside a ~4KB budget
 * shared with the session. Safari also clamps script-set cookies to seven
 * days, which would quietly wipe an iPhone shopper's list every week.
 *
 * ── IT STORES IDS, NOTHING ELSE ──────────────────────────────────────────
 *
 * No prices, no names, no quantities. Every product on the wishlist page is
 * resolved from today's catalogue, so a price change or a rename shows up by
 * itself — and a tampered entry resolves to nothing rather than exposing a
 * product the shop does not publish.
 *
 * ── KEYED PER STORE ──────────────────────────────────────────────────────
 *
 * One browser may shop at two stores on this platform, and product ids are
 * per-site. A shared list would show one shop's saved items in another's.
 */


type WishlistApi = {
  /** Saved product ids, newest first. */
  ids: number[]
  has: (productId: number) => boolean
  /** Adds or removes. Read `has` for the result — see the note on toggle. */
  toggle: (productId: number) => void
  remove: (productId: number) => void
  clear: () => void
  count: number
  /** False until localStorage has been read, so SSR and first paint agree. */
  ready: boolean
}

const WishlistContext = createContext<WishlistApi | null>(null)

export function useWishlist(): WishlistApi {
  const context = useContext(WishlistContext)
  if (!context) throw new Error('useWishlist must be used inside a WishlistProvider')
  return context
}

const storageKey = (token: string) => `odyssey.wishlist.${token}`

/**
 * Read and VALIDATE. Whatever is in storage was last written by us, but it may
 * have been edited by hand, written by an older version, or corrupted — so
 * every entry is checked rather than trusted.
 */
function read(token: string): number[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(storageKey(token))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []

    const out: number[] = []
    const seen = new Set<number>()
    for (const entry of parsed) {
      const id = typeof entry === 'number' ? entry : Number(entry)
      if (!Number.isInteger(id) || id <= 0) continue
      if (seen.has(id)) continue
      seen.add(id)
      out.push(id)
      if (out.length >= MAX_WISHLIST) break
    }
    return out
  } catch {
    // Unreadable JSON, private mode, disabled storage. An empty wishlist is
    // the right answer; a thrown error would take the whole shop down.
    return []
  }
}

export function WishlistProvider({ token, children }: { token: string; children: ReactNode }) {
  const [ids, setIds] = useState<number[]>([])
  const [ready, setReady] = useState(false)

  /*
   * Read in an effect, NOT in useState's initialiser.
   *
   * The server renders this component too, with an empty list. Seeding
   * synchronously in the browser would make the first client render disagree
   * with the server's HTML — a hydration mismatch. `ready` is what lets a
   * consumer avoid flashing "nothing saved" at someone with a full list.
   */
  useEffect(() => {
    setIds(read(token))
    setReady(true)
  }, [token])

  // Gated on `ready`, or the initial empty state would overwrite the stored
  // list before the read above has had a chance to run.
  useEffect(() => {
    if (!ready) return
    try {
      window.localStorage.setItem(storageKey(token), JSON.stringify(ids))
    } catch {
      /* quota or private mode — the list just won't survive a reload */
    }
  }, [ids, ready, token])

  /*
   * Another tab changed the list. `storage` only fires in OTHER tabs, so this
   * never fights its own write — a heart filled in one tab shows filled in the
   * other.
   */
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === storageKey(token)) setIds(read(token))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [token])

  const has = useCallback((productId: number) => ids.includes(productId), [ids])

  /*
   * Returns nothing, deliberately.
   *
   * An earlier shape returned "is it now saved" by capturing a variable set
   * inside the updater — but React may run an updater twice (StrictMode, a
   * replayed render), so that answer is a guess. Callers read `has` on the
   * next render instead, which is the truth.
   */
  const toggle = useCallback((productId: number) => {
    setIds((prev) => {
      if (prev.includes(productId)) return prev.filter((id) => id !== productId)
      // Newest first, and the cap drops the OLDEST. Saving one more than the
      // cap should not silently destroy the one you just saved.
      return [productId, ...prev].slice(0, MAX_WISHLIST)
    })
  }, [])

  const remove = useCallback((productId: number) => {
    setIds((prev) => prev.filter((id) => id !== productId))
  }, [])

  const clear = useCallback(() => setIds([]), [])

  const value = useMemo<WishlistApi>(
    () => ({ ids, has, toggle, remove, clear, count: ids.length, ready }),
    [ids, has, toggle, remove, clear, ready],
  )

  return <WishlistContext.Provider value={value}>{children}</WishlistContext.Provider>
}

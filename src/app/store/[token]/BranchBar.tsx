'use client'

import { useActionState, useEffect, useState, useTransition } from 'react'
import { Button, Icons } from '@/components/ui'
import { formatKm, type Coords } from '@/lib/storeBranchPicker'
import { chooseBranchAction, nearestBranchesAction, type BranchChoiceState } from './branchActions'

/**
 * Which shop the prices on this page belong to.
 *
 * A chain runs one storefront, so everything below this bar — the price, the
 * stock, the delivery charge, the collection time — is one particular branch's.
 * Saying which is not decoration: without it the shopper is reading numbers
 * without knowing whose they are.
 *
 * ── WHY THE UNCHOSEN STATE IS LOUD AND THE CHOSEN ONE IS QUIET ──────────────
 *
 * Before a branch is picked every figure on the page is provisional, so the bar
 * is a call to action. After it is picked the answer is context, and context
 * that keeps shouting is noise. Two states, deliberately different weights.
 *
 * Nothing here blocks browsing. A shopper who ignores the bar entirely can still
 * read the whole catalogue; they are asked again at checkout, where the answer
 * finally has to exist.
 */

export type BranchChoice = {
  siteId: number
  name: string
  address: string
  latitude: number | null
  longitude: number | null
  sortOrder: number
}

export type BranchState = {
  name: string
  needsChoice: boolean
  pinned: boolean
  choices: BranchChoice[]
}

type Ranked = { siteId: number; name: string; km: number | null }

export default function BranchBar({ token, branch }: { token: string; branch: BranchState }) {
  const [open, setOpen] = useState(branch.needsChoice)
  const [ranked, setRanked] = useState<Ranked[] | null>(null)
  const [locating, setLocating] = useState(false)
  /*
   * Once a browser has refused, asking again does nothing — Chrome remembers
   * the denial and the prompt never appears. Offering the button a second time
   * is offering something that visibly fails, so it is replaced by the list.
   */
  const [denied, setDenied] = useState(false)
  const [pending, startTransition] = useTransition()
  const [state, choose] = useActionState<BranchChoiceState, FormData>(chooseBranchAction, {
    error: null,
  })

  /*
   * Closing once the server says a branch is settled.
   *
   * Easy half to miss: choosing a branch re-renders the whole storefront and
   * this component comes back with needsChoice: false — but its own `open` was
   * seeded true and would leave the dialog sitting over the shop that was just
   * chosen. Watched rather than closed in the submit handler because the choice
   * is only real once the server has accepted it.
   *
   * Only ever CLOSES here. Re-opening on needsChoice would fight a shopper who
   * pressed Change, since that sets `open` while needsChoice is already false.
   */
  useEffect(() => {
    if (!branch.needsChoice) setOpen(false)
  }, [branch.needsChoice])

  function locate() {
    if (!('geolocation' in navigator)) {
      setDenied(true)
      return
    }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const fix: Coords = { lat: pos.coords.latitude, lng: pos.coords.longitude }
        startTransition(async () => {
          setRanked(await nearestBranchesAction(token, fix))
          setLocating(false)
        })
      },
      () => {
        setDenied(true)
        setLocating(false)
      },
      /*
       * Low accuracy on purpose: this is choosing between shops kilometres
       * apart, not navigating. A cached fix up to ten minutes old answers
       * instantly and is easily good enough.
       */
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 },
    )
  }

  const list: Ranked[] =
    ranked ??
    [...branch.choices]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      .map((b) => ({ siteId: b.siteId, name: b.name, km: null }))

  const addressFor = (siteId: number) =>
    branch.choices.find((c) => c.siteId === siteId)?.address ?? ''

  return (
    <div className="border-b border-border bg-surface">
      <div className="mx-auto w-full max-w-6xl px-4">
        {branch.needsChoice ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
            <Icons.MapPin size={16} className="shrink-0 text-brand" />
            <span className="text-sm font-medium text-ink">Which store?</span>
            <span className="text-sm text-muted">
              Prices, stock and delivery differ by store.
            </span>
            <span className="ml-auto">
              <Button type="button" variant="primary" size="sm" onClick={() => setOpen(true)}>
                Choose a store
              </Button>
            </span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2.5">
            <Icons.MapPin size={15} className="shrink-0 text-muted" />
            <span className="text-sm text-ink-2">
              Shopping at <span className="font-medium text-ink">{branch.name}</span>
            </span>
            {/* Someone who scanned the QR on a door is standing in that shop.
                They can still switch, but it is not the offer to lead with. */}
            <span className="ml-auto">
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
                Change
              </Button>
            </span>
          </div>
        )}
      </div>

      {open && (
        <div
          className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Choose a store"
          onClick={(e) => {
            // Dismissable only once there is an answer to keep.
            if (e.target === e.currentTarget && !branch.needsChoice) setOpen(false)
          }}
        >
          <div className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-card bg-surface p-5 shadow-pop sm:rounded-card">
            <div className="mb-1 flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-ink">Choose your store</h2>
              {!branch.needsChoice && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label="Close"
                  onClick={() => setOpen(false)}
                >
                  <Icons.Close size={18} />
                </Button>
              )}
            </div>
            <p className="mb-4 text-sm text-muted">
              We&rsquo;ll show you prices, stock and delivery for the store you pick.
            </p>

            {state.error && (
              <p className="mb-3 rounded-control bg-danger-soft px-3 py-2 text-sm text-danger-ink">
                {state.error}
              </p>
            )}

            {!denied && ranked === null && (
              <div className="mb-4 rounded-card border border-border p-3">
                <Button
                  type="button"
                  variant="primary"
                  className="w-full"
                  onClick={locate}
                  disabled={locating || pending}
                >
                  <Icons.MapPin size={15} />
                  {locating || pending ? 'Finding you…' : 'Use my location'}
                </Button>
                {/* Said BEFORE the browser's own prompt appears, so the prompt
                    is expected rather than an ambush — and because a promise
                    about retention is worth nothing after the fact. */}
                <p className="mt-2 text-xs leading-relaxed text-muted">
                  We ask your browser once, use it to find your closest store, and forget it.
                  Nothing is saved and you are not tracked. You can pick from the list instead.
                </p>
              </div>
            )}

            {denied && (
              <p className="mb-3 text-sm text-muted">
                No problem — pick your store below and we&rsquo;ll remember it.
              </p>
            )}

            <ul className="flex flex-col gap-2">
              {list.map((option) => {
                const address = addressFor(option.siteId)
                return (
                  <li key={option.siteId}>
                    <form action={choose}>
                      <input type="hidden" name="token" value={token} />
                      <input type="hidden" name="branchSiteId" value={option.siteId} />
                      {/* Not a kit Button: a selection row carrying a name, an
                          address and a distance on two lines. No variant
                          expresses that, and forcing one would restyle all
                          three — the same call CartBar makes for its strip. */}
                      <button
                        data-kit-ok
                        type="submit"
                        className="flex w-full items-center gap-3 rounded-card border border-border px-3 py-3 text-left transition hover:border-brand hover:bg-surface-2"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-ink">
                            {option.name}
                          </span>
                          {address && (
                            <span className="block truncate text-xs text-muted">{address}</span>
                          )}
                        </span>
                        {option.km !== null && (
                          <span className="numeric shrink-0 text-xs font-medium text-muted">
                            {formatKm(option.km)}
                          </span>
                        )}
                      </button>
                    </form>
                  </li>
                )
              })}
            </ul>

            {list.length === 0 && (
              <p className="text-sm text-muted">
                No stores are taking online orders at the moment. Please try again later.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

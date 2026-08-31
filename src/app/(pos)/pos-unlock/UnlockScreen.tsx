'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Card, PinPad, Button, Icons, Callout } from '@/components/ui'
import { deviceId } from '@/lib/deviceId'
import { ensureWindowId } from '@/lib/windowSession'
import { posUnlockAction, unlockSitesAction } from './actions'
import type { DeviceSite } from '@/lib/site/terminals'

/**
 * "The till needs to sign in again."
 *
 * Deliberately says almost nothing. It is a public URL, so every fact it could
 * display — the shop's name, who works here, how many sales are queued — is a fact
 * handed to whoever opens it. A PIN pad and one sentence is the whole screen.
 *
 * The one thing it does show is WHY, because a cashier who arrives at 07:00 to a
 * PIN prompt they have never seen before needs to know this is routine and their
 * own PIN will clear it.
 *
 * ── THE ONE EXCEPTION, AND WHAT IT COSTS ──────────────────────────────────
 *
 * A machine registered as a till in SEVERAL shops is offered the choice between
 * them by name, which does put shop names on a public URL. Weighed rather than
 * waved through:
 *
 *   · It is keyed on THIS MACHINE's own device id. Somebody opening /pos-unlock
 *     on their own laptop is registered nowhere and sees nothing at all — the
 *     names are not enumerable, and there is no id to guess that would produce
 *     another shop's list.
 *   · What leaks is therefore "the shops this particular machine is a till in",
 *     to somebody already sitting at that machine — who can read the shop's name
 *     off the wall, the till slips, and the invoice on the counter.
 *   · The alternative is the failure this replaced: resolving the site by sort
 *     order, so one company's counter silently opens another company's data.
 *
 * A shop name shown to the person standing in the shop is a smaller cost than
 * that. It stays limited to the multi-store case — a single-store machine
 * renders no list, exactly as before.
 */
export default function UnlockScreen() {
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  // Browser-only, so it resolves after mount. Until it does, the pad is shown but
  // submitting would send an empty device id — which the action refuses anyway.
  const [device, setDevice] = useState<string | null>(null)
  useEffect(() => setDevice(deviceId()), [])

  /*
   * ── WHICH SHOP, WHEN THIS MACHINE SERVES SEVERAL ────────────────────────
   *
   * One PC can invoice for two stores — a real arrangement, with a separately
   * paid licence in each. The unlock used to resolve the site by taking the
   * FIRST match, which meant a machine registered twice opened whichever
   * happened to sort first, silently.
   *
   * So the machine's own shops are fetched before the PIN is typed, and the
   * choice is offered rather than guessed. `null` means "not asked yet" and one
   * entry means no question worth asking — a picker with a single option is a
   * tap that teaches somebody to tap without reading.
   */
  const [sites, setSites] = useState<DeviceSite[] | null>(null)
  const [siteChoice, setSiteChoice] = useState<number | null>(null)

  useEffect(() => {
    if (!device) return
    let cancelled = false
    void unlockSitesAction(device)
      .then((found) => {
        if (cancelled) return
        setSites(found)
        /* Pre-selected when there is only one, so the single-store case never
           sees a control at all. */
        if (found.length === 1) setSiteChoice(found[0].siteId)
      })
      .catch(() => {
        /* Unreachable. The pad still submits; the action re-resolves the sites
           server-side and will say what is wrong. Better than blocking the one
           screen a shop uses when things are already going badly. */
        if (!cancelled) setSites([])
      })
    return () => {
      cancelled = true
    }
  }, [device])

  function submit(pin: string) {
    setError(null)
    if (!device) {
      setError('This browser has no device identity yet. Reload the page.')
      return
    }
    if (sites && sites.length > 1 && siteChoice === null) {
      setError('Choose which store this till is for.')
      return
    }
    startTransition(async () => {
      const result = await posUnlockAction(
        device,
        pin,
        ensureWindowId(),
        siteChoice ?? undefined,
      )
      if (!result.ok) {
        setError(result.error)
        return
      }
      // Straight back to the till. The cookies are set, so proxy.ts lets it through
      // and the outbox can start flushing.
      router.replace('/pos')
      router.refresh()
    })
  }

  return (
    /* Column, so the card and the way-out below it stack. It was a row while the
       card was the only child; a sibling added to that would have sat beside it.

       ── AND IT SCROLLS, WHICH THE TILL ITSELF MUST NOT ────────────────────

       The layout above is `fixed inset-0 overflow-hidden` on purpose: a till that
       scrolls mid-sale is a till whose keys move under a cashier's thumb. This
       screen is the exception. It is not the till — it is the door — and on a
       tablet held in portrait the card, the pad and the machine id are together
       taller than the viewport.

       `justify-center` alone was the bug: centred content that overflows spills
       off BOTH ends with nothing able to reach it, so the id panel was painted
       below the fold and no gesture could bring it up. `justify-start` with
       `my-auto` on the content keeps the screen centred when it fits — which is
       the desktop and landscape case, and the common one — and lets it scroll
       from the top when it does not. */
    <div className="flex flex-1 flex-col items-center justify-start overflow-y-auto p-6">
      {/* `mt-auto` here and `mb-auto` on the last child are what centre the stack
          when there is room to spare, and collapse to nothing when there is not —
          the behaviour `justify-center` gives right up until it overflows. `shrink-0`
          because a flex column crushes its children before it lets them overflow,
          which on this screen reads as a squashed PIN pad rather than a scroll. */}
      <Card className="mt-auto w-full max-w-sm shrink-0">
        <div className="flex flex-col items-center gap-5 px-6 py-8">
          <div className="text-center">
            {/* Round, tinted, warning-toned: this is a state to clear rather than a
                failure. The same idiom as the till's own gate, one step louder. */}
            <div
              data-kit-ok
              className="mx-auto mb-3 flex size-14 items-center justify-center rounded-full bg-warning-soft"
            >
              <Icons.KeyRound size={26} className="text-warning-ink" />
            </div>
            <h1 className="text-xl font-semibold text-ink">This till is locked</h1>
          </div>

          <Callout tone="warning">
            The till has been signed out — usually because it sat overnight. Enter
            your PIN to carry on. Any sales still waiting to send are safe and will
            go as soon as it unlocks.
          </Callout>

          {/* ── WHICH STORE ─────────────────────────────────────────────────
              Only when this machine is a till in more than one. A picker with a
              single option asks a question with one answer, which teaches people
              to tap it without reading — and every other machine on the platform
              is in that case.

              ABOVE the pad, because it changes what the PIN is checked against:
              the same person can have different PINs in two shops, and a pad
              answered before the store was chosen would be refused for reasons
              nobody could see. */}
          {sites && sites.length > 1 && (
            <div className="w-full">
              <p className="mb-2 text-center text-sm font-medium text-ink">
                Which store is this till for?
              </p>
              <div className="flex flex-col gap-2">
                {sites.map((site) => {
                  const selected = siteChoice === site.siteId
                  return (
                    <button
                      key={site.siteId}
                      type="button"
                      onClick={() => setSiteChoice(site.siteId)}
                      aria-pressed={selected}
                      disabled={pending}
                      className={`flex flex-col rounded-control border px-3 py-2 text-left transition ${
                        selected
                          ? 'border-brand bg-brand-soft'
                          : 'border-border bg-surface hover:border-brand'
                      }`}
                    >
                      <span className="text-sm font-semibold text-ink">{site.siteName}</span>
                      {/* The till CODE, not only the shop. A machine registered
                          in two stores is usually a different register in each,
                          and the code is what the person at the counter knows. */}
                      <span className="text-[13px] text-muted">{site.terminalCode}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          <PinPad onSubmit={submit} error={error} busy={pending} />
        </div>
      </Card>

      {/* ── THIS MACHINE'S ID, WHEN NOBODY CAN CLAIM IT WITHOUT IT ────────────

          The refusal above says "someone with back-office access must claim it
          first" and used to stop there — leaving that person with nothing to
          claim WITH. The id was already in state and simply never shown, so a
          new till meant reading it out of localStorage over the phone.

          Shown ONLY on an unclaimed machine. On a claimed till it is noise on a
          screen a cashier sees every morning, and `sites` already distinguishes
          the two: an empty array is the machine no shop knows.

          Not a secret. `deviceId.ts` says so plainly — it is an identifier, not
          a credential, and the server re-validates the terminal claim on every
          sale — so printing it costs nothing that spoofing it would not already
          have cost. */}
      {device && sites !== null && sites.length === 0 && (
        <div className="mt-4 w-full max-w-sm shrink-0 rounded-card border border-border bg-surface px-4 py-3">
          <p className="text-[13px] font-semibold text-ink">This machine&apos;s id</p>
          <p className="mt-1 break-all font-mono text-[13px] text-muted">{device}</p>
          <p className="mt-2 text-[13px] text-muted">
            Give this to whoever claims the till, under Setup → Terminals.
          </p>
        </div>
      )}

      {/* ── THE WAY OUT, BELOW THE CARD RATHER THAN INSIDE IT ──────────────────
          Not a link to the login form: this is a till, and the person standing
          at it may well not have an account.

          Outside the card because it is not part of unlocking. Inside, it sat
          directly under the PIN pad and read as the next step after typing —
          which for a cashier it never is. Below and apart, it reads as the
          alternative it actually is, and the card is left with one job. */}
      {/* `mb-auto` pairs with the card's `mt-auto` — together they centre the
          stack while it fits and release it to scroll once it does not. */}
      <div className="mb-auto mt-4 flex w-full max-w-sm shrink-0 justify-center">
        <Button variant="ghost" size="sm" onClick={() => router.push('/')}>
          Sign in to the back office instead
        </Button>
      </div>
    </div>
  )
}

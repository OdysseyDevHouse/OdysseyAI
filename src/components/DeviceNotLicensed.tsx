'use client'

import { useState, useTransition } from 'react'
import { Button, Card, Icons } from '@/components/ui'
import { isPosBuild } from '@/lib/appRole'
import { deviceTitleFor, type DeviceState, type SelfRegisterActionResult } from '@/lib/control/deviceMessages'

/**
 * A counter, refused — and, where the shop is entitled to it, unrefused.
 *
 * ── WHY THIS IS A WHOLE SCREEN AND NOT A BANNER ────────────────────────────
 *
 * Because nothing on the machine works without a licence, and a banner over a
 * working-looking till invites somebody to try ringing a sale up anyway — which
 * fails at the tender pad, in front of a customer, with a basket already built.
 * Refusing at the door costs one screen and saves that.
 *
 * ── AND WHY IT SERVES BOTH WINDOWS ─────────────────────────────────────────
 *
 * The till and the invoicing counter spend the SAME licence — one row in
 * `cp2_devices`, claimed by one machine, checked through `licenceForSerial` by
 * both. So they must refuse for the same reasons, in the same words, with the
 * same instructions, or a supervisor sent here by one window and there by the
 * other hears two different stories about one setting.
 *
 * What legitimately differs is the wordmark above the card and WHICH ACTION the
 * button calls — the two windows admit on different permissions, so each brings
 * its own. `PosNotLicensed` and `InvoicingNotLicensed` are the two lockups;
 * everything below is here.
 *
 * ── THE SCREEN HAS TWO FACES ───────────────────────────────────────────────
 *
 * It used to have one, and its job was to explain a dead end: say what is wrong,
 * show the device number support will ask for, and send the reader to fetch a
 * supervisor. That is still exactly right when the shop's licences are all in
 * use — there IS nothing to do here, and pretending otherwise wastes a trip.
 *
 * But when the machine may put itself into service — a paid licence is free, or
 * this machine has never had its thirty days — the dead end is a lie. So the
 * card leads with the button instead, and the numbered instructions come down:
 * telling somebody to go and find a supervisor while a button that solves it
 * sits on the same screen is worse than saying nothing.
 *
 * The offer is decided SERVER-SIDE (`deviceOffer`) and re-decided when the
 * button is pressed. This component only draws what it was handed; it cannot
 * talk itself into an offer the shop has not got.
 *
 * ── EXCEPT ON A TILL BUILD, WHERE THE BACK OFFICE DOES NOT EXIST ───────────
 *
 * Odyssey Point of Sale ships without a back office at all, so that button would
 * navigate to a screen this machine cannot show — and the will-navigate guard in
 * electron/main.js refuses it anyway. A button that visibly does nothing reads
 * as a broken app rather than a locked-down one, so it is hidden there.
 */
export default function DeviceNotLicensed({
  wordmark,
  reason,
  message,
  offer,
  serial,
  onRetry,
  onStart,
}: {
  /**
   * The product lockup above the card — the one thing that is not shared.
   *
   * A node rather than a name, because the two lockups are genuinely different
   * artwork: the till uses `logo-full.png`, whose raster reads "POINT OF SALE",
   * and the counter uses the icon beside its own typeset name for exactly the
   * reason InvoicingGate gives — those words are the wrong product on a screen
   * that writes invoices, and a raster's words cannot be swapped.
   */
  wordmark: React.ReactNode
  /** Which refusal this is, for the heading. */
  reason: Extract<DeviceState, { status: 'blocked' }>['reason']
  /** The specific refusal, from `deviceLabelFor`. */
  message: string
  /** What this machine may do about it, from `deviceOffer`. */
  offer?: Extract<DeviceState, { status: 'blocked' }>['offer']
  /** This machine's id. The one thing support needs to find the licence. */
  serial: string | null
  /** Re-ask the server — for the case where somebody just freed a licence. */
  onRetry: () => void
  /**
   * Take the offer. The window supplies its own, because the till and the
   * counter are guarded on different permissions.
   *
   * Absent means this window does not offer self-registration at all, which is
   * not the same as having nothing to offer — the screen then behaves exactly as
   * it did before, instructions and all.
   */
  onStart?: () => Promise<SelfRegisterActionResult>
}) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const canStart = !!onStart && !!offer && offer.kind !== 'none'

  function start() {
    if (!onStart) return
    setError(null)
    startTransition(async () => {
      const result = await onStart()
      if (!result.ok) {
        setError(result.error)
        return
      }
      /* ── A RELOAD, NOT A RE-CHECK ────────────────────────────────────────
         `onRetry` re-asks the LICENCE question, and that alone would let this
         screen through — but the window behind it was server-rendered before
         the till existed, and registering just created one.

         The stale prop is `terminals`, fetched once by the page. `PosShell`
         finds this machine in it by device id, so on a stale list the till it
         has just been given is missing: the shift gate says "this machine is
         not set up as a till yet" on a machine that plainly is, and `posMode`
         falls back to retail — which seeds PosShell's useState initialisers and
         cannot be corrected a tick later. (Reported exactly that way.)

         So the whole window is reloaded. Heavier than a re-check, and right:
         registering changes what this machine IS, and everything the server
         rendered on the old answer has to be drawn again. It happens once, on a
         machine that is not trading yet. */
      window.location.reload()
    })
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
      {wordmark}

      <Card>
        <div className="flex max-w-lg flex-col items-center gap-4 p-6 text-center">
          {/* The icon carries the tone, and the tone is the whole difference
              between the two faces: an invitation is not a warning, and a
              triangle over "try it free for 30 days" reads as a fault. */}
          {canStart ? (
            <span className="flex h-14 w-14 items-center justify-center rounded-pill bg-brand-soft text-brand">
              <Icons.Terminal size={28} />
            </span>
          ) : (
            <span className="flex h-14 w-14 items-center justify-center rounded-pill bg-warning-soft text-warning-ink">
              <Icons.StatusWarning size={28} />
            </span>
          )}

          <div>
            <h1 className="text-lg font-bold text-ink">{deviceTitleFor(reason)}</h1>
            <p className="mt-2 text-sm text-muted">{message}</p>
          </div>

          {canStart && offer ? (
            <>
              <Button variant="primary" size="touch" disabled={pending} onClick={start}>
                {pending ? (
                  <>
                    <Icons.Syncing size={18} className="animate-spin" />
                    Setting this machine up…
                  </>
                ) : (
                  <>
                    <Icons.Play size={18} />
                    {offer.kind === 'trial'
                      ? `Start my ${offer.days}-day free trial`
                      : 'Use this machine as a till'}
                  </>
                )}
              </Button>

              {/* WHAT THE BUTTON IS ABOUT TO DO, before it is pressed.
                  It registers a licence and creates a till, neither of which
                  the reader asked for by name, and both of which show up in the
                  back office afterwards. Somebody who is surprised by that goes
                  looking for what broke. */}
              <p className="text-[13px] text-muted">
                {offer.kind === 'trial'
                  ? 'This registers the machine you are sitting at and gives it its own till, with its own invoice numbering. No card, and nothing to cancel — it simply stops on the last day.'
                  : 'This puts the machine you are sitting at into a licence your shop already pays for, and gives it its own till with its own invoice numbering. Your bill does not change.'}
              </p>
            </>
          ) : (
            /* WHAT HAPPENS NEXT, in the order it happens.
               Only when there is nothing on this screen that would fix it. The
               person reading this cannot fix it themselves — they need a
               supervisor — so its job is to make the request precise enough that
               the supervisor can act on it without a second trip. */
            <ol className="w-full list-decimal space-y-1 rounded-control border border-border bg-surface-2 py-3 pl-8 pr-4 text-left text-[13px] text-ink-2">
              <li>Ask a supervisor to sign in to the back office.</li>
              <li>
                Open <span className="font-semibold text-ink">Setup → Tills</span>, on{' '}
                <span className="font-semibold text-ink">this machine</span>.
              </li>
              <li>
                Under <span className="font-semibold text-ink">Till licences</span>, choose{' '}
                <span className="font-semibold text-ink">Use this machine</span>.
              </li>
            </ol>
          )}

          {/* The registration was refused after all — the last free licence went
              to another machine between this screen being drawn and the button
              being pressed, most likely. Said here rather than in a toast: the
              till build has no toast host on this screen, and a message that
              fades is the wrong shape for one that changes what to do next. */}
          {error && (
            <div className="w-full rounded-control border border-danger bg-danger-soft px-4 py-3 text-left text-[13px] text-danger-ink">
              {error}
            </div>
          )}

          {/* The device number, in a shape somebody can read down a phone line.
              Selectable rather than a button: a till with no licence may also
              have no clipboard permission, and "tap to copy" that silently does
              nothing is worse than plain text. */}
          {serial && (
            <div className="w-full rounded-control border border-border bg-surface-2 px-4 py-3">
              <span className="block text-xs font-semibold uppercase tracking-wide text-muted">
                Device number
              </span>
              <code className="mt-1 block select-all break-all text-[13px] text-ink">{serial}</code>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-center gap-2">
            {/* Somebody may have just released a licence in the back office on
                another machine. Re-asking is cheaper than explaining a reload. */}
            <Button variant="secondary" size="touch" disabled={pending} onClick={onRetry}>
              <Icons.Refresh size={18} />
              Check again
            </Button>
            {/* The back office still works on this machine — deliberately. It is
                where a manager releases a spot, and locking them out of it would
                make this screen a dead end.

                Hidden on the till build, which has no back office to open. See
                the note at the top of this file. */}
            {!isPosBuild() && (
              <Button
                variant="ghost"
                size="touch"
                disabled={pending}
                onClick={() => (window.location.href = '/dashboard')}
              >
                <Icons.ArrowRight size={18} />
                Back office
              </Button>
            )}
          </div>
        </div>
      </Card>
    </div>
  )
}

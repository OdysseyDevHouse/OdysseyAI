'use client'

import { Button, Card, Callout, Icons } from '@/components/ui'

/**
 * The screen a machine shows the first time it opens with no line.
 *
 * ── WHY THIS EXISTS RATHER THAN AN ERROR PAGE ───────────────────────────────
 *
 * A back office that has never once reached the control panel does not know
 * what the shop is called, so it cannot draw a single screen — see
 * StoreDetailsUnavailableError in lib/sites.ts. That threw, and a throw lands
 * on global-error.tsx, which is a DIAGNOSTIC screen: it deliberately shows the
 * real error and a stack trace, because for a genuine fault the only reader is
 * the person who can act on it.
 *
 * This is not a genuine fault. It is the ordinary state of a machine plugged in
 * on a Monday morning before anybody found the network cable, and the person
 * reading it is the shop owner. Three Turbopack chunk paths above the sentence
 * that matters makes a solvable thing look like a broken product.
 *
 * ── SO IT SAYS THE THREE THINGS THAT PERSON NEEDS ───────────────────────────
 *
 * What happened, that nothing is broken, and exactly what to do next — the same
 * shape as LeaseLockScreen next door, and for the same reason: the reader is
 * usually not the person who understands the licensing model.
 *
 * ── IT HAPPENS EXACTLY ONCE PER MACHINE ─────────────────────────────────────
 *
 * After one successful sign-in with a working line the store details are
 * mirrored locally and this is unreachable for good. That is worth SAYING on
 * the screen: "you will need internet once" is a very different sentence from
 * "you need internet", and only one of them is true.
 */
export type NeedsInternetProps = {
  /**
   * True when this machine has NEVER reached us, so it does not yet hold a copy
   * of the store's details.
   *
   * Worth distinguishing, because the two states need opposite reassurances. A
   * first run genuinely requires a line once and the screen should say so
   * plainly. Every later time, the machine is meant to work offline and the
   * honest message is that something it wanted is temporarily out of reach —
   * promising "just once" there would be a lie the owner catches the next day.
   */
  firstRun: boolean
}

export default function NeedsInternetScreen({ firstRun }: NeedsInternetProps) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas p-6">
      <Card className="w-full max-w-xl">
        <div className="flex flex-col gap-5 p-6">
          <div className="flex items-start gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-pill bg-warning-soft text-warning-ink">
              <Icons.Offline size={24} />
            </span>
            <div>
              <h1 className="text-lg font-bold text-ink">
                {firstRun
                  ? 'This machine needs the internet once'
                  : 'No internet connection'}
              </h1>
              <p className="mt-1 text-sm text-muted">
                {firstRun
                  ? 'It has not yet been able to reach us, so it does not know which store it belongs to. That only has to happen once.'
                  : 'This machine cannot reach us at the moment, and the screen you asked for needs to check something with us first.'}
              </p>
            </div>
          </div>

          {/* Said before the instructions, because the unspoken question on a
              first morning is whether something has gone wrong with the setup
              that was just paid for. */}
          <Callout tone="brand">
            Nothing is broken and nothing has been lost. Your till, your stock and your
            takings are all on this machine already.
          </Callout>

          <div className="border-t border-border pt-5">
            <h2 className="text-sm font-semibold text-ink">What to do</h2>
            <ol className="mt-2 flex flex-col gap-2 text-sm text-muted">
              <li className="flex gap-3">
                <span className="numeric flex h-5 w-5 shrink-0 items-center justify-center rounded-pill bg-surface-2 text-xs font-semibold text-ink-2">
                  1
                </span>
                <span>
                  Connect this machine to the internet — plug in the network cable, or
                  join the shop&rsquo;s Wi-Fi.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="numeric flex h-5 w-5 shrink-0 items-center justify-center rounded-pill bg-surface-2 text-xs font-semibold text-ink-2">
                  2
                </span>
                <span>Press Try again below and sign in as you normally would.</span>
              </li>
              <li className="flex gap-3">
                <span className="numeric flex h-5 w-5 shrink-0 items-center justify-center rounded-pill bg-surface-2 text-xs font-semibold text-ink-2">
                  3
                </span>
                <span>
                  {firstRun
                    ? 'After that it works without the internet, so this screen will not come back.'
                    : 'Everything you were doing is still here, exactly as you left it.'}
                </span>
              </li>
            </ol>
          </div>

          <div className="flex flex-wrap gap-2">
            {/* A full reload rather than a router refresh: whether this machine
                can reach the control panel is decided server-side on a fresh
                request, and asking again from scratch is the only honest way to
                find out it can. Same reasoning as LeaseLockScreen. */}
            <Button
              variant="primary"
              size="touch"
              onClick={() => window.location.reload()}
            >
              <Icons.Refresh size={18} />
              Try again
            </Button>
          </div>

          <p className="text-sm text-muted">
            Still seeing this with the internet connected? Call support — it means this
            machine cannot reach us through the shop&rsquo;s network, which is usually a
            firewall rather than a fault on this PC.
          </p>
        </div>
      </Card>
    </div>
  )
}

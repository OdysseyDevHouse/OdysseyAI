'use client'

import Image from 'next/image'
import { useMemo, useState, useTransition } from 'react'
import {
  Badge,
  Button,
  Callout,
  DeepPanel,
  Icons,
  NumPad,
  QuoteCard,
  numPadValue,
  useToast,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { dayBannerFor, greetingFor, quoteOfTheDay } from '@/lib/tillQuotes'
import { tillOpenShiftAction } from './shiftActions'

/**
 * The till is not open for business yet.
 *
 * ── WHY A GATE AND NOT A MODAL ────────────────────────────────────────────
 *
 * A shift is not a setting somebody adjusts while trading — it is the thing
 * that makes trading legitimate. Every sale rung up before one is open banks
 * into no reconciliation: it is a real invoice, in a real drawer, that no
 * cash-up will ever account for. A dismissible dialog over a working till
 * invites exactly that, because the fastest way past a dialog is Escape and
 * the sale underneath is right there.
 *
 * So this stands IN FRONT of the sale, the way TableGate does — you open the
 * till or you do not use it. The cost of being firm here is one deliberate tap
 * at the start of a day; the cost of being lenient is a drawer nobody can
 * reconcile at the end of one.
 *
 * ── WHY IT IS WARM RATHER THAN MERELY CORRECT ─────────────────────────────
 *
 * This is the first screen of somebody's working day, and on a shop that signs
 * out between cashiers it is also the screen they come back to a dozen times.
 * It used to be a single grey card headed "This till is closed" — accurate, and
 * the tone of a locked door. The task itself is unchanged; what changed is that
 * the screen now greets the person doing it by name, tells them what day it is,
 * and gives them a line worth reading while they count.
 *
 * That is not decoration on a whim. A cashier hurried through the float is a
 * cashier who types the figure they expect rather than the one in the drawer,
 * and the whole day's variance follows from that number. A screen with room on
 * it is a screen somebody counts on.
 *
 * ── THE SPLIT ─────────────────────────────────────────────────────────────
 *
 * Two columns, and they hold different KINDS of thing: the left is about the
 * person and the day, the right is the one job to do. Nothing on the left is
 * pressable, which is why the pad on the right never has to compete for the
 * eye. On a narrow till the columns stack and the card comes FIRST — see the
 * order classes below — because the greeting is the thing you can scroll to
 * and the pad is not.
 *
 * ── THE TWO MODES SAY DIFFERENT THINGS ────────────────────────────────────
 *
 * 'user' — the shift belongs to the PERSON. Everyone signing in counts their
 *   own float, and the gate says so, because a cashier who thinks they are
 *   opening the shop will hand the float figure to whoever asks for it first.
 *
 * 'terminal' — the shift belongs to the TILL. Whoever opens it sets the float
 *   for everybody who trades on this machine afterwards, and that is worth
 *   stating plainly: the person typing is committing a number on behalf of
 *   colleagues who will never see this screen.
 *
 * In terminal mode a second cashier signing in mid-day never reaches here at
 * all — the till is already open, so they go straight to the sale. This screen
 * is only ever the first person of the day.
 */
export default function OpenTillGate({
  mode,
  operatorName,
  terminalId,
  terminalLabel,
  terminalName,
  unclaimed,
  canCashup,
  online,
  onOpened,
  onExit,
}: {
  mode: 'terminal' | 'user'
  operatorName: string
  /**
   * The till this machine has claimed. REQUIRED in terminal mode — `openShift`
   * refuses without it, which is the right answer: a till-owned shift with no
   * till is a drawer nobody can name at cash-up.
   *
   * ── WHY NULL GETS ITS OWN SCREEN RATHER THAN AN ERROR ─────────────────
   *
   * Because the error it produces is unactionable. `openShift` answers "Choose
   * a till." — accurate, and useless at a counter: there is nothing on this
   * screen to choose, and the place a till IS chosen is Setup › Tills in the
   * BACK OFFICE, which is not where the person reading it is standing.
   *
   * What that left was a screen inviting somebody to count a drawer and type a
   * figure, which then refused the figure for a reason they could not act on
   * and could not see coming. The float is asked for FIRST and the blocking
   * fact is revealed LAST — exactly backwards.
   *
   * So an unclaimed machine is told before the pad rather than after the tap.
   */
  terminalId: number | null
  /** The till's code, or null when this machine has claimed none. */
  terminalLabel: string | null
  /**
   * The till's human name — "Front counter". Optional: a shop that never named
   * its tills simply gets the code on its own, which is what this header said
   * before the prop existed.
   */
  terminalName?: string | null
  /**
   * Whether this machine has been checked and matches no till.
   *
   * DISTINCT from `terminalId === null`, which is also true for the tick before
   * the browser has read its own device id — showing the warning on that would
   * flash it on every load, at a counter, on the one screen a customer can see
   * from across the room.
   */
  unclaimed: boolean
  /** Whether this operator holds `sales.cashup`. Without it they can only wait. */
  canCashup: boolean
  /** A shift lives on the server; offline the gate explains rather than pretends. */
  online: boolean
  /** Fires with the new shift's id so the shell can stash it and open the till. */
  onOpened: (shiftId: number) => void
  /** Back to the PIN pad — the way out for whoever cannot open it themselves. */
  onExit: () => void
}) {
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [float, setFloat] = useState('')
  const [error, setError] = useState<string | null>(null)

  /**
   * Read ONCE per mount, not on every render.
   *
   * The clock crossing noon while somebody counts a drawer would otherwise swap
   * "Good morning" for "Good afternoon" under their hands on the next
   * keystroke — a screen that rewrites itself as you type reads as a glitch,
   * whichever greeting is technically right. Whatever it said when the screen
   * arrived is what it keeps saying until the screen is left.
   *
   * It is also why this is a `useMemo` and not a module constant: a till runs
   * for days at a time, so the value has to be recomputed the next time the
   * gate mounts rather than fixed at the moment the bundle loaded.
   */
  const day = useMemo(() => {
    const now = new Date()
    return {
      banner: dayBannerFor(now),
      greeting: greetingFor(now),
      quote: quoteOfTheDay(now),
    }
  }, [])

  function open() {
    setError(null)
    startTransition(async () => {
      const result = await tillOpenShiftAction(terminalId, numPadValue(float))
      if (!result.ok) {
        // Under the pad, not only in a toast: a toast leaves the screen while
        // the figure that caused it is still on it.
        setError(result.error)
        return
      }
      toast.success('The till is open. Have a good shift.')
      onOpened(result.shiftId)
    })
  }

  const amount = numPadValue(float)

  /** Whether anything at all stands between this operator and the pad. */
  const blocked = !online || !canCashup || (mode === 'terminal' && unclaimed)

  return (
    // SCROLLS, and that is not decoration. The card runs to about 830px with the
    // pad on it, and a 1366×768 till — the commonest machine this ships to — has
    // barely 700px under the status bar. Without `overflow-y-auto` here the flex
    // column crushes the content instead of letting it overflow, and the one
    // button on the screen ends up below the fold on the exact hardware it is for.
    /* `px-4 pb-4`, no top: TillStatusBar carries its own py-4. This screen
       CENTRES its content, so a p-4 here did not merely stack — the leftover
       space was dealt out above it too, and the gap under the chips grew with
       the window height. */
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-4 pb-4">
      {/* `shrink-0` so the content keeps its natural height and the pane above
          scrolls to it, rather than compressing to fit and squashing the pad's
          keys into unhittable slivers. */}
      <div className="grid w-full max-w-[1120px] shrink-0 grid-cols-1 items-center gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,560px)]">
        {/* ── THE PERSON AND THE DAY ────────────────────────────────────────
            `order-2` below the lg breakpoint: stacked on a narrow till the card
            has to be the first thing under the status bar, because it is the
            only part of this screen anybody came here to use. */}
        <div className="order-2 min-w-0 lg:order-1 lg:pr-4">
          {/*
           * THE FULL LOGO, at the head of the column that is about the person.
           *
           * The status bar above is stripped bare on this screen — see `bare` in
           * TillStatusBar — which left the till with no brand on it at all. It
           * belongs HERE rather than back in that bar: this half of the screen
           * is the welcome, read top to bottom as logo → day → name → quote, and
           * a mark in the bar would be a fourth thing competing with a greeting
           * that is already the largest text on the screen.
           *
           * The real artwork rather than the typeset lockup the crowded rows
           * use, because this column has the room for it and nothing to squeeze
           * it. `.logo-plate` is the same fix PosGate makes: the wordmark inside
           * the PNG is dark navy and would all but vanish on the dark canvas, so
           * it gets a white backing in dark mode and nothing in light.
           *
           * `mb-8`, deliberately wider than the 4-unit rhythm below it: the gap
           * separates the BRAND from the greeting, and at the same spacing as
           * the greeting's own parts the logo read as the first line of the
           * sentence rather than the mark above it.
           */}
          <Image
            src="/logo-full.png"
            alt="Odyssey Point of Sale"
            width={1109}
            height={304}
            priority
            unoptimized
            className="logo-plate mb-8 h-16 w-auto object-contain"
          />

          {/* The rule and the day. A weekday matters more at a till than it
              looks — a rota that changes by day gets checked on the way in. */}
          <div className="flex items-center gap-3">
            <span aria-hidden className="h-0.5 w-8 shrink-0 rounded-pill bg-brand" />
            <span className="text-xs font-bold uppercase tracking-wider text-brand">
              {day.banner}
            </span>
          </div>

          {/* THE NAME, and it is the largest thing on this half of the screen.
              Standing at a shared machine the first thing to confirm is WHO the
              till thinks you are — a float counted in under someone else's
              sign-in is their variance at cash-up, not yours. Colour and size
              make that findable at a glance instead of buried in a sentence. */}
          <h1 className="mt-4 text-[42px] font-extrabold leading-[1.08] tracking-tight text-ink">
            {day.greeting},
            <br />
            <span className="text-brand">{operatorName}.</span>
          </h1>

          <p className="mt-4 max-w-[30rem] text-base leading-relaxed text-muted">
            {/* WHOSE FLOAT THIS IS, said in the sentence rather than in a banner
                of its own. Which mode the shop runs decides who wears the
                variance at cash-up, and it is the one thing on this screen a
                cashier can get wrong without noticing. */}
            {mode === 'user'
              ? 'Your shift travels with you across whatever tills you work. Count your float, enter it beside this, and let us make today a good one.'
              : 'Your till is ready when you are. Count the drawer, enter the opening float, and let us make today a good one — everyone trading here today shares this figure.'}
          </p>

          {/* NO SHUFFLE BUTTON, on purpose. One quote a day makes it a fixture
              two cashiers can talk about; a button turns it into a slot machine
              nobody reads. See lib/tillQuotes for how the day is picked. */}
          <QuoteCard
            className="mt-7 max-w-[30rem]"
            eyebrow="Quote of the day"
            footnote={
              mode === 'user' ? 'A little momentum for your shift' : 'A little momentum for your day'
            }
          >
            {day.quote}
          </QuoteCard>
        </div>

        {/* ── THE JOB ───────────────────────────────────────────────────── */}
        <div className="order-1 w-full rounded-card border border-border bg-surface p-6 shadow-card lg:order-2 lg:p-7">
          {/* WHICH TILL, and whether it is ready — before the pad, not after a
              refused tap. The badge is the screen's one status, so it is the
              only coloured pill on the card. */}
          <div className="flex items-start gap-4">
            {/* A rounded square, not a disc: it sits in a header row beside text
                now, rather than standing alone as the screen's crest. */}
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-card bg-brand-soft text-brand">
              <Icons.Store size={22} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-xl font-extrabold leading-tight text-ink">Open your till</h2>
              <p className="mt-0.5 truncate text-sm text-muted">
                {terminalLabel ? (
                  <>
                    <span className="font-bold text-brand">{terminalLabel}</span>
                    {terminalName ? ` · ${terminalName}` : ''}
                  </>
                ) : mode === 'user' ? (
                  'Your own shift'
                ) : (
                  'No till linked yet'
                )}
              </p>
            </div>
            {/* Not "Closed". The state that matters to somebody standing here is
                whether they can open it — "Ready to open" answers that, where
                "Closed" only restates the thing they already worked out from the
                screen being in front of them. */}
            <Badge tone={blocked ? 'warning' : 'success'} dot className="mt-0.5 shrink-0">
              {!online
                ? 'Offline'
                : !canCashup
                  ? 'Needs a manager'
                  : mode === 'terminal' && unclaimed
                    ? 'Not set up'
                    : 'Ready to open'}
            </Badge>
          </div>

          <div className="mt-5">
            {!online ? (
              /* A shift is a server record. Saying so beats a float typed into a
                 screen that cannot store it. */
              <Callout tone="warning" title="Opening the till needs the connection">
                This till cannot reach the server, and a shift is opened there. Try again once
                the line is back — nothing is lost by waiting.
              </Callout>
            ) : !canCashup ? (
              /* The one person who cannot proceed. Told what to do, not just refused. */
              <Callout tone="warning" title="You cannot open the till yourself">
                Opening a till needs the cash-up right. Ask a manager to open it under their
                own PIN — once it is open you can sign in and trade on it.
              </Callout>
            ) : mode === 'terminal' && unclaimed ? (
              /* BEFORE the pad, not after a rejected tap — see the note on
                 `terminalId`. Named as a machine that has not been set up rather
                 than as a mistake the cashier made, because it is neither their
                 doing nor theirs to fix: claiming a till is a back-office job. */
              <Callout tone="warning" title="This machine is not set up as a till yet">
                <p>
                  A shift belongs to a till, and this machine has not been linked to one — so
                  there is no drawer to count the float into.
                </p>
                {/* The exact route and the exact button label, checked against
                    LicencesPanel.tsx rather than written from memory. Claiming
                    moved out of the Tills card and into Till licences — a message
                    naming the old place would send somebody to a card that no
                    longer does this, which is worse than naming nowhere. */}
                <p className="mt-2">
                  Someone with back-office access can link it under{' '}
                  <b className="font-semibold">Setup › Tills</b>, in the{' '}
                  <b className="font-semibold">Till licences</b> card — press{' '}
                  <b className="font-semibold">Use this machine</b> and pick which till this
                  is. Come back here afterwards and the float pad will be waiting.
                </p>
              </Callout>
            ) : (
              <>
                {/* THE FIGURE, on a plaque. It is the single number the whole
                    day's reconciliation rests on, and it has to be legible to
                    somebody standing back from the counter — which is what
                    DeepPanel exists for. Not NumPadDisplay: that is a control
                    among controls, and here the figure is the subject. */}
                <DeepPanel
                  label="Opening float"
                  hint="What is in the drawer?"
                  value={
                    <>
                      {/* The currency mark set small and in the panel's muted
                          step, so the DIGITS are what carries across the room.
                          A full-size R competes with the figure it qualifies. */}
                      <span className="mr-0.5 text-2xl text-deep-muted">R</span>
                      {float === '' ? '0.00' : float}
                    </>
                  }
                />

                <div className="mt-5 flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted">
                    Enter amount
                  </span>
                  {/* A till with a keyboard is as common as one without, and a
                      cashier who can touch-type figures is faster than any pad —
                      but only if they know the keys are live. NumPad has always
                      listened for them; nothing on screen ever said so. */}
                  <span className="rounded-pill bg-surface-2 px-2.5 py-1 text-[11px] font-medium text-muted">
                    Keyboard ready
                  </span>
                </div>

                {/* Full width, not a 300px block in the middle of the card. The
                    pad is the only thing to hit on this screen, so the keys take
                    the room rather than leaving a margin either side of them. */}
                <div className="mt-2">
                  <NumPad size="lg" value={float} onChange={setFloat} disabled={pending} />
                </div>

                {error && (
                  <div className="mt-4">
                    <Callout tone="danger" title="Could not open the till">
                      {error}
                    </Callout>
                  </div>
                )}

                {/* The confirm and the way out, on one row. Sign out is an icon
                    beside the button rather than a link at the foot of the card,
                    because the two things somebody can do here are "open it" and
                    "I am at the wrong machine", and those belong together. */}
                <div className="mt-5 flex gap-3">
                  <Button
                    variant="primary"
                    /* touch-lg, the size reserved for the keys that END something
                       — Pay, Close. Opening the till is that same kind of act: it
                       is the only button on the screen and it commits a figure
                       the whole day's reconciliation rests on. */
                    size="touch-lg"
                    disabled={pending}
                    onClick={open}
                    className="relative flex-1"
                  >
                    {pending ? 'Opening…' : `Open the till with ${formatMoney(amount)}`}
                    {/* Absolute, so the label stays optically centred on the
                        button rather than being shunted left by the glyph. The
                        arrow says this goes somewhere — it opens the till AND
                        moves to the sale screen, and on a touch screen that is
                        worth signalling before the tap, not after. */}
                    {!pending && (
                      <Icons.ArrowRight
                        size={22}
                        className="pointer-events-none absolute right-5"
                        aria-hidden
                      />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="touch-lg"
                    iconOnly
                    disabled={pending}
                    onClick={onExit}
                    aria-label="Sign out"
                    title="Sign out"
                  >
                    <Icons.LogOut size={20} />
                  </Button>
                </div>

                {/* COUNT IT, DO NOT ASSUME IT. Said here rather than in a tooltip
                    because a float that is wrong at the start makes every
                    variance for the rest of the day wrong in the same direction,
                    and by cash-up nobody can tell which end it came from.

                    ZERO IS A REAL ANSWER, not a mistake to be blocked. A shop
                    that keeps no float trades from an empty drawer, and refusing
                    that would leave them unable to open at all — so the same
                    line says so, rather than a second hint appearing under the
                    button and shifting the layout the moment the pad is cleared. */}
                <p className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-muted">
                  <Icons.Info size={14} className="mt-0.5 shrink-0" aria-hidden />
                  <span>
                    Enter the notes and coins physically in the drawer. No float today? Leave
                    the amount at zero and continue.
                  </span>
                </p>
              </>
            )}

            {/* The way back to the PIN pad for whoever cannot get past the block
                above — the manager path, and the way out when somebody signed in
                at the wrong machine. Only rendered when the pad is NOT: with the
                pad up, sign out lives beside the confirm, and two of them on one
                card is one too many. */}
            {blocked && (
              <div className="mt-6 flex justify-center border-t border-border pt-5">
                <Button variant="ghost" size="sm" disabled={pending} onClick={onExit}>
                  <Icons.LogOut size={15} />
                  Sign out
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

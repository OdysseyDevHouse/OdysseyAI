'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  Button,
  CHIP_BASE,
  CategoryTile,
  ClockChip,
  Icons,
  LOGOUT_CHIP,
  OperatorChip,
  StatusChip,
  TouchRow,
  type CategoryTone,
} from '@/components/ui'
import { tillShiftStatusAction } from '@/app/(pos)/pos/shiftActions'
import { useOfflineShell, INVOICING_SHELL } from '@/lib/posOffline/useOfflineShell'
import ShiftModal from '@/app/(pos)/pos/ShiftModal'
import { counterSignOutAction } from './pinActions'

/**
 * The four screens this window holds, in the order a counter reaches for them.
 *
 * Invoicing leads because it is what the window is FOR — the other three are
 * things you go and do. Same ordering principle as the till's module menu, and
 * the same four tones, so somebody who works both screens sees one product.
 */
const SCREENS: {
  href: string
  label: string
  hint: string
  icon: keyof typeof Icons
  tone: CategoryTone
}[] = [
  {
    href: '/invoicing',
    label: 'Invoicing',
    hint: 'Invoices and credit notes',
    icon: 'FileText',
    tone: 'emerald',
  },
  {
    href: '/invoicing/quotes',
    label: 'Quotes',
    hint: 'A price to think about',
    icon: 'FileText',
    tone: 'indigo',
  },
  {
    href: '/invoicing/orders',
    label: 'Sales orders',
    hint: 'Promised now, delivered later',
    icon: 'ListOrdered',
    tone: 'sky',
  },
  {
    href: '/invoicing/laybys',
    label: 'Lay-bys',
    /* Shorter than the till's wording for the same row: TouchRow truncates on
       one line, and "Take a payment or hand goods over" came back as "hand
       goods o…" here, where the panel is the same width but the label above it
       is longer. A hint that stops before the useful half is worse than a
       brief one. */
    hint: 'Paid off over time',
    icon: 'Package',
    tone: 'amber',
  },
]

/**
 * The invoicing window's own chrome.
 *
 * ── WHAT REPLACES THE SIDEBAR ─────────────────────────────────────────────
 *
 * A slim bar and a slide-in menu holding the four screens — deliberately the
 * same shape as the till's `ModuleMenu`, because the counter staff who work
 * this window are the people who work that one. A second navigation idiom in
 * the same product would be two things to learn for no reason.
 *
 * Not the same COMPONENT, though. The till's menu switches what the basket IS,
 * keyed on doc type, and never navigates — that is the whole point of it, since
 * unmounting a half-rung basket would lose the sale. This one navigates by URL,
 * because these are separate screens with separate data. Same shape, different
 * mechanism; sharing the component would mean one of them pretending.
 *
 * ── AND WHAT IS DELIBERATELY ABSENT ───────────────────────────────────────
 *
 * Everything else. No site switcher, no notification bell, no search, no rail
 * of Customers/Suppliers/Reports. The reason is in the layout's docblock: this
 * window has to keep working when the shop's server does not, and every control
 * that CANNOT survive that is a way for an operator to find themselves on a
 * dead page mid-document.
 *
 * The way out is not here either. "Back office" lives on the SIGN-IN screen,
 * under the pad — leaving is something you do between customers, not something
 * that should sit a tap away from Save with a document half typed.
 */
export default function InvoicingChrome({
  capabilities,
  operatorName,
  canCashup,
  children,
}: {
  /** Reserved: per-screen gating lands here when the screens grow it. */
  capabilities: string[]
  /** Who is signed in at this counter — see the layout on why this is not the session. */
  operatorName: string
  /** Whether the OPERATOR may open and close a shift. The modal states it too. */
  canCashup: boolean
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const [menuOpen, setMenuOpen] = useState(false)
  const [shiftOpen, setShiftOpen] = useState(false)
  const router = useRouter()

  /*
   * THE OFFLINE SHELL, registered here because this component wraps every
   * screen in the window and is the only thing guaranteed to mount on all of
   * them.
   *
   * Without it, cutting the line and moving between screens dropped the
   * operator onto the browser's own error page — the application gone, and with
   * it any suggestion of what had happened. See public/invoicing-sw.js.
   */
  const shell = useOfflineShell(true, INVOICING_SHELL)

  /*
   * WHETHER THE LINE IS UP.
   *
   * `navigator.onLine` is a weak signal — it means an interface is up, not that
   * the server answers — but it is the honest one to show a counter, and it is
   * what the till's own chip falls back to. Watched here rather than assumed,
   * because the whole point of this window is that somebody standing at it
   * knows whether their work is reaching the server.
   */
  /*
   * THE OPEN SHIFT, named on the strip the way the till names it.
   *
   * `null` terminal, deliberately — a trade counter claims no till, so on a
   * shop cashing up per TERMINAL there is genuinely no shift here and the chip
   * says so. On USER cash-up, which is the mode a counter wants, this is the
   * operator's own shift. Same call the till's bar makes, so the two windows
   * cannot disagree about whose drawer is open.
   *
   * Re-read when the modal closes (`shiftOpen`), which is the only thing in
   * this window that can open or close one.
   */
  const [shiftLabel, setShiftLabel] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void tillShiftStatusAction(null)
      .then((r) => {
        if (cancelled || 'ok' in r) return
        setShiftLabel(r.shift ? `Shift ${r.shift.id}` : null)
      })
      .catch(() => {
        /* Offline, or refused. The chip falls back to "No shift" rather than
           inventing one — an invented shift is worse than an absent answer on
           the row somebody checks before cashing up. */
      })
    return () => {
      cancelled = true
    }
  }, [shiftOpen])

  const [online, setOnline] = useState(true)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const report = () => setOnline(navigator.onLine)
    report()
    window.addEventListener('online', report)
    window.addEventListener('offline', report)
    return () => {
      window.removeEventListener('online', report)
      window.removeEventListener('offline', report)
    }
  }, [])

  /* Escape closes it, as everywhere else in the product. A panel whose only exit
     is a precise tap on the backdrop is one somebody gets stuck in. */
  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuOpen])

  /* Navigating closes it. Without this the panel stays open over the screen it
     just opened, which reads as the tap not having worked. */
  useEffect(() => {
    setMenuOpen(false)
  }, [pathname])

  /*
   * WHICH SCREEN IS SHOWING — longest match wins.
   *
   * `/invoicing` is a prefix of all three others, so a plain `startsWith` marks
   * Invoicing as current on every screen in the window. Sorting by length and
   * taking the first match is what makes /invoicing/quotes read as Quotes
   * rather than as both.
   */
  const currentScreen = [...SCREENS]
    .sort((a, b) => b.href.length - a.href.length)
    .find((s) => pathname === s.href || pathname.startsWith(`${s.href}/`))

  const current = currentScreen?.href ?? '/invoicing'

  /*
   * The caption names the SCREEN and nothing else — "Quotes" on quotes,
   * "Lay-bys" on lay-bys. This window holds four different jobs, and the
   * top-left corner is where somebody checks which one they are in. The
   * mark and the product name said the same thing on all four, so they are
   * gone; what is left is the only word that changes.
   */
  const screenName = currentScreen?.label ?? 'Invoicing'

  return (
    <>
      {/* THE BAR. `shrink-0` because the content below it scrolls — without it
          a long invoice squashes the chrome instead of overflowing, which is
          the flex-column trap this codebase has hit before. */}
      {/* `py-2.5`, down from `py-3`: the chips grew from h-control to the 46px
          the till uses, and the bar has to stay a strip above the work rather
          than becoming a band of its own. `flex-wrap` so a narrow counter screen
          drops a chip to a second line instead of pushing Logout off the edge. */}
      <header className="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-border px-4 py-2.5">
        <button
          type="button"
          data-kit-ok
          onClick={() => setMenuOpen(true)}
          aria-label="Go to another part of invoicing"
          title="Go to"
          className="flex h-control w-control items-center justify-center rounded-control border border-border bg-surface text-ink-2 transition hover:border-brand/40 hover:bg-brand-soft hover:text-brand"
        >
          <Icons.Menu size={20} />
        </button>

        {/* Set in the wordmark face like the till's lockup and the back
            office's rail, so this still reads as a room in the same app — but
            the mark and the product name are not repeated. The window is
            already open; the one thing worth stating here is WHICH of the four
            screens you are on.

            Brand blue, the same weight and colour the screen name carried when
            it was the second half of the lockup — dropping the mark and the
            product name changed what the corner SAYS, not how it is set. */}
        <span className="wordmark-lockup text-lg font-bold leading-none text-brand">
          {screenName}
        </span>

        {/*
          ── THE SAME STRIP THE TILL WEARS ──────────────────────────────────

          Built from the kit's chips (components/ui/StatusChip), which is where
          they live precisely so these two windows cannot drift apart. A counter
          clerk and a cashier work the same shop, often the same shift, and a row
          of facts that reads one way at the till and another here is a row
          nobody trusts.

          The order matches the till's, left to right: what is WRONG first (the
          connection), then the queue, then the shift, the machine, the person,
          the clock, and the way out last.
        */}
        <span className="ml-auto flex items-center gap-2.5">
          {/*
            THE CONNECTION, stated rather than left to be discovered.

            Shown only when it is WRONG — a green "Online" chip on every screen
            all day is a chip nobody reads, and the one moment it matters is the
            moment it changes. Two different problems, two different chips:

              Offline      the line is down right now
              Online only  this machine cannot work offline AT ALL (no HTTPS,
                           no service worker) — a deployment fact somebody has
                           to fix, and one worth knowing BEFORE the line drops
                           rather than at the counter with a customer waiting
          */}
          {!online && (
            <span
              data-kit-ok
              className={`${CHIP_BASE} border-warning/40 bg-warning-soft text-warning-ink`}
            >
              <Icons.Offline size={16} />
              Offline
            </span>
          )}
          {online && shell.reason && (
            <span
              data-kit-ok
              title={shell.reason}
              className={`${CHIP_BASE} border-border bg-surface text-muted`}
            >
              <Icons.Offline size={16} />
              Online only
            </span>
          )}

          {/*
            ── ARE THE DOCUMENTS THROUGH? ───────────────────────────────────

            The till's queue chip answers "can I cash up yet", and the counter
            needs the same answer before it closes its drawer.

            But it is answered DIFFERENTLY here, and the difference is the whole
            point. The till holds an outbox: sales taken offline sit in IndexedDB
            until they flush, so it can count them. This window has no outbox —
            invoicing writes straight to the server and refuses when it cannot
            (see the gate's note on why there is no offline PIN here). So there
            is never a backlog to report: either the line is up and every
            document is through, or it is down and the chip above already says
            so, which is the honest thing to show rather than a green tick that
            means "nothing was queued" wearing the clothes of "everything sent".
          */}
          <span
            data-kit-ok
            title={
              online
                ? 'Every document typed at this counter has reached the server. This window writes straight through — nothing is held back to send later.'
                : 'The line is down. Nothing can be saved until it returns — this window does not queue documents.'
            }
            className={`${CHIP_BASE} ${
              online
                ? 'border-success/40 bg-success-soft text-success-ink'
                : 'border-warning/40 bg-warning-soft text-warning-ink'
            }`}
          >
            {online ? <Icons.Check size={16} /> : <Icons.Syncing size={16} />}
            {online ? 'Sales synced' : 'Not syncing'}
          </span>

          {/* The drawer. Open = who is reconciling; closed = a nudge that the
              counter's takings are banking into no shift. One tap opens the
              same modal the till uses. */}
          <button
            type="button"
            data-kit-ok
            onClick={() => setShiftOpen(true)}
            title={
              shiftLabel
                ? 'The drawer — payouts, pay-ins, and cash up.'
                : 'No shift is open. Takings are banking into no reconciliation — open one with a float.'
            }
            className={`${CHIP_BASE} ${
              shiftLabel
                ? 'border-border bg-surface text-ink-2 hover:border-brand/40 hover:bg-brand-soft hover:text-brand'
                : 'border-warning/40 bg-warning-soft text-warning-ink hover:bg-warning-soft/70'
            }`}
          >
            <Icons.Coins size={16} />
            {shiftLabel ?? 'No shift'}
          </button>

          {/* WHICH MACHINE. Not a till number — a trade counter claims none —
              but the window it IS, so somebody reading a strip on a shop floor
              can tell at a glance which of the two they are standing at. */}
          <StatusChip>
            <Icons.Terminal size={16} className="text-muted" />
            Counter
          </StatusChip>

          {/* Who is signed in. Every document typed here is attributed to them,
              which is why it is stated rather than left to be remembered. */}
          <OperatorChip name={operatorName} />

          <ClockChip />

          {/* LOGOUT, and it says the word. Hands the screen back to the PIN pad
              for the next person rather than dropping somebody into the back
              office — the way OUT of the module lives under that pad now (see
              InvoicingGate), which is a between-customers decision rather than
              one that belongs beside Save. */}
          <button
            type="button"
            data-kit-ok
            onClick={() => {
              void counterSignOutAction().then(() => router.refresh())
            }}
            title="Hand over to the next person"
            className={LOGOUT_CHIP}
          >
            <Icons.LogOut size={16} />
            Logout
          </button>
        </span>
      </header>

      {/* `min-h-0` is what lets this scroll inside a flex column instead of
          pushing the header off screen. */}
      <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>

      {/*
        The till's own shift modal, reused rather than reimplemented.

        A shift is a shift: the same drawer, the same opening float, the same
        blind count, the same `shifts` rows. A second copy here would be a
        second place for the cash-up rules to drift, which is exactly what
        shiftActions.ts was written to stop.

        `terminalId` is null: a trade counter claims no till. On a shop set to
        TERMINAL cash-up that means the modal reports no shift, which is honest
        — that shop counts drawers per till and this counter is not one. On
        USER cash-up (openShiftForUser) it is the operator's own shift, which
        is the mode a counter wants.
      */}
      <ShiftModal
        open={shiftOpen}
        online={online}
        terminalId={null}
        pendingSales={0}
        onClose={() => setShiftOpen(false)}
        onShiftChanged={() => router.refresh()}
        /* The detailed declaration lives in the back office. Opened in this
           window rather than a new one: the operator is cashing up, which is
           the end of their stint at this counter. */
        onDeclare={() => {
          setShiftOpen(false)
          router.push('/sales/cashup')
        }}
      />

      {menuOpen && (
        <>
          {/* A plain div rather than a Button: a full-screen dismiss target with
              no label has no business in the tab order, and Escape plus the
              panel's own Close button are what make this reachable. */}
          <div
            data-kit-ok
            aria-hidden
            onClick={() => setMenuOpen(false)}
            className="fixed inset-0 z-40 bg-ink/50"
          />
          <aside
            /* LEFT, like the till's — it is a way back to somewhere, and every
               other back-affordance in this app lives on that edge. */
            className="fixed inset-y-0 left-0 z-50 flex w-[340px] max-w-[85vw] flex-col border-r border-border bg-surface shadow-pop"
            aria-label="Invoicing screens"
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <span className="text-[15px] font-semibold text-ink">Go to</span>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label="Close"
                onClick={() => setMenuOpen(false)}
              >
                <Icons.Close size={20} />
              </Button>
            </div>

            <nav className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4">
              {SCREENS.map((s) => {
                const Icon = Icons[s.icon]
                const isCurrent = s.href === current
                return (
                  <Link key={s.href} href={s.href} className="contents">
                    <TouchRow
                      icon={<CategoryTile icon={<Icon size={20} />} tone={s.tone} />}
                      title={s.label}
                      subtitle={s.hint}
                      tone={isCurrent ? 'active' : 'default'}
                      /* No chevron on the screen already showing — it would
                         promise somewhere the tap cannot take you. */
                      showChevron={!isCurrent}
                      trailing={
                        isCurrent ? (
                          <Icons.StatusSuccess size={18} className="text-brand" />
                        ) : undefined
                      }
                    />
                  </Link>
                )
              })}
            </nav>
          </aside>
        </>
      )}
    </>
  )
}

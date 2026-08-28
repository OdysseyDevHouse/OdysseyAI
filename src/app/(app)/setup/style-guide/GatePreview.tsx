'use client'

import { useState } from 'react'
import { Button } from '@/components/ui'
import OpenTillGate from '@/app/(pos)/pos/OpenTillGate'
import PosGate from '@/app/(pos)/pos/PosGate'
import { TableGate } from '@/app/(pos)/pos/TableGate'
import type { OpenTab } from '@/app/(pos)/pos/actions'
import type { PosTable } from '@/lib/site/posTables'
import type { PosSignInSpecial } from '@/components/ui'

/**
 * The till's table gate, on the Style Guide.
 *
 * Here for the same reason SplitPreview is: the POS sits behind a clerk PIN, so without
 * this the only way to look at the gate is to be standing at a till. The data is
 * fixtures; nothing here touches a bill.
 *
 * ── WHAT THIS ONE IS ACTUALLY FOR ─────────────────────────────────────────
 *
 * It reproduces a shop in hospitality mode whose tables have never been placed on a
 * floor plan (`roomId`/`x`/`y` all null) — a real site's data, not a hypothetical.
 * With no placed table the gate falls back to the LIST view.
 *
 * Split and Move have no buttons here any more: they are armed by quick key, from the
 * till behind this screen. The toggles below stand in for those keys so the ARMED
 * state — the banner, the ringed tiles, the inert ones — can still be looked at
 * without standing at a till.
 *
 * So the fixtures deliberately mix:
 *   · two tabs carried by configured tables — the armable ones,
 *   · one free-text tab with no table behind it — which must stay inert when armed.
 */

const table = (id: number, code: string, documentId: number | null): PosTable =>
  ({
    id,
    code,
    name: code,
    section: 'Main',
    seats: 4,
    visitTypeId: null,
    visitTypeName: null,
    sortOrder: id,
    isActive: true,
    documentId,
    billAskedAt: null,
    state: documentId === null ? 'free' : 'open',
    totalIncl: 0,
    lineCount: 0,
    openedAt: null,
    /* The whole point of this fixture: configured, active, and NOT on any plan. */
    roomId: null,
    x: null,
    y: null,
  }) as PosTable

/** Two seated, one free to be a destination — a split needs somewhere to land. */
const TABLES: PosTable[] = [table(1, 'Table 1', 8001), table(2, 'Table 2', 8002), table(3, 'Table 3', null)]

const tab = (documentId: number, label: string, totalIncl: number): OpenTab => ({
  documentId,
  label,
  customerName: null,
  userName: 'Preview',
  lineCount: 3,
  totalIncl,
  personCount: 2,
  visitTypeId: null,
  visitTypeName: null,
  updatedAt: '2026-08-16T10:00:00.000Z',
})

const TABS: OpenTab[] = [
  tab(8001, 'Table 1', 240),
  tab(8002, 'Table 2', 118.5),
  /* No configured table points at this document, so it is the inert case. */
  tab(8003, 'Walk-in — Sarah', 62),
]

export function GatePreview() {
  const [splitting, setSplitting] = useState(false)
  const [transferring, setTransferring] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-muted">
        A hospitality shop with no floor plan drawn — the tables exist but were never
        placed, so the gate opens on the list. Arm either mode and the two table-backed
        bills light up; the walk-in stays inert.
      </p>
      {/* These two stand in for the quick keys. On a real till the key arms the mode
          and drops the waiter here already armed — there is no button on the gate. */}
      <div className="flex flex-wrap gap-2">
        <Button
          variant={splitting ? 'warning' : 'secondary'}
          onClick={() => {
            setTransferring(false)
            setSplitting((s) => !s)
          }}
        >
          {splitting ? 'Armed: split' : 'Press “Split the bill” key'}
        </Button>
        <Button
          variant={transferring ? 'warning' : 'secondary'}
          onClick={() => {
            setSplitting(false)
            setTransferring((t) => !t)
          }}
        >
          {transferring ? 'Armed: move' : 'Press “Move table” key'}
        </Button>
      </div>
      {note && (
        <div className="rounded-card border border-border bg-surface-2 px-3 py-2 text-[13px] text-ink">
          {note}{' '}
          <Button variant="ghost" size="sm" onClick={() => setNote(null)}>
            Clear
          </Button>
        </div>
      )}
      <div className="h-[560px] overflow-hidden rounded-card border border-border">
        <TableGate
          tabs={TABS}
          tables={TABLES}
          rooms={[]}
          features={[]}
          visitTypes={[]}
          busy={false}
          onWalkIn={() => setNote('Quick sale tapped.')}
          onNewTable={() => setNote('Open new table tapped.')}
          splitting={splitting}
          onToggleSplitting={setSplitting}
          onSplitTable={(t) => setNote(`Split armed on ${t.code}.`)}
          transferring={transferring}
          onToggleTransferring={setTransferring}
          onTransferTable={(t) => setNote(`Move armed on ${t.code}.`)}
          onEmptyArm={(mode) => setNote(`Nothing to ${mode} — the shell toasts here.`)}
          /* The real gate only gets this when the shop has put keys on the tables
             bar — see PosShell's hasTableKeys. Wired here so the header's full set
             of controls is visible; the dialog itself belongs to the shell. */
          onShowQuickKeys={() => setNote('Quick keys tapped — the shell opens the tables bar here.')}
          onPickTab={(t) => setNote(`Resumed ${t.label}.`)}
          onPickTable={(t) => setNote(`Picked table ${t.code}.`)}
        />
      </div>
    </div>
  )
}

/* ── The same gate, with a floor actually drawn ───────────────────────────── */

/**
 * A placed table, in a 100×70 room.
 *
 * The counterpart to the fixtures above: those are unplaced so the gate falls back to
 * the list, these carry a room and coordinates so it opens on the FLOOR. Both cases are
 * real and both are worth being able to look at without standing at a till.
 */
const placed = (
  id: number,
  code: string,
  documentId: number | null,
  x: number,
  y: number,
  shape: PosTable['shape'],
  seats: number,
  width: number,
  height: number,
  billAsked = false,
): PosTable =>
  ({
    id,
    code,
    name: code,
    section: 'Main',
    seats,
    visitTypeId: null,
    visitTypeName: null,
    sortOrder: id,
    isActive: true,
    documentId,
    billAskedAt: billAsked ? new Date('2026-08-16T10:00:00.000Z') : null,
    state: documentId === null ? 'free' : billAsked ? 'bill' : 'open',
    totalIncl: documentId === null ? 0 : 240,
    lineCount: documentId === null ? 0 : 3,
    openedAt: null,
    roomId: 1,
    x,
    y,
    width,
    height,
    rotation: 0,
    shape,
  }) as PosTable

/* One of each shape, and one of each state, so the drawing and the tokens can both be
   checked at a glance. */
const PLACED: PosTable[] = [
  placed(11, '1', null, 8, 8, 'round', 2, 10, 10),
  placed(12, '2', 9001, 26, 8, 'rect', 4, 14, 10),
  placed(13, '3', 9002, 48, 8, 'oval', 6, 20, 10, true),
  placed(14, 'Bar', null, 8, 34, 'counter', 4, 34, 7),
  placed(15, '5', null, 52, 32, 'rect', 8, 22, 14),
]

const PLACED_TABS: OpenTab[] = [tab(9001, '2', 240), tab(9002, '3', 118.5)]

/* One of every fixture, so the drawings can be checked beside the tables they sit
   among — which is the only way to tell whether a wall reads as a wall rather than as
   another long table. */
const FEATURES = [
  { id: 1, roomId: 1, kind: 'wall', label: '', x: 4, y: 2, width: 60, height: 2, rotation: 0 },
  { id: 2, roomId: 1, kind: 'bar', label: 'Bar', x: 72, y: 46, width: 24, height: 8, rotation: 0 },
  { id: 3, roomId: 1, kind: 'pass', label: 'Pass', x: 72, y: 26, width: 24, height: 8, rotation: 0 },
  { id: 4, roomId: 1, kind: 'door', label: '', x: 4, y: 56, width: 9, height: 9, rotation: 0 },
  { id: 5, roomId: 1, kind: 'plant', label: '', x: 44, y: 54, width: 7, height: 9, rotation: 0 },
  { id: 6, roomId: 1, kind: 'text', label: 'Terrace', x: 22, y: 58, width: 14, height: 5, rotation: 0 },
] as never[]

export function FloorPreview() {
  const [note, setNote] = useState<string | null>(null)

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-muted">
        The same gate with a plan drawn, which is what the floor designer produces. Tables
        are drawn by <code>TableGlyph</code> — the very component the designer uses — so
        this is literally the same drawing, tinted by state: table 1 and the bar are free,
        2 is open, 3 has asked for the bill.
      </p>
      {note && (
        <div className="rounded-card border border-border bg-surface-2 px-3 py-2 text-[13px] text-ink">
          {note}{' '}
          <Button variant="ghost" size="sm" onClick={() => setNote(null)}>
            Clear
          </Button>
        </div>
      )}
      {/* Taller than the list preview above: the floor view sizes its canvas to the
          room's aspect ratio, so a 100×70 room needs the height or the bottom third —
          the bar, the door, the plant — is simply cropped away. */}
      <div className="h-[760px] overflow-hidden rounded-card border border-border">
        <TableGate
          tabs={PLACED_TABS}
          tables={PLACED}
          rooms={[{ id: 1, name: 'Main', width: 100, height: 70, isActive: true } as never]}
          features={FEATURES}
          visitTypes={[]}
          busy={false}
          onWalkIn={() => setNote('Quick sale tapped.')}
          onNewTable={() => setNote('Open new table tapped.')}
          splitting={false}
          onToggleSplitting={() => {}}
          onSplitTable={() => {}}
          transferring={false}
          onToggleTransferring={() => {}}
          onTransferTable={() => {}}
          onEmptyArm={() => {}}
          onPickTab={(t) => setNote(`Resumed ${t.label}.`)}
          onPickTable={(t) => setNote(`Picked table ${t.code}.`)}
        />
      </div>
    </div>
  )
}

/* ── The till before it is open ───────────────────────────────────────────── */

/**
 * OpenTillGate, on the Style Guide.
 *
 * Same argument as the table gate above: this screen lives behind a clerk PIN, so
 * without a preview the only way to look at it is to close a real till and stand at
 * it. It is also the screen a shop sees FIRST every morning, which makes it the one
 * worst served by being hard to look at.
 *
 * The toggle exists because the gate has two quite different faces and only one of
 * them is the happy path. The blocked states — offline, no cash-up right, a machine
 * never linked to a till — replace the pad entirely with a callout, and each is a
 * screen somebody will meet on a bad morning without anyone having designed it that
 * day. They are checked here rather than by unplugging a network cable.
 *
 * Nothing here opens a shift: `tillOpenShiftAction` would refuse a preview session
 * anyway, and the button is left live precisely so that refusal renders in the error
 * callout where it belongs.
 */
export function OpenTillPreview() {
  const [state, setState] = useState<'ready' | 'offline' | 'noRight' | 'unclaimed'>('ready')

  const STATES = [
    { key: 'ready', label: 'Ready to open' },
    { key: 'offline', label: 'Offline' },
    { key: 'noRight', label: 'No cash-up right' },
    { key: 'unclaimed', label: 'Machine not linked' },
  ] as const

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-muted">
        The first screen of a shop’s day. The greeting, the weekday and the quote are
        read once when the screen mounts — see <code>lib/tillQuotes</code>; the quote
        turns over at midnight and there is deliberately no button to shuffle it.
      </p>
      <div className="flex flex-wrap gap-2">
        {STATES.map((s) => (
          <Button
            key={s.key}
            variant={state === s.key ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setState(s.key)}
          >
            {s.label}
          </Button>
        ))}
      </div>
      {/* Tall enough for the card at its full height — measured at 744px, plus the
          gate's own padding. Shorter and the preview crops the button and the hint
          under it, which is exactly the part worth looking at. */}
      <div className="h-[800px] overflow-hidden rounded-card border border-border bg-canvas">
        <div className="flex h-full flex-col">
          <OpenTillGate
            mode="terminal"
            operatorName="Tiaan"
            terminalId={state === 'unclaimed' ? null : 1}
            terminalLabel={state === 'unclaimed' ? null : 'TILL001'}
            terminalName={state === 'unclaimed' ? null : 'Till 1'}
            unclaimed={state === 'unclaimed'}
            canCashup={state !== 'noRight'}
            online={state !== 'offline'}
            onOpened={() => {}}
            onExit={() => {}}
          />
        </div>
      </div>
    </div>
  )
}

/* ── The clerk PIN screen ─────────────────────────────────────────────────── */

/**
 * PosGate, on the Style Guide.
 *
 * The same argument as every preview above, and the strongest case of the lot:
 * this is the one screen in the product that faces the CUSTOMER rather than the
 * operator — it is what a shop's counter shows all day between sales — and it
 * is also the hardest to look at, because reaching it means signing a real till
 * out.
 *
 * ── WHY THE FIXTURES ARE THE INTERESTING PART ─────────────────────────────
 *
 * The showcase half has three inputs and each is INDIVIDUALLY optional, so the
 * screen has a designed appearance at four different levels of setup. The
 * toggle below walks them, because the states nobody remembers to check are the
 * ones every shop actually meets.
 *
 * The backdrop cases are the pair worth understanding. A real till is never
 * without a picture — `stockBackdropUrl` picks one from the shop's site type and
 * always answers — so “No picture at all” here is not a shop's first day. It is
 * the gradient underneath: what shows while the photograph loads, and what is
 * left if its bytes have gone missing.
 *
 * Signing in does nothing here. `tillSignInAction` refuses a preview session,
 * and the button is left live precisely so that refusal renders in the pad's
 * own error state where it belongs.
 */
const PREVIEW_SPECIALS: PosSignInSpecial[] = [
  {
    kind: 'price',
    productId: 1,
    description: 'Classic Beef Burger',
    blurb: 'Juicy beef patty with cheddar, lettuce, tomato & our special sauce.',
    priceIncl: 89,
    wasIncl: 109,
  },
  {
    kind: 'price',
    productId: 2,
    description: 'Creamy Chicken Pasta',
    blurb: 'Tender chicken, creamy mushroom sauce with parmesan.',
    priceIncl: 79,
    wasIncl: null,
  },
  {
    kind: 'price',
    productId: 3,
    description: 'Chocolate Fudge Cake',
    blurb: 'Rich chocolate cake served with vanilla ice cream.',
    priceIncl: 49,
    wasIncl: 65,
  },
  /*
   * The OTHER row type, and the reason it is in the default fixture rather than
   * behind its own toggle: a combo deal has no single price, and a shop running
   * only combos used to get a blank showcase with no clue why. It has to be
   * possible to see the two kinds sitting together and tell them apart at a
   * glance — which is the whole design brief for the offer row.
   */
  {
    kind: 'offer',
    specialId: 91,
    description: 'Combo test',
    blurb: 'Buy 2, cheapest at 10% off',
    appliesTo: 'On Beverages, Snacks',
  },
  /* A fifth, so the pager dots appear and the cycle has somewhere to go —
     four per page is the panel's own rule. */
  {
    kind: 'price',
    productId: 4,
    description: 'Flat White',
    blurb: 'Double shot, silky milk.',
    priceIncl: 32,
    wasIncl: 38,
  },
  /* An offer with nowhere brief to say it applies — `appliesTo` is '' and the
     row must still look finished rather than short a line. */
  {
    kind: 'offer',
    specialId: 92,
    description: 'Spend & save',
    blurb: 'Spend R500.00, get 10% off',
    appliesTo: '',
  },
]

export function PosGatePreview() {
  const [state, setState] = useState<'bare' | 'specials' | 'logo' | 'quiet' | 'full'>('bare')

  const STATES = [
    { key: 'bare', label: 'No picture at all' },
    { key: 'specials', label: 'Specials running' },
    { key: 'logo', label: 'Logo uploaded' },
    /* A logo and NO promotions — the commonest real shop by a distance, and the
       state where the greeting has the panel to itself. The specials card is
       what fills the bottom third; without it the whole lower half is
       photograph, which is the composition most tills in the field are actually
       showing and the easiest one to leave looking unfinished. */
    { key: 'quiet', label: 'Logo, no specials' },
    { key: 'full', label: 'Logo + own backdrop' },
  ] as const

  /* A data URI rather than a real upload: the preview must not depend on this
     shop having set a backdrop, and a remote URL would be one more thing that
     can fail on a screen whose job is to show what things look like. A flat
     tone is enough — what is being checked is that the scrim keeps the text
     readable over an arbitrary picture. */
  const BACKDROP =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600">
         <rect width="400" height="600" fill="#5b4636"/>
         <circle cx="90" cy="120" r="70" fill="#7a6047"/>
         <circle cx="310" cy="380" r="110" fill="#6b523c"/>
       </svg>`,
    )
  const LOGO =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
         <circle cx="100" cy="100" r="92" fill="none" stroke="#1b2432" stroke-width="6" stroke-dasharray="10 6"/>
         <text x="100" y="92" text-anchor="middle" font-family="sans-serif" font-size="30" font-weight="700" fill="#1b2432">YOUR</text>
         <text x="100" y="128" text-anchor="middle" font-family="sans-serif" font-size="30" font-weight="700" fill="#1b2432">LOGO</text>
       </svg>`,
    )

  const showLogo = state === 'logo' || state === 'quiet' || state === 'full'
  const showBackdrop = state === 'full'
  const showSpecials = state !== 'bare' && state !== 'quiet'

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-muted">
        What a counter shows between sales. The showcase half is built from three
        independent optional pieces, so step through them. “No picture at all” is the
        gradient the panel paints while a photograph loads or when its bytes have gone
        missing — a shop that has uploaded nothing gets a stock picture for its trade
        instead, so this is a fallback rather than a first day. The specials card leads
        with ONE offer at the size it is read from a queue and lists the rest beneath
        it, cycling two at a time. Both kinds of promotion take the same shape there:
        priced items a customer can act on lead with the price, while combos and
        spend-and-gets — which have no one price — lead with the deal said in words.
      </p>
      <div className="flex flex-wrap gap-2">
        {STATES.map((s) => (
          <Button
            key={s.key}
            variant={state === s.key ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setState(s.key)}
          >
            {s.label}
          </Button>
        ))}
      </div>
      {/* 706 for the sign-in card plus 48 of screen padding, rounded up. Short
          of that the pane's `max-h-full` kicks in and the preview quietly shows a
          squashed version rather than the real one — which is the specific way a
          preview becomes worse than no preview. Wide matters for the same reason:
          the showcase only appears from `lg`, so a cramped frame would show the
          fallback rather than the screen this exists to show. */}
      <div className="h-[800px] overflow-hidden rounded-card border border-border bg-canvas">
        <div className="flex h-full flex-col">
          <PosGate
            siteId={0}
            /* A name, because the greeting is the largest thing on the showcase
               and a preview of it reading "Welcome back." would be showing the
               unnamed-site fallback rather than what a shop actually sees. Long
               enough to wrap onto two lines, which is where the heading's
               `text-balance` earns its place. */
            siteName="Harbour View Deli"
            backdropUrl={showBackdrop ? BACKDROP : ''}
            logoUrl={showLogo ? LOGO : ''}
            specials={showSpecials ? PREVIEW_SPECIALS : []}
            onOfflineSignIn={() => {}}
          />
        </div>
      </div>
    </div>
  )
}

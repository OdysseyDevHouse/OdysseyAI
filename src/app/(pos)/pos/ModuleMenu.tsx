'use client'

import { useEffect } from 'react'
import {
  Button,
  CategoryTile,
  Icons,
  PromoArt,
  TintButton,
  TouchRow,
  type CategoryTone,
} from '@/components/ui'
import type { DraftDocType } from '@/lib/posOffline/draftOffline'

/**
 * Which screen the till is showing.
 *
 * `sale` is the till as it has always been — the basket, the catalogue, the
 * tender pad. The others are that SAME trading screen pointed at a different
 * kind of document.
 *
 * Deliberately NOT a fourth piece of state in the shell. Each module is a doc
 * type the basket already carries, and `MODULE_DOC_TYPES` below is the whole of
 * the translation. A separate "current module" variable would be a second
 * answer to a question `state.docType` already answers, and the two would drift
 * the first time anything set one without the other — a recovered draft, a
 * cleared return, an arrival from "New order".
 */
export type TillModule = 'sale' | 'quotes' | 'orders' | 'laybys'

/**
 * The document each module writes.
 *
 * A credit sale has no module of its own on purpose: returning is a MODE the
 * till drops into from the refund key and comes back out of, not a place a
 * cashier navigates to and stands in.
 *
 * LAY-BYS map to `invoice`, which looks wrong and is not. A lay-by is not a
 * sales document at all — it lives in its own table with its own payments —
 * and the till never builds one in the basket. Picking that module opens a
 * LIST and leaves the basket alone, so the doc type here only says what the
 * basket underneath goes on being: an ordinary sale, untouched.
 */
export const MODULE_DOC_TYPES: Record<TillModule, DraftDocType> = {
  sale: 'invoice',
  quotes: 'quote',
  orders: 'sales_order',
  laybys: 'invoice',
}

/**
 * Modules that open a list instead of changing what the basket is.
 *
 * Every other module answers "what kind of document am I writing". Lay-bys
 * answers "where is the customer's lay-by" — the basket is not involved, so
 * picking it must not clear one. Without this the module menu would bin a
 * half-rung sale to show a list and then hand back an identical empty till.
 */
export const LIST_ONLY_MODULES: readonly TillModule[] = ['laybys']

/**
 * What to call a module in a sentence.
 *
 * Not `DRAFT_DOC_LABELS`, which names the DOCUMENT. A cashier who taps "Point
 * of sale" and is then asked about "an invoice" has been asked about something
 * they did not press — and the first build of this asked exactly that, because
 * reusing the document labels was the obvious shortcut.
 *
 * Each entry carries its own article, so nothing has to guess between "a" and
 * "an" from a first letter. That guess is what produced "Start a invoice?".
 */
export const MODULE_PHRASES: Record<TillModule, string> = {
  sale: 'a sale',
  quotes: 'a quote',
  orders: 'an order',
  /* Never actually used in the "start a…" question — lay-bys open a list and
     leave the basket alone, so that question is never asked of them. Present
     because the record must be total, and a missing key here would be a crash
     rather than a wrong word. */
  laybys: 'a lay-by',
}

/**
 * What to call a module's DOCUMENTS, plural, when refusing to open their list.
 *
 * Separate from `MODULE_PHRASES`, which names the act of starting one ("a
 * quote") and reads wrong in the plural sentence this is for: "a quote need the
 * connection". Two records rather than one clever helper, because the two
 * sentences they serve are genuinely different and a shared one would have to be
 * bent for both.
 */
export const MODULE_LIST_NAMES: Record<TillModule, string> = {
  /* Never used — saved sales are the one list that works offline, since parked
     baskets live on this machine too. Present because the record must be total. */
  sale: 'Saved sales',
  quotes: 'Quotes',
  orders: 'Sales orders',
  laybys: 'Lay-bys',
}

/**
 * The inverse, for reading the current module off the basket.
 *
 * NEVER returns `laybys`, and cannot: that module shares the invoice doc type
 * because it does not change the basket at all. The till is "on" lay-bys only
 * while their list is open, which is a dialog rather than a mode — so the tick
 * in the menu belongs to whatever the basket is underneath, which is the truth.
 */
export function moduleForDocType(docType: DraftDocType): TillModule {
  if (docType === 'quote') return 'quotes'
  if (docType === 'sales_order') return 'orders'
  /* An invoice AND a credit sale both land on the sale screen, because that is
     the screen both are rung up on. */
  return 'sale'
}

/**
 * The modules a shop can be shown, in the order they appear.
 *
 * Ordered by how often a counter reaches for them, not alphabetically: selling
 * is what a till is FOR, and everything else is something you go and do.
 *
 * LAY-BYS WERE HELD BACK until the cash-up counted their money. They were built
 * in the back office all along, but a till taking payments against one would
 * have made every drawer read over by exactly them — the declaration showed
 * lay-by takings while the expected cash excluded them. That is fixed, so the
 * row is here.
 */
export const MODULES: {
  key: TillModule
  label: string
  hint: string
  icon: keyof typeof Icons
  tone: CategoryTone
  /**
   * The two things you can do with this kind of document, when there ARE two.
   *
   * ── WHY A MODULE IS NOT ONE DESTINATION ───────────────────────────────
   *
   * "Quotes" was one row that started a blank quote. But a counterhand reaching
   * for quotes wants one of two opposite things — to WRITE one for the person
   * standing there, or to FIND the one written last week — and a single row had
   * to pick. It picked "write", so finding an existing quote meant switching
   * module (clearing the basket) and then hunting for the list key.
   *
   * Naming both makes the row answer the question it raises. `newLabel` starts a
   * fresh document and clears the basket, which is why it still asks first;
   * `listLabel` opens the list OVER the screen and touches nothing.
   *
   * Absent on lay-bys, deliberately. A lay-by is not something the basket
   * becomes — it is opened from a basket already rung up, by taking a deposit —
   * so "new lay-by" from a menu would be a button that can only refuse. That
   * row stays what it was: one tap to the list.
   */
  newLabel?: string
  listLabel?: string
}[] = [
  /*
   * The hints are SHORT because TouchRow truncates on one line, and that is the
   * kit's decision rather than this screen's to overrule. The first draft wrote
   * a sentence each and the panel showed "Price something up for a custom…" —
   * a hint that stops before the useful half is worse than a brief one.
   */
  {
    key: 'sale',
    label: 'Point of sale',
    hint: 'Ring up and take the money',
    icon: 'ShoppingCart',
    tone: 'emerald',
    newLabel: 'New sale',
    /* The PARKED baskets, which is what "an existing sale" means on a till: a
       posted invoice is finished and belongs in Reprints. Named "Saved sales"
       rather than "Sale list" for that reason — it is the one list here whose
       contents are unfinished rather than filed. */
    listLabel: 'Saved sales',
  },
  {
    key: 'quotes',
    label: 'Quotes',
    hint: 'A price to think about',
    icon: 'FileText',
    tone: 'indigo',
    newLabel: 'New quote',
    listLabel: 'Quote list',
  },
  {
    key: 'orders',
    label: 'Sales orders',
    hint: 'Promised now, delivered later',
    icon: 'ListOrdered',
    tone: 'sky',
    newLabel: 'New order',
    listLabel: 'Order list',
  },
  /* One tap, no pair — see `newLabel` above for why a lay-by has no "new". */
  {
    key: 'laybys',
    label: 'Lay-bys',
    /* Shortened from "Take a payment or hand goods over", which was the longest
       of the four and the only one TouchRow actually clipped — it rendered as
       "…hand goods o…". Both halves of the old phrase are the same act from the
       customer's side, so naming the money keeps the useful half. */
    hint: 'Take a payment against one',
    icon: 'Package',
    tone: 'amber',
  },
]

/**
 * The till's way between its modules.
 *
 * ── WHY A PANEL OVER THE SCREEN, NOT ANOTHER GATE ─────────────────────────
 *
 * The shell already switches between screens — the closed-till gate, the floor
 * gate, the trading columns — as one chain of conditions, and a fourth branch
 * there would have been the obvious place for this. It would also have
 * UNMOUNTED the basket every time somebody glanced at the list, which is the
 * one thing a till must never do: a counterhand six lines into a quote who taps
 * the menu to check something must find those six lines still there.
 *
 * So this lays over the top. The trading screen stays exactly where it was, and
 * switching modules changes what the basket MEANS rather than throwing it away.
 *
 * ── AND WHY THE ROWS ARE THIS BIG ─────────────────────────────────────────
 *
 * It is used with a finger, on a screen somebody is standing in front of. These
 * are `TouchRow`s — the same component the saved-sales and reprint lists use —
 * with the reason for each module written beside it, because the person picking
 * may never have opened the one they are about to.
 *
 * ── WHY MOST ROWS CARRY TWO BUTTONS ───────────────────────────────────────
 *
 * Because "quotes" is not a place, it is two opposite jobs: WRITE one for the
 * customer in front of you, or FIND the one you wrote last week. A single row
 * had to choose, and it chose "write" — so looking a quote up meant switching
 * module, which cleared the basket, and then hunting for a list key.
 *
 * Naming both makes each card answer the question it raises, and the two differ
 * in the way that matters to whatever is on screen: New clears the basket and
 * asks first, List lays a dialog over the top and touches nothing.
 *
 * Lay-bys keep the single row. A lay-by is not something the basket BECOMES —
 * it is opened from one already rung up, by taking a deposit — so a "new lay-by"
 * button here could only ever refuse.
 *
 * ── AND WHY THE HEADING ABOVE THEM IS NOT ONE ─────────────────────────────
 *
 * On those cards the heading is a LABEL. It was a `TouchRow`, which is a button,
 * and that made a two-choice card offer three targets — the third being both the
 * biggest and the only one that would not say what it did. "Quotes" pressed on
 * its own had to choose between writing one and finding one, and it chose write,
 * silently, sitting directly above two buttons that name both.
 *
 * Lay-bys keeps its `TouchRow`, because there the row genuinely IS the single
 * destination and there is nothing under it to be ambiguous against.
 */
export default function ModuleMenu({
  open,
  current,
  available,
  operatorName,
  terminalLabel,
  onPick,
  onOpenList,
  onClose,
}: {
  open: boolean
  current: TillModule
  /**
   * Which modules this shop actually has.
   *
   * A hardware trade counter has no lay-bys; a restaurant has neither those nor
   * quotes. Listing a module a shop has switched off would teach somebody to
   * press a thing that then explains it is unavailable.
   */
  available: readonly TillModule[]
  /**
   * Who is signed in, and on which machine — the panel's foot.
   *
   * ── WHY THE MENU REPEATS WHAT THE STATUS BAR ALREADY SAYS ─────────────
   *
   * It is not a second answer to the same question. The bar along the top says
   * it while the till is TRADING; this panel covers the left third of the
   * screen, and on the 340px it takes it covers most of what a cashier would
   * glance at to check. A drawer that hides the answer to "am I still me" and
   * then offers four ways to leave the screen is a drawer somebody closes again
   * to look something up.
   *
   * Both read from the same two props the shell already holds, so there is one
   * source and two viewings rather than two answers that can disagree.
   *
   * `terminalLabel` is null on a machine that has claimed no till. Nothing is
   * rendered in its place: the panel is not where that gets fixed, and a warning
   * here would be a second, quieter copy of the one the status bar already
   * shows — in the drawer you opened to go somewhere else.
   */
  operatorName: string
  terminalLabel: string | null
  onPick: (module: TillModule) => void
  /**
   * Opens that module's EXISTING documents, without touching the basket.
   *
   * The counterpart to `onPick`, and separate from it because the two do
   * opposite things to what is on screen: picking a module changes what the
   * basket is (and so may have to clear it and ask first), while opening a list
   * lays a dialog over the top and leaves every rung line where it was.
   *
   * Routed up to the shell rather than handled here so each list keeps the
   * offline guard it already has — these documents live on the server, and a
   * list that renders its empty state offline says "you have no quotes" when
   * the truth is "this till cannot see them".
   */
  onOpenList: (module: TillModule) => void
  onClose: () => void
}) {
  /* Escape closes it, like every other overlay in the till. A panel with no way
     out but a precise tap on the backdrop is one somebody gets stuck in. */
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const shown = MODULES.filter((m) => available.includes(m.key))

  return (
    <>
      {/* The backdrop. A plain div rather than a Button: it is a 100%-of-screen
          dismiss target with no label and no focus stop of its own — the panel's
          own Close button and Escape are what make this reachable without a
          pointer, and a full-screen element in the tab order would be a trap. */}
      <div
        data-kit-ok
        aria-hidden
        onClick={onClose}
        className="fixed inset-0 z-40 bg-ink/50"
      />

      <aside
        /* LEFT, not right. It is a way BACK to somewhere, and every other
           back-affordance in this app — the sidebar, the gate's return arrow —
           lives on that edge. */
        className="fixed inset-y-0 left-0 z-50 flex w-[340px] max-w-[85vw] flex-col border-r border-border bg-surface shadow-pop"
        aria-label="Till modules"
      >
        {/* No rule under the heading. The cards below are each bordered and sit
            on a tinted rail, so a hairline here would be a third horizontal line
            in the top 80px — the panel's own edge, the rule, then the first
            card. The gap between the title and the first card does that job. */}
        <div className="flex shrink-0 items-center justify-between px-5 pb-1 pt-5">
          {/* 20px, well above the 15px this was. It is the only heading on the
              panel and it names the whole thing; at 15px it was the same size as
              the module titles under it, so the panel opened with four things
              shouting the same volume and nothing to land on first. */}
          <span className="text-[20px] font-semibold tracking-tight text-ink">Go to</span>
          {/* `ghost`, so it is a bordered square rather than a bare glyph. The
              rule above removes the panel's only other line, and without a box
              this X floats in white with nothing to say it is pressable. */}
          <Button variant="ghost" size="md" iconOnly aria-label="Close" onClick={onClose}>
            <Icons.Close size={18} />
          </Button>
        </div>

        {/* gap-3 rather than gap-2: the rows are cards now, each holding its own
            pair of buttons, so they need to read as separate blocks rather than
            as one list. */}
        <nav className="till-pane flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          {shown.map((m) => {
            const Icon = Icons[m.icon]
            const isCurrent = m.key === current
            /*
             * ── THE HEADING IS NOT A CONTROL ──────────────────────────────
             *
             * On a card that carries a pair of buttons it is a LABEL — it says
             * what the two buttons below are about and does nothing when pressed.
             *
             * It was a TouchRow, which is a <button>, and that made every such
             * card offer three targets where it means to offer two. The third
             * was also the biggest and the vaguest: "Quotes" pressed on its own
             * had to pick between writing one and finding one, and it picked
             * write — silently, with no label saying so, directly above two
             * buttons that name both choices explicitly.
             *
             * So the whole-card tap is gone from the paired cards and the
             * buttons are the only way through. Lay-bys keeps its TouchRow below,
             * because there the row genuinely IS the one destination.
             */
            const heading = (
              /* px-1, against the buttons' own edge — this is the padding fix.
                 A TouchRow carries pl-3/pr-3 of its own, so inside the card's p-2
                 the heading's icon started 20px from the card edge while the
                 button row started at 8px. The two were visibly out of line down
                 the left, and on the Quotes card "Quote list" ran up against the
                 right border while the heading stopped short of it.

                 Not zero: the buttons have a border and the text does not, so a
                 hair of inset is what makes the two read as one column. */
              <div className="flex items-center gap-3 px-1 py-1.5">
                <CategoryTile icon={<Icon size={20} />} tone={m.tone} size="lg" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold text-ink">
                    {m.label}
                  </span>
                  <span className="block truncate text-[13px] text-muted">{m.hint}</span>
                </span>
                {/* No chevron. It promised the heading went somewhere, which is
                    exactly what it has stopped doing. The tick stays: it is a
                    STATE, not an affordance, and "you are on this one" is the
                    thing a cashier most needs read off this panel. */}
                {isCurrent && <Icons.StatusSuccess size={18} className="shrink-0 text-brand" />}
              </div>
            )

            /*
             * A CARD, so the two buttons visibly belong to the heading above
             * them. Four modules each with two loose buttons under a title is
             * eight controls in a column, and without the box a cashier has to
             * count rows to work out which "List" belongs to which document.
             *
             * LAY-BYS GETS ONE TOO, which it did not before. It was the one bare
             * row in a column of cards, and reading down the panel it looked
             * like something that had failed to load rather than like a module
             * with less to offer. The box is the panel's unit; what goes IN it is
             * what differs, and for lay-bys that is one row and no pair.
             */
            return (
              /*
               * ── THE CARD IS NEUTRAL; ONLY WHAT IS IN IT CARRIES COLOUR ────
               *
               * Two earlier versions put the module's hue on the card itself —
               * first as a tinted band behind the heading, then as a coloured
               * border around the whole thing. Both made the card compete with
               * its own contents: the tile and the two buttons are already that
               * colour, and they are the parts you press.
               *
               * A grey hairline and a shadow instead. The shadow is what the
               * border was really being asked for — separating four cards down a
               * narrow drawer — and it does that by lifting them off the panel
               * rather than by drawing four coloured rectangles. The colour stays
               * where it belongs: on the tile, and on the pair of buttons.
               *
               * `shadow-card`, not `shadow-pop`. Pop is for something floating
               * over the page — a menu, a toast — and this panel is already that
               * thing. A second pop inside it would be a drawer full of drawers.
               */
              <div
                key={m.key}
                className="rounded-card border border-border bg-surface p-2 shadow-card"
              >
                {/*
                 * Lay-bys, and anything else with no pair: the row IS the
                 * destination, so it stays a TouchRow and stays pressable.
                 *
                 * `bare` so it draws no box inside the card's, and no activeTone
                 * — a module with one row and no buttons is never the module the
                 * basket is writing, so the tinted state has nothing to say here.
                 */}
                {m.newLabel && m.listLabel ? (
                  heading
                ) : (
                  <TouchRow
                    icon={<CategoryTile icon={<Icon size={20} />} tone={m.tone} size="lg" />}
                    title={m.label}
                    subtitle={m.hint}
                    tone="bare"
                    onClick={() => {
                      if (!isCurrent) onPick(m.key)
                      onClose()
                    }}
                  />
                )}
                {/* The two acts, side by side and equal width: neither is the
                    lesser one. Writing a new quote and finding an old one are
                    both ordinary, and sizing one down would be a guess about
                    which this shop does more of. */}
                {m.newLabel && m.listLabel && (
                  /*
                   * `min-w-0` on the row, and each button allowed to SHRINK.
                   *
                   * Every kit button carries `shrink-0` — right in a toolbar,
                   * where a button squeezed by its neighbours is a bug. Here it
                   * meant the pair demanded the full width of both labels and
                   * took it: "New quote" plus "Quote list" comes to more than the
                   * card holds, so `flex-1` grew them past the edge rather than
                   * splitting it, and "Quote list" ended 3px from the border
                   * where the heading above sat at 9px.
                   *
                   * That 6px is the gap that reads as a padding fault and is not
                   * one — every container here measures a correct and equal 9px.
                   * The buttons were overflowing, not mis-padded.
                   *
                   * `[flex-shrink:1]` rather than `shrink`: both would be the
                   * same declaration, but `shrink-0` from the button's own base
                   * sits in the same layer, and which of two same-layer utilities
                   * wins is decided by stylesheet order rather than by the
                   * attribute. An arbitrary property lands in a later layer and
                   * settles it. (Same trap as TintButton's colours — see the note
                   * on `buttonShape`.)
                   *
                   * With both, the pair splits the row exactly, and a label long
                   * enough to overrun truncates instead — the right failure: a
                   * clipped word inside the card beats a button hanging out of it.
                   *
                   * The side padding is trimmed from the touch size's 20px to
                   * 12px for the same reason. 20px is right for a button sized by
                   * its own label; on a 141px box fixed by the column it is 40px
                   * of the width spent on air, which is what pushed "Saved sales"
                   * hard against its icon and started squeezing the glyph. The
                   * height — the part a finger actually needs — is untouched.
                   */
                  <div className="mt-2 flex min-w-0 items-stretch gap-2">
                    <TintButton
                      /*
                       * The MODULE's colour, not the app's.
                       *
                       * These were `secondary` — brand blue — and six brand-blue
                       * buttons stacked down a narrow drawer made one wall in
                       * which no card owned its own pair. The tile at the top of
                       * each card was already carrying the identity and the
                       * buttons were ignoring it.
                       *
                       * Tinting them to the same tone makes the disc and the pair
                       * one identifier: green is the till, indigo is quotes, sky
                       * is orders, wherever your eye lands on the card. It is also
                       * why these are TintButtons rather than Buttons — a
                       * `success`-green "New quote" would be claiming the act is
                       * a positive one, which is a meaning the rest of the app
                       * then has to live with. See TintButton for that split.
                       */
                      tone={m.tone}
                      size="touch"
                      className="min-w-0 flex-1 [flex-shrink:1] [padding-inline:0.75rem]"
                      onClick={() => {
                        /* Same call the row makes. Starting a NEW document is what
                           picking the module has always done — clearing the basket,
                           asking first when there is something to lose — so this is
                           that act named out loud rather than a second path to it. */
                        onPick(m.key)
                        onClose()
                      }}
                    >
                      <Icons.Plus size={18} className="shrink-0" />
                      {m.newLabel}
                    </TintButton>
                    <TintButton
                      tone={m.tone}
                      size="touch"
                      className="min-w-0 flex-1 [flex-shrink:1] [padding-inline:0.75rem]"
                      onClick={() => {
                        /* NOT closed on the way. The shell may refuse — these lists
                           are server-bound and this till may be offline — and a menu
                           that shut on the way to a refusal would leave the cashier
                           looking at the trading screen wondering what happened. The
                           shell closes it when the list actually opens. */
                        onOpenList(m.key)
                      }}
                    >
                      <Icons.ListOrdered size={18} className="shrink-0" />
                      {m.listLabel}
                    </TintButton>
                  </div>
                )}
              </div>
            )
          })}

          {/*
           * THE PANEL'S FOOT, and the reason it is not empty.
           *
           * Four cards do not fill a full-height drawer on a counter screen, so
           * what used to be here was 300px of white between the last module and
           * the bottom edge — the part of the panel a cashier's eye travels
           * through on the way back up. This gives it something to be.
           *
           * It is deliberately NOT a control. No border, no chevron, nothing that
           * looks pressable: the panel's whole job is to say where you can go,
           * and a fifth box that goes nowhere would be the one thing on it that
           * lies. It reads as the drawer's own furniture, which is what a promo
           * panel is.
           *
           * mt-auto pins it below the cards and above the footer however few
           * modules a shop has switched on — with one module it sits low, with
           * four it sits right under them, and in neither case does it float in
           * the middle of a gap.
           */}
          <div className="mt-auto flex items-center gap-2 rounded-card bg-brand-soft/60 p-4">
            <div className="min-w-0 flex-1">
              {/* The break is written in rather than left to the box. At 340px
                  minus the drawing there is room for "All your sales," and no
                  more, so an automatic wrap put "in one" on line two and "place"
                  alone on a third — and it would move again the first time the
                  panel or the type changed. Two deliberate lines instead. */}
              <p className="text-[15px] font-semibold leading-snug text-ink">
                All your sales,
                <br />
                in one place
              </p>
              {/* text-[12px] here, below the 13px the hints under each module
                  carry. It is the one line on the panel nobody needs to read to
                  work the till, and sizing it with the rest made three lines of
                  the same weight fighting in a corner. */}
              <p className="mt-1.5 text-[12px] leading-snug text-muted">
                Fast, simple and built
                <br />
                for your business.
              </p>
            </div>
            {/* text-brand and nothing else — every stroke in the drawing is
                currentColor, so it follows the brand token into dark mode. */}
            <PromoArt kind="bag" className="h-24 w-24 shrink-0 text-brand" />
          </div>
        </nav>

        {/*
         * WHO IS AT THIS TILL — the panel's last line.
         *
         * Outside the scrolling nav on purpose. It is not a destination and must
         * not scroll away with the cards: a drawer that answers "where can I go"
         * should also answer "as whom", and the answer has to still be there when
         * you have scrolled to the bottom of a long module list.
         *
         * shrink-0 because the nav above it is the flex child that grows — see
         * the note on the aside. Without it a tall list crushes this to nothing
         * instead of scrolling.
         */}
        <div className="flex shrink-0 items-center gap-3 border-t border-border px-4 py-3.5">
          {/* The same initials-in-a-tinted-square block the status bar and the
              gate use, so "who is signed in" looks identical wherever it is read.
              Round here rather than square: at 40px on a drawer's foot it is an
              avatar, and the status bar's is a 28px chip in a row of chips. */}
          <span
            aria-hidden
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-pill bg-brand text-[13px] font-bold text-white"
          >
            {initials(operatorName)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] font-semibold text-ink">
              {operatorName}
            </span>
            {terminalLabel && (
              <span className="block truncate text-[13px] text-muted">{terminalLabel}</span>
            )}
          </span>
          {/* Points DOWN, not right, and is not a button.
              Every other chevron on this panel says "this row takes you
              somewhere"; this one marks the block as the panel's foot rather than
              a fifth destination. Making it a real menu is a separate job — until
              there is something for it to open, a live control here would be a
              button that does nothing, which is worse than a mark that never
              claimed to. */}
          <Icons.ChevronDown size={18} aria-hidden className="shrink-0 text-muted" />
        </div>
      </aside>
    </>
  )
}

/**
 * Two letters for an avatar.
 *
 * A copy of the status bar's own helper rather than a shared export, and
 * deliberately: it is four lines of string handling with no product decision in
 * it, and hoisting it into the kit would make "how do we abbreviate a name" a
 * system-wide contract that two callers happen to agree on. If a third wants it,
 * that is when it moves.
 */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  const first = parts[0][0]
  const last = parts.length > 1 ? parts[parts.length - 1][0] : ''
  return (first + last).toUpperCase()
}

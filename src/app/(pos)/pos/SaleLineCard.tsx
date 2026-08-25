'use client'

import { Button, Badge, Icons, ExpandingCard } from '@/components/ui'
import { formatMoney, formatQty } from '@/lib/decimals'
import { isPriceOverridden, type BasketLine } from '@/lib/basket'
import { formatLineAge, type LineSessionState } from '@/lib/lineSession'

/**
 * One line of the sale, as a CARD rather than a table row.
 *
 * ── WHY THIS INVERTS THE 36px TABLE DENSITY ───────────────────────────────
 *
 * The odyssey-craft rule is that rows are tight, because a 1,284-product list is
 * SCANNED and every pixel of padding is a product somebody has to scroll to
 * reach. A basket is the opposite instrument: eight to fifteen lines that get
 * TOUCHED, by a finger, by someone standing up and looking at a customer rather
 * than at the screen. Here the cost of a mis-tap is higher than the cost of a
 * scroll, so the same reasoning that produces 36px there produces ~64px here.
 *
 * Do not "fix" this to match the tables. It is the documented exception.
 *
 * A DataTable cannot express it either: the selected line GROWS to reveal its
 * actions, and a table row cannot hold a second row inside itself.
 *
 * ── WHAT A LINE HAS TO ANSWER ─────────────────────────────────────────────
 *
 * Four questions, in the order a waiter asks them, which is the order they are
 * stacked in below:
 *
 *   1. WHAT and HOW MUCH        — description, quantity, money
 *   2. AT WHICH PRICE           — the price structure it was rung on
 *   3. WITH WHAT ON IT          — the answers to the product's questions
 *   4. WHERE IT STANDS          — sent to the kitchen? changed? how old?
 *
 * The last row is the one that is easy to get wrong. A tab is reopened over and
 * over, and on the second visit the lines the kitchen already has look exactly
 * like the ones just added — so a waiter either re-sends everything (and the
 * starters are cooked twice) or sends nothing (and the main never arrives). The
 * state chips exist to make that difference visible; see lib/lineSession.
 */
export function SaleLineCard({
  line,
  lineTotal,
  effectiveDiscountPct,
  discountIncl,
  specialName,
  priceStructureName,
  sessionState,
  ageMinutes,
  selected,
  onSelect,
  onStep,
  onEdit,
  onRemove,
  onMore,
}: {
  line: BasketLine
  lineTotal: number
  /** After the special-versus-manual comparison — what is actually charged. */
  effectiveDiscountPct: number
  /**
   * What that percentage came to in rands on this line.
   *
   * Shown BESIDE the percentage rather than instead of it, for the same reason
   * the slip carries both: the percentage is the claim ("20% off"), the amount
   * is what this customer actually saved. A cashier answering "so how much did
   * I save?" should not have to work it out on a line already showing it.
   */
  discountIncl: number
  /** Named when a promotion is what discounted this line. */
  specialName: string | null
  /**
   * The price structure this basket is being rung on — "Retail", "Wholesale".
   *
   * Shown on EVERY line, which breaks the usual rule that a label on every row
   * is decoration, and does so deliberately: on an account sale the whole basket
   * silently prices off a different structure, and the line is where a cashier
   * looks to check what a customer is being charged. A label that appeared only
   * on the unusual structure would be missing from precisely the screen someone
   * is checking when they ask "is this the trade price?".
   *
   * Null when the shop has no structures configured, and then nothing is shown.
   */
  priceStructureName: string | null
  /** What has happened to this line since the tab was opened. */
  sessionState: LineSessionState
  /** How long ago it was ordered, in whole minutes. */
  ageMinutes: number
  selected: boolean
  onSelect: () => void
  onStep: (delta: number) => void
  onEdit: () => void
  onRemove: () => void
  /** The overflow of per-line actions. Undefined leaves the key out. */
  onMore?: () => void
}) {
  const refund = line.qty < 0
  const discounted = effectiveDiscountPct > 0
  /*
   * A line the promotion put here, rather than one it reduced.
   *
   * It carries NO discount — it is free, not marked down — so the ordinary
   * discount badge would never appear on the one line the deal actually gave
   * away. Its own badge, in the same warning tone, because to a cashier
   * glancing at the basket both mean "a promotion did this".
   */
  const granted = line.rewardSpecialId !== undefined
  /* Any of it, not all of it. A line of 3 with 1 sent is a line the kitchen has
     partly heard about, and telling the waiter it is unsent would invite a
     re-send of all three. The delta that actually prints is computed
     server-side against the live send history — see BasketLine.kitchenSent. */
  const sent = line.kitchenSent === true

  return (
    <li>
      <ExpandingCard
        className="mx-2.5 my-2"
        open={selected}
        onToggle={onSelect}
        header={
          <>
            <span className="flex items-start gap-2">
              {/* Bolder and TWO steps larger than the detail under it. The name is
                  what a waiter reads the line BY — everything else on the card
                  is checked only once the right line has been found, so the gap
                  between it and the detail is what makes a tab scannable at
                  arm's length. */}
              <span className="min-w-0 flex-1 text-base font-bold leading-tight text-ink">
                {line.description}
              </span>
              {/* SENT rides beside the name, not down in the state row, because
                  it answers a different question: not "has this line changed"
                  but "is the kitchen already cooking it". A waiter scanning for
                  what still has to go through reads this column alone. */}
              {sent && (
                <Badge tone="success" solid className="mt-0.5 shrink-0">
                  Sent
                </Badge>
              )}
              <span className="numeric shrink-0 text-[15px] font-bold text-ink">
                {formatMoney(lineTotal)}
              </span>
            </span>

            <span className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
              {/* "2 @Retail Price" — the quantity and the structure it is priced
                  on, read as one phrase, because they are one fact: this many,
                  at this shop's trade price. */}
              <span className="numeric">
                {formatQty(line.qty)}
                {priceStructureName ? ` @${priceStructureName}` : ''} ×{' '}
                {formatMoney(line.unitPriceIncl)}
              </span>

              {/* Badges only where they SAY something. A chip on every line is
                  decoration, and decoration is what hides the one line that is
                  actually unusual — see odyssey-craft on colour as meaning. */}
              {refund && <Badge tone="danger" solid>Refund</Badge>}
              {granted && (
                <Badge tone="warning" solid>
                  {specialName ? `Free — ${specialName}` : 'Free'}
                </Badge>
              )}
              {/* NAME, PERCENTAGE AND VALUE — all three, not whichever one
                  happened to be known.
                  This used to read `specialName ?? '<pct>% off'`, so a line on a
                  promotion showed the name ALONE: "Test13", with no hint of how
                  much came off or what it was worth. That hid a real case as
                  well as a figure — a cashier who discounts a line that already
                  has a special still sees only the promotion's name, because
                  effectiveDiscountPct takes the higher of the two and the badge
                  never mentioned it. The slip prints name, percentage and rands
                  together; the screen the customer is watching should not say
                  less than the paper they are handed. */}
              {!granted && discounted && (
                <Badge tone="warning" solid>
                  {specialName ? `${specialName} · ` : ''}
                  {formatQty(effectiveDiscountPct)}% off
                  {discountIncl > 0 ? ` · ${formatMoney(discountIncl)}` : ''}
                </Badge>
              )}
              {isPriceOverridden(line) && <Badge tone="brand" solid>Price changed</Badge>}
            </span>

            {/* What was chosen, and anything typed.
                This is the ONLY place a cashier sees the answers again before
                paying — the modal is gone by then — so a wrong tap has to be
                visible here or it reaches the kitchen unnoticed. The 'receipt'
                filter is deliberately not used: the cashier should see
                everything on the line, including the answers that will only
                print for the cook.

                The ↳ marks them as belonging to the line above rather than
                being lines of their own — on a fifteen-line tab, a modifier
                that reads as its own item is a modifier somebody tries to
                void. */}
            {(line.instructions.length > 0 || line.note || line.serialNo || line.batchNo) && (
              /* Ink, not muted. What is ON the burger is not secondary detail —
                 it is the half of the line the kitchen acts on, and a cashier
                 checking a wrong tap before payment is reading exactly this.
                 Greying it made the one thing that has to be re-read the
                 hardest thing on the card to see. The arrow and the count stay
                 quiet so the ANSWER is what carries the weight. */
              <span className="flex flex-col gap-0.5 text-[13px] text-ink">
                {line.instructions.map((chosen, i) => (
                  <span key={i} className="flex items-start gap-1.5">
                    {/* leading-none and a nudge down: ↳ sits low on its own
                        baseline, and left alone it reads as a stray comma
                        rather than an arrow pointing at the line above. */}
                    <span aria-hidden className="mt-px shrink-0 leading-none text-faint">
                      ↳
                    </span>
                    {/* The count leads and is always shown, including at one.
                        "1 ×" and "3 ×" then start at the same column, so a
                        glance down a line's modifiers compares numbers rather
                        than hunting for the few that carry one. */}
                    <span className="numeric shrink-0 text-muted">
                      {formatQty(chosen.qty)} ×
                    </span>
                    <span className="min-w-0">{chosen.optionName}</span>
                  </span>
                ))}
                {line.note && (
                  <span className="flex items-start gap-1.5">
                    <span aria-hidden className="mt-px shrink-0 leading-none text-faint">
                      ↳
                    </span>
                    <span className="min-w-0 italic">“{line.note}”</span>
                  </span>
                )}
                {/* WHICH one is going out (234/235). In the same ↳ idiom as the
                    modifiers because it is the same kind of fact — part of what
                    this line IS, and the thing a cashier checks against the box
                    in their hand before taking payment. A wrong serial here is
                    a warranty claim months from now against a machine the
                    customer never received. */}
                {line.serialNo && (
                  <span className="flex items-start gap-1.5">
                    <span aria-hidden className="mt-px shrink-0 leading-none text-faint">
                      ↳
                    </span>
                    <span className="min-w-0 numeric">{line.serialNo}</span>
                  </span>
                )}
                {line.batchNo && (
                  <span className="flex items-start gap-1.5">
                    <span aria-hidden className="mt-px shrink-0 leading-none text-faint">
                      ↳
                    </span>
                    <span className="min-w-0">Lot {line.batchNo}</span>
                  </span>
                )}
              </span>
            )}

            {/* ── Where the line stands ────────────────────────────────────
                Its own row, below the modifiers, so the eye can run down one
                column of chips across a whole tab without reading any of the
                text beside them.

                ONLY `modified` and `new` carry colour. `unmodified` and the age
                are on every line of every basket, and a saturated pill on every
                line is what stops the two that mean something from being seen —
                the odyssey-craft rule that colour marks exceptions. The mockup
                painted all four; this keeps its shape and spends the colour
                where it buys attention. */}
            <span className="flex flex-wrap items-center gap-1.5">
              {/* Solid, because this row is read across a tab from standing
                  height — see the note on Badge's TONE_SOLID. `unmodified`
                  still resolves to neutral, so the resting state of most of a
                  basket stays grey and the two that mean something are the two
                  that carry colour. */}
              <Badge tone={SESSION_TONE[sessionState]} solid>
                {SESSION_LABEL[sessionState]}
              </Badge>
              {/* Neutral at every age. A tab does not know what "too long" is —
                  a steak and a beer disagree — so the till reports the number
                  and lets the person who knows the kitchen read it. Colouring
                  it on every line, as the mockup does, would put a saturated
                  pill on all fifteen and leave the `modified` chip beside it
                  with nothing to stand out against. */}
              <Badge tone="neutral" solid>
                {formatLineAge(ageMinutes)}
              </Badge>
            </span>
          </>
        }
        /* Four buttons on every line would put sixty targets on screen and make
           the basket unreadable; one line's worth is a decision the cashier has
           just made. */
        actions={
          <>
            <Button
              variant="success"
              size="touch"
              className="flex-1"
              onClick={() => onStep(1)}
              aria-label="One more"
            >
              <Icons.Plus size={20} />
            </Button>
            {/* `danger`, matching the mockup, and it earns the colour: − on a
                single unit REMOVES the line (see stepQty), so this key destroys
                a line as readily as Void does. */}
            <Button
              variant="danger"
              size="touch"
              className="flex-1"
              onClick={() => onStep(-1)}
              aria-label="One fewer"
            >
              <Icons.Minus size={20} />
            </Button>
            <Button variant="danger" size="touch" className="flex-[1.4]" onClick={onRemove}>
              Void
            </Button>
            {/* Everything else a line can do, behind one key. Rendered only when
                the shell offers it, so a till with no overflow shows three keys
                rather than a fourth that does nothing. */}
            {onMore && (
              <Button variant="primary" size="touch" className="flex-[1.4]" onClick={onMore}>
                More
              </Button>
            )}
          </>
        }
      />
    </li>
  )
}

/*
 * Full class strings via a lookup, never a built-up `tone={...}` expression —
 * Tailwind scans source text, so a dynamic name emits no CSS. Same rule the kit
 * follows in Badge itself.
 */
const SESSION_LABEL: Record<LineSessionState, string> = {
  unmodified: 'unmodified',
  modified: 'modified',
  new: 'new',
}

/**
 * `warning` for modified, `brand` for new, neutral for untouched.
 *
 * A modified line is the one that needs a second look — the quantity or the
 * price moved after the kitchen had already been told something — so it takes
 * the attention colour. A new line is informational: it is simply the next
 * thing to send. An unmodified line is the resting state of most of a tab and
 * says so quietly.
 */
const SESSION_TONE: Record<LineSessionState, 'neutral' | 'warning' | 'brand'> = {
  unmodified: 'neutral',
  modified: 'warning',
  new: 'brand',
}

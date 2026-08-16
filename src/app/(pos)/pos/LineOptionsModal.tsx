'use client'

import { Button, Modal, TouchRow } from '@/components/ui'
import { formatQty } from '@/lib/decimals'
import type { BasketLine } from '@/lib/basket'

/**
 * Everything a line can have done to it that is not ＋, − or Void.
 *
 * ── WHY A MENU AND NOT MORE KEYS ──────────────────────────────────────────
 *
 * The card's action row holds the four things a cashier does constantly, and
 * those have to be enormous because they are hit with a thumb while looking at a
 * customer. Everything else a line can do is occasional — a discount, a price
 * override, a note for the kitchen — and putting seven more keys on the card
 * would shrink the four that matter and make a fifteen-line basket unreadable.
 *
 * So the rare things live one tap deeper, in a list a cashier READS rather than
 * aims at. That is also why these are `TouchRow`s and not a grid of tiles: this
 * is a menu of verbs, and a verb is recognised by reading it.
 *
 * ── WHY THE FIRST THREE ARE NOT ONE "EDIT" ROW ────────────────────────────
 *
 * Line Discount, Price Override and Set new quantity are the three fields of one
 * numeric pad, and an earlier shape offered them as a single "Edit line" that
 * opened the pad on whichever tab it happened to remember. The menu names them
 * separately and each opens the pad ON ITS OWN FIELD, because a cashier arrives
 * here having already decided which one they want — and being dropped on the
 * wrong tab means reading three tabs to find the one they asked for.
 */

/** What the menu can be asked to do. The shell decides what each one means. */
export type LineOption =
  | 'discount'
  | 'price'
  | 'wastage'
  | 'message'
  | 'extras'
  | 'move'
  | 'quantity'

export function LineOptionsModal({
  line,
  onClose,
  onChoose,
}: {
  /** Null closes the dialog. */
  line: BasketLine | null
  onClose: () => void
  onChoose: (option: LineOption) => void
}) {
  if (!line) return null

  return (
    <Modal
      open
      onClose={onClose}
      title="Line options"
      /* The line is named under the title, with its quantity, because the menu
         is opened from a card that is now behind a backdrop — and a cashier who
         opened the wrong line finds out here or not until the change lands. */
      description={`${formatQty(line.qty)} × ${line.description}`}
      size="sm"
      footer={
        <Button variant="ghost" size="touch" className="flex-1 justify-center" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      {/* No icons, deliberately. Seven rows of tinted discs would be seven
          colours competing in a list where nothing is an exception — the
          odyssey-craft rule that colour marks rather than decorates — and the
          words are what is being read here anyway.

          NO SUBTITLES either, and that is a measurement rather than a taste:
          with them each row is 66px, seven rows overflow Modal's 60vh body on a
          1024×768 till, and the last two — including Set new quantity — sit
          below the fold behind a scroll nobody expects in a seven-item menu. The
          names are plain verbs that do not need explaining, so the explanation
          was the part worth losing. */}
      <div className="flex flex-col gap-2">
        {OPTIONS.map((option) => (
          <TouchRow key={option.id} title={option.title} onClick={() => onChoose(option.id)} />
        ))}
      </div>
    </Modal>
  )
}

/**
 * The menu, in the order a till uses it.
 *
 * Money first (discount, price), then the things that change what the line IS
 * (wastage, message, extras), then where it goes (move), then quantity last —
 * which is the one most likely to be reached for by mistake, since ＋ and − on
 * the card already do it for the ordinary case.
 */
const OPTIONS: { id: LineOption; title: string }[] = [
  { id: 'discount', title: 'Line Discount' },
  { id: 'price', title: 'Price Override' },
  { id: 'wastage', title: 'Wastage' },
  { id: 'message', title: 'Custom Message' },
  { id: 'extras', title: 'Generic Extras' },
  { id: 'move', title: 'Move to person' },
  { id: 'quantity', title: 'Set new quantity' },
]

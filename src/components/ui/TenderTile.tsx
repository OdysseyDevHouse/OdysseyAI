'use client'

import * as Icons from './icons'
import type { LucideIcon } from './icons'

/**
 * One payment-method key on a till's tender pad.
 *
 * A GLYPH ABOVE A NAME, not a word on a slab. A cashier taking payment is
 * reading the same six keys forty times a day, and at that point the shape is
 * what they aim at — the name is confirmation, not the target. Every key wears
 * the same brand-soft circle rather than a colour of its own: colour on this
 * screen means "how is this sale doing" (owed, settled, refused), and giving
 * Card its own hue would spend that meaning on identity.
 *
 * REFUSED, NOT HIDDEN. A tender that cannot be taken keeps its place and says
 * why underneath — "Needs a customer". A key that vanishes leaves the cashier
 * wondering whether the store has the facility at all, with a customer waiting.
 */

/**
 * The glyph for a tender row.
 *
 * `tender_types.icon` is free text a shop can edit, and the seeds wrote it in
 * two casings ('Banknote', but 'gem' and 'wallet'), so the lookup is
 * case-insensitive and falls through to the code and integration key. Anything
 * unrecognised gets the wallet rather than nothing — a shop that adds
 * "Snapscan" must still get a key with a shape on it.
 *
 * Written as a lookup of real icon references, never `Icons[name]` on a raw
 * string: that would let a stray database value reach for any export in the
 * module, and would drag the whole icon set into the bundle.
 */
const TENDER_ICON: Record<string, LucideIcon> = {
  // what the seeds store in `icon`
  banknote: Icons.Banknote,
  creditcard: Icons.CreditCard,
  users: Icons.Users,
  /* The seeds store 'Building2' on EFT, which draws an office block — a direct
     deposit is money arriving at a BANK, and the columned facade is the shape
     anyone reads as one. Mapped here rather than migrated: the stored value is
     a shop-editable preference, and rewriting their rows to change a picture is
     not this component's business. */
  building2: Icons.Landmark,
  gem: Icons.Gem,
  wallet: Icons.Wallet,
  gift: Icons.Gift,
  landmark: Icons.Landmark,
  globe: Icons.Globe,
  ticket: Icons.Ticket,
  coins: Icons.Coins,
  handcoins: Icons.HandCoins,
  contact: Icons.Contact,
  money: Icons.Money,
  // by tender code, for a row whose icon was never set
  cash: Icons.Banknote,
  card: Icons.CreditCard,
  account: Icons.Users,
  /* The bank, not the building: a direct deposit is money arriving at an
     institution, and Building2 reads as "a branch of the shop". */
  eft: Icons.Landmark,
  online: Icons.Globe,
  gift_card: Icons.Gift,
  loyalty: Icons.Gem,
  loyalty_points: Icons.Gem,
  loyalty_wallet: Icons.Wallet,
  exchange: Icons.ArrowLeftRight,
  voucher: Icons.Ticket,
}

/**
 * Resolve a tender's glyph from what the row actually carries.
 *
 * Tried in the order a shop would expect to win: the icon they chose, then the
 * code, then the integration behind it.
 */
export function tenderIcon(tender: {
  icon?: string | null
  code?: string | null
  integrationKey?: string | null
}): LucideIcon {
  const keys = [tender.icon, tender.code, tender.integrationKey]
  for (const key of keys) {
    const found = key ? TENDER_ICON[key.trim().toLowerCase()] : undefined
    if (found) return found
  }
  return Icons.Wallet
}

export function TenderTile({
  name,
  icon,
  refusal = null,
  disabled = false,
  onClick,
}: {
  name: string
  /** Usually from `tenderIcon(tender)`. */
  icon: LucideIcon
  /**
   * Why this key cannot be used, in words the cashier can act on — "Needs a
   * customer", or the credit engine's own sentence. Non-null disables the key.
   */
  refusal?: string | null
  disabled?: boolean
  onClick: () => void
}) {
  const Glyph = icon
  const off = refusal !== null

  return (
    <button
      type="button"
      disabled={disabled || off}
      onClick={onClick}
      /*
       * min-h rather than h: a credit refusal is a whole sentence — "Acme would
       * be 240.00 over their 5000.00 limit." — and a fixed height clips it.
       *
       * Not a <Button>: this is a two-line tile with a badge, and dressing the
       * kit's button up to be one at the call site is exactly the restyling the
       * design rules forbid. It lives in the kit instead, so the till and the
       * desk pad get the same key.
       */
      className="flex h-full min-h-[7.5rem] flex-col items-center justify-center gap-2 rounded-card border border-border bg-surface px-3 py-4 text-center transition-colors hover:border-border-strong hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-brand focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-border disabled:hover:bg-surface"
    >
      <span
        aria-hidden
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-pill bg-brand-soft text-brand"
      >
        <Glyph size={24} />
      </span>
      <span className="text-base font-semibold text-ink">{name}</span>
      {/* The reason sits under the name at a smaller step, so a refused key
          still reads as the same key rather than a different control. */}
      {refusal && <span className="text-xs leading-tight text-muted">{refusal}</span>}
    </button>
  )
}

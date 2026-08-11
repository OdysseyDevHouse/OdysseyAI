import type { CategoryTone } from '@/components/ui/CategoryTile'

/**
 * The drawn artwork for a quick key, and the disc it sits on.
 *
 * ── WHY ART RATHER THAN A GLYPH ───────────────────────────────────────────
 *
 * The lucide set the rest of the app draws from is one stroke weight in one colour,
 * which is right for a toolbar where twenty icons must not compete. A till is the
 * opposite problem: a cashier picks a key from a grid of twenty-odd at arm's length,
 * under time pressure, without reading the caption. Multicolour art is findable by
 * SHAPE AND HUE together, and that is worth breaking the monochrome habit for — but
 * only here, and only for keys.
 *
 * ── THE HEX IN THIS FILE IS NOT A RAW COLOUR ──────────────────────────────
 *
 * There is none. The art is 36 static `.svg` files under `public/quick-keys/`, drawn
 * with their own hard-coded fills, and this module only ever names a FILE. Nothing
 * here paints a component, so the design system's "no raw colour" rule is untouched:
 * an `<img>` pointing at a picture is the same kind of thing as a product photograph.
 *
 * What the kit does still own is the DISC behind the art. That is a `cat-*` tone, so
 * the tinted circle on a quick key and the one on a department tile are the same
 * component with the same tokens, and a theme change moves both.
 *
 * ── WHY THE TONE IS WRITTEN DOWN RATHER THAN COMPUTED ─────────────────────
 *
 * Each tone below is the art's own dominant hue, matched by eye to the nearest
 * `cat-*` token — the blue supervisor shield on soft indigo, the green cash drawer on
 * soft emerald. It could in principle be sampled from the SVG at build time, but the
 * dominant fill by AREA is often not the hue the icon reads as: `print-labels` is
 * mostly dark slate with one amber tag, and the tag is the part a cashier sees. A
 * table of 36 hand-checked entries is honest about that; a colour-counting script
 * would be confidently wrong on about a third of the set.
 */

export type QuickKeyArt = {
  /** File under `public/quick-keys/`. */
  file: string
  /** The disc tint behind it — the art's own dominant hue, as a kit token. */
  tone: CategoryTone
}

/**
 * Art by ACTION SLUG.
 *
 * Keyed on the slug rather than on the stored `icon` name so a key gets its picture
 * from what it DOES. The icon field stays what it always was — a lucide name, used by
 * the designer's picker and by any key this table does not cover — and no migration is
 * needed to light the whole till up.
 */
const ART_BY_SLUG: Readonly<Record<string, QuickKeyArt>> = {
  /* Sale-level acts */
  'void-sale': { file: 'void-sale.svg', tone: 'rose' },
  'save-sale': { file: 'save-sale.svg', tone: 'indigo' },
  'view-saved-sales': { file: 'save-sale.svg', tone: 'indigo' },
  undo: { file: 'undo.svg', tone: 'violet' },
  'global-discount': { file: 'global-discount.svg', tone: 'rose' },
  'price-change': { file: 'price-change.svg', tone: 'orange' },
  'price-enquiry': { file: 'price-enquiry.svg', tone: 'slate' },

  /* Money */
  'customer-payment': { file: 'customer-payment.svg', tone: 'amber' },
  'credit-sale': { file: 'credit-sale.svg', tone: 'violet' },
  cashup: { file: 'cashup.svg', tone: 'emerald' },
  refund: { file: 'refund.svg', tone: 'amber' },
  'cash-out': { file: 'cash-out.svg', tone: 'emerald' },
  'kick-drawer': { file: 'kick-drawer.svg', tone: 'emerald' },
  'float-topup': { file: 'float-topup.svg', tone: 'amber' },
  payout: { file: 'payout.svg', tone: 'emerald' },
  'split-tender': { file: 'split-tender.svg', tone: 'indigo' },
  'eft-transfer': { file: 'eft-transfer.svg', tone: 'violet' },

  /* Loyalty */
  'redeem-voucher': { file: 'loyalty.svg', tone: 'sky' },
  'loyalty-payment': { file: 'loyalty-payment.svg', tone: 'violet' },

  /* Paper */
  'reprint-invoice': { file: 'reprint-invoice.svg', tone: 'indigo' },
  'reprint-last-slip': { file: 'reprint-last-slip.svg', tone: 'slate' },
  'print-labels': { file: 'print-labels.svg', tone: 'slate' },
  'bill-print': { file: 'bill-print.svg', tone: 'slate' },

  /* Off-till work */
  'online-orders': { file: 'online-orders.svg', tone: 'orange' },
  'shopify-orders': { file: 'shopify-orders.svg', tone: 'emerald' },
  'clock-in-out': { file: 'end-shift.svg', tone: 'indigo' },
  'end-shift': { file: 'end-shift.svg', tone: 'indigo' },
  supervisor: { file: 'supervisor.svg', tone: 'indigo' },
  'car-wash': { file: 'car-wash.svg', tone: 'sky' },
  customers: { file: 'customers.svg', tone: 'sky' },

  /* Hospitality */
  'table-transfer': { file: 'table-transfer.svg', tone: 'indigo' },
  'split-table': { file: 'split-table.svg', tone: 'teal' },
  'add-tip': { file: 'add-tip.svg', tone: 'amber' },

  /* Orders and lay-bys reuse the parked-sale art — both are "not yet a sale". */
  'save-as-order': { file: 'save-sale.svg', tone: 'indigo' },
  'save-as-layby': { file: 'save-sale.svg', tone: 'indigo' },
}

/**
 * Art by stored ICON NAME, for the keys the slug table does not reach.
 *
 * A product or department key has no slug at all, and a shop that picked `Coins` in
 * the designer should still get the drawn coin rather than falling back to a line
 * glyph. Only names with a genuine match are listed — a near-miss picture is worse
 * than the lucide icon the manager actually chose.
 */
const ART_BY_ICON: Readonly<Record<string, QuickKeyArt>> = {
  Coins: { file: 'cash.svg', tone: 'emerald' },
  HandCoins: { file: 'customer-payment.svg', tone: 'amber' },
  Printer: { file: 'reprint-last-slip.svg', tone: 'slate' },
  Ticket: { file: 'loyalty.svg', tone: 'sky' },
  Gem: { file: 'loyalty-payment.svg', tone: 'violet' },
  Contact: { file: 'account.svg', tone: 'indigo' },
  CreditCard: { file: 'card.svg', tone: 'indigo' },
  Reverse: { file: 'undo.svg', tone: 'violet' },
  Trash: { file: 'void-sale.svg', tone: 'rose' },
  Percent: { file: 'global-discount.svg', tone: 'rose' },
  Save: { file: 'save-sale.svg', tone: 'indigo' },
  ShoppingCart: { file: 'online-orders.svg', tone: 'orange' },
  Search: { file: 'price-enquiry.svg', tone: 'slate' },
  Tag: { file: 'price-change.svg', tone: 'orange' },
  ArrowLeftRight: { file: 'table-transfer.svg', tone: 'indigo' },
}

/** Where a file under `public/quick-keys/` is served from. */
export function quickKeyArtSrc(file: string): string {
  return `/quick-keys/${file}`
}

/**
 * The art for a key, or null when nothing fits.
 *
 * Null is a real answer, not a failure: the caller falls back to the lucide glyph,
 * which is what a product key or a shop-invented group should show. Slug first, then
 * the stored icon name — an action key is the more specific match, and a shop that
 * changed a cashup key's icon still gets a picture rather than none.
 */
export function quickKeyArt(
  key: { actionSlug?: string | null; icon?: string | null } | null | undefined,
): QuickKeyArt | null {
  if (!key) return null
  const bySlug = key.actionSlug ? ART_BY_SLUG[key.actionSlug] : undefined
  if (bySlug) return bySlug
  const byIcon = key.icon ? ART_BY_ICON[key.icon] : undefined
  return byIcon ?? null
}

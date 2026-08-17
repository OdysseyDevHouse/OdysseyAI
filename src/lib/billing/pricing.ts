import { round } from '@/lib/decimals'

/**
 * What a plan costs.
 *
 * ── PURE, AND THAT IS THE POINT ─────────────────────────────────────────────
 *
 * No server import, no database access. The billing screen recomputes the total
 * live as the customer toggles modules, and the server recomputes it before
 * writing anything — and because both run THIS function over the same inputs,
 * the number the customer agreed to is the number that gets stored.
 *
 * The legacy system got this right and it is worth restating why: the client
 * posts a SELECTION, never a price. Anything that lets the browser name its own
 * amount is a discount coupon anyone can mint.
 */

/** module_key -> unit price per site per month, VAT-exclusive. */
export type PriceBook = Readonly<Record<string, number>>

/** One module held by one site. Plain data, so it crosses to the client. */
export type Holding = {
  siteId: number
  moduleKey: string
  quantity: number
  /** Set when this site pays a rate agreed at sign-up rather than today's. */
  agreedPrice: number | null
  /** Set when the module is scheduled to end; it still bills this period. */
  endsOn: string | null
}

export type PricedLine = {
  siteId: number
  moduleKey: string
  quantity: number
  unitPrice: number
  /** The rate came from `agreedPrice`, not the book. Shown as a chip. */
  grandfathered: boolean
  /** No price row at all — renders as R0 and is visibly wrong on purpose. */
  unpriced: boolean
  /** Drops out of the total at period end. */
  ending: boolean
  lineTotal: number
}

export type Quote = {
  lines: PricedLine[]
  subtotal: number
  vat: number
  total: number
  /** What it becomes once every scheduled removal has landed. */
  nextPeriodSubtotal: number
  nextPeriodTotal: number
}

/**
 * Price one line.
 *
 * Resolution order: the agreed rate, then the book, then zero.
 *
 * Zero rather than a throw for an unknown module: a missing price row must not
 * take the billing screen down, and an R0 line is visibly wrong to the person
 * looking at it in a way an exception on a blank page is not.
 */
function priceFor(holding: Holding, book: PriceBook): { unit: number; grandfathered: boolean; unpriced: boolean } {
  if (holding.agreedPrice !== null && holding.agreedPrice !== undefined) {
    return { unit: holding.agreedPrice, grandfathered: true, unpriced: false }
  }
  const booked = book[holding.moduleKey]
  if (booked === undefined) return { unit: 0, grandfathered: false, unpriced: true }
  return { unit: booked, grandfathered: false, unpriced: false }
}

/**
 * THE function. Same inputs, same output, on both sides of the wire.
 *
 * `deviceCounts` is siteId -> billable till count, priced at the book's
 * `pos_device` rate. It is passed in rather than derived because the authority
 * for that number is cp2_devices, not anything in this file.
 */
export function quoteFor(
  holdings: readonly Holding[],
  deviceCounts: Readonly<Record<number, number>>,
  book: PriceBook,
  vatPercent: number,
): Quote {
  const lines: PricedLine[] = []

  for (const h of holdings) {
    const { unit, grandfathered, unpriced } = priceFor(h, book)
    lines.push({
      siteId: h.siteId,
      moduleKey: h.moduleKey,
      quantity: h.quantity,
      unitPrice: unit,
      grandfathered,
      unpriced,
      ending: h.endsOn !== null,
      // Rounded per line, before summing. Sum-then-round diverges from the
      // client's running total by a cent on some inputs, and finding out why
      // costs an afternoon.
      lineTotal: round(unit * h.quantity),
    })
  }

  const deviceUnit = book.pos_device ?? 0
  for (const [siteIdStr, count] of Object.entries(deviceCounts)) {
    if (!count) continue
    lines.push({
      siteId: Number(siteIdStr),
      moduleKey: 'pos_device',
      quantity: count,
      unitPrice: deviceUnit,
      grandfathered: false,
      unpriced: book.pos_device === undefined,
      ending: false,
      lineTotal: round(deviceUnit * count),
    })
  }

  const subtotal = round(lines.reduce((sum, l) => sum + l.lineTotal, 0))
  const vat = round(subtotal * (vatPercent / 100))

  const nextPeriodSubtotal = round(
    lines.filter((l) => !l.ending).reduce((sum, l) => sum + l.lineTotal, 0),
  )

  return {
    lines,
    subtotal,
    vat,
    total: round(subtotal + vat),
    nextPeriodSubtotal,
    nextPeriodTotal: round(nextPeriodSubtotal + nextPeriodSubtotal * (vatPercent / 100)),
  }
}

/**
 * What a pending set of changes would cost, for the confirm dialog.
 *
 * Takes the current holdings and the modules the customer has just toggled, and
 * returns the delta each way. The two numbers are deliberately separate: an
 * upgrade bills from today and a downgrade only at period end, so presenting
 * them as one net figure would misstate what is about to happen on the card.
 */
export function changePreview(
  holdings: readonly Holding[],
  adding: readonly { siteId: number; moduleKey: string }[],
  removing: readonly { siteId: number; moduleKey: string }[],
  book: PriceBook,
): { addedMonthly: number; removedMonthly: number } {
  const rateFor = (siteId: number, moduleKey: string): number => {
    // A module being re-added keeps whatever rate that site already agreed.
    const existing = holdings.find((h) => h.siteId === siteId && h.moduleKey === moduleKey)
    if (existing?.agreedPrice != null) return existing.agreedPrice
    return book[moduleKey] ?? 0
  }

  const addedMonthly = round(adding.reduce((sum, a) => sum + rateFor(a.siteId, a.moduleKey), 0))
  const removedMonthly = round(
    removing.reduce((sum, r) => sum + rateFor(r.siteId, r.moduleKey), 0),
  )
  return { addedMonthly, removedMonthly }
}

import 'server-only'
import { siteQuery } from '../siteDb'
import { liveSpecials } from './specials'
import { specialActiveAt, type Special } from '../specialsEngine'
import { primaryImages } from './productImages'

/**
 * The "specials of the day" the till's sign-in screen cycles through.
 *
 * ── WHY THIS IS NOT SIMPLY `liveSpecials()` ───────────────────────────────
 *
 * A `Special` is a PRICING RULE, and there are thirteen shapes of them. Most
 * have no single number a customer could read off a screen: "buy two get the
 * cheapest free" and "spend R500, get R50" are conditions on a whole basket,
 * not a price on a thing.
 *
 * This screen is a menu board. A menu board can only say "this item, that
 * price" — so only the two shapes that ARE that are shown:
 *
 *   special_price   the product is marked down to a stated figure
 *   happy_hour      a percentage off the shelf price, inside a time band
 *
 * Every other shape is skipped rather than rendered with a missing or invented
 * price. A board that says "Chicken Wings — R0.00" because the promotion was a
 * buy-two-get-one is worse than a board that does not mention chicken wings:
 * the customer can read it from across the room and will ask about it at the
 * counter, and the cashier will have to explain that the screen is wrong.
 *
 * ── AND WHY THE WINDOW IS RE-CHECKED HERE ─────────────────────────────────
 *
 * `liveSpecials` filters on the END date and the redemption cap, which is the
 * right question for the till's catalogue — it ships promotions WHOLE and lets
 * each till evaluate the daily band against its own clock. This screen is
 * rendered by the server for one moment, so it applies `specialActiveAt` as
 * well: a happy hour that runs 17:00–19:00 must not be on the board at ten in
 * the morning, and it is the one place a customer is reading the offer rather
 * than the till applying it.
 */

export type SignInSpecial = {
  /** The product, so the panel can key on something stable. */
  productId: number
  /** What it is called on the shelf. */
  description: string
  /**
   * The shop's own marketing line, where there is one.
   *
   * Falls back to the SPECIAL's name — "Lunch deal", "Happy hour" — which is
   * written by a person and reads better on a board than a product code does.
   * Empty is fine and the panel simply shows nothing.
   */
  blurb: string
  /** VAT-inclusive, what the customer pays under the promotion. */
  priceIncl: number
  /**
   * The ordinary shelf price, when it is genuinely higher.
   *
   * Null where the promotion does not actually save anything — a marked-down
   * price equal to or above the shelf price is a mis-configured special, and
   * striking through a number that is not bigger reads as a mistake by us
   * rather than by the shop.
   */
  wasIncl: number | null
  /**
   * The primary product photo's id, or null. The panel turns this into a URL
   * for /api/pos/special-image; it is never a path, for the reason
   * TillProduct.imageIcon gives — a baked URL goes stale when the route moves.
   */
  imageId: number | null
}

/** The shapes that state one price for one product. See the docblock. */
const BOARD_SHAPES = new Set(['special_price', 'happy_hour'])

/**
 * How many make it onto the board.
 *
 * The panel cycles, so this is not "what fits on screen" — it is how long the
 * loop may get before a customer waiting to be served sees the same item twice.
 * A shop running more promotions than this has a board that never repeats
 * within one queue, which is all the cycling has to achieve.
 */
const MAX_ON_BOARD = 8

/* Money, to the cent. A happy hour's percentage lands on fractions of a cent
   and a board showing R71.9999 would be our arithmetic on display. */
const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * The board, ready to render.
 *
 * Empty is an ordinary answer — most shops run no price-shaped specials at all,
 * and the panel simply omits the section rather than showing an empty card.
 */
export async function signInSpecials(siteId: number, now: Date): Promise<SignInSpecial[]> {
  let specials: Special[]
  try {
    specials = await liveSpecials(siteId)
  } catch {
    /* A shop that has not run the specials migrations still has to be able to
       sign in. The board is decoration on a screen whose actual job is a PIN
       pad, so it fails to nothing rather than taking the gate down with it. */
    return []
  }

  const onBoard = specials.filter(
    (s) => BOARD_SHAPES.has(s.shape) && specialActiveAt(s, now),
  )
  if (onBoard.length === 0) return []

  /*
   * Which PRODUCTS each promotion names, and how it prices them.
   *
   * Both board shapes carry their products in `scope` rows — see ROLES_USED in
   * the engine. The two price them differently, and getting that wrong is how a
   * board ends up advertising a figure the till will not charge:
   *
   *   special_price   the scope row's own `priceIncl` — an absolute figure
   *   happy_hour      `discountPct` off the SHELF price — no figure of its own
   *
   * A happy hour with an EMPTY scope is a store-wide sale. It is skipped rather
   * than expanded: "everything is 10% off" is not a list of three items, and
   * putting the first three products of the file on a board would misrepresent
   * it as a selection somebody made.
   */
  type Claim = { blurb: string; priceIncl: number | null; discountPct: number }
  const claims = new Map<number, Claim[]>()
  for (const special of onBoard) {
    const scope = special.items.filter((i) => i.role === 'scope' && i.productId !== null)
    /* Product-scoped rows only. A special attached to a whole DEPARTMENT has no
       single product to name or photograph, and expanding it would put a
       hundred rows on a board that shows eight. */
    if (scope.length === 0) continue

    for (const item of scope) {
      const productId = item.productId as number
      const claim: Claim =
        special.shape === 'special_price'
          ? { blurb: special.name, priceIncl: Number(item.priceIncl) || 0, discountPct: 0 }
          : { blurb: special.name, priceIncl: null, discountPct: Number(special.discountPct) || 0 }

      /* A marked-down price of zero, or a happy hour of nought percent, is a
         half-configured promotion rather than a free item. Neither belongs on a
         board customers read. */
      if (claim.priceIncl !== null && claim.priceIncl <= 0) continue
      if (claim.priceIncl === null && claim.discountPct <= 0) continue

      const list = claims.get(productId)
      if (list) list.push(claim)
      else claims.set(productId, [claim])
    }
  }
  if (claims.size === 0) return []

  const productIds = [...claims.keys()]
  const placeholders = productIds.map(() => '?').join(',')

  /*
   * The products themselves, filtered to what the till may actually sell — the
   * same rule browseForTill applies. An archived product still attached to a
   * live special would otherwise be advertised on a screen facing the shop
   * floor for something nobody can ring up.
   */
  const rows = await siteQuery<{
    id: number
    description: string
    extra_description: string | null
    price_incl: number | null
  }>(
    siteId,
    /* The DEFAULT structure's price — the shelf figure a customer compares
       against. Lowest structure id rather than a join to the default flag: a
       "was" price taken from a trade tariff would overstate the saving on a
       screen customers read. */
    `SELECT p.id, p.description, p.extra_description,
            (SELECT pp.selling_price_incl
               FROM product_prices pp
              WHERE pp.product_id = p.id
              ORDER BY pp.price_structure_id
              LIMIT 1) AS price_incl
       FROM products p
      WHERE p.id IN (${placeholders})
        AND p.is_archived = 0
        AND p.visible_in_pos = 1
        AND p.has_variants = 0`,
    productIds,
  ).catch(() => [])

  const images = await primaryImages(
    siteId,
    rows.map((r) => Number(r.id)),
  ).catch(() => new Map())

  const board: SignInSpecial[] = []
  for (const row of rows) {
    const productId = Number(row.id)
    const list = claims.get(productId)
    if (!list || list.length === 0) continue

    const shelf = Number(row.price_incl ?? 0)

    /*
     * Each claim resolved to a figure, then the LOWEST wins.
     *
     * A product can sit under two live promotions, and the board would
     * otherwise list it twice at two prices — which reads as a bug to a
     * customer and is an argument at the counter. The cheapest is the one the
     * shopper will hold us to, so it is the one advertised.
     *
     * A percentage claim needs the shelf price to become a number at all, so a
     * happy hour on a product with no price on file resolves to nothing and
     * drops out rather than showing R0.00.
     */
    let bestPrice: number | null = null
    let bestBlurb = ''
    for (const claim of list) {
      const price =
        claim.priceIncl !== null
          ? claim.priceIncl
          : shelf > 0
            ? round2(shelf * (1 - claim.discountPct / 100))
            : null
      if (price === null || price <= 0) continue
      if (bestPrice === null || price < bestPrice) {
        bestPrice = price
        bestBlurb = claim.blurb
      }
    }
    if (bestPrice === null) continue

    board.push({
      productId,
      description: String(row.description ?? ''),
      /* The shop's extra description where it wrote one — the customer-facing
         wording, which is exactly what a board wants — then the promotion's own
         name, which a person also wrote. Never the product code. */
      blurb: String(row.extra_description ?? '').trim() || bestBlurb,
      priceIncl: bestPrice,
      wasIncl: shelf > bestPrice ? shelf : null,
      imageId: images.get(productId)?.id ?? null,
    })
  }

  /* Biggest saving first, so the best offer is the one on screen when somebody
     glances up. A special with no comparable shelf price sorts last rather than
     being dropped — it is still a real offer, just not a provable saving. */
  board.sort((a, b) => {
    const sa = a.wasIncl === null ? -1 : a.wasIncl - a.priceIncl
    const sb = b.wasIncl === null ? -1 : b.wasIncl - b.priceIncl
    return sb - sa
  })
  return board.slice(0, MAX_ON_BOARD)
}

/**
 * Whether this product is currently advertised on the sign-in board.
 *
 * The gate for /api/pos/special-image, and the reason that route cannot be
 * walked to read the shop's whole image library: the product id in the URL is
 * checked against the board before a single byte is read, so the only pictures
 * reachable are the ones already on a screen facing the shop floor.
 */
export async function isOnSignInBoard(
  siteId: number,
  productId: number,
  now: Date,
): Promise<boolean> {
  const board = await signInSpecials(siteId, now)
  return board.some((s) => s.productId === productId)
}

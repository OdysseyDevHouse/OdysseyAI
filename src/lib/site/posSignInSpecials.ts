import 'server-only'
import { siteQuery } from '../siteDb'
import { liveSpecials } from './specials'
import { specialActiveAt, describeDeal, type Special } from '../specialsEngine'
import { formatMoney } from '../decimals'
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
 * So the board carries TWO kinds of row, and which one a promotion gets is
 * decided by whether it can name a price for a thing:
 *
 *   'price'   special_price and happy_hour — the product marked down to a
 *             stated figure, or a percentage off its shelf price. Photograph,
 *             name, and the number the customer will pay.
 *
 *   'offer'   everything else. The promotion's own name and what it gives, in
 *             words: "Combo test — Buy 2, cheapest at 10% off". No price, no
 *             photograph, because there is no one product and no one figure.
 *
 * An invented price is still forbidden. A board that says "Chicken Wings —
 * R0.00" because the promotion was a buy-two-get-one is worse than one that
 * does not mention chicken wings: the customer reads it from across the room,
 * asks at the counter, and the cashier has to explain that the screen is wrong.
 * Saying the deal in words tells the same truth without a number to be held to.
 *
 * ── AND WHY 'OFFER' ROWS EXIST AT ALL ─────────────────────────────────────
 *
 * Because silence was the worse failure. A shop running nothing but combo deals
 * — which is most shops that run promotions at all — had a live promotion, an
 * empty showcase, and no way to tell from the screen that the two were related.
 * A named offer with no price is honest; a blank panel is not.
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

/**
 * A row that names a product and what it costs today.
 *
 * The board's original and still its best row: a customer can read it from
 * across the room and act on it without asking anybody anything.
 */
export type SignInPriceRow = {
  kind: 'price'
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

/**
 * A row that names a DEAL, because there is no single price to name.
 *
 * Deliberately carries no image id. The promotion covers several products or a
 * whole department, so any one photograph would be a claim about which item the
 * offer is really about — and the customer would pick that one.
 */
export type SignInOfferRow = {
  kind: 'offer'
  /** The promotion, so the panel can key on something stable. */
  specialId: number
  /** The shop's own name for it — "Combo test", "Lunch deal". */
  description: string
  /** What it gives, in words. See `describeDeal`. */
  blurb: string
  /**
   * Where it applies, when that can be said briefly — "On Beverages, Snacks".
   * Empty for a store-wide deal, and for one covering more departments than fit
   * on a line, where naming some and not others would mislead.
   */
  appliesTo: string
}

export type SignInSpecial = SignInPriceRow | SignInOfferRow

/** The shapes that state one price for one product. See the docblock. */
const PRICED_SHAPES = new Set(['special_price', 'happy_hour'])

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

  /* Everything running RIGHT NOW, whatever its shape. `liveSpecials` filters on
     the end date and the redemption cap; `specialActiveAt` adds the daily band
     and the weekday, which is the question a customer reading the board is
     actually asking. */
  const live = specials.filter((s) => specialActiveAt(s, now))
  if (live.length === 0) return []

  const onBoard = live.filter((s) => PRICED_SHAPES.has(s.shape))

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
  type Claim = {
    /* WHICH promotion, so a special that has actually made it onto the board as
       a priced row is not then also announced in words below. */
    specialId: number
    blurb: string
    priceIncl: number | null
    discountPct: number
  }
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
          ? {
              specialId: special.id,
              blurb: special.name,
              priceIncl: Number(item.priceIncl) || 0,
              discountPct: 0,
            }
          : {
              specialId: special.id,
              blurb: special.name,
              priceIncl: null,
              discountPct: Number(special.discountPct) || 0,
            }

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
  const productIds = [...claims.keys()]
  const placeholders = productIds.map(() => '?').join(',')

  /*
   * The products themselves, filtered to what the till may actually sell — the
   * same rule browseForTill applies. An archived product still attached to a
   * live special would otherwise be advertised on a screen facing the shop
   * floor for something nobody can ring up.
   */
  const rows = productIds.length
    ? await siteQuery<{
        id: number
        description: string
        extra_description: string | null
        price_incl: number | null
      }>(
          siteId,
          /* The DEFAULT structure's price — the shelf figure a customer compares
             against. Lowest structure id rather than a join to the default flag:
             a "was" price taken from a trade tariff would overstate the saving on
             a screen customers read. */
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
      : /* No priced promotion at all is now an ordinary case rather than the end
           of the function — a shop running only combo deals lands here and its
           board is built entirely from offer rows below. Guarded because an
           empty id list renders `IN ()`, which is a syntax error rather than an
           empty result. */
        []

  const images = rows.length
    ? await primaryImages(
        siteId,
        rows.map((r) => Number(r.id)),
      ).catch(() => new Map())
    : new Map()

  const priced: SignInPriceRow[] = []
  /* Which promotions actually reached the board with a price on them. Anything
     not in here is said in words below, INCLUDING a special_price whose products
     all turned out to be archived — the promotion is running either way, and a
     board that mentions it neither by price nor by name is the silence this
     second row type exists to end. */
  const pricedSpecialIds = new Set<number>()
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
    let bestSpecialId: number | null = null
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
        bestSpecialId = claim.specialId
      }
    }
    if (bestPrice === null) continue
    if (bestSpecialId !== null) pricedSpecialIds.add(bestSpecialId)

    priced.push({
      kind: 'price',
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
  priced.sort((a, b) => {
    const sa = a.wasIncl === null ? -1 : a.wasIncl - a.priceIncl
    const sb = b.wasIncl === null ? -1 : b.wasIncl - b.priceIncl
    return sb - sa
  })

  /*
   * Everything still running that the priced pass could not put a number on.
   *
   * Ordered by the shop's OWN priority, not by anything we can measure. There is
   * no saving to compare across a bundle price, a spend-and-get and a mix-and-
   * match, so ranking them would be inventing an opinion — while the order a
   * manager dragged the list into is a real one, and is already the order the
   * till fires them in.
   */
  const unpriced = live
    .filter((x) => !pricedSpecialIds.has(x.id))
    .sort((a, b) => a.priority - b.priority)

  const offers = unpriced.length
    ? await offerRows(siteId, unpriced.slice(0, MAX_ON_BOARD)).catch(() => [])
    : []

  /* Priced rows FIRST, always. A row a customer can act on without asking
     anybody beats one that needs a conversation at the counter, however good the
     deal behind it is. The cycle reaches the offers on its next page. */
  return [...priced, ...offers].slice(0, MAX_ON_BOARD)
}

/**
 * The promotions that have no price to show, said in words.
 *
 * Two queries for the whole batch rather than a pair per special: this runs on
 * the render path of the screen a cashier is waiting on at 07:00, and sixteen
 * round trips to name eight deals is sixteen round trips nobody is served
 * during.
 */
async function offerRows(siteId: number, specials: Special[]): Promise<SignInOfferRow[]> {
  const departmentIds = [
    ...new Set(
      specials.flatMap((s) =>
        s.items.map((i) => i.departmentId).filter((id): id is number => id !== null),
      ),
    ),
  ]
  const productIds = [
    ...new Set(
      specials.flatMap((s) =>
        s.items.map((i) => i.productId).filter((id): id is number => id !== null),
      ),
    ),
  ]

  const [departments, products] = await Promise.all([
    departmentIds.length
      ? siteQuery<{ id: number; name: string }>(
          siteId,
          `SELECT id, name FROM departments WHERE id IN (${departmentIds.map(() => '?').join(',')})`,
          departmentIds,
        ).catch(() => [])
      : Promise.resolve([]),
    productIds.length
      ? siteQuery<{ id: number; description: string }>(
          siteId,
          /* The same sellability rule the priced pass applies. A deal whose
             products are all archived still gets its row — it is running either
             way — but it must not NAME something nobody can ring up. */
          `SELECT id, description FROM products
            WHERE id IN (${productIds.map(() => '?').join(',')})
              AND is_archived = 0 AND visible_in_pos = 1`,
          productIds,
        ).catch(() => [])
      : Promise.resolve([]),
  ])

  const departmentName = new Map(departments.map((d) => [Number(d.id), String(d.name ?? '')]))
  const productName = new Map(products.map((r) => [Number(r.id), String(r.description ?? '')]))

  /*
   * How a role is NAMED on a customer-facing board.
   *
   * The back office counts ("2 products") because a manager is auditing what is
   * running. Here the names are the whole point — "Buy 2 Cappuccinos" is an
   * offer, "Buy 2 products" is a riddle. `describeDeal` owns the arithmetic the
   * two screens share; this is the half that differs.
   *
   * Falls back to the count past three names, deliberately. A deal spanning six
   * departments listed in full wraps the row to four lines, and naming two of
   * the six would be a claim the promotion does not make.
   */
  const name = (items: Special['items']) => {
    const names = items
      .map((i) =>
        i.productId !== null
          ? productName.get(i.productId)
          : i.departmentId !== null
            ? departmentName.get(i.departmentId)
            : undefined,
      )
      .filter((n): n is string => !!n && n.trim() !== '')
    if (names.length === 0 || names.length > 3) {
      return items.length === 1 ? '1 item' : `${items.length} items`
    }
    return names.join(', ')
  }
  const role = (s: Special, r: 'scope' | 'trigger' | 'reward') =>
    name(s.items.filter((i) => i.role === r))

  return specials.map((s) => ({
    kind: 'offer' as const,
    specialId: s.id,
    description: s.name,
    blurb: describeDeal(s, {
      money: formatMoney,
      scope: (x) => role(x, 'scope'),
      trigger: (x) => role(x, 'trigger'),
      reward: (x) => role(x, 'reward'),
    }),
    appliesTo: departmentsLine(s, departmentName),
  }))
}

/**
 * "On Beverages, Snacks", or ''.
 *
 * DEPARTMENTS only. A product-scoped deal has already named its products in the
 * deal line above, and saying them again is the row talking to itself. A deal on
 * departments cannot name them there — `describeDeal` would have to say "Buy 2
 * Beverages", which is not what anybody buys — so this is where they land.
 */
function departmentsLine(s: Special, names: Map<number, string>): string {
  const departments = [
    ...new Set(s.items.map((i) => i.departmentId).filter((id): id is number => id !== null)),
  ]
    .map((id) => names.get(id))
    .filter((n): n is string => !!n && n.trim() !== '')

  if (departments.length === 0 || departments.length > 3) return ''
  return `On ${departments.join(', ')}`
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
  /* PRICED rows only, which is the whole set that has a picture. An offer row
     carries no image id by design — see SignInOfferRow — so widening this to
     match one would open the route to a product the board never photographs. */
  return board.some((s) => s.kind === 'price' && s.productId === productId)
}

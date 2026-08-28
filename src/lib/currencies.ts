/**
 * The currencies a shop can count a drawer in.
 *
 * ── WHY A LIST AND NOT A FREE-FORM BUILDER ──────────────────────────────────
 *
 * The open question on this was whether a shop picks a currency from a list
 * with denominations attached, or types its own denominations from scratch. It
 * is both, in that order, and the order is the point:
 *
 *   PICKING a currency fills the grid with the right rows in one act. That is
 *   what a shop actually wants — nobody opening a till in Windhoek wants to
 *   type "N$200, N$100, N$50…" and get the coin/note split right by hand.
 *
 *   EDITING is still possible afterwards, because the table is a table: rows
 *   can be added, renamed, deactivated. A country that demonetises a coin, or a
 *   shop that never sees the 5c, is a tick rather than a support call — the
 *   reasoning 168 already gave for making this a table at all.
 *
 * So the list is a STARTING POINT, not a constraint. What it buys is that the
 * common case is one click and the uncommon case is still possible.
 *
 * ── WHY THE SETS ARE HERE AND NOT IN THE DATABASE ───────────────────────────
 *
 * Because they are facts about the world, not about a shop. What coins Canada
 * mints is not something a customer configures, and putting it in a table would
 * mean every new site seeded with eight currencies it will never use — or,
 * worse, one site's edit to "the CAD set" silently becoming everyone's.
 *
 * A shop's OWN denominations are rows in `cash_denominations`. This is only the
 * template they are copied from.
 *
 * ── NO EXCHANGE RATES, DELIBERATELY ─────────────────────────────────────────
 *
 * This says what money looks like, never what it is worth. A shop trades in one
 * currency; it does not convert. The moment a rate appears here somebody will
 * expect an invoice to be converted, and that is a different feature with a
 * different failure mode — a wrong rate silently misprices a document.
 */

/** One physical piece of money. `value` is in major units, as the column is. */
export type DenominationSpec = {
  label: string
  value: number
  isNote: boolean
}

export type CurrencySpec = {
  /** ISO 4217. The stable handle — a set is matched on this, never on a name. */
  code: string
  /** What a person reads against a number: "R", "$", "P". */
  symbol: string
  /** For the picker. The country, because that is how somebody chooses. */
  name: string
  /**
   * Largest first, which is the order a person counts in.
   *
   * `isNote` is not decoration: notes and coins are counted in separate piles,
   * and a grid that interleaves them reads as an error to whoever is counting.
   * See 168, which made the same point about the seeded rand rows.
   */
  denominations: DenominationSpec[]
}

/**
 * The sets, largest denomination first.
 *
 * Deliberately short. These are the countries the product is actually sold in
 * today plus the two most likely next — an exhaustive ISO list would be a
 * hundred sets nobody has checked, and a WRONG denomination set is worse than
 * an absent one because a cashier counts into it without questioning it.
 *
 * Adding a country is this file plus nothing else.
 */
export const CURRENCIES: CurrencySpec[] = [
  {
    code: 'ZAR',
    symbol: 'R',
    name: 'South African rand',
    denominations: [
      { label: 'R200', value: 200, isNote: true },
      { label: 'R100', value: 100, isNote: true },
      { label: 'R50', value: 50, isNote: true },
      { label: 'R20', value: 20, isNote: true },
      { label: 'R10', value: 10, isNote: true },
      { label: 'R5', value: 5, isNote: false },
      { label: 'R2', value: 2, isNote: false },
      { label: 'R1', value: 1, isNote: false },
      { label: '50c', value: 0.5, isNote: false },
      { label: '20c', value: 0.2, isNote: false },
      { label: '10c', value: 0.1, isNote: false },
    ],
  },
  {
    code: 'NAD',
    symbol: 'N$',
    name: 'Namibian dollar',
    denominations: [
      { label: 'N$200', value: 200, isNote: true },
      { label: 'N$100', value: 100, isNote: true },
      { label: 'N$50', value: 50, isNote: true },
      { label: 'N$20', value: 20, isNote: true },
      { label: 'N$10', value: 10, isNote: true },
      { label: 'N$5', value: 5, isNote: false },
      { label: 'N$1', value: 1, isNote: false },
      { label: '50c', value: 0.5, isNote: false },
      { label: '10c', value: 0.1, isNote: false },
      { label: '5c', value: 0.05, isNote: false },
    ],
  },
  {
    code: 'BWP',
    symbol: 'P',
    name: 'Botswana pula',
    denominations: [
      { label: 'P200', value: 200, isNote: true },
      { label: 'P100', value: 100, isNote: true },
      { label: 'P50', value: 50, isNote: true },
      { label: 'P20', value: 20, isNote: true },
      { label: 'P10', value: 10, isNote: true },
      { label: 'P5', value: 5, isNote: false },
      { label: 'P2', value: 2, isNote: false },
      { label: 'P1', value: 1, isNote: false },
      { label: '50t', value: 0.5, isNote: false },
      { label: '25t', value: 0.25, isNote: false },
      { label: '10t', value: 0.1, isNote: false },
      { label: '5t', value: 0.05, isNote: false },
    ],
  },
  {
    /*
     * Canada abolished the penny in 2013 and rounds cash to the nearest 5c, so
     * there is no 1c row — a grid offering one would have a cashier hunting for
     * coins that are not in circulation. The $1 and $2 are coins (the loonie
     * and the toonie), which is the kind of detail that makes a hand-typed set
     * wrong: they sort with the notes by value and are counted with the coins.
     */
    code: 'CAD',
    symbol: '$',
    name: 'Canadian dollar',
    denominations: [
      { label: '$100', value: 100, isNote: true },
      { label: '$50', value: 50, isNote: true },
      { label: '$20', value: 20, isNote: true },
      { label: '$10', value: 10, isNote: true },
      { label: '$5', value: 5, isNote: true },
      { label: '$2', value: 2, isNote: false },
      { label: '$1', value: 1, isNote: false },
      { label: '25c', value: 0.25, isNote: false },
      { label: '10c', value: 0.1, isNote: false },
      { label: '5c', value: 0.05, isNote: false },
    ],
  },
  {
    code: 'USD',
    symbol: '$',
    name: 'United States dollar',
    denominations: [
      { label: '$100', value: 100, isNote: true },
      { label: '$50', value: 50, isNote: true },
      { label: '$20', value: 20, isNote: true },
      { label: '$10', value: 10, isNote: true },
      { label: '$5', value: 5, isNote: true },
      { label: '$1', value: 1, isNote: true },
      { label: '25c', value: 0.25, isNote: false },
      { label: '10c', value: 0.1, isNote: false },
      { label: '5c', value: 0.05, isNote: false },
      { label: '1c', value: 0.01, isNote: false },
    ],
  },
  {
    code: 'GBP',
    symbol: '£',
    name: 'Pound sterling',
    denominations: [
      { label: '£50', value: 50, isNote: true },
      { label: '£20', value: 20, isNote: true },
      { label: '£10', value: 10, isNote: true },
      { label: '£5', value: 5, isNote: true },
      { label: '£2', value: 2, isNote: false },
      { label: '£1', value: 1, isNote: false },
      { label: '50p', value: 0.5, isNote: false },
      { label: '20p', value: 0.2, isNote: false },
      { label: '10p', value: 0.1, isNote: false },
      { label: '5p', value: 0.05, isNote: false },
      { label: '2p', value: 0.02, isNote: false },
      { label: '1p', value: 0.01, isNote: false },
    ],
  },
  {
    code: 'EUR',
    symbol: '€',
    name: 'Euro',
    denominations: [
      { label: '€200', value: 200, isNote: true },
      { label: '€100', value: 100, isNote: true },
      { label: '€50', value: 50, isNote: true },
      { label: '€20', value: 20, isNote: true },
      { label: '€10', value: 10, isNote: true },
      { label: '€5', value: 5, isNote: true },
      { label: '€2', value: 2, isNote: false },
      { label: '€1', value: 1, isNote: false },
      { label: '50c', value: 0.5, isNote: false },
      { label: '20c', value: 0.2, isNote: false },
      { label: '10c', value: 0.1, isNote: false },
      { label: '5c', value: 0.05, isNote: false },
    ],
  },
  {
    code: 'AUD',
    symbol: '$',
    name: 'Australian dollar',
    denominations: [
      { label: '$100', value: 100, isNote: true },
      { label: '$50', value: 50, isNote: true },
      { label: '$20', value: 20, isNote: true },
      { label: '$10', value: 10, isNote: true },
      { label: '$5', value: 5, isNote: true },
      { label: '$2', value: 2, isNote: false },
      { label: '$1', value: 1, isNote: false },
      { label: '50c', value: 0.5, isNote: false },
      { label: '20c', value: 0.2, isNote: false },
      { label: '10c', value: 0.1, isNote: false },
      { label: '5c', value: 0.05, isNote: false },
    ],
  },
]

/** The set for a code, or null when nothing matches. */
export function currencyFor(code: string): CurrencySpec | null {
  const wanted = code.trim().toUpperCase()
  return CURRENCIES.find((c) => c.code === wanted) ?? null
}

/**
 * The symbol for a code, falling back to the code itself.
 *
 * The code rather than a guess: a shop on a currency this file does not know
 * gets "BRL 50.00", which is unlovely and unambiguous. Inventing a symbol would
 * be neither.
 */
export function symbolFor(code: string): string {
  return currencyFor(code)?.symbol ?? code.trim().toUpperCase()
}

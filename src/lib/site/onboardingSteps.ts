/**
 * The wizard's step list — the PURE half, importable from the browser.
 *
 * ── WHY THIS IS NOT IN onboarding.ts ────────────────────────────────────────
 *
 * That module is `server-only` and reads the settings table, so importing it
 * from a client component pulls the whole database stack into the browser
 * bundle — which is a BUILD error, not a runtime one, and it takes the route
 * down rather than degrading.
 *
 * The step list itself is data: names, blurbs and hrefs, with nothing to read
 * and nothing to protect. The wizard renders it in the browser and the server
 * half keys its progress off the same `StepKey`, so it has to be reachable from
 * both — and the only way to have that safely is a plain module neither side
 * has to apologise for.
 *
 * Same split, for the same reason, as `filterConditions.ts` beside the UI kit.
 */

/**
 * A step's key. Stored in `onboarding_done_steps`, so these strings are
 * effectively a schema — renaming one silently un-completes it for every shop
 * that had finished it. Add rather than rename.
 */
export type StepKey =
  | 'store'
  | 'money'
  | 'tax'
  | 'pricing'
  | 'costing'
  | 'decimals'
  | 'numbering'
  | 'locations'
  | 'tenders'
  | 'people'
  | 'catalogue'

export type OnboardingStep = {
  key: StepKey
  /** The heading on the step itself. */
  title: string
  /** The one line under it — what this decides, in the user's terms. */
  blurb: string
  /** The short label in the rail down the side. */
  short: string
  /**
   * Why it is worth answering now rather than later. Shown as the step's
   * footnote, and it is the whole argument for the wizard existing: a person
   * who knows WHY a question is being asked answers it better than one being
   * marched through a form.
   */
  why: string
  /** Where this lives permanently, for "change this later under …". */
  href: string
  /**
   * True when skipping it costs nothing that cannot be undone cheaply later.
   * The four the wizard leads with are the ones that get baked into documents
   * and stock values, and they are ordered first for that reason.
   */
  cheapToChangeLater: boolean
}

/**
 * The steps, in the order they are asked.
 *
 * ── THE ORDER IS AN ARGUMENT, NOT A LIST ────────────────────────────────────
 *
 * Identity first, because it is the one a person can answer without deciding
 * anything — it warms them up and it is what appears on every document.
 *
 * Then the four that are genuinely expensive to change once trading has
 * started: the tax rates that get stamped onto every historical document, the
 * price tiers that products are captured against, and the costing basis that
 * decides what every unit of stock is deemed to have cost. Changing any of
 * those after six months does not rewrite history — it leaves a shop with two
 * eras of data that do not compare.
 *
 * The rest are conveniences with cheap defaults, and they come last so that a
 * person who abandons the wizard half-way has still answered the ones that
 * matter.
 */
export const STEPS: readonly OnboardingStep[] = [
  {
    key: 'store',
    title: 'Your store',
    short: 'Store',
    blurb: 'The name, address and logo that appear on every invoice you issue.',
    why: 'This prints at the top of every document a customer receives, so it is worth getting right before you issue the first one.',
    href: '/setup/store-info',
    cheapToChangeLater: true,
  },
  {
    key: 'money',
    title: 'Money and tax wording',
    short: 'Money',
    blurb: 'The currency you trade in, and what your country calls its sales tax.',
    why: 'A slip headed "VAT" in a country that charges GST names a tax that does not exist there.',
    href: '/setup/store-info',
    cheapToChangeLater: true,
  },
  {
    key: 'tax',
    title: 'Tax rates',
    short: 'Tax rates',
    blurb: 'The rates a product can be sold at, and which one is used by default.',
    why: 'Every document you issue stores the rate it was taxed at. Correcting a rate later does not correct the documents already printed against it.',
    href: '/setup/pricing',
    cheapToChangeLater: false,
  },
  {
    key: 'pricing',
    title: 'Price types',
    short: 'Price types',
    blurb: 'The price tiers a product carries — retail, wholesale, staff.',
    why: 'Products are captured against these tiers. Adding one after a thousand products are loaded means pricing a thousand products again.',
    href: '/setup/pricing',
    cheapToChangeLater: false,
  },
  {
    key: 'costing',
    title: 'How stock is costed',
    short: 'Costing',
    blurb: 'Whether a unit of stock is valued at its average cost or its last cost.',
    why: 'This decides what every sale reports as profit. Switching it later leaves you with two periods of margin figures that cannot be compared.',
    /* Moved out of /setup with the screen itself, to /settings → "Purchasing
       and cost". This is the "change this later under …" reference rather than
       a wizard destination, so the shell's own route is the right target: it
       names the tab in the rail, which is how somebody finds it again. */
    href: '/settings',
    cheapToChangeLater: false,
  },
  {
    key: 'decimals',
    title: 'Decimal places',
    short: 'Decimals',
    blurb: 'How precisely quantities and costs are shown on screen.',
    why: 'Display only — nothing stored changes, so this one is safe to revisit whenever it starts to annoy you.',
    /* Moved out of /setup with the screen. This is the "change this later
       under …" reference rather than a wizard destination, and the tab is named
       in the settings rail, which is how somebody finds it again. */
    href: '/settings?tab=decimals',
    cheapToChangeLater: true,
  },
  {
    key: 'numbering',
    title: 'Document numbers',
    short: 'Numbering',
    blurb: 'What your first invoice, quote and order are numbered.',
    why: 'Worth setting now if you are moving from another system and want your numbering to carry on rather than restart at 1.',
    href: '/setup/numbering',
    cheapToChangeLater: false,
  },
  {
    key: 'locations',
    title: 'Where you keep stock',
    short: 'Locations',
    blurb: 'The storerooms, shelves and vehicles stock can sit in.',
    why: 'One location is enough to start. Add more when you actually need to tell them apart.',
    href: '/setup/locations',
    cheapToChangeLater: true,
  },
  {
    key: 'tenders',
    title: 'How customers pay',
    short: 'Payments',
    blurb: 'Cash, card, account and anything else your till accepts.',
    why: 'Your cash-up is only as accurate as this list — a payment method missing here gets rung up as something else.',
    href: '/setup/tender-types',
    cheapToChangeLater: true,
  },
  {
    key: 'people',
    title: 'Who else works here',
    short: 'People',
    blurb: 'Invite your staff and choose what each of them may do.',
    why: 'Each person signing in as themselves is what makes the audit trail worth reading.',
    href: '/setup/users',
    cheapToChangeLater: true,
  },
  {
    key: 'catalogue',
    title: 'Your products',
    short: 'Products',
    blurb: 'Bring in products, customers and suppliers from a spreadsheet.',
    why: 'Import is the last step on purpose — products land on the tax rates and price types you have just set up.',
    href: '/setup/import',
    cheapToChangeLater: true,
  },
] as const

/** Every key, for validating what came back from the settings row. */
export const STEP_KEYS: ReadonlySet<string> = new Set(STEPS.map((s) => s.key))

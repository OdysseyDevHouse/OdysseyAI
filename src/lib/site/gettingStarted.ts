import { siteQueryOne } from '../siteDb'
import { customerQueryOne, supplierQueryOne } from './customerDb'
import { getBooleanSetting } from './settings'
import type { Site } from '../sites'

/**
 * What a new shop has actually done — read from the data, never remembered.
 *
 * ── WHY THERE IS NO `onboarding_completed` COLUMN ─────────────────────────
 *
 * The obvious design is a checklist table with a tick per step. It is wrong
 * here for one reason: a tick and the shop can disagree. Somebody imports a
 * catalogue with the CSV tool, or a second manager adds the users, or a step is
 * done on another device — and a stored tick either has to be written by every
 * one of those paths (it will not be; the next import someone adds will forget)
 * or it goes stale and the screen starts lying about the shop to its owner.
 *
 * So every step below is a COUNT against the table that step is about. The
 * checklist is a view of the database, which means it cannot drift from it, and
 * a step done by any route at all — the screen, an import, the API, another
 * user — shows as done the next time this page is opened. It also means the
 * page needs no migration and no writes: opening it changes nothing.
 *
 * The cost is one round trip. It is a single query (below), on a screen opened
 * a handful of times in a shop's life, so that is the right trade.
 */

/** One thing a new shop should do, and whether it has. */
export type StepState = {
  /** How many of the thing exist. Shown as "4 added" once past zero. */
  count: number
  done: boolean
}

export type Progress = {
  storeInfo: StepState
  products: StepState
  departments: StepState
  users: StepState
  roles: StepState
  customers: StepState
  suppliers: StepState
  locations: StepState
  tenders: StepState
  stock: StepState
  sales: StepState
}

/** The keys of `Progress`, so a caller can key a checklist off the type. */
export type StepKey = keyof Progress

type CountRow = Record<string, number | string | null>

/**
 * A step whose threshold is "more than the seed".
 *
 * A fresh site is not empty: the installer seeds one price structure, a set of
 * VAT rates, the cash and card tenders, an owner role and the person who signed
 * up. Counting `> 0` on those tables would tick the box before the owner has
 * done anything, and a checklist that starts fully ticked teaches its reader to
 * ignore it.
 *
 * So the seeded steps carry the seed count as their bar. `users` is done at two
 * — the owner plus somebody — and `roles` at one more than the owner role.
 */
function step(count: number, seeded = 0): StepState {
  return { count, done: count > seeded }
}

/**
 * Has the shop's own identity been filled in?
 *
 * Read from the SESSION's site rather than queried: `requireSiteUser()` has
 * already loaded it, and these fields live in the control database rather than
 * the site one, so a query here would be a second connection to answer a
 * question already in hand.
 *
 * A VAT number is deliberately NOT required. Plenty of small shops are not
 * registered, and demanding one would leave them with a step they can never
 * tick. An address and a phone number are what a document needs to be a valid
 * thing to hand a customer, so those are the bar.
 */
function storeInfoState(site: Site): StepState {
  const filled = [site.address1, site.phone].filter((v) => (v ?? '').trim() !== '').length
  return { count: filled, done: filled === 2 }
}

/**
 * Every count in one round trip.
 *
 * Scalar subqueries in a single SELECT rather than eleven awaited queries: this
 * runs on a page load, and eleven sequential round trips to a database that may
 * be across a network is most of a second for figures that are all small
 * indexed counts.
 *
 * Each count is capped where the exact number stops mattering. The screen says
 * "20+ added" past the cap — nobody reads the difference between 4,000 and
 * 4,001 products, and an uncapped COUNT(*) on a large catalogue is a table scan
 * to render a word.
 */
export async function readProgress(site: Site): Promise<Progress> {
  /*
   * THREE queries, not one, and the split is not arbitrary.
   *
   * Customers and suppliers may be SHARED across a store group: the file lives
   * in the primary site's database, and `customerQuery`/`supplierQuery` resolve
   * which one that is. Folding them into the site query below would count this
   * branch's empty copy of a table the group fills in elsewhere, and tell a shop
   * it has no customers while the list screen shows four hundred.
   *
   * They run concurrently, so this is one round trip's worth of latency rather
   * than three.
   */
  const [row, customerRow, supplierRow] = await Promise.all([
    siteQueryOne<CountRow>(
      site.id,
      `SELECT
         (SELECT COUNT(*) FROM (
            SELECT 1 FROM products WHERE is_archived = 0 LIMIT 20
          ) t) AS products,
         (SELECT COUNT(*) FROM (
            SELECT 1 FROM departments WHERE is_active = 1 LIMIT 20
          ) t) AS departments,
         (SELECT COUNT(*) FROM (
            SELECT 1 FROM users WHERE is_active = 1 LIMIT 20
          ) t) AS users,
         (SELECT COUNT(*) FROM (SELECT 1 FROM roles LIMIT 20) t) AS roles,
         (SELECT COUNT(*) FROM (
            SELECT 1 FROM stock_locations WHERE is_active = 1 LIMIT 20
          ) t) AS locations,
         (SELECT COUNT(*) FROM (
            SELECT 1 FROM tender_types WHERE is_active = 1 LIMIT 20
          ) t) AS tenders,
         (SELECT COUNT(*) FROM (
            SELECT 1 FROM product_location_stock WHERE stock_on_hand <> 0 LIMIT 20
          ) t) AS stock,
         (SELECT COUNT(*) FROM (
            SELECT 1 FROM sales_documents
             WHERE doc_type = 'invoice' AND status = 'finalised' LIMIT 20
          ) t) AS sales`,
    ),
    customerQueryOne<CountRow>(
      site.id,
      `SELECT COUNT(*) AS n FROM (
         SELECT 1 FROM customers WHERE status <> 'closed' LIMIT 20
       ) t`,
    ),
    supplierQueryOne<CountRow>(
      site.id,
      `SELECT COUNT(*) AS n FROM (
         SELECT 1 FROM suppliers WHERE status <> 'closed' LIMIT 20
       ) t`,
    ),
  ])

  const n = (key: string) => Number(row?.[key] ?? 0)

  return {
    storeInfo: storeInfoState(site),
    products: step(n('products')),
    departments: step(n('departments')),
    /* Seeded: the person who signed up is already a user, and the site ships
       with an owner role. Both are one, so both need one more to count. */
    users: step(n('users'), 1),
    roles: step(n('roles'), 1),
    customers: step(Number(customerRow?.n ?? 0)),
    suppliers: step(Number(supplierRow?.n ?? 0)),
    /* A main location is created with the site, so having one is not a choice
       anybody made. A SECOND is. */
    locations: step(n('locations'), 1),
    /* The seeded four — cash, card, account and EFT. A shop that takes anything
       else has been to this screen. */
    tenders: step(n('tenders'), 4),
    stock: step(n('stock')),
    sales: step(n('sales')),
  }
}

/**
 * Where a sign-in should land: the checklist, or the dashboard.
 *
 * ── WHY THIS ASKS THE DATABASE RATHER THAN A FLAG ─────────────────────────
 *
 * "Is this a new account" has no honest boolean. A site row's age says nothing —
 * an account created three months ago and never set up is exactly the shop this
 * screen is for, and one set up in an afternoon is not. What actually matters
 * is whether the shop can trade yet, and that is a fact about its data.
 *
 * So the test is the narrowest possible read: has anything ever been SOLD? A
 * shop with a finalised invoice has been through setup by definition — you
 * cannot ring one up without products, prices and a till — and it gets the
 * dashboard, which is what it wants every morning after. A shop with none gets
 * the checklist.
 *
 * ── WHY IT CANNOT FAIL A SIGN-IN ──────────────────────────────────────────
 *
 * This runs between valid credentials and a working screen, so a database that
 * is briefly unreachable must not turn a good password into an error page. Any
 * failure falls through to the dashboard — the destination sign-in has always
 * used, and a screen that copes with having no data.
 */
export async function landingFor(siteId: number): Promise<'/getting-started' | '/dashboard'> {
  try {
    /* Asked FIRST, and on its own: a shop that has said "don't show me this
       again" has answered the question, and going on to work out whether it has
       ever sold anything would be reopening a decision it already made. */
    if (await isHidden(siteId)) return '/dashboard'

    const row = await siteQueryOne<CountRow>(
      siteId,
      `SELECT COUNT(*) AS n FROM (
         SELECT 1 FROM sales_documents
          WHERE doc_type = 'invoice' AND status = 'finalised' LIMIT 1
       ) t`,
    )
    return Number(row?.n ?? 0) > 0 ? '/dashboard' : '/getting-started'
  } catch {
    return '/dashboard'
  }
}

/**
 * Has this shop dismissed the checklist?
 *
 * Its own tiny read rather than a field on `Progress`, because the two answer
 * different questions and are wanted in different places: progress is what the
 * page DRAWS, and this decides whether the page is reached at all — by the
 * sign-in redirect, and by the page's own guard against a typed URL.
 *
 * Fails to SHOWN. The row and the redirect are how a new shop finds the screen
 * written for it, and a settings blip must not be the thing that takes it away;
 * the worst case is a screen somebody has to dismiss twice.
 */
export async function isHidden(siteId: number): Promise<boolean> {
  try {
    return await getBooleanSetting(siteId, 'getting_started_hidden')
  } catch {
    return false
  }
}

/**
 * How far along, as a fraction of the steps that were actually offered.
 *
 * The denominator is passed in rather than counted from `Progress`, because a
 * shop is only shown the steps its modules and this person's role allow — and a
 * bar reading "3 of 11" to somebody who can see six of them is a bar measuring
 * work they cannot do.
 */
export function completion(steps: StepState[]): { done: number; total: number; pct: number } {
  const done = steps.filter((s) => s.done).length
  const total = steps.length
  return { done, total, pct: total === 0 ? 0 : Math.round((done / total) * 100) }
}

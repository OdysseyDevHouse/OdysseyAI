/**
 * Trading rules and sold-out marks, against a live site database.
 *
 * test:trading-hours proves the ARITHMETIC. This proves the two things that
 * only a database can answer: that the rules round-trip, and that the storefront
 * actually refuses an order when a shop has stopped its queue or marked
 * something off. A disabled button in a browser is a courtesy; these are the
 * rules, and they are what a stale tab or a resubmitted form meets.
 *
 *   npm run test:branch-trading
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import {
  setSoldOut,
  soldOutToday,
  tradingExceptions,
  tradingRules,
} from '../src/lib/site/branchTrading'
import { collectionSlots, openState, isoDate } from '../src/lib/tradingHours'
import { storefrontContext, placePublicOrder, publishedProducts } from '../src/lib/site/storefront'

const SITE = 2 // Smash Burger Joint — the one with a real online store.
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/**
 * Put stock on a product for the duration of the test, and give it back.
 *
 * The checks that expect an order to SUCCEED need a shop that can actually
 * promise the item: this storefront holds stock (hold_minutes 60), so
 * placePublicOrder refuses anything whose stock_on_hand is 0 with "has just
 * sold out". Every published product on this fixture site is at 0, so those
 * checks were failing on the DATA — a true statement about the fixture and
 * nothing about trading hours, which is what this suite exists to prove.
 *
 * Lending rather than skipping, because a skip here would quietly stop testing
 * the accept path altogether — the failure mode the refusal checks cannot
 * catch, since they pass whether or not an order could ever be accepted.
 *
 * The exact prior value is restored through `undo`, so a shop that did have
 * stock is left exactly as it was.
 */
async function lendStock(
  productId: number,
  undo: (() => Promise<void>)[],
  qty = 25,
): Promise<void> {
  const before = await siteQueryOne<{ stock_on_hand: string | number }>(
    SITE,
    'SELECT stock_on_hand FROM products WHERE id = ?',
    [productId],
  )
  if (!before) return
  const previous = before.stock_on_hand
  await siteExecute(SITE, 'UPDATE products SET stock_on_hand = ? WHERE id = ?', [qty, productId])
  undo.push(async () => {
    await siteExecute(SITE, 'UPDATE products SET stock_on_hand = ? WHERE id = ?', [previous, productId])
  })
}

async function main() {
  const undo: (() => Promise<void>)[] = []

  const before = await siteQueryOne<{
    trading_hours: string | null
    accepting_orders: number
    accepting_note: string
    order_horizon_days: number
    is_enabled: number
  }>(
    SITE,
    `SELECT trading_hours, accepting_orders, accepting_note, order_horizon_days, is_enabled
       FROM online_store_settings WHERE id = 1`,
  )
  undo.push(async () => {
    await siteExecute(
      SITE,
      `UPDATE online_store_settings
          SET trading_hours = ?, accepting_orders = ?, accepting_note = ?,
              order_horizon_days = ?, is_enabled = ?
        WHERE id = 1`,
      [
        before?.trading_hours ?? null,
        before?.accepting_orders ?? 1,
        before?.accepting_note ?? '',
        before?.order_horizon_days ?? 2,
        before?.is_enabled ?? 0,
      ],
    )
  })

  console.log('\n— A shop that has set no hours —')
  await siteExecute(
    SITE,
    `UPDATE online_store_settings
        SET trading_hours = NULL, accepting_orders = 1, accepting_note = '', is_enabled = 1
      WHERE id = 1`,
  )
  const always = await tradingRules(SITE)
  ok('reads as always open', always.hours === null)
  ok('and is open right now', openState(always, new Date()).state === 'open')
  ok('taking orders', always.acceptingOrders)

  console.log('\n— Hours round-trip —')
  const week = JSON.stringify({ '2': [['08:00', '14:00'], ['17:00', '21:00']] })
  await siteExecute(SITE, 'UPDATE online_store_settings SET trading_hours = ? WHERE id = 1', [week])
  const parsed = await tradingRules(SITE)
  ok('the week comes back', parsed.hours !== null)
  ok('with both services on Tuesday', (parsed.hours?.['2'] ?? []).length === 2,
    JSON.stringify(parsed.hours?.['2']))

  console.log('\n— A date that does not repeat —')
  const today = isoDate(new Date())
  await siteExecute(
    SITE,
    `INSERT INTO online_trading_exceptions (on_date, is_closed, note)
          VALUES (?, 1, 'Test closure')
     ON DUPLICATE KEY UPDATE is_closed = 1, note = 'Test closure'`,
    [today],
  )
  undo.push(async () => {
    await siteExecute(SITE, 'DELETE FROM online_trading_exceptions WHERE note = ?', ['Test closure'])
  })
  const withException = await tradingExceptions(SITE)
  const mine = withException.find((e) => e.note === 'Test closure')
  ok('the exception is read back', mine !== undefined)
  // The DATE must survive the pool's UTC timezone without rolling a day.
  ok('on the right date', mine?.onDate === today, `${mine?.onDate} vs ${today}`)

  const closedRules = await tradingRules(SITE)
  ok('and closes the shop today', openState(closedRules, new Date()).state === 'closed')
  await siteExecute(SITE, 'DELETE FROM online_trading_exceptions WHERE note = ?', ['Test closure'])

  console.log('\n— Stopping the queue —')
  await siteExecute(
    SITE,
    `UPDATE online_store_settings
        SET trading_hours = NULL, accepting_orders = 0, accepting_note = 'Kitchen closed'
      WHERE id = 1`,
  )
  const stopped = await tradingRules(SITE)
  const state = openState(stopped, new Date())
  ok('the shop reads as paused', state.state === 'paused')
  ok('and carries the reason', state.note === 'Kitchen closed')

  const context = await storefrontContext(SITE)
  if (!context) {
    console.log('**FAIL**  the storefront context could not be built')
    fails++
    for (const step of undo.reverse()) await step()
    process.exit(1)
  }

  /* A wider slice than the five this used to take, because the item has to be
     one the shop could ACTUALLY sell — see the pick below. */
  const catalogue = await publishedProducts(context, { limit: 60 })
  /*
   * The item this section orders has to be one the shop could ACTUALLY sell.
   *
   * `catalogue[0]` on this shop is BBQ Brisket Smash, whose stock_on_hand is 0.
   * With hold_minutes at 60 the storefront refuses to promise stock it has not
   * got, so the checks that expect an order to SUCCEED were failing on "has just
   * sold out" — a true statement about the fixture data and nothing at all about
   * trading hours, which is what this suite is for.
   *
   * One with stock if the shop has one, else the first published product with
   * stock LENT to it for the run. The refusal checks are unaffected either way:
   * being paused and being marked sold out both refuse regardless of stock,
   * which is the point of each.
   */
  if (catalogue.length === 0) {
    console.log('SKIP  this shop publishes nothing — order refusals not exercised')
  } else {
    const item = catalogue.find((p) => p.stockRaw > 0) ?? catalogue[0]
    if (item.stockRaw <= 0) await lendStock(item.id, undo)
    const shopper = {
      fulfilment: 'collect' as const,
      contactName: 'Trading Hours Test',
      contactPhone: '0210000000',
      contactEmail: '',
    }

    const whilePaused = await placePublicOrder(context, {
      ...shopper,
      lines: [{ productId: item.id, qty: 1 }],
    })
    // The whole point: a stopped queue is a rule, not a disabled button.
    ok('an order is refused while paused', !whilePaused.ok)
    ok('and the shopper is told why', !whilePaused.ok && whilePaused.error.includes('Kitchen closed'),
      !whilePaused.ok ? whilePaused.error : '')

    console.log('\n— Sold out today —')
    await siteExecute(
      SITE,
      "UPDATE online_store_settings SET accepting_orders = 1, accepting_note = '' WHERE id = 1",
    )
    await setSoldOut(SITE, item.id, today, 'Back tomorrow', 'test')
    undo.push(async () => void (await setSoldOut(SITE, item.id, null)))

    const marked = await soldOutToday(SITE)
    ok('the mark is read back', marked.has(item.id))
    ok('with its note', marked.get(item.id)?.note === 'Back tomorrow')

    const fresh = await storefrontContext(SITE)
    const whileSoldOut = await placePublicOrder(fresh!, {
      ...shopper,
      lines: [{ productId: item.id, qty: 1 }],
    })
    // The ONE thing that blocks outright. Staff said they have not got it, so
    // "we'll confirm your order" would be a promise about a known falsehood.
    ok('the order is refused', !whileSoldOut.ok)
    ok('naming the item', !whileSoldOut.ok && whileSoldOut.error.includes(item.description.slice(0, 10)),
      !whileSoldOut.ok ? whileSoldOut.error : '')

    console.log('\n— Putting it back on the menu —')
    await setSoldOut(SITE, item.id, null)
    ok('the mark is gone', !(await soldOutToday(SITE)).has(item.id))
    const after = await placePublicOrder((await storefrontContext(SITE))!, {
      ...shopper,
      lines: [{ productId: item.id, qty: 1 }],
    })
    ok('and orders are taken again', after.ok, after.ok ? after.orderNumber : after.error)
    if (after.ok) {
      await siteExecute(SITE, 'DELETE FROM online_stock_holds WHERE order_id = ?', [after.orderId])
      await siteExecute(SITE, 'DELETE FROM online_order_lines WHERE order_id = ?', [after.orderId])
      await siteExecute(SITE, 'DELETE FROM online_orders WHERE id = ?', [after.orderId])
    }
  }

  console.log('\n— The collection time is re-derived, not trusted —')
  // Hours the shop actually keeps, so there are real slots to accept and real
  // times to refuse.
  await siteExecute(
    SITE,
    `UPDATE online_store_settings
        SET trading_hours = ?, accepting_orders = 1, accepting_note = ''
      WHERE id = 1`,
    [JSON.stringify({ '0': [['08:00', '20:00']], '1': [['08:00', '20:00']], '2': [['08:00', '20:00']],
                      '3': [['08:00', '20:00']], '4': [['08:00', '20:00']], '5': [['08:00', '20:00']],
                      '6': [['08:00', '20:00']] })],
  )
  const slotRules = await tradingRules(SITE)
  const offered = collectionSlots(slotRules, new Date())
  ok('the shop offers times', offered.length > 0, String(offered.length))

  const slotCtx = await storefrontContext(SITE)
  /* Wide enough to find one with stock, for the same reason as the pick above:
     the two checks below expect an order to be ACCEPTED, and the storefront will
     not promise stock the shop has not got. */
  const slotCatalogue = slotCtx ? await publishedProducts(slotCtx, { limit: 60 }) : []
  if (!slotCtx || slotCatalogue.length === 0) {
    console.log('SKIP  nothing publishable to order with')
  } else {
    // Same rule as the pick above, and stock lent for the run when there is none.
    const slotItem = slotCatalogue.find((p) => p.stockRaw > 0) ?? slotCatalogue[0]
    if (slotItem.stockRaw <= 0) await lendStock(slotItem.id, undo)
    const line = { productId: slotItem.id, qty: 1 }
    const shopper = {
      fulfilment: 'collect' as const,
      contactName: 'Trading Hours Test',
      contactPhone: '0210000000',
      contactEmail: '',
    }

    // A time the shop never offered — the stale-tab case, and a payload naming
    // any time it likes. Both arrive here identically.
    const madeUp = new Date()
    madeUp.setDate(madeUp.getDate() + 1)
    madeUp.setHours(3, 7, 0, 0)
    const refused = await placePublicOrder(slotCtx, {
      ...shopper,
      lines: [line],
      requestedFor: madeUp.toISOString(),
    })
    ok('a time outside trading hours is refused', !refused.ok,
      !refused.ok ? refused.error : 'accepted')

    const accepted = await placePublicOrder(slotCtx, {
      ...shopper,
      lines: [line],
      requestedFor: offered[0].toISOString(),
    })
    ok('a real slot is accepted', accepted.ok, accepted.ok ? accepted.orderNumber : accepted.error)
    if (accepted.ok) {
      const stored = await siteQueryOne<{ requested_for: Date | null }>(
        SITE,
        'SELECT requested_for FROM online_orders WHERE id = ?',
        [accepted.orderId],
      )
      ok('and is written to the order', stored?.requested_for !== null, String(stored?.requested_for))
      await siteExecute(SITE, 'DELETE FROM online_stock_holds WHERE order_id = ?', [accepted.orderId])
      await siteExecute(SITE, 'DELETE FROM online_order_lines WHERE order_id = ?', [accepted.orderId])
      await siteExecute(SITE, 'DELETE FROM online_orders WHERE id = ?', [accepted.orderId])
    }

    const asap = await placePublicOrder(slotCtx, { ...shopper, lines: [line], requestedFor: '' })
    ok('as-soon-as-possible is always fine', asap.ok, asap.ok ? '' : asap.error)
    if (asap.ok) {
      await siteExecute(SITE, 'DELETE FROM online_stock_holds WHERE order_id = ?', [asap.orderId])
      await siteExecute(SITE, 'DELETE FROM online_order_lines WHERE order_id = ?', [asap.orderId])
      await siteExecute(SITE, 'DELETE FROM online_orders WHERE id = ?', [asap.orderId])
    }
  }

  console.log('\n— A mark that has expired —')
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  await siteExecute(
    SITE,
    `INSERT INTO online_product_availability (product_id, unavailable_until, note)
     SELECT id, ?, 'expired test' FROM products ORDER BY id LIMIT 1
     ON DUPLICATE KEY UPDATE unavailable_until = VALUES(unavailable_until)`,
    [isoDate(yesterday)],
  )
  const expired = await soldOutToday(SITE)
  // A date rather than a flag is what makes this self-clearing: no cron, and
  // nothing for staff to remember at close.
  ok('yesterday’s mark no longer applies', ![...expired.values()].some((v) => v.note === 'expired test'))
  await siteExecute(SITE, 'DELETE FROM online_product_availability WHERE note = ?', ['expired test'])

  console.log('\n— Cleanup —')
  for (const step of undo.reverse()) await step()
  const restored = await siteQueryOne<{ accepting_orders: number; is_enabled: number }>(
    SITE,
    'SELECT accepting_orders, is_enabled FROM online_store_settings WHERE id = 1',
  )
  ok('settings put back', Number(restored?.accepting_orders) === Number(before?.accepting_orders ?? 1))
  ok('and the shop left as it was', Number(restored?.is_enabled) === Number(before?.is_enabled ?? 0))
  const leftovers = await siteQueryOne<{ n: number }>(
    SITE,
    "SELECT COUNT(*) AS n FROM online_orders WHERE contact_name = 'Trading Hours Test'",
  )
  ok('no test orders left behind', Number(leftovers?.n ?? 0) === 0, String(leftovers?.n ?? 0))

  console.log(fails === 0 ? '\nAll branch trading checks passed.' : `\n${fails} FAILED.`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

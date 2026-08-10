/**
 * Saved baskets — the rules that keep one nudge from becoming spam.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-saved-baskets.ts
 *
 * The whole feature is one email. Everything asserted here is a reason NOT to
 * send it, because every one of them is a way this becomes the reason somebody
 * unsubscribes from a shop they liked:
 *
 *   · ONE ROW PER SHOPPER. Saving twice must upsert, not accumulate — two rows
 *     means two emails, and the sweep would happily send both.
 *   · ONE REMINDER, EVER, per basket. reminded_at is the guard.
 *   · A NEW basket re-arms it. Someone reminded last week who has since left a
 *     different basket deserves their one email about THAT one; without this
 *     an early saver is reminded once in their life.
 *   · Recovered, ordered and unsubscribed baskets are never chased.
 *   · A basket still being shopped is not chased either — the age cutoff.
 *   · The recovery token survives an update, so a link already in an inbox
 *     keeps working.
 */
import { siteExecute, siteQuery } from '../src/lib/siteDb'
import {
  saveBasket,
  basketByToken,
  dueForReminder,
  markReminded,
  markRecovered,
  markOrdered,
  unsubscribeBasket,
} from '../src/lib/site/savedBaskets'

const SITE = 1
const MAIL = 'zztest-basket@example.com'
const MAIL2 = 'zztest-basket-2@example.com'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** Backdate a basket so the age cutoff treats it as abandoned. */
async function ageBasket(email: string, hours: number) {
  await siteExecute(
    SITE,
    'UPDATE online_saved_baskets SET updated_at = (NOW() - INTERVAL ? HOUR) WHERE contact_email = ?',
    [hours, email],
  )
}

async function cleanup() {
  await siteExecute(SITE, 'DELETE FROM online_saved_baskets WHERE contact_email LIKE ?', [
    'zztest-basket%',
  ])
}

async function main() {
  await cleanup()

  /* ── 1. Saving ───────────────────────────────────────────────────────── */

  const first = await saveBasket(SITE, {
    contactEmail: MAIL,
    contactName: 'Test Shopper',
    lines: [{ productId: 2, qty: 3 }],
    subtotalIncl: 150,
  })
  ok('a basket saves', first.ok, first.ok ? '' : first.error)
  const token = first.ok ? first.token : ''
  ok('  and returns a recovery token', token.length === 43, String(token.length))

  const empty = await saveBasket(SITE, { contactEmail: MAIL, lines: [] })
  ok('an empty basket is refused', !empty.ok)

  const noMail = await saveBasket(SITE, {
    contactEmail: 'not-an-address',
    lines: [{ productId: 2, qty: 1 }],
  })
  ok('an address with no @ is refused', !noMail.ok)

  /* ── 2. One row per shopper ──────────────────────────────────────────── */

  const again = await saveBasket(SITE, {
    contactEmail: MAIL,
    contactName: 'Test Shopper',
    lines: [{ productId: 2, qty: 1 }, { productId: 37, qty: 2 }],
    subtotalIncl: 260,
  })
  ok('saving again succeeds', again.ok)

  const rows = await siteQuery<{ n: number }>(
    SITE,
    'SELECT COUNT(*) AS n FROM online_saved_baskets WHERE contact_email = ?',
    [MAIL],
  )
  ok('  and there is still ONE row', Number(rows[0]?.n) === 1, String(rows[0]?.n))
  ok(
    '  keeping the SAME recovery token, so a sent link still works',
    again.ok && again.token === token,
    again.ok ? `${again.token.slice(0, 8)} vs ${token.slice(0, 8)}` : '',
  )

  const reread = await basketByToken(SITE, token)
  ok('  and now holds the newer basket', reread?.lines.length === 2, String(reread?.lines.length))

  /* ── 3. Nothing is due until it is old enough ────────────────────────── */

  let due = await dueForReminder(SITE, 4)
  ok(
    'a basket saved just now is NOT due',
    !due.some((b) => b.contactEmail === MAIL),
    `${due.length} due`,
  )

  await ageBasket(MAIL, 6)
  due = await dueForReminder(SITE, 4)
  ok('an abandoned basket IS due', due.some((b) => b.contactEmail === MAIL))

  /* ── 4. ONE reminder, ever ───────────────────────────────────────────── */

  const mine = due.find((b) => b.contactEmail === MAIL)!
  await markReminded(SITE, mine.id)

  due = await dueForReminder(SITE, 4)
  ok(
    'once reminded it is never due again',
    !due.some((b) => b.contactEmail === MAIL),
    `${due.length} due`,
  )

  /* ── 5. A NEW basket re-arms the reminder ────────────────────────────── */

  await saveBasket(SITE, {
    contactEmail: MAIL,
    lines: [{ productId: 2, qty: 9 }],
    subtotalIncl: 900,
  })
  await ageBasket(MAIL, 6)
  due = await dueForReminder(SITE, 4)
  ok(
    'a NEW basket earns its own single reminder',
    due.some((b) => b.contactEmail === MAIL),
  )

  /* ── 6. Recovered, ordered, unsubscribed are never chased ────────────── */

  const live = due.find((b) => b.contactEmail === MAIL)!
  await markRecovered(SITE, live.id)
  due = await dueForReminder(SITE, 4)
  ok('a recovered basket is not chased', !due.some((b) => b.contactEmail === MAIL))

  // A fresh basket for the ordered case.
  await saveBasket(SITE, {
    contactEmail: MAIL2,
    lines: [{ productId: 2, qty: 1 }],
    subtotalIncl: 50,
  })
  await ageBasket(MAIL2, 6)
  ok(
    'a second shopper is due',
    (await dueForReminder(SITE, 4)).some((b) => b.contactEmail === MAIL2),
  )

  await markOrdered(SITE, MAIL2.toUpperCase())
  ok(
    '  and once they order, they are not — case-insensitively',
    !(await dueForReminder(SITE, 4)).some((b) => b.contactEmail === MAIL2),
  )

  // Unsubscribe, on a re-armed basket.
  await saveBasket(SITE, {
    contactEmail: MAIL2,
    lines: [{ productId: 2, qty: 4 }],
    subtotalIncl: 200,
  })
  await ageBasket(MAIL2, 6)
  const second = await siteQuery<{ recovery_token: string }>(
    SITE,
    'SELECT recovery_token FROM online_saved_baskets WHERE contact_email = ?',
    [MAIL2],
  )
  const gone = await unsubscribeBasket(SITE, String(second[0]?.recovery_token))
  ok('unsubscribing works', gone)
  ok(
    '  and an unsubscribed shopper is never chased',
    !(await dueForReminder(SITE, 4)).some((b) => b.contactEmail === MAIL2),
  )
  ok(
    '  but their basket is still recoverable from a link they hold',
    (await basketByToken(SITE, String(second[0]?.recovery_token))) !== null,
  )

  /* ── 7. A bad token finds nothing ────────────────────────────────────── */

  ok('an unknown token resolves to nothing', (await basketByToken(SITE, 'x'.repeat(43))) === null)
  ok('an oversized token is refused outright', (await basketByToken(SITE, 'x'.repeat(200))) === null)

  /* ── Clean up ────────────────────────────────────────────────────────── */
  await cleanup()
  const left = await siteQuery<{ n: number }>(
    SITE,
    "SELECT COUNT(*) AS n FROM online_saved_baskets WHERE contact_email LIKE 'zztest-basket%'",
  )
  ok('the test leaves nothing behind', Number(left[0]?.n) === 0, String(left[0]?.n))

  console.log(fails === 0 ? '\nAll saved-basket checks passed.' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

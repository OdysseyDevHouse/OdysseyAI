/**
 * Phase 11 — the audit reader and the low-stock digest.
 *
 * The audit reader's property is honest FILTERS + keyset pagination with no
 * gap and no overlap. The digest's property is the skip ladder: every guard
 * is a reason not to send, and the claim stamps BEFORE any send.
 *
 *   npm run test:hardening
 */
import { siteExecute, siteQuery } from '../src/lib/siteDb'
import { logActivity, listActivityLog, listActivityActors } from '../src/lib/site/activityLog'
import { recordSignIn, listSignIns } from '../src/lib/signinLog'
import { execute } from '../src/lib/db'
import { buildLowStockDigest, sendLowStockDigest } from '../src/lib/site/lowStockAlert'
import { getSetting, setSetting } from '../src/lib/site/settings'
import { mainLocationId } from '../src/lib/site/stockLocations'

const SITE = 1
const actor = { userId: 1, userName: 'Hardening Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const TAG = 'zh11_probe'

async function main() {
  await siteExecute(SITE, `DELETE FROM activity_log WHERE action LIKE '${TAG}%'`)
  await execute(`DELETE FROM cp2_signin_log WHERE email LIKE 'zh11%'`)

  /* ── 1. The audit reader ─────────────────────────────────────────────── */

  for (let i = 0; i < 7; i++) {
    await logActivity(SITE, actor, {
      entity: i % 2 === 0 ? 'product' : 'customer',
      entityId: 990_000 + i,
      action: `${TAG}_${i}`,
      // The search box matches the action EXACTLY or the detail by LIKE, so
      // the tag lives in the detail for the wildcard half to find.
      detail: `${TAG} row ${i}`,
    })
  }

  const all = await listActivityLog(SITE, { search: TAG, limit: 3 })
  ok('*** the search filter finds the probes, newest first ***',
    all.events.length === 3 && all.hasMore,
    `${all.events.length} events, hasMore=${all.hasMore}`)

  const oldest = all.events.at(-1)!
  const page2 = await listActivityLog(SITE, {
    search: TAG,
    limit: 10,
    before: {
      createdAt: oldest.createdAt.toISOString().slice(0, 19).replace('T', ' '),
      id: oldest.id,
    },
  })
  const page1Ids = new Set(all.events.map((e) => e.id))
  ok('*** keyset pagination: no overlap between pages ***',
    page2.events.every((e) => !page1Ids.has(e.id)))
  ok('  and no gap — together they hold all 7',
    all.events.length + page2.events.length === 7,
    `${all.events.length}+${page2.events.length}`)

  const products = await listActivityLog(SITE, { search: TAG, entity: 'product' })
  ok('  the entity filter narrows honestly',
    products.events.length === 4 && products.events.every((e) => e.entity === 'product'))

  const actors = await listActivityActors(SITE)
  ok('  the actor list includes the probe writer',
    actors.some((a) => a.userName === 'Hardening Test'))

  /* ── 2. The sign-in log ──────────────────────────────────────────────── */

  await recordSignIn({ userId: null, email: 'zh11.nobody@example.com', event: 'failed' })
  await recordSignIn({ userId: 1, email: 'zh11.owner@example.com', event: 'success', ip: '10.0.0.1' })
  const signIns = await listSignIns(SITE, 50)
  ok('*** sign-ins for this site read back ***',
    signIns.some((s) => s.email === 'zh11.owner@example.com' && s.event === 'success'))

  /* ── 3. The low-stock digest ─────────────────────────────────────────── */

  const emailBefore = await getSetting(SITE, 'low_stock_alert_email')
  const lastBefore = await getSetting(SITE, 'low_stock_alert_last_sent')

  // Off: empty address short-circuits everything.
  await setSetting(SITE, 'low_stock_alert_email', '')
  ok('*** an empty address means OFF ***',
    (await sendLowStockDigest(SITE)).skipped === 'off')

  // Not due: a fresh stamp inside the window.
  await setSetting(SITE, 'low_stock_alert_email', 'zh11@example.com')
  await setSetting(SITE, 'low_stock_alert_last_sent', new Date().toISOString())
  ok('  a fresh stamp means NOT DUE',
    (await sendLowStockDigest(SITE)).skipped === 'not_due')

  // Due, but no mail configured: refused honestly, and the row NOT stamped —
  // wait: mail_unconfigured is checked BEFORE the claim, so last_sent stays.
  await setSetting(SITE, 'low_stock_alert_last_sent', '2020-01-01T00:00:00.000Z')
  const noMail = await sendLowStockDigest(SITE)
  ok('  due with no SMTP reads mail_unconfigured (or sends, when SMTP exists)',
    noMail.skipped === 'mail_unconfigured' || noMail.sent || noMail.skipped === 'nothing_low',
    JSON.stringify(noMail))

  // The builder itself: seed a below-minimum product and find it by name.
  const stamp = Date.now().toString().slice(-8)
  const locationId = await mainLocationId(SITE)
  await siteExecute(SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost)
     VALUES (?, 'ZH11 low widget', 'normal', 2, 5)`, [`ZH11${stamp}`])
  const productId = Number((await siteQuery<any>(SITE,
    'SELECT id FROM products WHERE code = ?', [`ZH11${stamp}`]))[0].id)
  // The digest keeps its WORST shortages when the engine cap truncates (this
  // dev database holds tens of thousands of below-minimum rows), so the
  // fixture's shortfall must outrank every real row to appear deterministically.
  await siteExecute(SITE,
    `INSERT INTO product_location_stock (product_id, location_id, stock_on_hand, min_stock, max_stock)
     VALUES (?,?,2,500,600)
     ON DUPLICATE KEY UPDATE stock_on_hand=2, min_stock=500, max_stock=600`,
    [productId, locationId])
  await siteExecute(SITE,
    `INSERT INTO stock_movements (product_id, location_id, movement_type, qty_change, qty_after,
                                  unit_cost_excl, source, user_id, user_name)
     VALUES (?,?,'opening',2,2,5,'opening',1,'Hardening Test')`, [productId, locationId])

  const digest = await buildLowStockDigest(SITE)
  const line = digest?.lines.find((l) => l.productId === productId)
  ok('*** the digest names the below-minimum product with its figures ***',
    line !== undefined && line.stockOnHand === 2 && line.minStock === 500,
    line ? `on hand ${line.stockOnHand}, min ${line.minStock}, suggest ${line.suggested}` : 'absent')
  ok('  and the email text carries its code',
    digest !== null && digest.text.includes(`ZH11${stamp}`))

  /* ── Clean up ────────────────────────────────────────────────────────── */

  await setSetting(SITE, 'low_stock_alert_email', emailBefore ?? '')
  await setSetting(SITE, 'low_stock_alert_last_sent', lastBefore ?? '')
  await siteExecute(SITE, 'DELETE FROM stock_movements WHERE product_id = ?', [productId])
  await siteExecute(SITE, 'DELETE FROM product_location_stock WHERE product_id = ?', [productId])
  await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [productId])
  await siteExecute(SITE, `DELETE FROM activity_log WHERE action LIKE '${TAG}%'`)
  await execute(`DELETE FROM cp2_signin_log WHERE email LIKE 'zh11%'`)

  console.log(fails === 0 ? '\nAll hardening checks passed.' : `\n${fails} FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

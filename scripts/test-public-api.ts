/**
 * The public API — key lifecycle, scope refusal, and the rate limiter.
 *
 * The property that matters most: a key is HASH-ONLY at rest, and a tampered
 * or revoked key is refused with the same uniform message a nonsense one gets.
 *
 *   npm run test:public-api
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  verifyApiKey,
  capabilityFnFor,
  sha256hex,
  type ApiScope,
} from '../src/lib/site/apiKeys'
import { takeToken, type Bucket } from '../src/lib/rateLimit'
import { listProducts } from '../src/lib/site/products'
import { listCustomers, CUSTOMER_STATUSES } from '../src/lib/site/customers'
import { resolveReport } from '../src/lib/reportBuilder/resolve'
import { runBuilderSpec } from '../src/lib/reportBuilder/run'

const SITE = 1
const actor = { userName: 'API Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const TAG = 'zapi probe'

async function main() {
  await siteExecute(SITE, `DELETE FROM api_keys WHERE name LIKE '${TAG}%'`)

  /* ── 1. Key lifecycle ──────────────────────────────────────────────────── */

  const minted = await createApiKey(SITE, actor, {
    name: `${TAG} key`,
    scopes: ['products:read', 'reports:run'],
  })
  ok('*** a key mints ***', minted.ok, minted.ok ? '' : minted.error)
  if (!minted.ok) { console.log('cannot continue'); process.exit(1) }

  ok('  the raw key carries the site id', minted.rawKey.startsWith(`odk_${SITE}_`), minted.rawKey.slice(0, 14))

  const stored = await siteQueryOne<any>(
    SITE, 'SELECT token_hash FROM api_keys WHERE id = ?', [minted.id])
  ok('*** only the SHA-256 is stored ***',
    String(stored?.token_hash) === sha256hex(minted.rawKey) &&
      !String(stored?.token_hash).includes(minted.rawKey.slice(-10)))

  const verified = await verifyApiKey(minted.rawKey)
  ok('*** the raw key verifies with its site and scopes ***',
    verified.ok && verified.siteId === SITE && verified.scopes.has('products:read') &&
      verified.scopes.has('reports:run') && !verified.scopes.has('customers:read'))

  const tampered = await verifyApiKey(minted.rawKey.slice(0, -2) + 'xx')
  ok('  a tampered secret is refused', !tampered.ok)
  ok('  nonsense is refused', !(await verifyApiKey('odk_1_garbage')).ok)
  ok('  a foreign site id in the key is refused',
    !(await verifyApiKey(minted.rawKey.replace(`odk_${SITE}_`, 'odk_2_'))).ok)

  const listed = await listApiKeys(SITE)
  const mine = listed.find((k) => k.id === minted.id)
  ok('  the list shows prefix and scopes, never the key',
    mine !== undefined && minted.rawKey.includes(mine.keyPrefix) && mine.scopes.length === 2)

  const revoked = await revokeApiKey(SITE, minted.id)
  ok('*** revocation sticks ***', revoked.ok && !(await verifyApiKey(minted.rawKey)).ok)
  ok('  and revoking twice reports so', !(await revokeApiKey(SITE, minted.id)).ok)

  /* ── 1b. Expiry ────────────────────────────────────────────────────────── */

  const dated = await createApiKey(SITE, actor, {
    name: `${TAG} expiring key`, scopes: ['products:read'], expiresInDays: 30,
  })
  ok('*** a key mints with an expiry date ***', dated.ok, dated.ok ? '' : dated.error)
  if (dated.ok) {
    const row = await listApiKeys(SITE).then((ks) => ks.find((k) => k.id === dated.id))
    ok('  the list carries expiresAt, not yet expired',
      row?.expiresAt !== null && row?.expired === false)
    ok('  and it verifies while still in date', (await verifyApiKey(dated.rawKey)).ok)

    // Age it past its date and the same uniform refusal applies.
    await siteExecute(SITE,
      'UPDATE api_keys SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?', [dated.id])
    const lapsed = await verifyApiKey(dated.rawKey)
    ok('*** an expired key is refused with the uniform 401 ***',
      !lapsed.ok && (lapsed as any).error === 'Invalid API key.')
    ok('  and the list reports it expired',
      (await listApiKeys(SITE)).find((k) => k.id === dated.id)?.expired === true)
  }
  ok('  a nonsense expiry is refused at mint',
    !(await createApiKey(SITE, actor, { name: `${TAG} bad`, scopes: ['products:read'], expiresInDays: 0 })).ok)

  /* ── 1c. Sync cursors ──────────────────────────────────────────────────── */

  const epoch = new Date('1000-01-02T00:00:00Z')
  const future = new Date('9999-01-01T00:00:00Z')
  const allProducts = await listProducts(SITE, { collapseVariants: false, includeArchived: true, limit: 1 })
  const sinceEpoch = await listProducts(SITE, {
    collapseVariants: false, includeArchived: true, updatedSince: epoch, limit: 1 })
  ok('*** updatedSince at the epoch returns the whole catalogue ***',
    allProducts.total > 0 && sinceEpoch.total === allProducts.total,
    `${sinceEpoch.total}/${allProducts.total}`)
  ok('  and a future cursor returns an empty delta',
    (await listProducts(SITE, {
      collapseVariants: false, includeArchived: true, updatedSince: future, limit: 1 })).total === 0)

  const allCustomers = await listCustomers(SITE, { statuses: CUSTOMER_STATUSES, limit: 1 })
  const custEpoch = await listCustomers(SITE, {
    statuses: CUSTOMER_STATUSES, updatedSince: epoch, limit: 1 })
  ok('*** the customer cursor behaves the same ***',
    allCustomers.total > 0 && custEpoch.total === allCustomers.total &&
      (await listCustomers(SITE, { statuses: CUSTOMER_STATUSES, updatedSince: future, limit: 1 })).total === 0,
    `${custEpoch.total}/${allCustomers.total}`)

  /* ── 2. Scope → capability projection ──────────────────────────────────── */

  const canReports = capabilityFnFor(new Set<ApiScope>(['reports:run']))
  ok('*** reports:run grants reports.view ***', canReports('reports.view'))
  ok('*** and NEVER cost or financials ***',
    !canReports('products.cost') && !canReports('reports.financial'))
  const canProducts = capabilityFnFor(new Set<ApiScope>(['products:read']))
  ok('  products:read grants products.view and nothing else',
    canProducts('products.view') && !canProducts('customers.view'))

  const canPurchasing = capabilityFnFor(new Set<ApiScope>(['suppliers:read', 'purchases:read']))
  ok('  the purchasing scopes grant their views',
    canPurchasing('suppliers.view') && canPurchasing('purchasing.view') &&
      !canPurchasing('reports.financial'))
  const canGl = capabilityFnFor(new Set<ApiScope>(['gl:read']))
  ok('*** gl:read grants reports.financial by its own name ***',
    canGl('reports.financial') && !canGl('products.cost'))
  ok('  gift-cards:read grants giftcards.view alone',
    capabilityFnFor(new Set<ApiScope>(['gift-cards:read']))('giftcards.view') &&
      !capabilityFnFor(new Set<ApiScope>(['gift-cards:read']))('sales.view'))

  /* ── 3. The rate limiter (pure) ────────────────────────────────────────── */

  const opts = { capacity: 3, refillPerMinute: 60 }
  let bucket: Bucket | undefined
  let allowed = 0
  for (let i = 0; i < 5; i++) {
    const outcome = takeToken(bucket, 1_000_000, opts)
    bucket = outcome.bucket
    if (outcome.allowed) allowed++
  }
  ok('*** a fresh bucket allows exactly its capacity ***', allowed === 3, String(allowed))

  const refusal = takeToken(bucket, 1_000_000, opts)
  ok('  the refusal names a sane retry', !refusal.allowed && refusal.retryAfterSeconds === 1,
    `${refusal.retryAfterSeconds}s`)

  const later = takeToken(bucket, 1_000_000 + 2_000, opts) // 2s at 1 token/s
  ok('*** tokens refill with time ***', later.allowed)

  const costed = takeToken(undefined, 0, { capacity: 10, refillPerMinute: 60, cost: 10 })
  ok('  a heavy call can spend the whole bucket at once',
    costed.allowed && !takeToken(costed.bucket, 0, { capacity: 10, refillPerMinute: 60, cost: 10 }).allowed)

  /* ── 4. The report path under a key's capabilities ─────────────────────── */

  const report = await resolveReport(SITE, 'sales-by-product')
  ok('*** the built-in id space resolves ***', report !== null, report?.name)
  if (report) {
    // reports:run alone opens the DOOR, not every source behind it — a
    // sales-sourced report still demands the sales scope's capability.
    let refused = false
    try {
      await runBuilderSpec(SITE, report.spec, canReports, { limit: 5 })
    } catch {
      refused = true
    }
    ok('*** a sales report is refused without the sales scope ***', refused)

    const canSales = capabilityFnFor(new Set<ApiScope>(['reports:run', 'sales:read']))
    const result = await runBuilderSpec(SITE, report.spec, canSales, { limit: 5 })
    ok('*** the engine runs under scope-derived capabilities ***', result.columns.length > 0,
      `${result.columns.length} cols, ${result.rows.length} rows`)
    ok('*** and hides the cost columns from the key ***',
      result.hiddenColumns.length > 0 &&
        !result.columns.some((c) => /cost|profit|margin/i.test(String(c.label))),
      `hidden: ${result.hiddenColumns.join(', ')}`)
  }

  /* ── Clean up ──────────────────────────────────────────────────────────── */

  await siteExecute(SITE, `DELETE FROM api_keys WHERE name LIKE '${TAG}%'`)

  console.log(fails === 0 ? '\nAll public-api checks passed.' : `\n${fails} FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

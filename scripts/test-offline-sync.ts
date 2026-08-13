/**
 * Posting a sale that was rung up with no database.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-offline-sync.ts
 *
 * This is the file that has to be right. Everything it covers concerns money that
 * has ALREADY changed hands — the customer has left, the drawer holds the cash, and
 * a printed tax invoice bearing a specific number is in somebody's pocket. There is
 * no "refuse and try again" available: a sale this path loses is revenue and VAT
 * that never enter the books.
 *
 * So the assertions are about the things that would silently lose or duplicate one:
 *
 *   · the same uid twice posts ONCE and returns the same number both times;
 *   · the crash window between finaliseDocument's commit and the claim's commit
 *     RESOLVES rather than double-posting — the one weakness the design knowingly
 *     accepts, so it is the one that most needs a test;
 *   · a locked VAT period QUARANTINES rather than posting or discarding;
 *   · a price the till got wrong posts the SERVER's figure, with an exception;
 *   · a sale banks into the shift that took the cash, not whichever is open now;
 *   · the number the customer is holding is the number that ends up on the books.
 *
 * Calls reconcileStock, so the runner schedules it solo: it finishes by asserting a
 * site-wide invariant that another test's in-flight sale would move underneath it.
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { postOfflineSale, validateOfflineSale } from '../src/lib/site/offlineSync'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { reconcileStock, seedOpeningStock } from '../src/lib/site/stockMovements'
import { numberingConfig, tillNumber } from '../src/lib/site/numbering'
import { getSequence } from '../src/lib/site/sequences'
import { formatNumber } from '../src/lib/numberFormat'
import { toNum } from '../src/lib/decimals'
import type { OfflineSale } from '../src/lib/posOffline/types'

const SITE = 1
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const uuid = () =>
  '10000000-1000-4000-8000-' + Date.now().toString(16).padStart(12, '0').slice(-12)

const stockOf = async (id: number) =>
  toNum(
    (await siteQueryOne<any>(SITE, 'SELECT stock_on_hand FROM products WHERE id = ?', [id]))
      ?.stock_on_hand,
  )

/**
 * A till number no terminal is currently using.
 *
 * QUERIED, never hardcoded, and the reason is a real failure this file had: it used to
 * ask for '97', which is inside the range `test-cashup.ts` picks from. That suite exits
 * early on a few paths without reaching its cleanup, so its scratch till sat in the table
 * still holding 97 — and every later run of THIS file died on
 * `Duplicate entry '97' for key 'uq_terminal_till_number'` before reaching a single
 * assertion. Which reads as a broken schema, and is really just two tests reaching for the
 * same number.
 *
 * Counting DOWN from 99 keeps scratch tills clear of the low numbers a real shop uses.
 */
async function freeTillNumber(): Promise<string> {
  const rows = await siteQuery<{ till_number: string }>(
    SITE,
    'SELECT till_number FROM terminals WHERE till_number IS NOT NULL',
  )
  const taken = new Set(rows.map((r) => String(r.till_number)))
  for (let n = 99; n >= 50; n--) {
    if (!taken.has(String(n))) return String(n)
  }
  throw new Error('No free till number in 50..99 — sweep the scratch terminals.')
}

async function main() {
  const stamp = Date.now().toString().slice(-8)

  /* Sweep scratch rows from a crashed earlier run. till_number is UNIQUE, so a
     leftover would fail the INSERT below rather than the assertion it was making
     — a failure that reads as a broken schema and is really just litter. */
  const orphans = await siteQuery<{ id: number }>(
    SITE,
    "SELECT id FROM terminals WHERE code LIKE 'TSTSYNC%'",
  )
  for (const o of orphans) {
    await siteExecute(SITE, 'DELETE FROM sales_documents WHERE terminal_id = ?', [o.id])
    await siteExecute(SITE, 'DELETE FROM document_sequences WHERE terminal_id = ?', [o.id])
    await siteExecute(SITE, 'DELETE FROM terminals WHERE id = ?', [o.id])
  }
  if (orphans.length) console.log(`      (swept ${orphans.length} terminal(s) from an earlier run)`)

  const vat = await siteQueryOne<any>(
    SITE,
    "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1",
  )
  const vatRate = toNum(vat?.rate, 15)
  const cash = await getTenderByCode(SITE, 'CASH')
  if (!cash) throw new Error('This site has no CASH tender.')

  const product = await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost,
                           selling_vat_rate_id)
     VALUES (?,?,'normal','500.000','4.0000','4.0000',?)`,
    [`SY${stamp}`, `Offline sync test ${stamp}`, vat?.id ?? null],
  )
  const productId = product.insertId
  await seedOpeningStock(SITE, { userId: 1, userName: 'Offline sync test' })

  // The shelf price this product is expected to sell at, so the pricing
  // comparison later is against a real structure price rather than nothing.
  const structure = await siteQueryOne<any>(
    SITE,
    'SELECT id FROM price_structures ORDER BY id LIMIT 1',
  )
  await siteExecute(
    SITE,
    `INSERT INTO product_prices (product_id, price_structure_id, selling_price_incl)
     VALUES (?,?,'20.0000')
     ON DUPLICATE KEY UPDATE selling_price_incl = VALUES(selling_price_incl)`,
    [productId, structure?.id ?? 1],
  )

  /* A disposable till of its own, so allocating numbers here cannot leave a
     sequence ahead of its documents on a till a person actually uses — which is
     what makes test-sales-posting fail instead of this one. */
  const tillIns = await siteExecute(
    SITE,
    'INSERT INTO terminals (code, till_number, name, is_active) VALUES (?,?,?,1)',
    [`TSTSYNC${stamp}`, await freeTillNumber(), `Offline sync till ${stamp}`],
  )
  const terminalId = tillIns.insertId
  await siteExecute(
    SITE,
    `INSERT INTO document_sequences (terminal_id, doc_type, prefix, next_number, padding)
     VALUES (?, 'invoice', 'INV', 1, 6)
     ON DUPLICATE KEY UPDATE doc_type = doc_type`,
    [terminalId],
  )

  const config = await numberingConfig(SITE)
  const till = await tillNumber(SITE, terminalId)

  /** The number this till would print for counter `n`. */
  const numberFor = (n: number) =>
    formatNumber('INV', n, 6, null, { store: config.storeNumber, till: till! })

  /* Every uid this run mints, so cleanup can delete exactly its own claims.
     Deleting by terminal_id is NOT enough: a quarantined sale's document is
     removed, and the claim that outlives it would then show on /sales/offline
     as a refused sale with no document — a manager reading "one sale refused"
     that no longer exists anywhere. Test litter that looks like a real
     incident is worse than test litter that looks like nothing. */
  const mintedUids = new Set<string>()

  /** A complete offline sale, as the till would have queued it. */
  const buildSale = (n: number, over: Partial<OfflineSale> = {}): OfflineSale => ({
    saleUid: uuid(),
    documentNumber: numberFor(n),
    terminalId,
    terminalCode: `TSTSYNC${stamp}`,
    operatorUserId: 1,
    operatorName: 'Offline cashier',
    shiftId: null,
    takenAt: new Date().toISOString(),
    documentDate: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10),
    priceStructureId: structure?.id ?? null,
    customerId: null,
    customerName: 'Walk-in',
    customerVatNo: null,
    customerPhone: null,
    lines: [
      {
        productId,
        productCode: `SY${stamp}`,
        description: 'Offline line',
        productType: 'normal',
        departmentId: null,
        qty: 2,
        unitPriceIncl: 20,
        discountPct: 0,
        specialId: null,
        vatRatePct: vatRate,
        unitCostExcl: 4,
      },
    ],
    tenders: [{ tenderTypeId: cash.id, tenderCode: 'CASH', amount: 40, reference: null }],
    claimedTotalIncl: 40,
    claimedTenderedTotal: 40,
    claimedChange: 0,
    ...over,
  })

  /* Wraps buildSale so the uid is recorded AFTER any override is applied — the
     malformed-uid cases pass their own, and cleanup has to know about those too. */
  const saleAt = (n: number, over: Partial<OfflineSale> = {}): OfflineSale => {
    const sale = buildSale(n, over)
    mintedUids.add(sale.saleUid)
    return sale
  }

  /* ── 1. The ordinary case: it posts, under the number already printed ──── */

  const stockBefore = await stockOf(productId)
  const first = saleAt(1)
  const posted = await postOfflineSale(SITE, first)

  ok('an offline sale posts', posted.ok, posted.ok ? '' : posted.error)
  ok(
    'it posts under the number the customer is holding',
    posted.documentNumber === first.documentNumber,
    `printed ${first.documentNumber}, posted ${posted.documentNumber}`,
  )
  ok('a clean sale carries no exception', !posted.exception, posted.exception ?? '')
  ok(
    'the stock moved',
    (await stockOf(productId)) === stockBefore - 2,
    `${stockBefore} -> ${await stockOf(productId)}`,
  )

  const row = await siteQueryOne<any>(
    SITE,
    `SELECT status, offline_sale_uid, offline_taken_at, offline_synced_at, total_incl
       FROM sales_documents WHERE id = ?`,
    [posted.documentId],
  )
  ok('it is finalised', row?.status === 'finalised', String(row?.status))
  ok('the uid is on the document', row?.offline_sale_uid === first.saleUid)
  ok('when it was taken is recorded', !!row?.offline_taken_at)
  ok('it is stamped as synced', !!row?.offline_synced_at)

  const audit = await siteQuery<any>(
    SITE,
    'SELECT action FROM document_audit WHERE document_id = ?',
    [posted.documentId],
  )
  ok(
    'the trail says it was rung up offline',
    audit.some((a) => a.action === 'offline_synced'),
    audit.map((a) => a.action).join(','),
  )

  /* ── 2. IDEMPOTENCY — the assertion that stops a shop being paid twice ───
     A till cannot tell "the request timed out" from "it succeeded and the reply
     was lost", so it WILL send the same batch again. */

  const replay = await postOfflineSale(SITE, first)
  ok('a replayed sale is accepted, not refused', replay.ok, replay.ok ? '' : replay.error)
  ok('a replay is reported as a duplicate', replay.duplicate === true)
  ok(
    'a replay returns the SAME number',
    replay.documentNumber === posted.documentNumber,
    `${posted.documentNumber} vs ${replay.documentNumber}`,
  )

  const copies = await siteQueryOne<any>(
    SITE,
    'SELECT COUNT(*) AS n FROM sales_documents WHERE offline_sale_uid = ?',
    [first.saleUid],
  )
  ok('the sale exists exactly ONCE', Number(copies?.n) === 1, `${copies?.n} copies`)
  ok(
    'a replay does not move stock again',
    (await stockOf(productId)) === stockBefore - 2,
    `expected ${stockBefore - 2}, got ${await stockOf(productId)}`,
  )

  /* ── 3. THE CRASH WINDOW ─────────────────────────────────────────────────
     finaliseDocument commits, then the claim commits separately. A crash between
     them leaves a finalised sale with a claim still at 'claimed'. That window is
     accepted deliberately (closing it means threading an outer connection through
     the most sensitive function in the codebase) — so the recovery branch is the
     thing that has to work. Simulated by rewinding the claim to what a crash
     would have left. */

  await siteExecute(
    SITE,
    "UPDATE offline_sync_claims SET status='claimed', posted_at=NULL WHERE sale_uid = ?",
    [first.saleUid],
  )
  const recovered = await postOfflineSale(SITE, first)
  ok('a crashed claim recovers', recovered.ok, recovered.ok ? '' : recovered.error)
  ok(
    'recovery returns the number already issued',
    recovered.documentNumber === posted.documentNumber,
    `${recovered.documentNumber}`,
  )
  const afterRecovery = await siteQueryOne<any>(
    SITE,
    'SELECT COUNT(*) AS n FROM sales_documents WHERE offline_sale_uid = ?',
    [first.saleUid],
  )
  ok(
    'recovery does NOT post a second copy',
    Number(afterRecovery?.n) === 1,
    `${afterRecovery?.n} copies`,
  )
  const claimNow = await siteQueryOne<any>(
    SITE,
    'SELECT status FROM offline_sync_claims WHERE sale_uid = ?',
    [first.saleUid],
  )
  ok('and it settles the claim', claimNow?.status === 'posted', String(claimNow?.status))

  /* ── 3b. THE RACE — four requests carrying one sale, at once ─────────────
     The `posted` branch above only covers a replay that arrives AFTER the first
     one finished. The dangerous case is four arriving together, all reading the
     claim before any of them has posted — which is exactly what a till on a
     flapping connection produces when its retry fires while the first request is
     still in flight. uq_offline_uid is what makes this safe; this asserts it. */

  const raced = saleAt(50)
  const raceResults = await Promise.all([
    postOfflineSale(SITE, raced),
    postOfflineSale(SITE, raced),
    postOfflineSale(SITE, raced),
    postOfflineSale(SITE, raced),
  ])
  const winners = raceResults.filter((r) => r.ok)
  const raceCopies = await siteQueryOne<any>(
    SITE,
    'SELECT COUNT(*) AS n FROM sales_documents WHERE offline_sale_uid = ?',
    [raced.saleUid],
  )
  ok(
    'four concurrent attempts post the sale EXACTLY ONCE',
    Number(raceCopies?.n) === 1,
    `${raceCopies?.n} documents from 4 requests`,
  )
  ok('exactly one request wins', winners.length === 1, `${winners.length} winners`)
  ok(
    'the losers are retryable, not discarded',
    raceResults.filter((r) => !r.ok).every((r) => r.retryable === true),
    raceResults.filter((r) => !r.ok).map((r) => `retryable=${r.retryable}`).join(','),
  )
  ok(
    'and a loser says something a cashier can read',
    raceResults.filter((r) => !r.ok).every((r) => !/uq_offline_uid|Duplicate entry/.test(r.error ?? '')),
    raceResults.find((r) => !r.ok)?.error ?? '(none)',
  )
  // And the retry settles rather than failing forever.
  const settled = await postOfflineSale(SITE, raced)
  ok('a loser settles on retry', settled.ok && settled.duplicate === true, settled.error ?? '')
  ok(
    'onto the same number the winner issued',
    settled.documentNumber === winners[0]?.documentNumber,
    `${winners[0]?.documentNumber} vs ${settled.documentNumber}`,
  )

  /* ── 4. The sequence caught up rather than allocating ──────────────────── */

  const seq = await getSequence(SITE, 'invoice', terminalId)
  ok(
    'the sequence advanced PAST the adopted number',
    (seq?.nextNumber ?? 0) >= 2,
    `next_number = ${seq?.nextNumber}`,
  )

  /* ── 5. A total the till got wrong posts the SERVER's figure ─────────────
     The till claims R99 for a basket that prices at R40. The invoice must be for
     R40 — a client's arithmetic never decides what a customer owes — and the gap
     must be recorded rather than swallowed. */

  const wrong = saleAt(2, { claimedTotalIncl: 99 })
  const wrongPosted = await postOfflineSale(SITE, wrong)
  ok('a mispriced sale still posts', wrongPosted.ok, wrongPosted.ok ? '' : wrongPosted.error)
  ok(
    'it is flagged as an exception',
    !!wrongPosted.exception,
    wrongPosted.exception ?? '(none)',
  )
  const wrongRow = await siteQueryOne<any>(
    SITE,
    'SELECT total_incl, offline_exception FROM sales_documents WHERE id = ?',
    [wrongPosted.documentId],
  )
  ok(
    "the invoice is for the SERVER's figure, not the till's",
    Math.abs(toNum(wrongRow?.total_incl) - 40) < 0.01,
    `total_incl = ${wrongRow?.total_incl}`,
  )
  ok('the exception is on the document', !!wrongRow?.offline_exception)

  /* ── 6. A locked VAT period QUARANTINES ─────────────────────────────────
     Posting into a submitted return silently changes a figure already declared to
     SARS. Refusing outright would lose the sale. So it is saved, not posted. */

  /* Locked via the `vat_period_locked_to` setting rather than a period_locks row:
     isPeriodLocked checks it FIRST, it is one row to set and restore, and it needs
     no knowledge of that table's shape. A date long past so nothing real is
     affected, and the previous value is put back at the end regardless. */
  const lockedToBefore = await siteQueryOne<any>(
    SITE,
    "SELECT setting_value FROM settings WHERE setting_key = 'vat_period_locked_to'",
  )
  await siteExecute(
    SITE,
    `INSERT INTO settings (setting_key, setting_value) VALUES ('vat_period_locked_to','2019-12-31')
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
  )

  /* try/finally, not a straight line: a throw between setting the lock and
     restoring it would leave THIS SITE refusing every back-dated sale, and the
     next test to fail would be an unrelated one with no clue why. */
  try {
    const quarantined = await postOfflineSale(
      SITE,
      saleAt(3, { documentDate: '2019-06-01', claimedTotalIncl: 40 }),
    )
    ok('a locked period does NOT post', !quarantined.ok, quarantined.documentNumber ?? '')
    ok('and says why', /locked|closed/i.test(quarantined.error ?? ''), quarantined.error ?? '')
    ok(
      'it is not retryable — a human has to decide',
      quarantined.retryable === false,
      String(quarantined.retryable),
    )
    const saved = await siteQueryOne<any>(
      SITE,
      `SELECT id, status, offline_exception FROM sales_documents
        WHERE offline_sale_uid IS NOT NULL AND document_date = '2019-06-01'
        ORDER BY id DESC LIMIT 1`,
    )
    ok(
      'the sale is QUARANTINED as a draft, not lost',
      saved?.status === 'saved' || saved?.status === 'draft',
      `status = ${saved?.status}`,
    )
    ok('with the reason on it', !!saved?.offline_exception, saved?.offline_exception ?? '')
    if (saved?.id) {
      await siteExecute(SITE, 'DELETE FROM sales_document_lines WHERE document_id = ?', [saved.id])
      await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [saved.id])
    }
  } finally {
    if (lockedToBefore?.setting_value != null) {
      await siteExecute(
        SITE,
        "UPDATE settings SET setting_value = ? WHERE setting_key = 'vat_period_locked_to'",
        [lockedToBefore.setting_value],
      )
    } else {
      await siteExecute(SITE, "DELETE FROM settings WHERE setting_key = 'vat_period_locked_to'")
    }
  }

  /* ── 6b. THE SHIFT THAT TOOK THE CASH ───────────────────────────────────
     An offline sale banks into the drawer the money physically went into, not
     whichever shift happens to be open when it finally syncs. Getting this wrong
     makes one drawer inexplicably over and another short by the same amount, and
     no amount of counting afterwards can tell you which sale did it.

     Simulated by opening a shift, ringing up against it, then opening a SECOND
     shift before syncing — which is what happens to a sale queued at 17:00 and
     delivered the next morning. */

  /* There is no `status` column — open vs closed is `closed_at IS NULL`, and a
     generated column makes ONE open shift per till a database rule. So shift A
     must actually be closed before B can be opened, which is also exactly the
     sequence a real overnight queue goes through. */
  const shiftA = await siteExecute(
    SITE,
    `INSERT INTO shifts (terminal_id, terminal_code, user_id, user_name, opening_float, opened_at)
     VALUES (?,?,1,'Offline sync test','100.0000', NOW())`,
    [terminalId, `TSTSYNC${stamp}`],
  )
  const shiftAId = shiftA.insertId

  const banked = await postOfflineSale(SITE, saleAt(60, { shiftId: shiftAId }))
  ok('a sale carrying a shift posts', banked.ok, banked.ok ? '' : banked.error)

  // That shift closes and another opens — the sale is already posted, so what is
  // asserted below is which shift the stored row points at.
  await siteExecute(SITE, 'UPDATE shifts SET closed_at = NOW() WHERE id = ?', [shiftAId])
  const shiftB = await siteExecute(
    SITE,
    `INSERT INTO shifts (terminal_id, terminal_code, user_id, user_name, opening_float, opened_at)
     VALUES (?,?,1,'Offline sync test','100.0000', NOW())`,
    [terminalId, `TSTSYNC${stamp}`],
  )
  const shiftBId = shiftB.insertId

  const bankedRow = await siteQueryOne<any>(
    SITE,
    'SELECT shift_id FROM sales_documents WHERE id = ?',
    [banked.documentId],
  )
  ok(
    'it banks into the shift that TOOK the cash',
    Number(bankedRow?.shift_id) === shiftAId,
    `shift_id = ${bankedRow?.shift_id}, took=${shiftAId}, now open=${shiftBId}`,
  )

  /* And a sale with NO shift stays unbanked rather than being adopted by whichever
     drawer is open — an explicit null means "belongs to no shift", which
     shiftToBankInto already treats as legitimate for a store that never cashes up. */
  const unbanked = await postOfflineSale(SITE, saleAt(61, { shiftId: null }))
  const unbankedRow = await siteQueryOne<any>(
    SITE,
    'SELECT shift_id FROM sales_documents WHERE id = ?',
    [unbanked.documentId],
  )
  ok(
    'a sale with no shift is NOT adopted by the open one',
    unbankedRow?.shift_id === null,
    `shift_id = ${unbankedRow?.shift_id} (open shift is ${shiftBId})`,
  )

  await siteExecute(SITE, 'DELETE FROM shifts WHERE id IN (?,?)', [shiftAId, shiftBId]).catch(
    () => null,
  )

  /* ── 7. Structural refusals — non-retryable, so the queue can drain ────── */

  const bad = (over: Partial<OfflineSale>) => validateOfflineSale(saleAt(9, over) as OfflineSale)
  ok('a malformed uid is refused', !!bad({ saleUid: 'not-a-uuid' }))
  ok('a sale with no printed number is refused', !!bad({ documentNumber: '' }))
  ok('a sale with no lines is refused', !!bad({ lines: [] }))
  ok('a sale with no payment is refused', !!bad({ tenders: [] }))
  ok('a non-finite total is refused', !!bad({ claimedTotalIncl: Number.NaN }))
  ok('a bad date is refused', !!bad({ documentDate: '15/06/2026' }))
  ok('a valid sale is NOT refused', bad({}) === null, String(bad({})))

  const rejected = await postOfflineSale(SITE, saleAt(9, { saleUid: 'not-a-uuid' }))
  ok('a malformed sale is refused non-retryably', rejected.retryable === false)
  ok('and never reaches the books', !rejected.documentId)

  /* ── 8. An operator who has since been deleted still gets their sale on ── */

  const ghost = await postOfflineSale(SITE, saleAt(4, { operatorUserId: 99_999_999 }))
  ok('a sale by a deleted operator still posts', ghost.ok, ghost.ok ? '' : ghost.error)
  ok(
    'and is flagged so it can be attributed',
    /no longer exists/i.test(ghost.exception ?? ''),
    ghost.exception ?? '(none)',
  )
  const ghostRow = await siteQueryOne<any>(
    SITE,
    'SELECT user_name FROM sales_documents WHERE id = ?',
    [ghost.documentId],
  )
  ok(
    "the till's own record of who sold it survives",
    /offline/i.test(String(ghostRow?.user_name)),
    String(ghostRow?.user_name),
  )

  /* ── 9. Site-wide invariant. Scheduled solo because of this. ───────────── */

  const drift = await reconcileStock(SITE)
  ok(
    'no stock drift anywhere on the site',
    drift.length === 0,
    drift
      .slice(0, 3)
      .map((d: any) => `${d.code}: ${d.stockOnHand} vs ${d.movementSum}`)
      .join('; '),
  )

  /* ── Clean up ────────────────────────────────────────────────────────────
     Every document this test issued is removed along with its till, so the
     sequence cannot be left ahead of its documents — which is what makes
     test-sales-posting fail instead of this one. */
  /* By uid, not by terminal: a quarantined sale's document is deleted above and
     its claim carries no terminal, so a terminal-scoped delete would leave it
     behind — and /sales/offline would then show a refused sale that exists
     nowhere. */
  if (mintedUids.size > 0) {
    await siteExecute(
      SITE,
      `DELETE FROM offline_sync_claims WHERE sale_uid IN (${[...mintedUids].map(() => '?').join(',')})`,
      [...mintedUids],
    ).catch(() => null)
  }
  await siteExecute(
    SITE,
    'DELETE FROM offline_sync_claims WHERE terminal_id = ?',
    [terminalId],
  ).catch(() => null)
  await siteExecute(SITE, 'DELETE FROM sales_documents WHERE terminal_id = ?', [terminalId])
  await siteExecute(SITE, 'DELETE FROM document_sequences WHERE terminal_id = ?', [terminalId])
  await siteExecute(SITE, 'DELETE FROM terminals WHERE id = ?', [terminalId])
  await siteExecute(SITE, 'DELETE FROM stock_movements WHERE product_id = ?', [productId])
  await siteExecute(SITE, 'DELETE FROM product_prices WHERE product_id = ?', [productId])
  await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [productId])

  console.log(fails === 0 ? '\nAll offline sync checks passed.' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

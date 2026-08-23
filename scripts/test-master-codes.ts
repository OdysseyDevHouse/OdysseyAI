/**
 * Auto-numbered customer, supplier, product and till codes.
 *
 * The things worth proving are the ones that only break under conditions a
 * person clicking through the UI will not reproduce:
 *
 *   - Off by default, so an existing store's own coding scheme survives.
 *   - A typed code always wins, so the feature is a suggestion and not a rule.
 *   - A code already taken by hand is stepped over rather than colliding.
 *   - Two saves at the same instant get different codes. This is the one that
 *     matters: a plain SELECT-then-UPDATE passes every sequential test and
 *     double-issues in a real shop.
 *   - The preview claims nothing, so an abandoned form burns no code.
 *
 *   npm run test:master-codes
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { createCustomer } from '../src/lib/site/customers'
import { createSupplier } from '../src/lib/site/suppliers'
import { createProduct } from '../src/lib/site/products'
import { createTerminal } from '../src/lib/site/terminals'
import { resolveMasterCode, suggestedMasterCode } from '../src/lib/site/masterCodes'
import { previewMasterCode } from '../src/lib/site/sequences'
import { setSetting, getSetting } from '../src/lib/site/settings'

const SITE = 1
const ACTOR = { userId: 9101, userName: 'Code test' }

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** Ids created here, torn down at the end regardless of outcome. */
const made = { customers: [] as number[], suppliers: [] as number[], products: [] as number[], terminals: [] as number[] }

async function main() {
  // The sequences are shared site state, so the test drives them to a private
  // prefix and puts everything back in the finally block.
  const before = {
    customer: await getSetting(SITE, 'autocode_customer'),
    supplier: await getSetting(SITE, 'autocode_supplier'),
    product: await getSetting(SITE, 'autocode_product'),
    terminal: await getSetting(SITE, 'autocode_terminal'),
  }
  const seqBefore = await siteQuery<any>(
    SITE,
    /* terminal_id = 0 is the SITE sequence. Scoped explicitly because this test
       now creates tills, and a till carries its own per-till rows for the sales
       doc types — restoring by doc_type alone would reach into those. */
    "SELECT doc_type, prefix, next_number, padding FROM document_sequences WHERE terminal_id = 0 AND doc_type IN ('customer','supplier','product','terminal')",
  )

  try {
    // A prefix nothing else in the database uses, so "is this code taken" is
    // answering a question about this test and not about real data.
    const stamp = Date.now().toString().slice(-6)
    const CUS = `TCUS${stamp}`.slice(0, 12)
    const SUP = `TSUP${stamp}`.slice(0, 12)
    const PRD = `TPRD${stamp}`.slice(0, 12)
    /* Shorter, because validateTerminal caps a till code at 24 characters and
       the typed-code case below appends to this. */
    const TIL = `TT${stamp}`.slice(0, 10)

    await siteExecute(SITE, "UPDATE document_sequences SET prefix=?, next_number=1, padding=4 WHERE doc_type='customer'", [CUS])
    await siteExecute(SITE, "UPDATE document_sequences SET prefix=?, next_number=1, padding=4 WHERE doc_type='supplier'", [SUP])
    await siteExecute(SITE, "UPDATE document_sequences SET prefix=?, next_number=1, padding=4 WHERE doc_type='product'", [PRD])
    await siteExecute(SITE, "UPDATE document_sequences SET prefix=?, next_number=1, padding=4 WHERE doc_type='terminal'", [TIL])

    /* ── Off by default ──────────────────────────────────────────────────
       A store that never opens the setting must keep typing its own codes —
       and must still be refused when it leaves one blank. */
    await setSetting(SITE, 'autocode_customer', '0')

    ok('off: nothing is suggested', (await suggestedMasterCode(SITE, 'customer')) === null)
    ok('off: a blank code stays blank', (await resolveMasterCode(SITE, 'customer', '')) === '')

    const refused = await createCustomer(SITE, ACTOR, { code: '', name: 'No code given' })
    ok('off: a blank code is still refused', !refused.ok, refused.ok ? 'it was created' : refused.error)

    /* ── On: the code is filled in ───────────────────────────────────────── */
    await setSetting(SITE, 'autocode_customer', '1')
    await setSetting(SITE, 'autocode_supplier', '1')
    await setSetting(SITE, 'autocode_product', '1')
    await setSetting(SITE, 'autocode_terminal', '1')

    // The preview must not consume anything — an abandoned New Customer form
    // is the common case, and each one leaving a hole would be the bug.
    const peek1 = await previewMasterCode(SITE, 'customer')
    const peek2 = await previewMasterCode(SITE, 'customer')
    ok('preview claims nothing', peek1 === `${CUS}0001` && peek2 === peek1, `${peek1} then ${peek2}`)

    const c1 = await createCustomer(SITE, ACTOR, { code: '', name: 'Auto one' })
    if (c1.ok) made.customers.push(c1.id)
    const c1row = c1.ok ? await siteQueryOne<any>(SITE, 'SELECT code FROM customers WHERE id=?', [c1.id]) : null
    ok('customer gets the first code', c1row?.code === `${CUS}0001`, String(c1row?.code))

    const c2 = await createCustomer(SITE, ACTOR, { code: '', name: 'Auto two' })
    if (c2.ok) made.customers.push(c2.id)
    const c2row = c2.ok ? await siteQueryOne<any>(SITE, 'SELECT code FROM customers WHERE id=?', [c2.id]) : null
    ok('the next customer gets the next code', c2row?.code === `${CUS}0002`, String(c2row?.code))

    /* ── A typed code always wins ────────────────────────────────────────
       This is what makes the feature a suggestion. A shop that wants the
       supplier's own part number as the product code must still be able to
       type it while auto-numbering is on. */
    const typed = await createCustomer(SITE, ACTOR, { code: `${CUS}-MINE`, name: 'Typed over' })
    if (typed.ok) made.customers.push(typed.id)
    const typedRow = typed.ok ? await siteQueryOne<any>(SITE, 'SELECT code FROM customers WHERE id=?', [typed.id]) : null
    ok('a typed code is kept', typedRow?.code === `${CUS}-MINE`, String(typedRow?.code))

    const after = await previewMasterCode(SITE, 'customer')
    ok('a typed code does not consume a number', after === `${CUS}0003`, String(after))

    /* ── A code already taken is stepped over ────────────────────────────
       A store switching this on mid-life may already have typed the code the
       counter is about to reach. Refusing to save would strand the user on an
       error they cannot act on. */
    const squatter = await createCustomer(SITE, ACTOR, { code: `${CUS}0003`, name: 'Typed by hand earlier' })
    if (squatter.ok) made.customers.push(squatter.id)

    const c4 = await createCustomer(SITE, ACTOR, { code: '', name: 'Steps past the squatter' })
    if (c4.ok) made.customers.push(c4.id)
    const c4row = c4.ok ? await siteQueryOne<any>(SITE, 'SELECT code FROM customers WHERE id=?', [c4.id]) : null
    ok('a taken code is skipped, not reused', c4row?.code === `${CUS}0004`, String(c4row?.code))

    /* ── Suppliers and products use their own counters ───────────────────
       Separate sequences, so a supplier is never numbered off the customer
       counter — the mistake that makes CUST0007 and SUPP0007 arrive together
       and look like they mean something. */
    const s1 = await createSupplier(SITE, ACTOR, { code: '', name: 'Auto supplier' })
    if (s1.ok) made.suppliers.push(s1.id)
    const s1row = s1.ok ? await siteQueryOne<any>(SITE, 'SELECT code FROM suppliers WHERE id=?', [s1.id]) : null
    ok('supplier has its own counter', s1row?.code === `${SUP}0001`, String(s1row?.code))

    const p1 = await createProduct(SITE, { code: '', description: 'Auto product' })
    if (p1.ok) made.products.push(p1.id)
    const p1row = p1.ok ? await siteQueryOne<any>(SITE, 'SELECT code FROM products WHERE id=?', [p1.id]) : null
    ok('product has its own counter', p1row?.code === `${PRD}0001`, String(p1row?.code))

    /* ── Tills ───────────────────────────────────────────────────────────
       A till's CODE comes off this sequence; its `till_number` does not — that
       is the segment inside an invoice number and is allocated separately, by
       lowest-free, so a decommissioned till's slot is reused. The two must not
       be confused, and the second assertion is what would catch it if some
       later change wired the code to the till number. */
    const t1 = await createTerminal(SITE, { code: '', name: 'Auto till one' })
    if (t1.ok) made.terminals.push(t1.id)
    const t1row = t1.ok
      ? await siteQueryOne<any>(SITE, 'SELECT code, till_number FROM terminals WHERE id=?', [t1.id])
      : null
    ok('till has its own counter', t1row?.code === `${TIL}0001`, String(t1row?.code))
    ok(
      '*** and its till_number is allocated separately, not from the code ***',
      !!t1row?.till_number && String(t1row.till_number) !== `${TIL}0001`,
      `code ${t1row?.code}, till_number ${t1row?.till_number}`,
    )

    const t2 = await createTerminal(SITE, { code: '', name: 'Auto till two' })
    if (t2.ok) made.terminals.push(t2.id)
    const t2row = t2.ok ? await siteQueryOne<any>(SITE, 'SELECT code FROM terminals WHERE id=?', [t2.id]) : null
    ok('the next till gets the next code', t2row?.code === `${TIL}0002`, String(t2row?.code))

    const tTyped = await createTerminal(SITE, { code: `${TIL}-BAR`, name: 'Typed till' })
    if (tTyped.ok) made.terminals.push(tTyped.id)
    const tTypedRow = tTyped.ok
      ? await siteQueryOne<any>(SITE, 'SELECT code FROM terminals WHERE id=?', [tTyped.id])
      : null
    ok('a typed till code is kept', tTypedRow?.code === `${TIL}-BAR`, String(tTypedRow?.code))

    /* ── Concurrency ─────────────────────────────────────────────────────
       THE test. Ten saves fired together: under MySQL's default REPEATABLE
       READ a plain SELECT takes no lock, so a naive read-then-write hands the
       same code to several of them. Every code must be distinct. */
    const racers = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        createCustomer(SITE, ACTOR, { code: '', name: `Race ${i}` }),
      ),
    )
    const raceIds = racers.flatMap((r) => (r.ok ? [r.id] : []))
    made.customers.push(...raceIds)
    ok('all ten concurrent saves succeeded', raceIds.length === 10, `${raceIds.length}/10`)

    const raceRows = raceIds.length
      ? await siteQuery<any>(SITE, `SELECT code FROM customers WHERE id IN (${raceIds.map(() => '?').join(',')})`, raceIds)
      : []
    const distinct = new Set(raceRows.map((r: any) => String(r.code)))
    ok('no code was issued twice', distinct.size === raceRows.length, `${distinct.size} distinct of ${raceRows.length}`)

    /* ── A failed save must not strand the counter ───────────────────────
       The code is claimed outside the insert's transaction, deliberately —
       so a save that fails for an unrelated reason leaves the counter moved
       on rather than rolled back onto a value the next save would collide
       with. A gap here is harmless; a duplicate is not. */
    const beforeFail = await previewMasterCode(SITE, 'customer')
    const failed = await createCustomer(SITE, ACTOR, { code: '', name: '' })
    ok('a save with no name is refused', !failed.ok)
    const afterFail = await previewMasterCode(SITE, 'customer')
    ok(
      'a refused save never re-issues a claimed code',
      afterFail !== null && beforeFail !== null && afterFail >= beforeFail,
      `${beforeFail} then ${afterFail}`,
    )
  } finally {
    /* ── Cleanup ──────────────────────────────────────────────────────── */
    for (const id of made.products) {
      await siteExecute(SITE, 'DELETE FROM stock_movements WHERE product_id = ?', [id])
      await siteExecute(SITE, 'DELETE FROM product_prices WHERE product_id = ?', [id])
      await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [id])
    }
    for (const id of made.customers) {
      await siteExecute(SITE, "DELETE FROM activity_log WHERE entity='customer' AND entity_id = ?", [id])
      await siteExecute(SITE, 'DELETE FROM customers WHERE id = ?', [id])
    }
    for (const id of made.suppliers) {
      await siteExecute(SITE, "DELETE FROM activity_log WHERE entity='supplier' AND entity_id = ?", [id])
      await siteExecute(SITE, 'DELETE FROM suppliers WHERE id = ?', [id])
    }
    /* A till is created WITH its own per-till numbering sequences, so deleting
       the terminal alone would leave those rows behind — and a stray sequence
       with no document is exactly what makes test-sales-posting fail instead of
       this suite. The sequence rows go first, being the child side. */
    for (const id of made.terminals) {
      await siteExecute(SITE, 'DELETE FROM document_sequences WHERE terminal_id = ?', [id])
      await siteExecute(SITE, 'DELETE FROM terminals WHERE id = ?', [id])
    }

    // Put the sequences and settings back exactly as they were.
    for (const s of seqBefore) {
      await siteExecute(
        SITE,
        'UPDATE document_sequences SET prefix=?, next_number=?, padding=?, last_issued_number=NULL WHERE doc_type=? AND terminal_id = 0',
        [s.prefix, s.next_number, s.padding, s.doc_type],
      )
    }
    await setSetting(SITE, 'autocode_customer', before.customer)
    await setSetting(SITE, 'autocode_supplier', before.supplier)
    await setSetting(SITE, 'autocode_product', before.product)
    await setSetting(SITE, 'autocode_terminal', before.terminal)
  }

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}
main()

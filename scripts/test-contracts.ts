/*
 * Exercises contract billing against a real site database.
 *
 *   npm run test:contracts -- [siteId]
 *
 * Everything it creates is torn down at the end, INCLUDING posted invoices and
 * their debtor transactions — so it must only ever be pointed at a development
 * site. It refuses to run if the site already has contracts, rather than risk
 * cleaning up something real.
 *
 * What it proves, in order:
 *   1. A contract bills its due periods and no more.
 *   2. Running the tick twice does not bill twice.
 *   3. A missed quarter catches up as separate invoices.
 *   4. A back-dated invoice carries the price of ITS period, not today's.
 *   5. auto_send posts to the debtor; without it the invoice stays a draft.
 *   6. A blocked account leaves a draft with the reason, not a silent failure.
 */
import { siteQuery, siteExecute } from '../src/lib/siteDb'
import {
  saveContract,
  getContract,
  generateDue,
  billNow,
  contractInvoices,
  contractSummary,
  listContracts,
} from '../src/lib/site/contracts'
import type { Actor } from '../src/lib/site/activityLog'

const siteId = Number(process.argv[2] || 1)
const actor: Actor = { userId: 1, userName: 'Contract test' }

let pass = 0
let fail = 0
const created: number[] = []

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}\n         expected ${e}\n         actual   ${a}`)
  }
}

function ok(label: string, condition: boolean, detail = '') {
  if (condition) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}${detail ? `\n         ${detail}` : ''}`)
  }
}

async function main() {
  const existing = await siteQuery<{ n: number }>(siteId, 'SELECT COUNT(*) AS n FROM contracts')
  if (Number(existing[0]?.n ?? 0) > 0) {
    console.error(
      `Site ${siteId} already has contracts. This script deletes what it finds, so it refuses to run here.`,
    )
    process.exit(1)
  }

  const customers = await siteQuery<{ id: number; name: string; status: string }>(
    siteId,
    "SELECT id, name, status FROM customers WHERE status = 'active' ORDER BY id LIMIT 2",
  )
  const held = await siteQuery<{ id: number; name: string }>(
    siteId,
    "SELECT id, name FROM customers WHERE status = 'on_hold' ORDER BY id LIMIT 1",
  )
  if (customers.length < 2) {
    console.error('Need at least two active customers to test with.')
    process.exit(1)
  }

  const product = await siteQuery<{ id: number; code: string; description: string }>(
    siteId,
    'SELECT id, code, description FROM products ORDER BY id LIMIT 1',
  )

  const line = {
    productId: product[0]?.id ?? null,
    productCode: product[0]?.code ?? null,
    description: product[0]?.description ?? 'Monthly monitoring',
    qty: 1,
    unitPriceIncl: 1000,
    vatRatePct: 15,
    departmentId: null,
  }

  /* ── 1. Basic billing ───────────────────────────────────────────────── */
  console.log('\n── a monthly contract bills its due periods ────────────────')

  const saved = await saveContract(siteId, actor, {
    name: 'TEST — monthly monitoring',
    customerId: customers[0]!.id,
    frequency: 'monthly',
    billingDay: 1,
    startsOn: '2026-01-01',
    endsOn: null,
    escalationPct: 8,
    escalationMonth: 3,
    autoSend: false,
    offerPaymentLink: true,
    paymentTermsDays: 30,
    reference: null,
    notes: null,
    internalNote: null,
    lines: [line],
  })
  ok('contract saved', saved.ok, saved.ok ? '' : (saved as { error: string }).error)
  if (!saved.ok) return
  created.push(saved.id)

  const contract = await getContract(siteId, saved.id)
  ok('it has a CON number', !!contract?.contractNumber, `got ${contract?.contractNumber}`)
  check('per-period value', contract?.totalIncl, 1000)
  check('annual value', contract?.annualValue, 12000)
  check('base price recorded', contract?.lines[0]?.basePriceIncl, 1000)

  // Bill as at 2026-02-15: January and February are due.
  const first = await billNow(siteId, actor, saved.id, '2026-02-15')
  check('two periods billed', first.generated.map((g) => g.forDate), ['2026-01-01', '2026-02-01'])
  check('no escalation yet', first.escalated.length, 0)
  check('billed at the agreed price', first.generated[0]?.totalIncl, 1000)

  /* ── 2. Idempotence ─────────────────────────────────────────────────── */
  console.log('\n── running it again bills nothing ──────────────────────────')

  const again = await billNow(siteId, actor, saved.id, '2026-02-15')
  check('nothing billed twice', again.generated.length, 0)
  const afterTwice = await contractInvoices(siteId, saved.id)
  check('still exactly two invoices', afterTwice.length, 2)

  /* ── 3. Catch-up + escalation on a back-dated period ────────────────── */
  console.log('\n── catch-up, and back-dated prices ─────────────────────────')

  // Jump to 2027-05-15. The contract starts 2026-01-01 and escalates every
  // March, so TWO raises are now owed — March 2026 and March 2027 — compounding
  // 1000 → 1080 → 1166.40. Each back-dated invoice must carry the price that
  // was correct for ITS month, not the price after both raises.
  const catchUp = await billNow(siteId, actor, saved.id, '2027-05-15')
  check('one contract escalated', catchUp.escalated.length, 1)
  check('two raises applied at once', catchUp.escalated[0]?.times, 2)
  check(
    'compounded 1000 → 1166.40',
    [catchUp.escalated[0]?.from, catchUp.escalated[0]?.to],
    [1000, 1166.4],
  )

  const byDate = new Map(catchUp.generated.map((g) => [g.forDate, g.totalIncl]))
  check('Feb 2026 — before any raise', byDate.get('2026-02-01'), undefined) // billed earlier
  check('Mar 2026 — first raise applies', byDate.get('2026-03-01'), 1080)
  check('Dec 2026 — still the first raise', byDate.get('2026-12-01'), 1080)
  check('Feb 2027 — still the first raise', byDate.get('2027-02-01'), 1080)
  check('Mar 2027 — second raise applies', byDate.get('2027-03-01'), 1166.4)
  check('May 2027 — second raise', byDate.get('2027-05-01'), 1166.4)

  const afterCatchUp = await getContract(siteId, saved.id)
  check('contract now priced at 1166.40', afterCatchUp?.totalIncl, 1166.4)
  check('base price unchanged by escalation', afterCatchUp?.lines[0]?.basePriceIncl, 1000)
  check('escalation stamped to the latest', afterCatchUp?.lastEscalatedFor, '2027-03-01')

  const all = await contractInvoices(siteId, saved.id, 200)
  // Jan 2026 → May 2027 inclusive is 17 months.
  check('seventeen invoices in total', all.length, 17)
  check('all still drafts (auto_send off)', all.every((i) => i.status === 'draft'), true)

  /* ── 4. Quarterly ───────────────────────────────────────────────────── */
  console.log('\n── a quarterly contract ────────────────────────────────────')

  const quarterly = await saveContract(siteId, actor, {
    name: 'TEST — quarterly service',
    customerId: customers[1]!.id,
    frequency: 'quarterly',
    billingDay: 15,
    startsOn: '2026-01-15',
    endsOn: null,
    escalationPct: 0,
    escalationMonth: null,
    autoSend: false,
    offerPaymentLink: false,
    paymentTermsDays: 30,
    reference: null,
    notes: null,
    internalNote: null,
    lines: [{ ...line, unitPriceIncl: 2500 }],
  })
  if (!quarterly.ok) {
    ok('quarterly saved', false, (quarterly as { error: string }).error)
    return
  }
  created.push(quarterly.id)

  const q = await billNow(siteId, actor, quarterly.id, '2026-08-01')
  check(
    'three quarters billed',
    q.generated.map((g) => g.forDate),
    ['2026-01-15', '2026-04-15', '2026-07-15'],
  )
  check('quarterly annual value', (await getContract(siteId, quarterly.id))?.annualValue, 10000)

  /* ── 5. auto_send actually posts ────────────────────────────────────── */
  console.log('\n── auto_send posts to the account ──────────────────────────')

  const auto = await saveContract(siteId, actor, {
    name: 'TEST — auto-send',
    customerId: customers[0]!.id,
    frequency: 'monthly',
    billingDay: 1,
    startsOn: '2026-06-01',
    endsOn: '2026-06-30',
    escalationPct: 0,
    escalationMonth: null,
    autoSend: true,
    offerPaymentLink: true,
    paymentTermsDays: 30,
    reference: null,
    notes: null,
    internalNote: null,
    lines: [{ ...line, unitPriceIncl: 50 }],
  })
  if (!auto.ok) {
    ok('auto-send contract saved', false, (auto as { error: string }).error)
  } else {
    created.push(auto.id)
    const autoRun = await billNow(siteId, actor, auto.id, '2026-06-15')
    check('one invoice billed', autoRun.generated.length, 1)
    ok('it posted', autoRun.generated[0]?.posted === true, JSON.stringify(autoRun))

    const rows = await contractInvoices(siteId, auto.id)
    check('recorded as posted', rows[0]?.status, 'posted')
    ok('it has an invoice number', !!rows[0]?.documentNumber, `got ${rows[0]?.documentNumber}`)

    const txn = await siteQuery<{ n: number }>(
      siteId,
      'SELECT COUNT(*) AS n FROM customer_transactions WHERE source_doc_id = ?',
      [rows[0]?.documentId],
    )
    check('a debtor transaction exists', Number(txn[0]?.n ?? 0) >= 1, true)
  }

  /* ── 6. A blocked account fails safe ────────────────────────────────── */
  if (held.length > 0) {
    console.log('\n── an on-hold account leaves a draft, with a reason ────────')

    const blocked = await saveContract(siteId, actor, {
      name: 'TEST — held account',
      customerId: held[0]!.id,
      frequency: 'monthly',
      billingDay: 1,
      startsOn: '2026-06-01',
      endsOn: '2026-06-30',
      escalationPct: 0,
      escalationMonth: null,
      autoSend: true,
      offerPaymentLink: false,
      paymentTermsDays: 30,
      reference: null,
      notes: null,
      internalNote: null,
      lines: [{ ...line, unitPriceIncl: 75 }],
    })
    if (blocked.ok) {
      created.push(blocked.id)
      const run = await billNow(siteId, actor, blocked.id, '2026-06-15')
      const rows = await contractInvoices(siteId, blocked.id)
      ok('the invoice was still created', run.generated.length === 1)
      check('but left as a draft', rows[0]?.status, 'draft')
      ok('and the reason was recorded', !!rows[0]?.error, `error was ${rows[0]?.error}`)
      console.log(`         reason: ${rows[0]?.error}`)
    } else {
      ok('held-account contract saved', false, (blocked as { error: string }).error)
    }
  }

  /* ── 7. Validation refusals ─────────────────────────────────────────── */
  console.log('\n── it refuses what it should ───────────────────────────────')

  const noLines = await saveContract(siteId, actor, {
    name: 'TEST — bad', customerId: customers[0]!.id, frequency: 'monthly', billingDay: 1,
    startsOn: '2026-01-01', endsOn: null, escalationPct: 0, escalationMonth: null,
    autoSend: false, offerPaymentLink: false, paymentTermsDays: 30,
    reference: null, notes: null, internalNote: null, lines: [],
  })
  check('no lines refused', noLines.ok, false)

  const badEsc = await saveContract(siteId, actor, {
    name: 'TEST — bad', customerId: customers[0]!.id, frequency: 'monthly', billingDay: 1,
    startsOn: '2026-01-01', endsOn: null, escalationPct: 8, escalationMonth: null,
    autoSend: false, offerPaymentLink: false, paymentTermsDays: 30,
    reference: null, notes: null, internalNote: null, lines: [line],
  })
  check('escalation without a month refused', badEsc.ok, false)

  const backwards = await saveContract(siteId, actor, {
    name: 'TEST — bad', customerId: customers[0]!.id, frequency: 'monthly', billingDay: 1,
    startsOn: '2026-06-01', endsOn: '2026-01-01', escalationPct: 0, escalationMonth: null,
    autoSend: false, offerPaymentLink: false, paymentTermsDays: 30,
    reference: null, notes: null, internalNote: null, lines: [line],
  })
  check('ends-before-starts refused', backwards.ok, false)

  /* ── 8. Summary + the whole-site tick ───────────────────────────────── */
  console.log('\n── summary and the site-wide tick ──────────────────────────')

  const summary = await contractSummary(siteId)
  ok('summary counts the contracts', summary.active >= 2, JSON.stringify(summary))
  console.log(`         ${JSON.stringify(summary)}`)

  const list = await listContracts(siteId)
  check('list returns them all', list.length, created.length)

  // A tick as at a date everything has already been billed for: must be quiet.
  const quiet = await generateDue(siteId, actor, '2026-02-15')
  check('a caught-up tick bills nothing new', quiet.generated.length, 0)
}

async function cleanup() {
  console.log('\n── cleaning up ─────────────────────────────────────────────')
  for (const id of created) {
    const invoices = await contractInvoices(siteId, id, 500)
    for (const inv of invoices) {
      if (!inv.documentId) continue
      // Debtor transactions and their allocations first, then the document.
      const txns = await siteQuery<{ id: number }>(
        siteId,
        'SELECT id FROM customer_transactions WHERE source_doc_id = ?',
        [inv.documentId],
      )
      for (const t of txns) {
        await siteExecute(siteId, 'DELETE FROM customer_allocations WHERE transaction_id = ? OR allocated_to_id = ?', [t.id, t.id]).catch(() => {})
        await siteExecute(siteId, 'DELETE FROM customer_transactions WHERE id = ?', [t.id])
      }
      await siteExecute(siteId, 'DELETE FROM stock_movements WHERE document_id = ?', [inv.documentId]).catch(() => {})
      await siteExecute(siteId, 'DELETE FROM document_tenders WHERE document_id = ?', [inv.documentId]).catch(() => {})
      await siteExecute(siteId, 'DELETE FROM document_audit WHERE document_id = ?', [inv.documentId]).catch(() => {})
      await siteExecute(siteId, 'DELETE FROM sales_document_lines WHERE document_id = ?', [inv.documentId])
      await siteExecute(siteId, 'DELETE FROM sales_documents WHERE id = ?', [inv.documentId])
    }
    await siteExecute(siteId, 'DELETE FROM contracts WHERE id = ?', [id])
  }

  // Put the customers' balances back where they were.
  await siteExecute(
    siteId,
    `UPDATE customers c SET balance = COALESCE(
       (SELECT SUM(amount_signed) FROM customer_transactions WHERE customer_id = c.id), 0)`,
  )
  console.log(`  removed ${created.length} contract(s) and everything they produced`)
}

main()
  .catch((e) => {
    fail++
    console.error('\nUNCAUGHT:', e instanceof Error ? e.stack : e)
  })
  .then(cleanup)
  .catch((e) => console.error('cleanup failed:', e instanceof Error ? e.message : e))
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed\n`)
    process.exit(fail ? 1 : 0)
  })

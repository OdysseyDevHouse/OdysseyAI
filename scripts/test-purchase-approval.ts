/**
 * The approval threshold on a purchase order.
 *
 * ── WHAT IS ACTUALLY BEING PROTECTED ──────────────────────────────────────
 *
 * That a person without the right cannot commit the shop to a large spend.
 * Issuing is the act that does that — it claims the document number and makes
 * the order something a supplier can hold us to — so the check has to live in
 * issueOrder() and not on the screen. A test that only proved a button was
 * greyed out would prove nothing at all: the URL is typeable and the action is
 * callable.
 *
 * The other half is that the gate is OFF by default and stays off for the
 * shops that never configure it. A control that arrives switched on is a
 * control that gets switched off in a hurry, usually for good.
 *
 * ── THE THRESHOLD IS VAT-INCLUSIVE ────────────────────────────────────────
 *
 * Deliberately, and it is worth an assertion of its own: an order whose
 * EXCLUSIVE total sits under the line but whose inclusive total sits over it
 * must be caught. Reading the exclusive figure would wave through every order
 * at 15% above whatever number the owner typed.
 *
 *   npm run test:purchase-approval
 */
import type { RowDataPacket } from 'mysql2/promise'
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import {
  approvalGate,
  saveOrder,
  issueOrder,
  getPurchaseDocument,
} from '../src/lib/site/purchaseDocuments'
import { createSupplier } from '../src/lib/site/suppliers'
import { defaultVat, listVatRates } from '../src/lib/site/lookups'
import { getSetting, setSetting } from '../src/lib/site/settings'
import type { CapabilitySet } from '../src/lib/site/permissions'

const SITE = 1
const actor = { userId: 1, userName: 'Approval Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** A buyer: may raise and issue orders, may not approve a large one. */
const buyer: CapabilitySet = {
  isOwner: false,
  granted: new Set(['purchasing.view', 'purchasing.edit']),
}
/** A manager: the same, plus the right to sign one off. */
const approver: CapabilitySet = {
  isOwner: false,
  granted: new Set(['purchasing.view', 'purchasing.edit', 'purchasing.approve']),
}
/** An owner holds everything implicitly — see can(). */
const owner: CapabilitySet = { isOwner: true, granted: new Set() }

async function main() {
  const stamp = Date.now().toString().slice(-8)
  // Restored in the finally: this is a SHARED site setting, and leaving a
  // threshold behind would make every later suite's orders need approval.
  const originalThreshold = await getSetting(SITE, 'purchase_approval_threshold')

  const sup = await createSupplier(SITE, actor, {
    code: `APV${stamp}`,
    name: 'Approval Test Suppliers',
    paymentTermsDays: 30,
    leadTimeDays: 5,
  })
  if (!sup.ok) {
    console.log('setup failed:', sup.error)
    process.exit(1)
  }

  const p = await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, visible_in_pos)
     VALUES (?,?,'normal',0,0,0,1)`,
    [`AP${stamp}`, `Approval test item ${stamp}`],
  )
  const productId = p.insertId

  const rates = await listVatRates(SITE)
  const rate = (defaultVat(rates, 'purchase') ?? defaultVat(rates, 'sales'))?.rate ?? 15

  /** A fresh draft of a given EXCLUSIVE value. */
  async function draftWorth(exclTotal: number): Promise<number> {
    const r = await saveOrder(SITE, actor, {
      supplierId: sup.ok ? sup.id : 0,
      reference: `Approval ${stamp}`,
      lines: [
        {
          productId,
          description: `Approval test item ${stamp}`,
          qtyOrdered: 1,
          unitCostExcl: exclTotal,
          vatRatePct: rate,
        },
      ],
    })
    if (!r.ok) throw new Error(r.error)
    return r.id
  }

  try {
    /* ── off by default ─────────────────────────────────────────────────── */
    console.log('\n── Switched off ──')

    await setSetting(SITE, 'purchase_approval_threshold', '0')

    const offGate = await approvalGate(SITE, 1_000_000)
    ok('*** ZERO MEANS OFF, however large the order ***', !offGate.needed)

    const cheap = await draftWorth(100)
    ok('a buyer can issue with no threshold set',
      (await issueOrder(SITE, actor, cheap, buyer)).ok)

    /* ── the gate itself ────────────────────────────────────────────────── */
    console.log('\n── The line, at R1,000 ──')

    await setSetting(SITE, 'purchase_approval_threshold', '1000')

    ok('under the line does not need approval', !(await approvalGate(SITE, 999)).needed)
    ok('*** exactly ON the line does not need approval ***',
      !(await approvalGate(SITE, 1000)).needed)
    ok('a cent over does', (await approvalGate(SITE, 1000.01)).needed)
    ok('  and it reports the threshold', (await approvalGate(SITE, 5000)).threshold === 1000,
      String((await approvalGate(SITE, 5000)).threshold))

    /* ── who may issue ──────────────────────────────────────────────────── */
    console.log('\n── Who may commit the spend ──')

    // 900 excl at 15% is 1035 incl — UNDER the line exclusive, OVER it
    // inclusive. The whole point of reading the inclusive figure.
    const straddling = await draftWorth(900)
    const straddleDoc = await getPurchaseDocument(SITE, straddling)
    ok('  (a R900 line comes to over R1,000 with VAT)',
      Number(straddleDoc?.totalIncl) > 1000,
      `excl ${straddleDoc?.subtotalExcl}, incl ${straddleDoc?.totalIncl}`)

    const straddleBlocked = await issueOrder(SITE, actor, straddling, buyer)
    ok('*** THE THRESHOLD IS VAT-INCLUSIVE — a buyer is refused ***',
      !straddleBlocked.ok, straddleBlocked.ok ? 'issued!' : straddleBlocked.error)

    let stillDraft = await getPurchaseDocument(SITE, straddling)
    ok('*** and the order is untouched — still a draft ***',
      stillDraft?.status === 'draft', String(stillDraft?.status))
    ok('*** with NO document number claimed ***',
      stillDraft?.documentNumber === null, String(stillDraft?.documentNumber))

    const big = await draftWorth(5000)
    const blocked = await issueOrder(SITE, actor, big, buyer)
    ok('a buyer cannot issue a large order', !blocked.ok,
      blocked.ok ? 'issued!' : blocked.error)
    ok('  and the message says what to do',
      !blocked.ok && /approve/i.test(blocked.error), blocked.ok ? '' : blocked.error)

    stillDraft = await getPurchaseDocument(SITE, big)
    ok('  it stays a draft', stillDraft?.status === 'draft')

    // A draft blocked on approval must still be workable — that is the whole
    // reason 'draft' is the pending state rather than a new status.
    const edited = await saveOrder(
      SITE,
      actor,
      {
        supplierId: sup.id,
        reference: `Approval ${stamp} edited`,
        lines: [
          {
            productId,
            description: `Approval test item ${stamp}`,
            qtyOrdered: 1,
            unitCostExcl: 5000,
            vatRatePct: rate,
          },
        ],
      },
      // The document id is the FOURTH argument, not a field on the input —
      // passing it as `{ id }` silently saved a brand-new draft instead, so
      // this assertion proved nothing until the typechecker caught it.
      big,
    )
    ok('*** a blocked draft can still be EDITED while it waits ***', edited.ok,
      edited.ok ? '' : edited.error)
    ok('  and the edit landed on the SAME draft', edited.ok && edited.id === big,
      edited.ok ? `${edited.id} vs ${big}` : '')
    const editedDoc = await getPurchaseDocument(SITE, big)
    ok('  which now carries the new reference',
      editedDoc?.reference === `Approval ${stamp} edited`, String(editedDoc?.reference))

    const approved = await issueOrder(SITE, actor, big, approver)
    ok('*** an approver CAN issue it ***', approved.ok,
      approved.ok ? '' : approved.error)

    const issuedDoc = await getPurchaseDocument(SITE, big)
    ok('  and it is issued', issuedDoc?.status === 'issued', String(issuedDoc?.status))
    ok('  with a number', !!issuedDoc?.documentNumber, String(issuedDoc?.documentNumber))

    const ownersOrder = await draftWorth(5000)
    ok('*** an owner may issue without the explicit right ***',
      (await issueOrder(SITE, actor, ownersOrder, owner)).ok)

    /* ── the check cannot be skipped ────────────────────────────────────── */
    console.log('\n── The boundary is the action ──')

    const sneaky = await draftWorth(5000)
    // No capabilities passed at all: the signature allows it for callers where
    // the question does not arise, and it MUST NOT become a way around the
    // gate for the one caller that stands in front of a person. The action
    // always passes them — asserted here so that stays true.
    ok('a caller passing no capabilities is not checked (by design)',
      (await issueOrder(SITE, actor, sneaky, undefined)).ok)

    const actionSrc = await import('node:fs').then((fs) =>
      fs.readFileSync('src/app/(app)/purchasing/actions.ts', 'utf8'),
    )
    const forwards = /issueOrder\(siteId,\s*actor,\s*id,\s*capabilities\)/.test(actionSrc)
    ok('*** and the real action DOES pass them ***', forwards,
      forwards ? '' : 'issueOrderAction no longer forwards capabilities')
  } finally {
    await setSetting(SITE, 'purchase_approval_threshold', originalThreshold).catch(() => {})
    const restored = await getSetting(SITE, 'purchase_approval_threshold').catch(() => '?')
    ok('the site threshold is put back', restored === originalThreshold,
      `${restored} vs ${originalThreshold}`)

    const supId = sup.ok ? sup.id : 0
    for (const table of [
      'purchase_document_audit',
      'purchase_order_details',
      'purchase_document_lines',
    ]) {
      await siteExecute(
        SITE,
        `DELETE FROM ${table} WHERE document_id IN
           (SELECT id FROM purchase_documents WHERE supplier_id = ?)`,
        [supId],
      ).catch(() => {})
    }
    await siteExecute(SITE, 'DELETE FROM purchase_documents WHERE supplier_id = ?', [supId])
      .catch(() => {})
    await siteExecute(SITE, 'DELETE FROM product_suppliers WHERE product_id = ?', [productId])
      .catch(() => {})
    await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [productId]).catch(() => {})

    const left = await siteQueryOne<RowDataPacket & { n: number }>(
      SITE,
      'SELECT COUNT(*) AS n FROM products WHERE id = ?',
      [productId],
    ).catch(() => null)
    ok('test records cleaned up', Number(left?.n ?? 0) === 0, String(left?.n))
  }

  console.log(`\n${fails === 0 ? 'All good.' : `${fails} FAILED`}\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

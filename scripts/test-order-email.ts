/**
 * Emailing a purchase order to its supplier.
 *
 * The transport is injected (MailDeps), so this proves the whole flow — the
 * stationery render included — without an SMTP host. What matters:
 *
 *   · a DRAFT is refused: it has no number for the supplier to quote back, so
 *     sending one asks for goods the business has not actually ordered;
 *   · the body is the ORDER, rendered from the same stationery the print route
 *     uses — not a covering note with the real document somewhere else;
 *   · the logo travels. logoImgTag points at /api/document-logo, which is
 *     useless in an inbox, so no app-relative src may survive into the message;
 *   · a second send is recorded as its own action, because "did this supplier
 *     get two copies" is the question asked afterwards;
 *   · nothing about the order moves. Emailing is communication, not posting.
 *
 *   npm run test:order-email
 */
import type { RowDataPacket } from 'mysql2/promise'
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import {
  emailPurchaseOrder,
  lastOrderEmail,
  type IssuingSiteDetails,
  type MailDeps,
} from '../src/lib/site/purchaseOrderEmail'
import { saveOrder, issueOrder, getPurchaseDocument } from '../src/lib/site/purchaseDocuments'
import { createSupplier } from '../src/lib/site/suppliers'
import { defaultVat, listVatRates } from '../src/lib/site/lookups'
import type { SendInput, SendResult } from '../src/lib/mail'

const SITE = 1
const actor = { userId: 1, userName: 'Order Email Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const site: IssuingSiteDetails = {
  name: 'Order Email Trading',
  vatNumber: '4120000000',
  registrationNumber: null,
  address1: '1 Test Street',
  address2: null,
  address3: null,
  postalCode: '0001',
  phone: '011 555 0000',
  email: 'buying@example.com',
}

/** Captures what would have gone out, instead of going out. */
function capturingTransport() {
  const sent: SendInput[] = []
  const deps: MailDeps = {
    configured: () => true,
    send: async (input: SendInput): Promise<SendResult> => {
      sent.push(input)
      return { ok: true, messageId: `test-${sent.length}` }
    },
  }
  return { sent, deps }
}

async function main() {
  const stamp = Date.now().toString().slice(-8)

  const sup = await createSupplier(SITE, actor, {
    code: `EML${stamp}`,
    name: 'Order Email Test Suppliers',
    paymentTermsDays: 30,
    leadTimeDays: 5,
    email: 'orders@supplier.example',
  })
  if (!sup.ok) {
    console.log('setup failed:', sup.error)
    process.exit(1)
  }

  const p = await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, visible_in_pos)
     VALUES (?,?,'normal',0,0,0,1)`,
    [`EM${stamp}`, `Email test widget ${stamp}`],
  )
  const productId = p.insertId

  const rates = await listVatRates(SITE)
  const rate = (defaultVat(rates, 'purchase') ?? defaultVat(rates, 'sales'))?.rate ?? 15

  try {
    const draft = await saveOrder(SITE, actor, {
      supplierId: sup.id,
      reference: `Email test ${stamp}`,
      lines: [
        {
          productId,
          description: `Email test widget ${stamp}`,
          qtyOrdered: 4,
          unitCostExcl: 25,
          vatRatePct: rate,
        },
      ],
    })
    if (!draft.ok) {
      console.log('setup failed:', draft.error)
      process.exit(1)
    }

    /* ── the guards ─────────────────────────────────────────────────────── */
    console.log('\n── What may be sent ──')

    const noMail = await emailPurchaseOrder(
      SITE, site, actor, draft.id, { to: 'a@b.com' },
      { configured: () => false, send: async () => ({ ok: true, messageId: 'x' }) },
    )
    ok('refused when email is not set up', !noMail.ok, noMail.ok ? 'sent!' : noMail.error)

    let cap = capturingTransport()
    const asDraft = await emailPurchaseOrder(
      SITE, site, actor, draft.id, { to: 'orders@supplier.example' }, cap.deps,
    )
    ok('*** A DRAFT IS REFUSED ***', !asDraft.ok, asDraft.ok ? 'sent!' : asDraft.error)
    ok('  and nothing was handed to the transport', cap.sent.length === 0, String(cap.sent.length))

    const noAddress = await emailPurchaseOrder(
      SITE, site, actor, draft.id, { to: '   ' }, cap.deps,
    )
    ok('an empty address is refused', !noAddress.ok)

    ok('the order issues', (await issueOrder(SITE, actor, draft.id)).ok)
    const issued = await getPurchaseDocument(SITE, draft.id)
    const number = issued!.documentNumber!

    /* ── the send ───────────────────────────────────────────────────────── */
    console.log('\n── Sending it ──')

    cap = capturingTransport()
    const sent = await emailPurchaseOrder(
      SITE, site, actor, draft.id,
      { to: 'orders@supplier.example', message: 'Please deliver Friday.' },
      cap.deps,
    )
    ok('an issued order sends', sent.ok, sent.ok ? sent.to : sent.error)
    ok('  exactly one message', cap.sent.length === 1, String(cap.sent.length))

    const msg = cap.sent[0]
    ok('  to the address given', msg?.to === 'orders@supplier.example', msg?.to)
    ok('  the subject names the order', !!msg && msg.subject.includes(number), msg?.subject)
    ok('  and names the buying business', !!msg && msg.subject.includes(site.name))

    console.log('\n── The body IS the order ──')
    const html = msg?.html ?? ''
    ok('there is an HTML body', html.length > 0, String(html.length))
    ok('*** it carries the order number ***', html.includes(number))
    ok('*** and the supplier it is addressed to ***',
      html.includes('Order Email Test Suppliers'))
    ok('*** and the line that was ordered ***', html.includes(`Email test widget ${stamp}`))
    ok('  and the buying business', html.includes(site.name))
    ok('  the covering note sits above it', html.includes('Please deliver Friday.'))

    // The whole reason costs are forced on for this render: the supplier
    // quoted these prices and cannot check an order that hides them.
    ok('*** the supplier can see the prices they quoted ***',
      /25\.00/.test(html), /25\.00/.test(html) ? '' : 'no unit price in the body')

    console.log('\n── Nothing unreachable travels ──')
    ok('*** no app-relative logo URL survives into the message ***',
      !html.includes('/api/document-logo'),
      html.includes('/api/document-logo') ? 'found one' : '')
    ok('  no other app-relative src either',
      !/src="\/(?!\/)/.test(html),
      /src="\/(?!\/)/.test(html) ? 'relative src found' : '')

    ok('a plain-text alternative is always sent', (msg?.text ?? '').length > 0)
    ok('  and it names the order', (msg?.text ?? '').includes(number))

    console.log('\n── The trail ──')
    const first = await lastOrderEmail(SITE, draft.id)
    if (first) {
      ok('the send is recorded', !!first.detail && first.detail.includes(number), first.detail ?? '')
      ok('  with the address', !!first.detail?.includes('orders@supplier.example'))

      // A resend is its own action — see recordSend.
      cap = capturingTransport()
      const again = await emailPurchaseOrder(
        SITE, site, actor, draft.id, { to: 'branch@supplier.example' }, cap.deps,
      )
      ok('a resend is allowed', again.ok, again.ok ? '' : again.error)

      const row = await siteQueryOne<RowDataPacket & { n: number }>(
        SITE,
        `SELECT COUNT(*) AS n FROM purchase_document_audit
          WHERE document_id = ? AND action = 're_emailed'`,
        [draft.id],
      )
      ok('*** and recorded as a DUPLICATE, not a first send ***', Number(row?.n ?? 0) === 1,
        String(row?.n))

      // The second copy must say so on its face, or a supplier holding two
      // orders cannot tell which is which.
      ok('  the second copy is marked a reprint',
        /REPRINT/i.test(cap.sent[0]?.html ?? ''),
        /REPRINT/i.test(cap.sent[0]?.html ?? '') ? '' : 'no REPRINT banner')
    } else {
      console.log('SKIP  no purchase_document_audit table on this site')
    }

    console.log('\n── What must NOT have changed ──')
    const after = await getPurchaseDocument(SITE, draft.id)
    ok('the order is still issued', after?.status === 'issued', String(after?.status))
    ok('  its number is unchanged', after?.documentNumber === number)
    ok('  and its lines are untouched', Number(after?.lines[0]?.qtyOrdered) === 4)

    const stock = await siteQueryOne<RowDataPacket & { stock_on_hand: number }>(
      SITE, 'SELECT stock_on_hand FROM products WHERE id = ?', [productId],
    )
    ok('*** EMAILING MOVED NO STOCK ***', Number(stock?.stock_on_hand ?? -1) === 0,
      String(stock?.stock_on_hand))

    /* ── a failing transport must not claim success ──────────────────────── */
    console.log('\n── When the send fails ──')
    const failing: MailDeps = {
      configured: () => true,
      send: async () => ({ ok: false, error: 'Mailbox unavailable' }),
    }
    const before = await countAudit(draft.id)
    const failed = await emailPurchaseOrder(
      SITE, site, actor, draft.id, { to: 'nope@supplier.example' }, failing,
    )
    ok('the failure is reported', !failed.ok, failed.ok ? 'claimed success!' : failed.error)
    ok('*** and NOTHING is written to the trail ***',
      (await countAudit(draft.id)) === before,
      `${before} -> ${await countAudit(draft.id)}`)
  } finally {
    const supId = sup.ok ? sup.id : 0
    await siteExecute(
      SITE,
      `DELETE FROM purchase_document_audit WHERE document_id IN
         (SELECT id FROM purchase_documents WHERE supplier_id = ?)`,
      [supId],
    ).catch(() => {})
    await siteExecute(
      SITE,
      `DELETE FROM purchase_order_details WHERE document_id IN
         (SELECT id FROM purchase_documents WHERE supplier_id = ?)`,
      [supId],
    ).catch(() => {})
    await siteExecute(
      SITE,
      `DELETE FROM purchase_document_lines WHERE document_id IN
         (SELECT id FROM purchase_documents WHERE supplier_id = ?)`,
      [supId],
    ).catch(() => {})
    await siteExecute(SITE, 'DELETE FROM purchase_documents WHERE supplier_id = ?', [supId])
      .catch(() => {})
    await siteExecute(SITE, 'DELETE FROM product_suppliers WHERE product_id = ?', [productId])
      .catch(() => {})
    await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [productId]).catch(() => {})
  }

  console.log(`\n${fails === 0 ? 'All good.' : `${fails} FAILED`}\n`)
  process.exit(fails === 0 ? 0 : 1)
}

async function countAudit(documentId: number): Promise<number> {
  const row = await siteQueryOne<RowDataPacket & { n: number }>(
    SITE,
    'SELECT COUNT(*) AS n FROM purchase_document_audit WHERE document_id = ?',
    [documentId],
  ).catch(() => null)
  return Number(row?.n ?? 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

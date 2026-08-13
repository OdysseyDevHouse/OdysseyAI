/**
 * Emailing an invoice on demand — the guards, the audit trail, and nothing
 * else moving.
 *
 * The transport is injected (MailDeps), so this proves the whole flow — PDF
 * render included — without an SMTP host. What matters:
 *
 *   · a draft is refused: it has no number and no debtor entry, so sending it
 *     would bill the customer for something the business never raised;
 *   · every send lands in document_audit, so a resend is an informed act;
 *   · a failed send leaves NO audit row — the trail records what happened,
 *     not what was attempted;
 *   · the ledger never moves. Emailing is communication, not posting.
 *
 *   npm run test:invoice-email
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { createCustomer, getCustomer } from '../src/lib/site/customers'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { saveDraft } from '../src/lib/site/salesDocuments'
import { finaliseDocument } from '../src/lib/site/salesPosting'
import { emailInvoiceDocument, lastEmailed, type MailDeps } from '../src/lib/site/invoiceEmail'
import type { IssuingSite } from '../src/lib/invoices/build'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Email Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const stamp = Date.now().toString().slice(-8)
const site: IssuingSite = {
  displayName: 'Email Test Trading',
  vatNumber: null,
  registrationNumber: null,
  address1: null,
  address2: null,
  address3: null,
  postalCode: null,
  phone: null,
  email: null,
}

const sent: { to: string; subject: string; attachments: number }[] = []
const workingMail: MailDeps = {
  configured: () => true,
  send: async (msg) => {
    sent.push({ to: msg.to, subject: msg.subject, attachments: msg.attachments?.length ?? 0 })
    return { ok: true, messageId: 'fake-1' }
  },
}
const brokenMail: MailDeps = {
  configured: () => true,
  send: async () => ({ ok: false, error: 'Mailbox on fire.' }),
}
const unconfiguredMail: MailDeps = {
  configured: () => false,
  send: async () => ({ ok: true, messageId: 'fake-2' }),
}

async function main() {
  const vat = await siteQueryOne<any>(SITE,
    "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1")
  const rate = toNum(vat?.rate, 15)

  const cash = await getTenderByCode(SITE, 'CASH')
  const cust = await createCustomer(SITE, actor, {
    code: `EML${stamp}`, name: 'Email Test Co', paymentTermsDays: 30, creditLimit: 0,
    email: 'account@example.com',
  })
  if (!cash || !cust.ok) { console.log('**FAIL** setup'); process.exit(1) }

  // A service line: no stock to set up, nothing to reconcile afterwards.
  const draft = await saveDraft(SITE, actor, {
    docType: 'invoice', customerId: cust.id, customerName: 'Email Test Co',
    lines: [{ productId: null, description: 'Callout fee', productType: 'service',
              qty: 1, unitPriceIncl: 230, vatRatePct: rate, unitCostExcl: 0 }],
  })
  if (!draft.ok) { console.log('**FAIL** draft'); process.exit(1) }

  // ── The guards, before anything is finalised
  const draftRefused = await emailInvoiceDocument(SITE, site, actor, draft.id,
    { to: 'a@b.co', origin: '' }, workingMail)
  ok('*** a draft is refused ***', !draftRefused.ok,
    draftRefused.ok ? '' : draftRefused.error)

  const posted = await finaliseDocument(SITE, actor, {
    documentId: draft.id, customerId: cust.id,
    tenders: [{ tenderTypeId: cash.id, amount: 230 }],
  })
  ok('the invoice posts', posted.ok, posted.ok ? posted.documentNumber : posted.error)
  if (!posted.ok) process.exit(1)

  ok('unconfigured mail is refused with the reason',
    !(await emailInvoiceDocument(SITE, site, actor, draft.id, { to: 'a@b.co', origin: '' }, unconfiguredMail)).ok)
  ok('an empty address is refused',
    !(await emailInvoiceDocument(SITE, site, actor, draft.id, { to: '   ', origin: '' }, workingMail)).ok)

  const balanceBefore = (await getCustomer(SITE, cust.id))?.balance ?? -1

  // ── The send
  const sentResult = await emailInvoiceDocument(SITE, site, actor, draft.id,
    { to: 'books@example.com', message: 'As discussed.', origin: '' }, workingMail)
  ok('*** a finalised invoice sends ***', sentResult.ok,
    sentResult.ok ? sentResult.to : sentResult.error)
  ok('  with the PDF attached', sent[0]?.attachments === 1, JSON.stringify(sent[0]))
  ok('  to the confirmed address', sent[0]?.to === 'books@example.com')

  const trail = await siteQuery<any>(SITE,
    "SELECT action, detail FROM document_audit WHERE document_id = ? AND action = 'emailed' ORDER BY id",
    [draft.id])
  ok('*** the send is on the audit trail ***', trail.length === 1, JSON.stringify(trail))
  ok('  naming the address', String(trail[0]?.detail ?? '').includes('books@example.com'))

  const last = await lastEmailed(SITE, draft.id)
  ok('  lastEmailed reads it back', !!last && (last.detail ?? '').includes('books@example.com'))

  // ── A failed send leaves no trace on the trail
  const failed = await emailInvoiceDocument(SITE, site, actor, draft.id,
    { to: 'books@example.com', origin: '' }, brokenMail)
  ok('a transport failure reports the error', !failed.ok && failed.error === 'Mailbox on fire.',
    failed.ok ? '' : failed.error)
  const trailAfterFail = await siteQuery<any>(SITE,
    "SELECT id FROM document_audit WHERE document_id = ? AND action = 'emailed'", [draft.id])
  ok('*** and leaves NO audit row ***', trailAfterFail.length === 1)

  // ── A resend is allowed, and adds a second row
  const resend = await emailInvoiceDocument(SITE, site, actor, draft.id,
    { to: 'owner@example.com', origin: '' }, workingMail)
  ok('a resend is allowed', resend.ok)
  const trailAfterResend = await siteQuery<any>(SITE,
    "SELECT id FROM document_audit WHERE document_id = ? AND action = 'emailed'", [draft.id])
  ok('  as its own audit row', trailAfterResend.length === 2)

  // ── The ledger never moved
  ok('*** emailing moved no money ***',
    ((await getCustomer(SITE, cust.id))?.balance ?? -1) === balanceBefore)

  // ── Cleanup — the numbers go back too (see test-adjustments' rule).
  await siteExecute(SITE, 'DELETE FROM document_audit WHERE document_id = ?', [draft.id])
  await siteExecute(SITE, 'DELETE FROM sales_tenders WHERE document_id = ?', [draft.id])
  await siteExecute(SITE, 'DELETE FROM sales_document_lines WHERE document_id = ?', [draft.id])
  await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [draft.id])
  await siteExecute(SITE,
    `UPDATE document_sequences
        SET next_number = next_number - 1,
            last_issued_number = CASE WHEN last_issued_number IS NULL THEN NULL
                                      ELSE GREATEST(last_issued_number - 1, 0) END
      WHERE doc_type = 'invoice' AND terminal_id = 0 AND next_number > 1`).catch(() => undefined)
  await siteExecute(SITE, 'DELETE FROM customer_transactions WHERE customer_id = ?', [cust.id])
  await siteExecute(SITE, 'DELETE FROM customers WHERE id = ?', [cust.id])

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  console.log('\nCRASHED')
  process.exit(1)
})

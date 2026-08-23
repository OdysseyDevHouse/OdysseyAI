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
import {
  emailInvoiceDocument,
  emailQuoteDocument,
  recordQuoteView,
  quotePlainBody,
  lastEmailed,
  type MailDeps,
} from '../src/lib/site/invoiceEmail'
import { issueQuote, getQuote } from '../src/lib/site/quotes'
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

  /*
   * ── Quotes ──────────────────────────────────────────────────────────────
   *
   * The load-bearing assertion is the one about the pay link. An invoice email
   * carries a "Pay online" button; a quote must NOT, because nothing is owed
   * and asking a customer to pay for something they have not agreed to buy is
   * the worst thing this feature could do. It is asserted on the rendered body
   * rather than on the argument, because the argument is what the code MEANT
   * and the body is what the customer receives.
   */
  const qDraft = await saveDraft(SITE, actor, {
    docType: 'quote', customerId: cust.id, customerName: 'Email Test Co',
    lines: [{ productId: null, description: 'Rewire the shop', productType: 'service',
              qty: 1, unitPriceIncl: 4600, vatRatePct: rate, unitCostExcl: 0 }],
  })
  if (!qDraft.ok) { console.log('**FAIL** quote draft'); process.exit(1) }

  // ── Guards
  const qDraftRefused = await emailQuoteDocument(SITE, site, actor, qDraft.id,
    { to: 'a@b.co' }, workingMail)
  ok('*** a draft quote is refused — it has no number to quote back ***',
    !qDraftRefused.ok, qDraftRefused.ok ? '' : qDraftRefused.error)

  const wrongKind = await emailQuoteDocument(SITE, site, actor, draft.id,
    { to: 'a@b.co' }, workingMail)
  ok('*** and an INVOICE is refused by the quote sender ***',
    !wrongKind.ok, wrongKind.ok ? 'IT SENT' : wrongKind.error)

  const issued = await issueQuote(SITE, actor, qDraft.id)
  ok('the quote issues', issued.ok, issued.ok ? '' : issued.error)
  if (!issued.ok) process.exit(1)

  // ── Before it is sent, it is simply open
  const beforeSend = await getQuote(SITE, qDraft.id)
  ok('an issued quote starts out awaiting a decision',
    beforeSend?.state === 'open', String(beforeSend?.state))

  // ── The send
  const qSent = await emailQuoteDocument(SITE, site, actor, qDraft.id,
    { to: 'buyer@example.com', message: 'Prices hold for 30 days.' }, workingMail)
  ok('*** a quote sends ***', qSent.ok, qSent.ok ? qSent.to : qSent.error)

  const qMail = sent[sent.length - 1]
  ok('  with the PDF attached', qMail?.attachments === 1, JSON.stringify(qMail))
  ok('  and a subject saying QUOTATION, not invoice',
    /^Quotation /.test(qMail?.subject ?? ''), qMail?.subject)

  /*
   * The body itself. quotePlainBody is pure, so this asserts on exactly the
   * string the customer receives rather than on a stand-in for it.
   */
  const body = quotePlainBody('Test Co', 'Email Test Co', 'QUO001',
    { documentDate: '2026-08-23', validUntil: '2026-09-22', totalIncl: 4600 }, 'As discussed.')
  ok('*** the quote body has NO pay link and asks for no payment ***',
    !/pay|amount due|please quote .* with your payment/i.test(body), body)
  ok('  it states the validity date, which is the sentence on every quote',
    body.includes('Valid until: 2026-09-22'))
  ok('  and carries the covering message', body.includes('As discussed.'))

  /*
   * A quote with no validity omits the line rather than inventing one. A
   * business that chooses not to expire its quotes must not have this email
   * making up an expiry on its behalf.
   */
  const noValidity = quotePlainBody('Test Co', '', 'QUO002',
    { documentDate: '2026-08-23', validUntil: null, totalIncl: 100 })
  ok('  a quote with no validity says nothing about one',
    !/valid until/i.test(noValidity), noValidity)

  // ── Sent is now the state, and it is stamped
  const afterSend = await getQuote(SITE, qDraft.id)
  ok('*** the quote now reads as Sent ***', afterSend?.state === 'sent', String(afterSend?.state))
  ok('  recording who it went to', afterSend?.sentTo === 'buyer@example.com',
    String(afterSend?.sentTo))
  ok('  and the outcome is untouched — sent is not a decision',
    afterSend?.outcome === 'open', String(afterSend?.outcome))

  // ── The customer opens it
  await recordQuoteView(SITE, qDraft.id)
  const afterView = await getQuote(SITE, qDraft.id)
  ok('*** opening it moves the state to Seen ***',
    afterView?.state === 'viewed', String(afterView?.state))
  ok('  counted once', afterView?.viewCount === 1, String(afterView?.viewCount))

  /*
   * Backdated a week before the second view.
   *
   * Without this the two views land in the same second and the assertion below
   * passes whether the value is kept OR overwritten — it would be proving
   * nothing. A visible gap is what makes "the first one survived" a claim.
   */
  await siteExecute(SITE,
    'UPDATE sales_documents SET quote_viewed_at = ? WHERE id = ?',
    ['2026-01-05 09:15:00', qDraft.id])
  const firstView = (await getQuote(SITE, qDraft.id))?.viewedAt

  await recordQuoteView(SITE, qDraft.id)
  const afterTwo = await getQuote(SITE, qDraft.id)
  ok('  a second open counts again', afterTwo?.viewCount === 2, String(afterTwo?.viewCount))
  /*
   * The FIRST view is kept. How long the customer took to look is the
   * interesting fact; a last_viewed_at would overwrite it every time somebody
   * re-opened the link.
   */
  ok('*** but the FIRST view time is kept, not overwritten ***',
    afterTwo?.viewedAt instanceof Date &&
      afterTwo.viewedAt.getUTCFullYear() === 2026 &&
      afterTwo.viewedAt.getUTCMonth() === 0 &&
      afterTwo.viewedAt.getUTCDate() === 5,
    `${String(firstView)} -> ${String(afterTwo?.viewedAt)}`)

  /*
   * ── EXPIRY BEATS SEEN ──────────────────────────────────────────────────
   *
   * A quote emailed in March and opened in April is still expired today. If
   * viewed won here, every stale quote in the register would show "Seen by the
   * customer" and invite a follow-up call offering prices that no longer stand.
   */
  await siteExecute(SITE,
    "UPDATE sales_documents SET valid_until = '2020-01-01' WHERE id = ?", [qDraft.id])
  const stale = await getQuote(SITE, qDraft.id)
  ok('*** an expired quote reads Expired even though it was seen ***',
    stale?.state === 'expired', String(stale?.state))
  await siteExecute(SITE,
    "UPDATE sales_documents SET valid_until = NULL WHERE id = ?", [qDraft.id])

  /*
   * ── AN OUTCOME BEATS BOTH ──────────────────────────────────────────────
   *
   * Once the customer has answered, what happened on the way there stops being
   * the headline. Accepted is what a person needs to see.
   */
  await siteExecute(SITE,
    "UPDATE sales_documents SET quote_outcome = 'accepted', quote_outcome_at = NOW() WHERE id = ?",
    [qDraft.id])
  const decided = await getQuote(SITE, qDraft.id)
  ok('*** and an ANSWERED quote reads Accepted, not Seen ***',
    decided?.state === 'accepted', String(decided?.state))

  // ── Teardown, giving the QUO number back too
  await siteExecute(SITE, 'DELETE FROM document_audit WHERE document_id = ?', [qDraft.id])
  await siteExecute(SITE, 'DELETE FROM sales_document_lines WHERE document_id = ?', [qDraft.id])
  await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [qDraft.id])
  await siteExecute(SITE,
    `UPDATE document_sequences
        SET next_number = next_number - 1,
            last_issued_number = CASE WHEN last_issued_number IS NULL THEN NULL
                                      ELSE GREATEST(last_issued_number - 1, 0) END
      WHERE doc_type = 'quote' AND terminal_id = 0 AND next_number > 1`).catch(() => undefined)


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

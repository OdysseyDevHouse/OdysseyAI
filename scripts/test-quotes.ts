/**
 * Quotes.
 *
 * The rules that matter, and what breaks if they slip:
 *
 *   A QUOTE NEVER POSTS. No stock moves, no ledger entry, no VAT declared. It
 *   is an offer, not a tax document — and a quote that moved stock would empty
 *   the shelves for work nobody has agreed to.
 *
 *   CONVERSION CREATES, IT DOES NOT MUTATE. The quote stays exactly as it was
 *   offered and a NEW invoice is linked to it. Turning the quote into the
 *   invoice destroys the evidence of what was quoted — which is precisely what
 *   a customer disputes.
 *
 *   PRICES ARE HONOURED. The invoice carries the quote's prices, not today's.
 *   Silently re-pricing at conversion breaks the promise made to the customer.
 *
 *   EXPIRY WARNS, IT DOES NOT BLOCK. A customer accepting a day late is
 *   ordinary business.
 *
 *   npm run test:quotes
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { saveDraft, getDocument } from '../src/lib/site/salesDocuments'
import { finaliseDocument } from '../src/lib/site/salesPosting'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import {
  issueQuote, getQuote, listQuotes, convertToInvoice, declineQuote,
  reopenQuote, setValidUntil, quoteSummary, lostReasons, quoteState,
  defaultValidUntil,
} from '../src/lib/site/quotes'
import { round, toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Quote Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

function daysFromNow(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const stamp = Date.now().toString().slice(-6)
const created: number[] = []

async function main() {
  console.log('\n── State, derived ──────────────────────────────────────────\n')

  ok('an issued quote inside its validity is open',
      quoteState({ status: 'issued', outcome: 'open', validUntil: daysFromNow(10) }) === 'open')
  ok('*** past its validity it is expired ***',
      quoteState({ status: 'issued', outcome: 'open', validUntil: daysFromNow(-1) }) === 'expired')
  ok('with no validity it never expires',
      quoteState({ status: 'issued', outcome: 'open', validUntil: null }) === 'open')

  // Order matters: an answer outranks a date passing afterwards.
  ok('*** a declined quote stays declined once expired ***',
      quoteState({ status: 'issued', outcome: 'declined', validUntil: daysFromNow(-30) }) === 'declined')
  ok('  and an accepted one stays accepted',
      quoteState({ status: 'issued', outcome: 'accepted', validUntil: daysFromNow(-30) }) === 'accepted')
  ok('a draft is a draft whatever the date',
      quoteState({ status: 'draft', outcome: 'open', validUntil: daysFromNow(-5) }) === 'draft')

  const defaultValid = await defaultValidUntil(SITE)
  ok('a default validity comes from settings', defaultValid !== null, String(defaultValid))

  console.log('\n── Capture, on the invoicing machinery ─────────────────────\n')

  // saveDraft is the INVOICING function. A quote is a sales document, so the
  // same capture path serves both — that is the whole design.
  const draft = await saveDraft(SITE, actor, {
    docType: 'quote',
    customerName: `Quote Customer ${stamp}`,
    lines: [
      {
        productCode: `QS${stamp}`,
        description: 'Quoted service',
        productType: 'service',
        qty: 2,
        unitPriceIncl: 575,
        vatRatePct: 15,
        unitCostExcl: 200,
      },
    ],
  })
  ok('a quote is captured by the invoicing saveDraft', draft.ok, draft.ok ? '' : draft.error)
  if (!draft.ok) return finish()
  created.push(draft.id)

  const asDocument = await getDocument(SITE, draft.id)
  ok('  it is a sales document', asDocument?.docType === 'quote')
  ok('  with totals computed by documentMath', asDocument?.totalIncl === 1150,
      String(asDocument?.totalIncl))
  ok('  and no number until issued', asDocument?.documentNumber === null)

  console.log('\n── Issuing ─────────────────────────────────────────────────\n')

  await setValidUntil(SITE, actor, draft.id, daysFromNow(30))

  const issued = await issueQuote(SITE, actor, draft.id)
  ok('a quote is issued', issued.ok, issued.ok ? issued.documentNumber : issued.error)
  ok('  with its own QUO number', issued.ok && /^QUO\d+/.test(issued.documentNumber),
      issued.ok ? issued.documentNumber : '')

  const afterIssue = await getQuote(SITE, draft.id)
  ok('  it is awaiting a decision', afterIssue?.state === 'open')
  ok('  and knows how long it has left', (afterIssue?.daysRemaining ?? 0) > 25,
      String(afterIssue?.daysRemaining))

  ok('issuing twice is refused', !(await issueQuote(SITE, actor, draft.id)).ok)

  // THE defining rule.
  const cash = await getTenderByCode(SITE, 'CASH')
  if (cash) {
    const posted = await finaliseDocument(SITE, actor, {
      documentId: draft.id,
      tenders: [{ tenderTypeId: cash.id, amount: 1150 }],
    })
    ok('*** A QUOTE CANNOT BE POSTED ***', !posted.ok,
        posted.ok ? 'IT POSTED' : posted.error)
  }

  const ledgerEntry = await siteQueryOne<{ n: number }>(
    SITE,
    "SELECT COUNT(*) AS n FROM journal_batches WHERE source = 'sale' AND source_doc_id = ?",
    [draft.id],
  )
  ok('*** and it reaches no ledger ***', Number(ledgerEntry?.n ?? 0) === 0)

  const movements = await siteQueryOne<{ n: number }>(
    SITE, 'SELECT COUNT(*) AS n FROM stock_movements WHERE document_id = ?', [draft.id],
  ).catch(() => null)
  ok('*** and moves no stock ***', Number(movements?.n ?? 0) === 0)

  console.log('\n── Conversion ──────────────────────────────────────────────\n')

  const converted = await convertToInvoice(SITE, actor, draft.id)
  ok('a quote converts', converted.ok, converted.ok ? `invoice #${converted.invoiceId}` : converted.error)
  if (!converted.ok) return finish()
  created.push(converted.invoiceId)

  const quoteAfter = await getQuote(SITE, draft.id)
  ok('*** THE QUOTE SURVIVES, UNCHANGED ***',
      quoteAfter?.totalIncl === 1150 && quoteAfter?.documentNumber === (issued.ok ? issued.documentNumber : ''),
      `${quoteAfter?.documentNumber} at ${quoteAfter?.totalIncl}`)
  ok('  marked accepted', quoteAfter?.state === 'accepted')
  ok('  and linked to what it became', quoteAfter?.convertedToId === converted.invoiceId)

  const invoice = await getDocument(SITE, converted.invoiceId)
  ok('the invoice is a separate document', invoice?.id !== draft.id)
  ok('  of type invoice', invoice?.docType === 'invoice')
  ok('  as a DRAFT, not posted', invoice?.status === 'draft',
      String(invoice?.status))
  ok('  pointing back at the quote', invoice?.convertedFromId === draft.id)

  // THE promise to the customer.
  ok('*** the quote\'s prices are carried, not today\'s ***',
      invoice?.totalIncl === 1150 && invoice?.lines[0]?.unitPriceIncl === 575,
      `${invoice?.totalIncl}, line at ${invoice?.lines[0]?.unitPriceIncl}`)
  ok('  and the lines came with it', invoice?.lines.length === 1)

  ok('converting twice is refused', !(await convertToInvoice(SITE, actor, draft.id)).ok)
  ok('  and it cannot be reopened once converted',
      !(await reopenQuote(SITE, actor, draft.id)).ok)

  console.log('\n── Expiry warns rather than blocks ─────────────────────────\n')

  const stale = await saveDraft(SITE, actor, {
    docType: 'quote',
    customerName: `Stale Customer ${stamp}`,
    lines: [{
      productCode: `QE${stamp}`, description: 'Old offer', productType: 'service',
      qty: 1, unitPriceIncl: 230, vatRatePct: 15, unitCostExcl: 100,
    }],
  })
  if (!stale.ok) return finish()
  created.push(stale.id)

  await issueQuote(SITE, actor, stale.id)
  await setValidUntil(SITE, actor, stale.id, daysFromNow(-5))

  const expired = await getQuote(SITE, stale.id)
  ok('a past-dated quote reads as expired', expired?.state === 'expired')

  const lateConvert = await convertToInvoice(SITE, actor, stale.id)
  ok('*** an expired quote STILL converts ***', lateConvert.ok,
      lateConvert.ok ? '' : lateConvert.error)
  if (lateConvert.ok) {
    created.push(lateConvert.invoiceId)
    ok('  but it warns about the expiry',
        lateConvert.warnings.some((w) => w.toLowerCase().includes('expired')),
        lateConvert.warnings.join(' | ') || 'no warnings')
  }

  console.log('\n── Losing a quote ──────────────────────────────────────────\n')

  const lost = await saveDraft(SITE, actor, {
    docType: 'quote',
    customerName: `Lost Customer ${stamp}`,
    lines: [{
      productCode: `QL${stamp}`, description: 'Not taken', productType: 'service',
      qty: 1, unitPriceIncl: 5000, vatRatePct: 15, unitCostExcl: 2000,
    }],
  })
  if (!lost.ok) return finish()
  created.push(lost.id)
  await issueQuote(SITE, actor, lost.id)

  ok('*** a reason is required to mark it lost ***',
      !(await declineQuote(SITE, actor, lost.id, '')).ok)

  const declined = await declineQuote(SITE, actor, lost.id, 'Price')
  ok('it can be marked lost with a reason', declined.ok)

  const lostQuote = await getQuote(SITE, lost.id)
  ok('  and reads as declined', lostQuote?.state === 'declined')
  ok('  with the reason kept', lostQuote?.lostReason === 'Price')

  ok('a lost quote can be reopened', (await reopenQuote(SITE, actor, lost.id)).ok)
  const reopened = await getQuote(SITE, lost.id)
  ok('  returning to open', reopened?.state === 'open')
  ok('  and clearing the reason', reopened?.lostReason === null)

  await declineQuote(SITE, actor, lost.id, 'Price')

  console.log('\n── The register ────────────────────────────────────────────\n')

  const summary = await quoteSummary(SITE)
  ok('the summary counts what was accepted', summary.acceptedCount >= 2,
      String(summary.acceptedCount))
  ok('  and what was lost', summary.declinedCount >= 1, String(summary.declinedCount))
  ok('*** a conversion rate is computed ***', summary.conversionRate !== null,
      `${summary.conversionRate}%`)
  ok('  excluding undecided quotes from the denominator',
      summary.conversionRate === round((summary.acceptedCount / (summary.acceptedCount + summary.declinedCount)) * 100, 1),
      String(summary.conversionRate))

  const reasons = await lostReasons(SITE)
  ok('lost reasons are grouped', reasons.some((r) => r.reason === 'Price'),
      reasons.map((r) => `${r.reason}:${r.count}`).join(', '))

  const open = await listQuotes(SITE, { state: 'open' })
  ok('the open list excludes decided quotes',
      !open.items.some((q) => q.id === draft.id || q.id === lost.id))

  const accepted = await listQuotes(SITE, { state: 'accepted' })
  ok('the accepted list finds ours', accepted.items.some((q) => q.id === draft.id))

  await finish()
}

async function finish() {
  for (const id of created) {
    await siteExecute(SITE, 'DELETE FROM document_audit WHERE document_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM sales_tenders WHERE document_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM sales_document_lines WHERE document_id = ?', [id])
  }
  // Invoices first: they point at the quotes via converted_from_id.
  for (const id of [...created].reverse()) {
    await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [id])
  }

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main()

import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteExecute, siteQueryOne } from '../siteDb'
import { formatMoney } from '../decimals'
import { send, isConfigured, sendAs, isConfiguredFor } from '../mail'
import { renderInvoicePdf } from '../invoices/pdf'
import { buildInvoice, type IssuingSite } from '../invoices/build'
import { getSite } from '../sites'
import { HEADING, CLOSING, printKindFor } from './salesDocumentKind'
import { createCallbackToken } from '../callbackToken'
import { appBaseUrl } from '../appUrl'
import { createIntent, getGateway } from './payments'
import { documentPayUrl } from './qrLinks'
import { outstandingForDocument } from './paidInvoices'
import { getDocument } from './salesDocuments'
import { getCustomer } from './customers'
import { logActivity, type Actor } from './activityLog'

/**
 * Emailing one sales document to its customer, on demand.
 *
 * Extracted from contractSend.ts, which had quietly become nine tenths of this
 * feature — the render, the attachment shape, the guards, the pay link. The
 * contract flow keeps its own outcome bookkeeping (email_status per billing
 * period, three-strike retries); THIS path has none of that, deliberately.
 * A person pressing "Email" watches the result and decides about a resend
 * themselves, so the trail is the document_audit row, not a status column.
 *
 * Resending is allowed for the same reason: the audit trail shows every send,
 * and the dialog shows the last one, so a second copy is an informed act
 * rather than a bug. The document itself is never touched — same number, same
 * ledger entry, same PDF re-rendered from stored figures.
 */

type Row = RowDataPacket & Record<string, unknown>

export type EmailInvoiceResult = { ok: true; to: string } | { ok: false; error: string }

/** Injectable transport, so the suite can prove the flow without an SMTP host. */
/**
 * How this module reaches a mail server.
 *
 * ── BOTH HALVES TAKE A siteId NOW ───────────────────────────────────────────
 *
 * They used to be the process-wide `send` and `isConfigured`, which meant every
 * business on a shared server emailed its invoices from the same address — see
 * lib/mail.ts. The site is threaded through so a document leaves from the shop
 * that issued it.
 *
 * Still INJECTED rather than imported directly, for the reason it always was:
 * the tests for this file must not open a socket. The defaults below are the
 * real thing; a test passes a pair of fakes.
 */
export type MailDeps = {
  send: (siteId: number, input: Parameters<typeof send>[0]) => ReturnType<typeof send>
  configured: (siteId: number) => boolean | Promise<boolean>
}

/**
 * The real transport, per site, with the process account as the fallback.
 *
 * Named rather than written inline at three call sites: they must not be able
 * to drift into three ideas of what "send mail" means.
 */
const SITE_MAIL: MailDeps = { send: sendAs, configured: isConfiguredFor }

export async function emailInvoiceDocument(
  siteId: number,
  site: IssuingSite,
  actor: Actor,
  documentId: number,
  opts: { to: string; message?: string | null; origin: string },
  deps: MailDeps = SITE_MAIL,
): Promise<EmailInvoiceResult> {
  if (!(await deps.configured(siteId))) return { ok: false, error: 'Email is not set up on this system.' }

  const to = opts.to.trim()
  if (!to) return { ok: false, error: 'Give an address to send it to.' }

  const document = await getDocument(siteId, documentId)
  if (!document) return { ok: false, error: 'That document no longer exists.' }

  if (document.docType !== 'invoice' && document.docType !== 'credit_sale') {
    return { ok: false, error: `A ${document.docLabel.toLowerCase()} is not emailed from here.` }
  }
  // A draft has no number and no debtor entry. Sending one would be sending
  // the customer a bill the business has not actually raised.
  if (document.status !== 'finalised') {
    return { ok: false, error: 'Only a finalised document can be emailed.' }
  }

  const customer = document.customerId ? await getCustomer(siteId, document.customerId) : null

  // Minted per SEND — the callback token expires in 24 hours, so baking one in
  // earlier would hand out dead links. Failure must not stop the send: an
  // invoice with no pay link is still an invoice. Never on a credit note —
  // nobody pays a credit. And never on a SETTLED sale: a cash sale emailed as
  // a receipt must not carry a button asking to be paid again, and the link's
  // amount is what is STILL OWED, not what was raised.
  const outstanding =
    document.docType === 'invoice' ? await outstandingForDocument(siteId, document) : 0
  const paymentUrl =
    document.docType === 'invoice' && outstanding > 0.005 && opts.origin
      ? await mintPaymentLink(siteId, documentId, outstanding, opts.origin).catch(() => null)
      : null

  const data = await buildInvoice(siteId, site, documentId, {
    paymentUrl,
    /*
     * Stamps PAID on the attachment when nothing is owed.
     *
     * `outstanding` is already in hand above — it decides whether to mint a pay
     * link at all — so this costs no extra query. Only for an INVOICE: a credit
     * note is not something anybody pays, and marking one PAID would say the
     * refund had been made.
     */
    paidInFull: document.docType === 'invoice' ? outstanding <= 0.005 : undefined,
  })
  if (!data) return { ok: false, error: 'The document could not be built.' }

  let pdf: Buffer
  try {
    /*
     * A credit note is not an invoice, and s21(3) of the VAT Act names it. One
     * headed INVOICE with a negative total asks a customer to pay money they are
     * owed — so the kind travels with the document rather than being guessed at
     * from the VAT number.
     */
    pdf = await renderInvoicePdf(data, siteId, {
      heading: HEADING[printKindFor(document)],
      closing: CLOSING[printKindFor(document)],
      /*
       * The DURABLE link on the attachment, not the 24-hour one in the body.
       *
       * The button in the email is minted per send and read today, so a short
       * token is right there. The PDF is the thing that gets SAVED and PRINTED,
       * and a square in it that stops working tomorrow is worse than no square:
       * it is on paper, in a drawer, and cannot be corrected. So the attachment
       * carries the revocable slug, which is what that form exists for.
       *
       * documentPayUrl returns null on a credit note, so this is also what
       * keeps a refund from being emailed with a "pay now" square on it.
       */
      payUrl: await documentPayUrl(siteId, document).catch(() => null),
    })
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'The PDF could not be produced.',
    }
  }

  const number = document.documentNumber ?? `#${documentId}`
  const label = document.docType === 'credit_sale' ? 'Credit note' : 'Invoice'
  const result = await deps.send(siteId, {
    to,
    subject: `${label} ${number} from ${site.displayName}`,
    text: invoicePlainBody(site.displayName, customer?.name ?? '', number, { ...document, outstanding }, paymentUrl, opts.message),
    html: invoiceHtmlBody(site.displayName, customer?.name ?? '', number, { ...document, outstanding }, paymentUrl, opts.message),
    attachments: [{ filename: `${number}.pdf`, content: pdf, contentType: 'application/pdf' }],
  })
  if (!result.ok) return { ok: false, error: result.error }

  // The trail. document_audit because this happened TO a tax document; the
  // activity log because a customer's timeline should show it too.
  await siteExecute(
    siteId,
    `INSERT INTO document_audit (document_id, action, detail, user_id, user_name)
     VALUES (?, 'emailed', ?, ?, ?)`,
    [documentId, `${number} to ${to} — ${formatMoney(document.totalIncl)}`, actor.userId, actor.userName.slice(0, 120)],
  )
  if (document.customerId) {
    await logActivity(siteId, actor, {
      entity: 'customer',
      entityId: document.customerId,
      action: 'invoice_emailed',
      detail: `${number} emailed to ${to} — ${formatMoney(document.totalIncl)}`,
    }).catch(() => undefined)
  }

  return { ok: true, to }
}

/**
 * Emails a just-finalised invoice, if the account asked for that.
 *
 * ── WHY THIS IS A SEPARATE FUNCTION AND NOT A FLAG ON THE ONE ABOVE ──────
 *
 * Because it must decide whether to send at all, and every reason NOT to is a
 * silent, expected no-op rather than an error: the customer never opted in,
 * has no address on file, or the site has no mail configured. A manual press
 * of "Email" with no address is a mistake worth a message; an automatic send
 * skipped for the same reason is simply not applicable, and reporting it as a
 * failure would fill the log with noise on every sale of every site that does
 * not use this.
 *
 * So the return is a quiet outcome, not a Result. The CALLER — the posting
 * engine — is on the far side of the commit and does not act on it either
 * way; it exists so the tests can assert which branch ran.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────
 *
 * No retry, no queue, no email_status column. Contracts have all three
 * because a monthly billing run is unattended and a missed invoice there is
 * missed revenue nobody notices. This is a counter sale: the document screen
 * shows the last send, the Email button re-sends, and a person is standing
 * right there. Adding a retry ladder would be building the contract sender
 * again for a case that already has a human in it.
 */
export type AutoEmailOutcome =
  | { sent: true; to: string }
  | { sent: false; reason: 'not-enabled' | 'no-address' | 'not-configured' | 'failed'; error?: string }

export async function autoEmailInvoice(
  siteId: number,
  actor: Actor,
  customerId: number,
  documentId: number,
  deps: MailDeps = SITE_MAIL,
): Promise<AutoEmailOutcome> {
  const customer = await getCustomer(siteId, customerId)
  if (!customer?.autoEmailInvoices) return { sent: false, reason: 'not-enabled' }

  // The ACCOUNT's email, not a contact's. See the header of
  // 031_party_contacts_documents_comments.sql: contacts are people who come
  // and go, and an invoice belongs to the business.
  const to = customer.email?.trim()
  if (!to) return { sent: false, reason: 'no-address' }

  if (!(await deps.configured(siteId))) return { sent: false, reason: 'not-configured' }

  const site = await issuingSiteFor(siteId)
  if (!site) return { sent: false, reason: 'failed', error: 'No issuing site.' }

  // Null when APP_URL is unset, which emailInvoiceDocument reads as "no pay
  // link" and sends the invoice anyway. A localhost link in a customer's
  // inbox forever is worse than no link — see appUrl.ts.
  const origin = appBaseUrl() ?? ''

  const result = await emailInvoiceDocument(
    siteId,
    site,
    actor,
    documentId,
    { to, origin },
    deps,
  )
  return result.ok
    ? { sent: true, to: result.to }
    : { sent: false, reason: 'failed', error: result.error }
}

/** The most recent 'emailed' audit row, so a resend is an informed act. */
export async function lastEmailed(
  siteId: number,
  documentId: number,
): Promise<{ detail: string | null; userName: string; at: Date } | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT detail, user_name, created_at FROM document_audit
      WHERE document_id = ? AND action = 'emailed'
      ORDER BY id DESC LIMIT 1`,
    [documentId],
  )
  if (!row) return null
  return {
    detail: (row.detail as string | null) ?? null,
    userName: String(row.user_name ?? ''),
    at: row.created_at as Date,
  }
}

/**
 * A pay-online URL for one invoice.
 *
 * Reuses the storefront's machinery exactly — an intent recording what we
 * expect, plus a signed callback token binding site and reference together.
 * `purpose: 'debtor_invoice'` tells the ITN handler to settle a debtor invoice
 * rather than a shop order. Returns null when the gateway is not usable, so
 * the invoice still goes out with no link rather than not going out at all.
 *
 * Lives here (rather than in contractSend, where it grew up) because every
 * emailed invoice wants one; contracts import it back.
 */
export async function mintPaymentLink(
  siteId: number,
  documentId: number,
  amountIncl: number,
  origin: string,
): Promise<string | null> {
  const gateway = await getGateway(siteId)
  if (!gateway?.isActive || !gateway.credentialsUsable) return null
  if (amountIncl <= 0) return null

  const intent = await createIntent(siteId, {
    target: { purpose: 'debtor_invoice', documentId },
    amountIncl,
  })
  const token = await createCallbackToken(siteId, intent.reference)

  // The landing page, not the gateway itself: PayFast wants a signed POST, and
  // a link in an email can only ever be a GET. The page builds the form and
  // submits it.
  return `${origin.replace(/\/$/, '')}/pay/${token}`
}

/**
 * Everything the invoice letterhead needs, from the control database.
 *
 * Shared by every place that emails or renders a document on the site's
 * paper — contracts had its own copy, which is how letterheads drift.
 */
export async function issuingSiteFor(siteId: number): Promise<IssuingSite | null> {
  /* ── THROUGH getSite, NOT A SECOND SELECT ─────────────────────────────────
   *
   * This used to read cp2_sites directly, which meant a shop with no line
   * could not put its own name on its own invoice — every field below is
   * already sitting in the local mirror by then, behind a query that was
   * spelled slightly differently. getSite() carries the offline fallback (see
   * lib/site/siteProfile.ts) and requireSite has almost certainly already
   * called it this request, so this is also one fewer control-database read on
   * the document path.
   *
   * The one behavioural difference, said out loud rather than discovered:
   * getSite filters to active and suspended sites, where the old query did not.
   * An ARCHIVED site now gets no letterhead — which is right. An archived site
   * is not trading, and a document issued on its paper is a document that
   * should not exist.
   */
  const site = await getSite(siteId)
  if (!site) return null

  return {
    displayName: site.displayName,
    vatNumber: site.vatNumber,
    registrationNumber: site.registrationNumber,
    address1: site.address1,
    address2: site.address2,
    address3: site.address3,
    postalCode: site.postalCode,
    phone: site.phone,
    email: site.email,
  }
}

/* ── Bodies — shared with the contract sender ────────────────────────────── */

export function invoicePlainBody(
  siteName: string,
  customerName: string,
  number: string,
  document: {
    documentDate: string
    dueDate: string | null
    totalIncl: number
    /** What is STILL owed. Undefined keeps the pre-140 wording (contracts). */
    outstanding?: number
  },
  paymentUrl: string | null,
  message?: string | null,
): string {
  const settled = document.outstanding !== undefined && document.outstanding <= 0.005
  return [
    `Good day${customerName ? ` ${customerName}` : ''},`,
    '',
    ...(message?.trim() ? [message.trim(), ''] : []),
    `Please find attached invoice ${number} for ${formatMoney(document.totalIncl)}.`,
    '',
    `Invoice date: ${document.documentDate}`,
    ...(document.dueDate ? [`Due date: ${document.dueDate}`] : []),
    settled
      ? 'Paid in full — nothing is owed.'
      : `Amount due: ${formatMoney(document.outstanding ?? document.totalIncl)}`,
    ...(paymentUrl ? ['', 'Pay this invoice online:', paymentUrl] : []),
    ...(settled ? [] : ['', `Please quote ${number} with your payment.`]),
    '',
    'Kind regards,',
    siteName,
  ].join('\n')
}

export function invoiceHtmlBody(
  siteName: string,
  customerName: string,
  number: string,
  document: {
    documentDate: string
    dueDate: string | null
    totalIncl: number
    /** What is STILL owed. Undefined keeps the pre-140 wording (contracts). */
    outstanding?: number
  },
  paymentUrl: string | null,
  message?: string | null,
): string {
  const settled = document.outstanding !== undefined && document.outstanding <= 0.005
  // Inline styles and a table layout, because email clients support almost
  // nothing else. Deliberately plain — a statement of fact with a button, not a
  // marketing template.
  return `<div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#16191d;line-height:1.5">
  <p>Good day${customerName ? ` ${escapeHtml(customerName)}` : ''},</p>
  ${message?.trim() ? `<p>${escapeHtml(message.trim())}</p>` : ''}
  <p>Please find attached invoice <strong>${escapeHtml(number)}</strong> for <strong>${formatMoney(document.totalIncl)}</strong>.</p>
  <table cellpadding="0" cellspacing="0" style="font-size:14px;margin:16px 0">
    <tr><td style="padding:2px 16px 2px 0;color:#667085">Invoice date</td><td>${escapeHtml(document.documentDate)}</td></tr>
    ${document.dueDate ? `<tr><td style="padding:2px 16px 2px 0;color:#667085">Due date</td><td>${escapeHtml(document.dueDate)}</td></tr>` : ''}
    ${
      settled
        ? `<tr><td style="padding:2px 16px 2px 0;color:#667085">Payment</td><td><strong>Paid in full — nothing is owed</strong></td></tr>`
        : `<tr><td style="padding:2px 16px 2px 0;color:#667085">Amount due</td><td><strong>${formatMoney(document.outstanding ?? document.totalIncl)}</strong></td></tr>`
    }
  </table>
  ${
    paymentUrl
      ? `<p style="margin:20px 0"><a href="${escapeHtml(paymentUrl)}" style="background:#16191d;color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block">Pay this invoice online</a></p>`
      : ''
  }
  ${settled ? '' : `<p style="color:#667085;font-size:13px">Please quote ${escapeHtml(number)} with your payment.</p>`}
  <p>Kind regards,<br>${escapeHtml(siteName)}</p>
</div>`
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}


/* ── A quote says something different ─────────────────────────────────────── */

/**
 * The covering note for a quote.
 *
 * ── WHY NOT invoicePlainBody WITH A FLAG ────────────────────────────────────
 *
 * Almost every line differs, and the ones that differ are the ones that matter.
 * An invoice says "amount due" and "please quote this number with your
 * payment"; a quote asks for neither, because nothing is owed and nobody should
 * be told to pay. Threading a `kind` through the invoice body would put a
 * conditional on nearly every line, and the first person to add a line would
 * have to decide what a quote does with it — which is how a customer eventually
 * receives an offer telling them to settle it within thirty days.
 *
 * ── VALIDITY IS THE LINE THAT EARNS THIS ────────────────────────────────────
 *
 * "Valid for 30 days" is the sentence on every quote ever issued, and it is the
 * one fact the attached PDF and the covering email must agree on. Where a quote
 * carries no validity date the line is omitted rather than filled in with a
 * guess — a business that chooses not to expire its quotes should not have this
 * email inventing an expiry for it.
 */
export function quotePlainBody(
  siteName: string,
  customerName: string,
  number: string,
  document: { documentDate: string; validUntil: string | null; totalIncl: number },
  message?: string | null,
): string {
  return [
    `Good day${customerName ? ` ${customerName}` : ''},`,
    '',
    ...(message?.trim() ? [message.trim(), ''] : []),
    `Please find attached quotation ${number} for ${formatMoney(document.totalIncl)}.`,
    '',
    `Quotation date: ${document.documentDate}`,
    ...(document.validUntil ? [`Valid until: ${document.validUntil}`] : []),
    '',
    'Let us know if you would like to go ahead, or if anything needs changing.',
    '',
    'Kind regards,',
    siteName,
  ].join('\n')
}

export function quoteHtmlBody(
  siteName: string,
  customerName: string,
  number: string,
  document: { documentDate: string; validUntil: string | null; totalIncl: number },
  message?: string | null,
): string {
  // Inline styles and a table, matching invoiceHtmlBody: email clients support
  // almost nothing else, and the two should look like they came from one
  // business. escapeHtml on every value somebody typed — this goes out under
  // the business's name, so a note field must not be able to inject into it.
  return `<div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#16191d;line-height:1.5">
  <p>Good day${customerName ? ` ${escapeHtml(customerName)}` : ''},</p>
  ${message?.trim() ? `<p>${escapeHtml(message.trim())}</p>` : ''}
  <p>Please find attached quotation <strong>${escapeHtml(number)}</strong> for <strong>${formatMoney(document.totalIncl)}</strong>.</p>
  <table cellpadding="0" cellspacing="0" style="font-size:14px;margin:16px 0">
    <tr><td style="padding:2px 16px 2px 0;color:#667085">Quotation date</td><td>${escapeHtml(document.documentDate)}</td></tr>
    ${document.validUntil ? `<tr><td style="padding:2px 16px 2px 0;color:#667085">Valid until</td><td>${escapeHtml(document.validUntil)}</td></tr>` : ''}
  </table>
  <p>Let us know if you would like to go ahead, or if anything needs changing.</p>
  <p>Kind regards,<br>${escapeHtml(siteName)}</p>
</div>`
}


/* ── Quotes ───────────────────────────────────────────────────────────────── */

export type EmailQuoteResult = { ok: true; to: string } | { ok: false; error: string }

/**
 * Email a quote to its customer.
 *
 * ── WHY THIS IS BESIDE emailInvoiceDocument AND NOT INSIDE IT ───────────────
 *
 * The two share the render, the transport and the audit row, and that shared
 * machinery is used verbatim. What differs is every guard and the whole of what
 * the customer is told:
 *
 *   · An invoice may only be sent once FINALISED, because a draft has no number
 *     and no debtor entry. A quote has no such rule — an issued quote is the
 *     normal thing to send, and it never posts at all (see 048).
 *   · An invoice carries a pay link. A quote must not: nothing is owed yet, and
 *     a button asking for money on an offer the customer has not accepted is
 *     the single worst thing this feature could do.
 *   · An invoice records nothing on the document. A quote records quote_sent_at,
 *     which is what the follow-up worklist is built from.
 *
 * A `kind` parameter on the invoice sender would put a conditional on each of
 * those, and the failure mode of getting one wrong is a customer being asked to
 * pay for something they have not agreed to buy.
 */
export async function emailQuoteDocument(
  siteId: number,
  site: IssuingSite,
  actor: Actor,
  documentId: number,
  opts: { to: string; message?: string | null },
  deps: MailDeps = SITE_MAIL,
): Promise<EmailQuoteResult> {
  if (!(await deps.configured(siteId))) return { ok: false, error: 'Email is not set up on this system.' }

  const to = opts.to.trim()
  if (!to) return { ok: false, error: 'Give an address to send it to.' }

  const document = await getDocument(siteId, documentId)
  if (!document) return { ok: false, error: 'That document no longer exists.' }
  if (document.docType !== 'quote') {
    return { ok: false, error: `A ${document.docLabel.toLowerCase()} is not emailed from here.` }
  }
  /*
   * A DRAFT quote is refused, and this is the one guard shared with invoices.
   *
   * Not for the invoice's reason — a quote raises no debtor entry either way —
   * but because a draft has no document number, and a customer cannot refer to
   * an offer that has no name. It is also, in practice, still being written.
   */
  if (document.status === 'draft' || document.status === 'saved') {
    return { ok: false, error: 'Issue the quote first — a draft has no number for the customer to quote back.' }
  }
  if (document.status === 'cancelled') {
    return { ok: false, error: 'That quote has been cancelled.' }
  }

  const customer = document.customerId ? await getCustomer(siteId, document.customerId) : null

  /*
   * NO paymentUrl, and the null is passed explicitly rather than omitted.
   *
   * buildInvoice takes it as an option; leaving it out would work today and
   * would be the sort of thing somebody later "tidies up" by copying the
   * invoice call. Written out so the absence is visibly deliberate.
   */
  const data = await buildInvoice(siteId, site, documentId, { paymentUrl: null })
  if (!data) return { ok: false, error: 'The document could not be built.' }

  let pdf: Buffer
  try {
    // QUOTATION, not TAX INVOICE. printKindFor already knows; the heading and
    // closing come from the same maps every other surface prints from, so the
    // emailed PDF and the printed one cannot disagree.
    pdf = await renderInvoicePdf(data, siteId, {
      heading: HEADING[printKindFor(document)],
      closing: CLOSING[printKindFor(document)],
      /*
       * A quote's square takes a DEPOSIT — it does not settle anything, and it
       * emphatically does not convert the quote.
       *
       * Paying is how a customer ACCEPTS an offer, and money is a better signal
       * of that than a click. But convertToInvoice raises a draft plus three
       * warnings a person is meant to read — the quote expired, prices moved,
       * stock is short — and converting on payment would take the money and only
       * then discover the goods cannot be supplied. documentPayUrl gives a
       * `document_deposit` link for exactly that reason; see paidLinks.ts.
       */
      payUrl: await documentPayUrl(siteId, document).catch(() => null),
    })
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'The PDF could not be produced.',
    }
  }

  const number = document.documentNumber ?? `#${documentId}`
  /*
   * The validity date, read straight from the row.
   *
   * SalesDocument does not carry valid_until — it is the shared shape for every
   * document type, and widening it for the one caller that needs a quote-only
   * column would put a field on invoices, credit notes and orders that is
   * always null. One small query is the cheaper answer, and it fails soft:
   * a quote with no validity simply omits the line.
   */
  const validityRow = await siteQueryOne<Row>(
    siteId,
    `SELECT valid_until FROM sales_documents WHERE id = ?`,
    [documentId],
  ).catch(() => null)
  const validUntil =
    validityRow?.valid_until == null ? null : String(validityRow.valid_until).slice(0, 10)

  const result = await deps.send(siteId, {
    to,
    subject: `Quotation ${number} from ${site.displayName}`,
    text: quotePlainBody(
      site.displayName,
      customer?.name ?? '',
      number,
      { documentDate: document.documentDate, validUntil, totalIncl: document.totalIncl },
      opts.message,
    ),
    html: quoteHtmlBody(
      site.displayName,
      customer?.name ?? '',
      number,
      { documentDate: document.documentDate, validUntil, totalIncl: document.totalIncl },
      opts.message,
    ),
    attachments: [{ filename: `${number}.pdf`, content: pdf, contentType: 'application/pdf' }],
  })
  if (!result.ok) return { ok: false, error: result.error }

  /*
   * Stamped only AFTER the transport accepted it.
   *
   * quote_sent_at drives the follow-up worklist and the Sent state, so writing
   * it before the send would mark a quote as sent that never left — and the
   * salesperson would wait for a reply to an email nobody received.
   */
  await siteExecute(
    siteId,
    `UPDATE sales_documents SET quote_sent_at = NOW(), quote_sent_to = ? WHERE id = ?`,
    [to.slice(0, 190), documentId],
  ).catch(() => {})

  await siteExecute(
    siteId,
    `INSERT INTO document_audit (document_id, action, detail, user_id, user_name)
     VALUES (?, 'emailed', ?, ?, ?)`,
    [documentId, `${number} to ${to} — ${formatMoney(document.totalIncl)}`, actor.userId, actor.userName.slice(0, 120)],
  ).catch(() => {})

  if (document.customerId) {
    await logActivity(siteId, actor, {
      entity: 'customer',
      entityId: document.customerId,
      action: 'quote_emailed',
      detail: `${number} emailed to ${to} — ${formatMoney(document.totalIncl)}`,
    }).catch(() => undefined)
  }

  return { ok: true, to }
}

/**
 * The customer opened it.
 *
 * ── IT NEVER THROWS AND NEVER BLOCKS ────────────────────────────────────────
 *
 * Called from whatever surface shows a customer their quote. That surface's job
 * is to show the quote; if this fails, the customer must still see it. A
 * tracking write that can 500 a customer-facing page is a worse bug than no
 * tracking at all.
 *
 * ── FIRST view is kept, not the last ────────────────────────────────────────
 *
 * quote_viewed_at is written only while it is NULL, so it records how long the
 * customer took to look. The count increments every time. See 227.
 */
export async function recordQuoteView(siteId: number, documentId: number): Promise<void> {
  try {
    await siteExecute(
      siteId,
      `UPDATE sales_documents
          SET quote_viewed_at = COALESCE(quote_viewed_at, NOW()),
              quote_view_count = quote_view_count + 1
        WHERE id = ? AND doc_type = 'quote'`,
      [documentId],
    )
  } catch {
    /* A site without 227, or a database blip. Never the reason a page fails. */
  }
}

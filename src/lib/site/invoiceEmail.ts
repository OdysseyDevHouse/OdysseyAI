import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteExecute, siteQueryOne } from '../siteDb'
import { queryOne } from '../db'
import { formatMoney } from '../decimals'
import { send, isConfigured } from '../mail'
import { renderInvoicePdf } from '../invoices/pdf'
import { buildInvoice, type IssuingSite } from '../invoices/build'
import { createCallbackToken } from '../callbackToken'
import { createIntent, getGateway } from './payments'
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
export type MailDeps = {
  send: typeof send
  configured: () => boolean
}

export async function emailInvoiceDocument(
  siteId: number,
  site: IssuingSite,
  actor: Actor,
  documentId: number,
  opts: { to: string; message?: string | null; origin: string },
  deps: MailDeps = { send, configured: isConfigured },
): Promise<EmailInvoiceResult> {
  if (!deps.configured()) return { ok: false, error: 'Email is not set up on this system.' }

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

  const data = await buildInvoice(siteId, site, documentId, { paymentUrl })
  if (!data) return { ok: false, error: 'The document could not be built.' }

  let pdf: Buffer
  try {
    pdf = await renderInvoicePdf(data)
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'The PDF could not be produced.',
    }
  }

  const number = document.documentNumber ?? `#${documentId}`
  const label = document.docType === 'credit_sale' ? 'Credit note' : 'Invoice'
  const result = await deps.send({
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
    targetId: documentId,
    amountIncl,
    purpose: 'debtor_invoice',
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
  const row = await queryOne<{
    company_name: string
    trading_name: string | null
    vat_number: string | null
    registration_number: string | null
    address1: string | null
    address2: string | null
    address3: string | null
    postal_code: string | null
    phone: string | null
    email: string | null
  }>(
    `SELECT company_name, trading_name, vat_number, registration_number,
            address1, address2, address3, postal_code, phone, email
       FROM cp2_sites WHERE id = ? LIMIT 1`,
    [siteId],
  )
  if (!row) return null

  return {
    displayName: row.trading_name?.trim() || row.company_name,
    vatNumber: row.vat_number,
    registrationNumber: row.registration_number,
    address1: row.address1,
    address2: row.address2,
    address3: row.address3,
    postalCode: row.postal_code,
    phone: row.phone,
    email: row.email,
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

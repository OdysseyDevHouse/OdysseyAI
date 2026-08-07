import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'
import { formatMoney } from '../decimals'
import { send, isConfigured } from '../mail'
import { renderInvoicePdf } from '../invoices/pdf'
import { buildInvoice, type IssuingSite } from '../invoices/build'
import { createCallbackToken } from '../callbackToken'
import { createIntent, getGateway } from './payments'
import { getDocument } from './salesDocuments'
import { getCustomer } from './customers'
import { logActivity, type Actor } from './activityLog'

/**
 * Emailing a contract invoice to the customer.
 *
 * Split from contracts.ts deliberately. Generating an invoice and sending it are
 * separate failures with separate remedies: a generation failure means the
 * customer was not billed and the period must be retried, while a send failure
 * means they WERE billed and only the notification is missing. Conflating them
 * is how a customer gets billed twice for one month — so the two live in
 * different files and record their outcomes in different columns.
 *
 * ── SENDING IS RETRIED, BILLING IS NOT ───────────────────────────────────
 *
 * `email_status` and `email_attempts` on contract_invoices are what make a
 * resend safe: it re-renders and re-sends the SAME document, touching nothing
 * on the ledger. The invoice keeps its number and its debtor transaction.
 *
 * ── ONE BAD ADDRESS MUST NOT STOP THE RUN ────────────────────────────────
 *
 * Every send reports rather than throws, exactly as lib/mail.ts is built to do.
 * A book of 400 contracts is 400 independent sends and one bounced address marks
 * ONE row failed.
 */

type Row = RowDataPacket & Record<string, unknown>

export type SendOutcome =
  | { ok: true; to: string }
  | { ok: false; error: string; skipped?: boolean }

/**
 * Renders one invoice and emails it, recording the outcome.
 *
 * `contractInvoiceId` is the contract_invoices row, not the document — the
 * outcome belongs against the period that was billed, which is what a person
 * looking at "did March go out" is actually asking about.
 */
export async function emailContractInvoice(
  siteId: number,
  site: IssuingSite,
  actor: Actor,
  contractInvoiceId: number,
  opts: { origin: string; force?: boolean } = { origin: '' },
): Promise<SendOutcome> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT ci.*, c.name AS contract_name, c.contract_number, c.offer_payment_link,
            c.customer_id
       FROM contract_invoices ci
       INNER JOIN contracts c ON c.id = ci.contract_id
      WHERE ci.id = ? LIMIT 1`,
    [contractInvoiceId],
  )
  if (!row) return { ok: false, error: 'That billing record no longer exists.' }

  const documentId = row.document_id === null ? null : Number(row.document_id)
  if (!documentId) {
    return await record(siteId, contractInvoiceId, 'skipped', null, 'No invoice was created for this period.')
  }

  // Already sent, and not an explicit resend. Silent success rather than a
  // second copy: a customer receiving March's invoice twice reads it as a
  // second bill and phones about it.
  if (String(row.email_status) === 'sent' && !opts.force) {
    return { ok: true, to: String(row.emailed_to ?? '') }
  }

  if (!isConfigured()) {
    return await record(siteId, contractInvoiceId, 'skipped', null, 'Email is not set up on this system.')
  }

  const document = await getDocument(siteId, documentId)
  if (!document) {
    return await record(siteId, contractInvoiceId, 'failed', null, 'That invoice no longer exists.')
  }

  // A draft has no number and no debtor entry. Sending one would be sending the
  // customer a bill the business has not actually raised.
  if (document.status !== 'finalised') {
    return await record(
      siteId,
      contractInvoiceId,
      'skipped',
      null,
      'The invoice has not been posted yet, so it has not been sent.',
    )
  }

  const customer = await getCustomer(siteId, Number(row.customer_id))
  const to = customer?.email?.trim() ?? ''
  if (!to) {
    return await record(
      siteId,
      contractInvoiceId,
      'skipped',
      null,
      `${customer?.name ?? 'That customer'} has no email address on their account.`,
    )
  }

  // ── The pay-online link ────────────────────────────────────────────────
  //
  // Minted per SEND, not per invoice: the callback token expires in 24 hours,
  // so a link baked in at generation time would already be dead by the time
  // anyone resent it. A failure here must not stop the invoice going out — an
  // invoice with no pay link is still an invoice.
  let paymentUrl: string | null = null
  if (Boolean(row.offer_payment_link) && opts.origin) {
    paymentUrl = await mintPaymentLink(siteId, documentId, document.totalIncl, opts.origin).catch(
      () => null,
    )
  }

  const forDate = String(row.for_date)
  const contractNumber = (row.contract_number as string | null) ?? null

  const data = await buildInvoice(siteId, site, documentId, {
    paymentUrl,
    footNote: contractNumber
      ? `Raised automatically from contract ${contractNumber} · ${monthName(forDate)}.`
      : null,
  })
  if (!data) {
    return await record(siteId, contractInvoiceId, 'failed', to, 'The invoice could not be built.')
  }

  let pdf: Buffer
  try {
    pdf = await renderInvoicePdf(data)
  } catch (error) {
    return await record(
      siteId,
      contractInvoiceId,
      'failed',
      to,
      error instanceof Error ? error.message : 'The invoice PDF could not be produced.',
    )
  }

  const number = document.documentNumber ?? `#${documentId}`
  const result = await send({
    to,
    subject: `Invoice ${number} from ${site.displayName}`,
    text: plainBody(site.displayName, customer?.name ?? '', number, document, paymentUrl),
    html: htmlBody(site.displayName, customer?.name ?? '', number, document, paymentUrl),
    attachments: [
      {
        filename: `${number}.pdf`,
        content: pdf,
        contentType: 'application/pdf',
      },
    ],
  })

  if (!result.ok) {
    return await record(siteId, contractInvoiceId, 'failed', to, result.error)
  }

  await record(siteId, contractInvoiceId, 'sent', to, null)
  await logActivity(siteId, actor, {
    entity: 'customer',
    entityId: Number(row.customer_id),
    action: 'contract_invoice_sent',
    detail: `${number} emailed to ${to} — ${formatMoney(document.totalIncl)}`,
  })

  return { ok: true, to }
}

/**
 * Sends every posted contract invoice that has not gone out yet.
 *
 * Worked one at a time rather than in parallel: SMTP providers rate-limit, and
 * being throttled halfway through a run with no way to tell which sends landed
 * is worse than taking a minute longer. The same reasoning statementRuns.ts
 * gives for its pooled, capped transport.
 */
export async function sendPending(
  siteId: number,
  site: IssuingSite,
  actor: Actor,
  origin: string,
  limit = 200,
): Promise<{ sent: number; failed: number; skipped: number }> {
  const capped = Math.min(Math.max(limit, 1), 1000)
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT ci.id
       FROM contract_invoices ci
      WHERE ci.status = 'posted'
        AND ci.email_status IN ('pending','failed')
        -- Three strikes. A permanently bad address must stop consuming a send
        -- slot on every tick for ever; it stays visible on the screen as failed.
        AND ci.email_attempts < 3
      ORDER BY ci.for_date
      LIMIT ${capped}`,
  )

  let sent = 0
  let failed = 0
  let skipped = 0

  for (const row of rows) {
    const outcome = await emailContractInvoice(siteId, site, actor, Number(row.id), { origin })
    if (outcome.ok) sent++
    else if (outcome.skipped) skipped++
    else failed++
  }

  return { sent, failed, skipped }
}

/* ── Internals ───────────────────────────────────────────────────────────── */

async function record(
  siteId: number,
  contractInvoiceId: number,
  status: 'sent' | 'failed' | 'skipped',
  to: string | null,
  error: string | null,
): Promise<SendOutcome> {
  await siteExecute(
    siteId,
    `UPDATE contract_invoices
        SET email_status = ?, emailed_to = ?, error = ?,
            emailed_at = ${status === 'sent' ? 'NOW()' : 'emailed_at'},
            -- Only a real attempt counts. A skip for "no email address" must not
            -- burn through the retry budget, or fixing the address later would
            -- leave the invoice permanently unsendable.
            email_attempts = email_attempts + ${status === 'failed' ? 1 : 0}
      WHERE id = ?`,
    [status, to, error, contractInvoiceId],
  )

  if (status === 'sent') return { ok: true, to: to ?? '' }
  return { ok: false, error: error ?? 'The invoice was not sent.', skipped: status === 'skipped' }
}

/**
 * A pay-online URL for one invoice.
 *
 * Reuses the storefront's machinery exactly — an intent recording what we
 * expect, plus a signed callback token binding site and reference together. The
 * only difference is `purpose`, which tells the ITN handler to settle a debtor
 * invoice rather than a shop order.
 *
 * Returns null when the gateway is not usable, so the invoice still goes out
 * with no link rather than not going out at all.
 */
async function mintPaymentLink(
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

function monthName(iso: string): string {
  const date = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' })
}

function plainBody(
  siteName: string,
  customerName: string,
  number: string,
  document: { documentDate: string; dueDate: string | null; totalIncl: number },
  paymentUrl: string | null,
): string {
  return [
    `Good day${customerName ? ` ${customerName}` : ''},`,
    '',
    `Please find attached invoice ${number} for ${formatMoney(document.totalIncl)}.`,
    '',
    `Invoice date: ${document.documentDate}`,
    ...(document.dueDate ? [`Due date: ${document.dueDate}`] : []),
    `Amount due: ${formatMoney(document.totalIncl)}`,
    ...(paymentUrl ? ['', 'Pay this invoice online:', paymentUrl] : []),
    '',
    `Please quote ${number} with your payment.`,
    '',
    'Kind regards,',
    siteName,
  ].join('\n')
}

function htmlBody(
  siteName: string,
  customerName: string,
  number: string,
  document: { documentDate: string; dueDate: string | null; totalIncl: number },
  paymentUrl: string | null,
): string {
  // Inline styles and a table layout, because email clients support almost
  // nothing else. Deliberately plain — a statement of fact with a button, not a
  // marketing template.
  return `<div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#16191d;line-height:1.5">
  <p>Good day${customerName ? ` ${escapeHtml(customerName)}` : ''},</p>
  <p>Please find attached invoice <strong>${escapeHtml(number)}</strong> for <strong>${formatMoney(document.totalIncl)}</strong>.</p>
  <table cellpadding="0" cellspacing="0" style="font-size:14px;margin:16px 0">
    <tr><td style="padding:2px 16px 2px 0;color:#667085">Invoice date</td><td>${escapeHtml(document.documentDate)}</td></tr>
    ${document.dueDate ? `<tr><td style="padding:2px 16px 2px 0;color:#667085">Due date</td><td>${escapeHtml(document.dueDate)}</td></tr>` : ''}
    <tr><td style="padding:2px 16px 2px 0;color:#667085">Amount due</td><td><strong>${formatMoney(document.totalIncl)}</strong></td></tr>
  </table>
  ${
    paymentUrl
      ? `<p style="margin:20px 0"><a href="${escapeHtml(paymentUrl)}" style="background:#16191d;color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block">Pay this invoice online</a></p>`
      : ''
  }
  <p style="color:#667085;font-size:13px">Please quote ${escapeHtml(number)} with your payment.</p>
  <p>Kind regards,<br>${escapeHtml(siteName)}</p>
</div>`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

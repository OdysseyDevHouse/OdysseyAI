import { requireSiteUser } from '@/lib/auth'
import { getDocument } from '@/lib/site/salesDocuments'
import { creditableLines } from '@/lib/site/salesReversal'
import { listSalesReasons } from '@/lib/site/salesReasons'
import { getCustomer } from '@/lib/site/customers'
import { lastEmailed } from '@/lib/site/invoiceEmail'
import { isConfigured as mailIsConfigured } from '@/lib/mail'
import { can } from '@/lib/site/permissions'
import { today as localToday } from '@/lib/site/ledger'
import DocumentActions from './DocumentActions'

/**
 * What may be DONE to a posted document — print, email, credit, cancel — with
 * every "may they" resolved on the server.
 *
 * ── WHY THIS IS ITS OWN COMPONENT ─────────────────────────────────────────
 *
 * The rules are fiddly and they matter: a sale is cancellable only on the day
 * it was rung up, creditable only while a line has something left on it, and
 * both only for a role that holds the right. They used to live inline on the
 * back-office viewer, which was fine while that page was the only place a
 * document could be acted on.
 *
 * The invoicing counter now finishes a sale in its own window and offers the
 * same four actions there, so a second copy would be a second place for
 * "same-day only" to drift out of step — and the two disagreeing about whether
 * something can be cancelled is the kind of bug nobody reports, because each
 * screen looks right on its own.
 *
 * So the rules live here once and both screens render this.
 */
export default async function DocumentActionBar({ documentId }: { documentId: number }) {
  const { site, capabilities } = await requireSiteUser()

  const document = await getDocument(site.id, documentId)
  if (!document) return null

  const emailable =
    document.status === 'finalised' &&
    (document.docType === 'invoice' || document.docType === 'credit_sale')
  const mailReady = mailIsConfigured()

  const [remaining, voidReasons, returnReasons, emailCustomer, lastSend] = await Promise.all([
    document.docType === 'invoice' && document.status === 'finalised'
      ? creditableLines(site.id, documentId)
      : Promise.resolve(null),
    // Active only: these are the lists somebody picks FROM. Retired reasons stay
    // readable on the documents that used them.
    listSalesReasons(site.id, 'void'),
    listSalesReasons(site.id, 'return'),
    emailable && document.customerId
      ? getCustomer(site.id, document.customerId)
      : Promise.resolve(null),
    emailable ? lastEmailed(site.id, documentId) : Promise.resolve(null),
  ])

  // Local date, matching voidDocument's own check — toISOString() is UTC and
  // hid the Void button from a sale rung up after local midnight.
  const today = localToday()
  const voidable =
    document.status === 'finalised' &&
    document.documentDate === today &&
    can(capabilities, 'sales.void')

  // Offered only when there is genuinely something left to credit — a button
  // that leads to "everything has already been credited" is a wasted trip.
  const creditable =
    (remaining ?? []).some((l) => l.creditable > 0) && can(capabilities, 'sales.credit_note')

  /*
   * Why an action is unavailable, computed here where the facts are.
   *
   * Returns null when the button should not appear at all — on a quote, or a
   * document that was never finalised, a Cancel button is noise. It returns a
   * REASON when the action is one this user could plausibly have expected,
   * because a silently missing button sends people looking for a bug.
   */
  const isPostedInvoice = document.docType === 'invoice' && document.status === 'finalised'

  const voidBlockedReason = !isPostedInvoice
    ? null
    : !can(capabilities, 'sales.void')
      ? `Your role (${site.role}) cannot cancel a sale. An owner can grant this in Setup → Permissions.`
      : document.documentDate !== today
        ? `Only same-day sales can be cancelled — this one is dated ${document.documentDate}. Credit it instead.`
        : null

  const creditBlockedReason = !isPostedInvoice
    ? null
    : !can(capabilities, 'sales.credit_note')
      ? `Your role (${site.role}) cannot credit a sale. An owner can grant this in Setup → Permissions.`
      : !(remaining ?? []).some((l) => l.creditable > 0)
        ? 'Every line on this invoice has already been credited.'
        : null

  return (
    <DocumentActions
      documentId={document.id}
      documentNumber={document.documentNumber}
      voidable={voidable}
      isVoid={document.status === 'cancelled'}
      creditable={creditable}
      voidReasons={voidReasons}
      returnReasons={returnReasons}
      voidBlockedReason={voidBlockedReason}
      creditBlockedReason={creditBlockedReason}
      emailable={emailable}
      mailConfigured={mailReady}
      emailDefaultTo={emailCustomer?.email ?? ''}
      lastEmailedNote={lastSend ? `${lastSend.detail ?? ''} · ${lastSend.userName}` : null}
    />
  )
}

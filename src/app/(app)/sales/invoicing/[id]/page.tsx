import { notFound } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { getDocument, isEditable } from '@/lib/site/salesDocuments'
import { listPriceStructures, repsForLines } from '@/lib/site/lookups'
import { listUsers } from '@/lib/site/users'
import { liveSpecials } from '@/lib/site/specials'
import { can } from '@/lib/site/permissions'
import { listTenderTypes } from '@/lib/site/tenderTypes'
import { getNumericSetting } from '@/lib/site/settings'
import { getTillCustomer } from '@/lib/site/tillCustomers'
import InvoiceEditor from './InvoiceEditor'
import { depositSummary } from '@/lib/site/deposits'
import { DepositPanel } from '../../DepositPanel'
import { listAttachments } from '@/lib/site/attachments'
import { AttachmentsPanel } from '@/components/attachments/AttachmentsPanel'
import { PageBody, Card, CardHeader, CardBody } from '@/components/ui'

export const dynamic = 'force-dynamic'

/**
 * The back-office invoice editor.
 *
 * Distinct from /sales/[id], which is the read-only record of a posted
 * document, and from the till, which is touch-first and one-basket-at-a-time.
 * This is the keyboard-and-mouse screen for capturing an invoice off an order
 * form: every figure on a line is editable until the document is finalised.
 */
export default async function InvoicingPage({ params }: { params: Promise<{ id: string }> }) {
  const { site, user, capabilities } = await requireSiteUser()
  const { id } = await params

  const documentId = Number(id)
  if (!Number.isFinite(documentId) || documentId <= 0) notFound()

  const [document, structures, users, tenders, cashRounding, specials, deposits] =
    await Promise.all([
    getDocument(site.id, documentId),
    listPriceStructures(site.id),
    // Users, not sales_reps: commission is paid to a user (047), so the
    // per-line picker has to name one or the attribution goes nowhere.
    listUsers(site.id),
    listTenderTypes(site.id),
    getNumericSetting(site.id, 'sales_cash_rounding'),
    // Windows unevaluated — the editor checks them against its own clock.
    liveSpecials(site.id),
    // What is held against this invoice (172). Batched here rather than fetched
    // by the panel, so the figures paint with the page instead of after it.
    depositSummary(site.id, documentId),
  ])
  if (!document) notFound()

  // Whoever is capturing is pre-selected on every new line — right nearly
  // every time, and otherwise they pick themselves out of a list on each one.
  const { reps, defaultUserId } = repsForLines(users, user.id)

  // The credit position for the attached account, so the finalise dialog can
  // judge the account tender without a round trip on open. Depends on the
  // document, so it cannot join the batch above.
  const customer = document.customerId
    ? await getTillCustomer(site.id, document.customerId)
    : null

  // Only once it is a real document. A draft has nothing to prove yet, and an
  // upload box on a half-captured invoice is noise in the way of the grid.
  const attachments = isEditable(document.status)
    ? []
    : await listAttachments(site.id, 'sales_document', documentId)

  return (
    <>
      <InvoiceEditor
        document={document}
        structures={structures}
        reps={reps}
        defaultRepUserId={defaultUserId}
        tenders={tenders}
        cashRounding={cashRounding}
        customer={customer}
        editable={isEditable(document.status)}
        canOverrideDiscount={can(capabilities, 'sales.discount_override')}
        canOverridePrice={can(capabilities, 'sales.price_override')}
        specials={specials}
        showCost={can(capabilities, 'products.cost')}
      />

      {/* Money already paid against this invoice. Below the grid: the lines are
          what somebody opened this screen to work on, and the deposit is what
          they check once they know what the invoice is worth.

          In a PageBody like every other section on this page — it carries the
          page gutter and the gap between sections, so a bare Card here sits
          flush against the editor above it and runs to the window edges. */}
      <PageBody>
        <DepositPanel
          documentId={documentId}
          docType="invoice"
          status={document.status}
          totalIncl={deposits.totalIncl}
          held={deposits.held}
          entries={deposits.entries}
          hasCustomer={document.customerId !== null}
          canEdit={can(capabilities, 'sales.edit') && isEditable(document.status)}
        />
      </PageBody>

      {/* The signed delivery note. This is the answer when a customer says the
          delivery was short — the exact dispute credit control now tracks. */}
      {!isEditable(document.status) && (
        <PageBody>
          <Card>
            <CardHeader
              title="Proof of delivery"
              description="Anything signed or sent that supports this invoice."
            />
            <CardBody>
              <AttachmentsPanel
                entity="sales_document"
                entityId={documentId}
                canEdit={can(capabilities, 'sales.edit')}
                hint="Attach the signed delivery note. When a customer disputes what arrived, this is the answer."
                attachments={attachments.map((a) => ({
                  id: a.id,
                  filename: a.filename,
                  description: a.description,
                  sizeBytes: a.sizeBytes,
                  uploadedName: a.uploadedName,
                  createdAt: a.createdAt.toISOString(),
                }))}
              />
            </CardBody>
          </Card>
        </PageBody>
      )}
    </>
  )
}

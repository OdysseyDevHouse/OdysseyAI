import { notFound } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { getDocument, isEditable } from '@/lib/site/salesDocuments'
import { listPriceStructures } from '@/lib/site/lookups'
import { listUsers } from '@/lib/site/users'
import { liveSpecials } from '@/lib/site/specials'
import { can } from '@/lib/site/permissions'
import { listTenderTypes } from '@/lib/site/tenderTypes'
import { getNumericSetting } from '@/lib/site/settings'
import { getTillCustomer } from '@/lib/site/tillCustomers'
import InvoiceEditor from './InvoiceEditor'
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
  const { site, capabilities } = await requireSiteUser()
  const { id } = await params

  const documentId = Number(id)
  if (!Number.isFinite(documentId) || documentId <= 0) notFound()

  const [document, structures, users, tenders, cashRounding, specials] = await Promise.all([
    getDocument(site.id, documentId),
    listPriceStructures(site.id),
    // Users, not sales_reps: commission is paid to a user (047), so the
    // per-line picker has to name one or the attribution goes nowhere.
    listUsers(site.id),
    listTenderTypes(site.id),
    getNumericSetting(site.id, 'sales_cash_rounding'),
    // Windows unevaluated — the editor checks them against its own clock.
    liveSpecials(site.id),
  ])
  if (!document) notFound()

  const reps = users
    .filter((u) => u.isActive)
    .map((u) => ({ id: u.id, name: u.name, code: null }))

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
        tenders={tenders}
        cashRounding={cashRounding}
        customer={customer}
        editable={isEditable(document.status)}
        canOverrideDiscount={can(capabilities, 'sales.discount_override')}
        canOverridePrice={can(capabilities, 'sales.price_override')}
        specials={specials}
        showCost={can(capabilities, 'products.cost')}
      />

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

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
import { DepositPanel } from '@/app/(app)/sales/DepositPanel'
import { listAttachments } from '@/lib/site/attachments'
import { listSalesReasons } from '@/lib/site/salesReasons'
import { AttachmentsPanel } from '@/components/attachments/AttachmentsPanel'
import { Card, CardHeader, CardBody, Icons } from '@/components/ui'

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

  const [
    document,
    structures,
    users,
    tenders,
    cashRounding,
    specials,
    deposits,
    voidReasons,
    returnReasons,
  ] = await Promise.all([
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
    /* The two reason lists, for the dialog that appears once this invoice is
       posted — a counter cancelling or crediting picks from them without
       leaving the window. Active only: these are the lists somebody picks
       FROM, and a retired reason stays readable on the documents that used
       it. Batched here so the dialog opens with them already in hand. */
    listSalesReasons(site.id, 'void'),
    listSalesReasons(site.id, 'return'),
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
        /* What the counter may do with the invoice the moment it posts —
           the finalised dialog offers cancel and credit rather than sending
           somebody to the back office to find them. The rules themselves
           are re-checked server-side by each action. */
        voidReasons={voidReasons}
        returnReasons={returnReasons}
        canVoid={can(capabilities, 'sales.void')}
        canCredit={can(capabilities, 'sales.credit_note')}
        /* Already read for the panel below, and the tender pad needs the same
           figure: it must ask for the BALANCE, because finaliseDocument adds
           the held deposit as a tender of its own. */
        depositHeld={deposits.held}
        /* The deposit panel — and, once finalised, proof of delivery — follow
           below, so the editor must not close the page with its own pb-10. */
        hasSectionsBelow
      />

      {/*
        ── EVERYTHING BELOW THE EDITOR, IN ONE BLOCK ──────────────────────

        NOT a second and third PageBody, which is what this was. PageBody
        carries `pt-5 pb-10` as well as the gutter, so stacking them put 60px
        between the editor and the deposit — three times the `gap-5` that
        separates every other section — and the same again before proof of
        delivery. The screen visibly came apart at those two seams.

        One block wearing PageBody's own numbers — `px-6 pt-5 pb-10 gap-5` —
        so every seam on the page is the same 20px. The editor is told
        `hasSectionsBelow`, which drops its trailing `pb-10`; without that its
        40px and this block's 20px stacked into a 60px gap. Same shape the
        order screen uses.
      */}
      <div className="flex flex-col gap-5 px-6 pt-5 pb-10">
        {/* Money already paid against this invoice. Below the grid: the lines
            are what somebody opened this screen to work on, and the deposit is
            what they check once they know what the invoice is worth. */}
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

        {/* The signed delivery note. This is the answer when a customer says the
            delivery was short — the exact dispute credit control now tracks. */}
        {!isEditable(document.status) && (
          <Card>
            <CardHeader
              icon={<Icons.FileText size={18} />}
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
        )}
      </div>
    </>
  )
}

import { requireModuleCapability } from '@/lib/auth'
import { listPromises } from '@/lib/site/creditControl'
import { Icons, PageHeader, PageBody } from '@/components/ui'
import { PromisesClient, type PromiseRow } from './PromisesClient'

export const dynamic = 'force-dynamic'

/**
 * Promises to pay.
 *
 * ── WHY THIS DESERVES ITS OWN SCREEN ─────────────────────────────────────
 *
 * "I'll pay on Friday" is the most common reply to a reminder and the piece of
 * information most often lost — it lives in one person's head, or a sticky
 * note, and by the following Friday nobody remembers whether it was kept.
 *
 * Written down, a promise does two useful things: it stops the automated
 * chasing until the date, and it becomes visible the moment it is broken. A
 * customer who has broken four is a different commercial risk from one who has
 * broken none, and that difference only exists if the history survives.
 */
export default async function PromisesPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireModuleCapability('customers', 'customers.view')

  const promises = await listPromises(siteId, { limit: 300 })

  const rows: PromiseRow[] = promises.map((p) => ({
    id: p.id,
    customerId: p.customerId,
    customerCode: p.customerCode,
    customerName: p.customerName,
    promisedDate: p.promisedDate,
    promisedAmount: p.promisedAmount,
    receivedAmount: p.receivedAmount,
    balanceAtPromise: p.balanceAtPromise,
    status: p.status,
    state: p.state,
    promisedBy: p.promisedBy,
    notes: p.notes,
    userName: p.userName,
  }))

  const open = rows.filter((r) => r.status === 'open')

  return (
    <>
      <PageHeader
        title="Promises to pay"
        icon={<Icons.Wallet size={18} />}
        subtitle={
          open.length === 0
            ? 'No open promises'
            : `${open.length} open · ${open.filter((r) => r.state === 'broken').length} already broken`
        }
      />

      <PageBody>
        <PromisesClient promises={rows} />
      </PageBody>
    </>
  )
}

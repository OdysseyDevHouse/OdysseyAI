import { notFound } from 'next/navigation'
import { requireCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { listUsers } from '@/lib/site/users'
import { declarationView } from '@/lib/site/cashupDeclaration'
import { PageHeader, PageBody, ButtonLink, Icons } from '@/components/ui'
import DeclarationClient from './DeclarationClient'
import { visibleFor } from './visible'

export const dynamic = 'force-dynamic'

/**
 * The detailed cash-up for one shift.
 *
 * A URL of its own rather than a modal on the list: a drawer count takes real
 * minutes, gets interrupted, and has to survive a refresh — none of which a
 * dialog does well. It also means a finalized cash-up has a permanent address
 * somebody can be sent to.
 */
export default async function DeclarePage({
  params,
}: {
  params: Promise<{ shiftId: string }>
}) {
  // A hidden button is not a boundary — this URL is typeable.
  const { siteId, capabilities } = await requireCapability('sales.cashup')
  const blind = !can(capabilities, 'sales.cashup_expected')
  const { shiftId: raw } = await params

  const shiftId = Number(raw)
  if (!Number.isFinite(shiftId) || shiftId <= 0) notFound()

  const view = await declarationView(siteId, shiftId)
  if (!view) notFound()

  const users = await listUsers(siteId)

  return (
    <>
      <PageHeader
        title={
          view.finalizedAt
            ? `Cash-up — ${view.ownerLabel}`
            : `Cash declaration — ${view.ownerLabel}`
        }
        subtitle={
          view.finalizedAt
            ? 'Signed off. Every figure below is the one that was committed at the time.'
            : `Count the drawer, declare every tender, and close ${view.userName} off. Trading since ${view.openedAt.toLocaleString('en-ZA')}.`
        }
        action={
          <ButtonLink href="/sales/cashup" variant="secondary">
            <Icons.ChevronLeft size={15} />
            Back to cash-ups
          </ButtonLink>
        }
      />
      <PageBody>
        <DeclarationClient
          /* Stripped HERE, on the server, per THIS person's permission — an
             expected figure a cashier may not see never reaches their browser
             at all, so it cannot be read out of devtools. See visible.ts. */
          view={visibleFor(view, blind)}
          supervisors={users.filter((u) => u.isActive).map((u) => ({ id: u.id, name: u.name }))}
          canFinalize={view.finalizedAt === null}
        />
      </PageBody>
    </>
  )
}

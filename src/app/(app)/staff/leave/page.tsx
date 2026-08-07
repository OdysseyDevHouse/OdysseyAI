import { redirect } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { balancesFor, listRequests, listLeaveTypes, ledgerFor } from '@/lib/site/leave'
import { listUsers } from '@/lib/site/users'
import { PageHeader, PageBody } from '@/components/ui'
import LeaveScreen from './LeaveScreen'

export const dynamic = 'force-dynamic'

/**
 * Leave — balances, requests and the ledger behind them.
 *
 * Everyone can reach this: booking a day off is not a manager's privilege.
 * What changes with permission is whose leave you see, and whether the
 * approve/decline buttons are there at all.
 */
export default async function LeavePage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string }>
}) {
  const { site, user, capabilities } = await requireSiteUser()

  const seesEveryone = can(capabilities, 'staff.view_all')
  if (!seesEveryone && !can(capabilities, 'staff.view_own')) redirect('/not-allowed')

  const params = await searchParams
  // Somebody who may only see their own is pinned to themselves, whatever the
  // query string says.
  const forUser = seesEveryone
    ? params.user && /^\d+$/.test(params.user)
      ? Number(params.user)
      : user.id
    : user.id

  const [balances, mine, pending, types, ledger, users] = await Promise.all([
    balancesFor(site.id, forUser),
    listRequests(site.id, { userId: forUser }),
    // The queue a manager works through. Everybody else sees only their own.
    seesEveryone
      ? listRequests(site.id, { status: 'requested' })
      : listRequests(site.id, { userId: user.id, status: 'requested' }),
    listLeaveTypes(site.id, true),
    ledgerFor(site.id, forUser),
    seesEveryone ? listUsers(site.id) : Promise.resolve([]),
  ])

  return (
    <>
      <PageHeader title="Leave" subtitle={site.displayName} />

      <PageBody>
        <LeaveScreen
          balances={balances}
          requests={mine}
          pending={pending}
          types={types.map((t) => ({
            id: t.id,
            name: t.name,
            isPaid: t.isPaid,
          }))}
          ledger={ledger}
          people={users
            .filter((u) => u.isActive)
            .map((u) => ({ id: u.id, name: u.name }))}
          viewingUserId={forUser}
          currentUserId={user.id}
          currentUserName={user.name}
          canApprove={can(capabilities, 'staff.approve')}
          canEdit={can(capabilities, 'staff.edit')}
          seesEveryone={seesEveryone}
        />
      </PageBody>
    </>
  )
}

import { redirect } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { timesheetsFor } from '@/lib/site/timesheets'
import { payMultipliers } from '@/lib/site/payRates'
import { listUsers } from '@/lib/site/users'
import { PageHeader, PageBody, Callout } from '@/components/ui'
import TimesheetScreen from './TimesheetScreen'

export const dynamic = 'force-dynamic'

/** The Monday of the week a date falls in. */
function mondayOf(d: Date): string {
  const offset = (d.getDay() + 6) % 7
  const monday = new Date(d.getTime() - offset * 86_400_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() + days)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Timesheets — what everybody worked, banded and ready to sign off.
 *
 * Defaults to the current week rather than the month: a week is the unit the
 * BCEA measures ordinary hours in, and it is the span a supervisor actually
 * reviews. A month is one click away.
 */
export default async function TimesheetsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; user?: string }>
}) {
  const { site, user, capabilities } = await requireSiteUser()

  const seesEveryone = can(capabilities, 'staff.view_all')
  if (!seesEveryone && !can(capabilities, 'staff.view_own')) redirect('/not-allowed')

  const params = await searchParams
  const iso = /^\d{4}-\d{2}-\d{2}$/

  const defaultFrom = mondayOf(new Date())
  const from = iso.test(params.from ?? '') ? params.from! : defaultFrom
  const to = iso.test(params.to ?? '') ? params.to! : addDays(from, 6)

  // Somebody who may only see their own hours is pinned to themselves,
  // whatever the query string says.
  const forUser = seesEveryone
    ? params.user && /^\d+$/.test(params.user)
      ? Number(params.user)
      : undefined
    : user.id

  // The rates are read here rather than assumed in the screen: a store on a
  // bargaining council agreement pays something other than the BCEA figures,
  // and a hint that names the wrong multiplier is worse than none.
  const [sheets, users, rates] = await Promise.all([
    timesheetsFor(site.id, from, to, forUser),
    seesEveryone ? listUsers(site.id) : Promise.resolve([]),
    payMultipliers(site.id),
  ])

  return (
    <>
      <PageHeader
        title="Timesheets"
        subtitle={`${from} to ${to}`}
      />

      <PageBody>
        {!seesEveryone && (
          <Callout tone="neutral" title="These are your own hours.">
            An owner can grant you sight of the whole team in Setup → Roles.
          </Callout>
        )}

        <TimesheetScreen
          sheets={sheets}
          from={from}
          to={to}
          people={users
            .filter((u) => u.isActive)
            .map((u) => ({ id: u.id, name: u.name }))}
          selectedUserId={forUser ?? null}
          rates={rates}
          canEdit={can(capabilities, 'staff.edit')}
          canApprove={can(capabilities, 'staff.approve')}
        />
      </PageBody>
    </>
  )
}

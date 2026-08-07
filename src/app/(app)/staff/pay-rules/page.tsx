import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { getSettings } from '@/lib/site/settings'
import { holidaysFor, holidayOverrides } from '@/lib/site/holidays'
import { PageHeader, PageBody, Card, Icons } from '@/components/ui'
import PayRulesScreen from './PayRulesScreen'

export const dynamic = 'force-dynamic'

/**
 * Pay rules — the multipliers and the holiday calendar.
 *
 * Guarded on `staff.cost`, not `setup.edit`: everything here decides what the
 * wage bill comes to, so the capability that governs seeing pay governs
 * changing what pay is multiplied by. A hidden menu entry is not a boundary —
 * this URL is typeable, and the actions check the same capability again.
 */
export default async function PayRulesPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string }>
}) {
  const { site, capabilities } = await requireSiteUser()

  const canEdit = can(capabilities, 'staff.cost')
  if (!canEdit) {
    return (
      <>
        <PageHeader title="Pay rules" />
        <PageBody>
          <Card>
            <div className="flex items-start gap-3 px-6 py-4">
              <Icons.Info size={18} className="mt-0.5 shrink-0 text-muted" />
              <div className="text-sm">
                <p className="font-medium text-ink">These are not yours to see.</p>
                <p className="text-muted">
                  Pay rules decide what an hour costs. An owner can grant sight of them in Setup
                  &rarr; Roles.
                </p>
              </div>
            </div>
          </Card>
        </PageBody>
      </>
    )
  }

  const params = await searchParams
  const thisYear = new Date().getFullYear()
  const year =
    params.year && /^\d{4}$/.test(params.year) ? Number(params.year) : thisYear

  const from = `${year}-01-01`
  const to = `${year}-12-31`

  const [rates, calendar, overrides] = await Promise.all([
    getSettings(site.id, [
      'staff_overtime_multiplier',
      'staff_sunday_multiplier',
      'staff_sunday_ordinary_multiplier',
      'staff_holiday_multiplier',
    ]),
    holidaysFor(site.id, from, to),
    holidayOverrides(site.id, from, to),
  ])

  return (
    <>
      <PageHeader
        title="Pay rules"
        subtitle="What an hour outside ordinary time costs, and which days count"
      />

      <PageBody>
        <Card>
          <div className="flex items-start gap-3 px-6 py-4">
            <Icons.Info size={18} className="mt-0.5 shrink-0 text-muted" />
            <div className="text-sm">
              <p className="font-medium text-ink">
                The Basic Conditions of Employment Act sets the floor.
              </p>
              <p className="text-muted">
                Overtime is one and a half times ordinary pay (section 10), a Sunday is double
                (section 16), and a public holiday is double where it is not an ordinary working
                day (section 18). Those are minimums — an agreement may pay more, never less, and
                the figures below are refused if they fall under an ordinary hour.
              </p>
              <p className="mt-1 text-muted">
                Whether a person ordinarily works Sundays is set on their own record, under Staff
                &rarr; People, because it differs between a weekend team and an office.
              </p>
            </div>
          </div>
        </Card>

        <PayRulesScreen
          rates={{
            overtime: rates.staff_overtime_multiplier ?? '1.5',
            sunday: rates.staff_sunday_multiplier ?? '2',
            sundayOrdinary: rates.staff_sunday_ordinary_multiplier ?? '1.5',
            holiday: rates.staff_holiday_multiplier ?? '2',
          }}
          calendar={calendar}
          overrides={overrides}
          year={year}
          canEdit={canEdit}
        />
      </PageBody>
    </>
  )
}

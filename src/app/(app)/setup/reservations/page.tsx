import { requireCapability } from '@/lib/auth'
import { PageBody, PageHeader } from '@/components/ui'
import { createPublicReserveToken } from '@/lib/publicReserveToken'
import { getReservationSettings } from '@/lib/site/reservations'
import ReservationSettingsForm from './ReservationSettingsForm'

export const dynamic = 'force-dynamic'

/**
 * Reservation settings — the switch, the week, and the rules that keep the
 * public form honest.
 *
 * Beside Setup → Tables deliberately: the floor plan and the booking diary are
 * the same shop answering the same question, and the table names a booking is
 * matched against are the ones drawn on that screen.
 */
export default async function ReservationSetupPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('reservations.edit')

  const [settings, token] = await Promise.all([
    getReservationSettings(siteId),
    createPublicReserveToken(siteId),
  ])

  return (
    <>
      <PageHeader
        title="Reservations"
        subtitle="Whether guests can book a table online, and the times you offer"
      />
      <PageBody>
        <ReservationSettingsForm settings={settings} reservePath={`/reserve/${token}`} />
      </PageBody>
    </>
  )
}

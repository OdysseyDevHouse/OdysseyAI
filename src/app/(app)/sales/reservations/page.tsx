import { requireCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { Badge, Icons, PageBody, PageHeader, StatStrip, StatTile } from '@/components/ui'
import { createPublicReserveToken } from '@/lib/publicReserveToken'
import { getReservationSettings, listReservations } from '@/lib/site/reservations'
import { dateKey, dayLabel, dayOf } from '@/lib/reservationTypes'
import ReservationsQueue from './ReservationsQueue'

export const dynamic = 'force-dynamic'

/**
 * Table reservations — the shop-side book. Staff confirm requests, seat parties
 * as they arrive, and mark the ones that never did.
 *
 * LOADS FROM A WEEK AGO FORWARD. Yesterday's no-shows still matter (somebody
 * has to mark them, and they are the figure a restaurateur actually wants
 * counted), but a restaurant's book is a forward document — opening on six
 * months of history would bury tonight.
 */
export default async function ReservationsPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId, capabilities } = await requireCapability('reservations.view')

  const today = new Date()
  const from = new Date(today)
  from.setDate(from.getDate() - 7)

  const [reservations, settings, reserveToken] = await Promise.all([
    listReservations(siteId, { fromDate: dateKey(from) }),
    getReservationSettings(siteId),
    // Deterministic, so the link on a menu printed last month still resolves.
    createPublicReserveToken(siteId),
  ])

  const todayKey = dateKey(today)
  const todays = reservations.filter((r) => dayOf(r.reservedFor) === todayKey)

  const pending = reservations.filter((r) => r.status === 'pending').length
  const bookingsToday = todays.filter((r) => r.status !== 'cancelled').length
  // Covers = people expected through the door. A cancelled table freed itself
  // and a no-show never arrived, so neither is a mouth the kitchen must feed.
  const coversToday = todays
    .filter((r) => r.status !== 'cancelled' && r.status !== 'no_show')
    .reduce((sum, r) => sum + r.partySize, 0)
  const seatedNow = todays.filter((r) => r.status === 'seated').length

  return (
    <>
      {/* The header badge takes no dot: it is a COUNT of work waiting, not the
          state of a record. The dot is reserved for status pills. */}
      <PageHeader
        title="Reservations"
        icon={<Icons.CalendarClock size={18} />}
        subtitle="Tonight’s book, and every booking still to come."
        action={
          pending > 0 ? (
            <Badge tone="warning">
              {pending} awaiting confirmation
            </Badge>
          ) : undefined
        }
      />
      <PageBody>
        <StatStrip columns={4}>
          {/*
            Only the first tile is ever coloured, and only when it is non-zero.
            A request nobody has answered is the single thing on this screen
            that means ACT ON ME; painting the other three would spend the
            signal that makes it visible.
          */}
          <StatTile
            label="Awaiting confirmation"
            value={pending.toLocaleString('en-ZA')}
            tone={pending > 0 ? 'warning' : 'default'}
            hint={pending === 1 ? '1 request to answer' : 'Requests to answer'}
            icon={<Icons.StatusWarning size={20} />}
          />
          <StatTile
            label="Bookings today"
            value={bookingsToday.toLocaleString('en-ZA')}
            hint={dayLabel(todayKey)}
            icon={<Icons.CalendarClock size={20} />}
          />
          <StatTile
            label="Covers today"
            value={coversToday.toLocaleString('en-ZA')}
            hint="People expected"
            icon={<Icons.Users size={20} />}
          />
          <StatTile
            label="Seated now"
            value={seatedNow.toLocaleString('en-ZA')}
            hint="Parties in the room"
            iconTone="success"
            icon={<Icons.StatusSuccess size={20} />}
          />
        </StatStrip>

        {/*
          DataTable's cells are functions, which cannot cross the server→client
          boundary — so the table lives in ReservationsQueue and gets plain rows.
        */}
        <ReservationsQueue
          reservations={reservations}
          maxPartySize={settings.maxPartySize}
          onlineEnabled={settings.isEnabled}
          canEdit={can(capabilities, 'reservations.edit')}
          /* A path, not a URL: the server has no reliable view of the public
             origin behind a proxy, so the browser adds it. */
          reservePath={`/reserve/${reserveToken}`}
        />
      </PageBody>
    </>
  )
}

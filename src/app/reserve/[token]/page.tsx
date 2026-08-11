import type { ReactNode } from 'react'
import type { Metadata } from 'next'
import { verifyPublicReserveToken } from '@/lib/publicReserveToken'
import { publicSiteName } from '@/lib/sites'
import { bookableSlots, getReservationSettings } from '@/lib/site/reservations'
import ReserveForm from './ReserveForm'

export const dynamic = 'force-dynamic'

/**
 * The public "book a table" page — a guest books with no login.
 *
 * The signed token in the URL scopes the page to one shop (see
 * lib/publicReserveToken.ts). It is the href behind the restaurant's own "Book
 * a table" button and the QR code on the door.
 *
 * ── THE SLOTS ARE COMPUTED HERE, ON THE SERVER ────────────────────────────
 *
 * The form is handed a list of days and times and cannot invent one, and the
 * action re-derives the same list before writing. So what the page offers and
 * what the shop will accept can never drift apart.
 *
 * ── IT EXPLAINS ITSELF RATHER THAN 404-ing ────────────────────────────────
 *
 * The storefront answers a closed shop with notFound(), because a shop that is
 * closed sells nothing and the 404 also hides whether the tenant exists. This
 * page takes the opposite view for the CONFIGURED-BUT-UNAVAILABLE cases: the
 * link is printed on menus and door signs, and a guest standing outside with a
 * phone needs to be told "not online, call them" rather than shown a dead page.
 * An invalid TOKEN still says nothing useful, so the link cannot be used to
 * probe for sites.
 */

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>
}): Promise<Metadata> {
  try {
    const { token } = await params
    const siteId = await verifyPublicReserveToken(token)
    if (siteId === null) return { title: 'Book a table' }
    const name = await publicSiteName(siteId)
    return { title: name ? `Book a table — ${name}` : 'Book a table' }
  } catch {
    // Metadata must never be the thing that breaks the page.
    return { title: 'Book a table' }
  }
}

export default async function ReservePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const siteId = await verifyPublicReserveToken(token)

  if (siteId === null) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold text-ink">This link is not valid</h1>
        <p className="mt-2 text-sm text-muted">
          The booking link you followed is not valid any more. Please ask the restaurant for a
          new one.
        </p>
      </Shell>
    )
  }

  const storeName = (await publicSiteName(siteId)) ?? 'this restaurant'
  const settings = await getReservationSettings(siteId)

  if (!settings.isEnabled) {
    return (
      <Shell name={storeName}>
        <h1 className="text-xl font-semibold text-ink">
          {storeName} is not taking online bookings
        </h1>
        <p className="mt-2 text-sm text-muted">
          Please give them a call and they will find you a table.
        </p>
      </Shell>
    )
  }

  /*
   * Only days that actually have a time are offered. A shop that is switched on
   * but has no hours configured — or whose whole horizon falls inside the lead
   * time — would otherwise render a day picker where every choice fails.
   */
  const days = bookableSlots(settings).filter((d) => d.times.length > 0)
  if (days.length === 0) {
    return (
      <Shell name={storeName}>
        <h1 className="text-xl font-semibold text-ink">No tables available online</h1>
        <p className="mt-2 text-sm text-muted">
          There are no bookable times at the moment. Please call {storeName} and they will find
          you a table.
        </p>
      </Shell>
    )
  }

  return (
    <ReserveForm
      token={token}
      storeName={storeName}
      blurb={settings.blurb}
      autoConfirm={settings.autoConfirm}
      maxPartySize={settings.maxPartySize}
      days={days}
    />
  )
}

/** The card every non-form outcome renders inside. */
function Shell({ name, children }: { name?: string; children: ReactNode }) {
  return (
    <main className="min-h-screen bg-canvas px-4 py-10">
      <div className="mx-auto w-full max-w-lg rounded-card border border-border bg-surface p-6 shadow-card">
        {name ? <p className="mb-1 text-sm text-muted">{name}</p> : null}
        {children}
      </div>
    </main>
  )
}

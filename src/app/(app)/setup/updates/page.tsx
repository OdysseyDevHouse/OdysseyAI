import { requireCapability } from '@/lib/auth'
import { PageHeader, PageBody } from '@/components/ui'
import UpdatesClient from './UpdatesClient'

export const dynamic = 'force-dynamic'

/**
 * Updates — what this machine is running, and how to make it current now.
 *
 * ── EVERYTHING REAL HAPPENS IN THE CLIENT ───────────────────────────────────
 *
 * There is nothing for the server to fetch. The version, the channel and the
 * download state all live in the Electron main process and arrive over the
 * preload bridge, which only the renderer can reach. So this page is the
 * capability gate and the header; the screen itself is a client component.
 *
 * ── WHY THE GATE IS setup.edit ──────────────────────────────────────────────
 *
 * The same key as the rest of the System group. Restarting a shop's app onto a
 * new version is the sort of thing that belongs with whoever is trusted to
 * change document numbering and reset training data — and the people who need
 * this screen most, technicians standing at a counter, already hold it.
 *
 * A hidden menu entry is not a boundary; this URL is typeable.
 */
export default async function UpdatesPage() {
  await requireCapability('setup.edit')

  return (
    <>
      <PageHeader
        title="Updates"
        subtitle="Check for a new version of Odyssey and install it on this machine."
      />
      <PageBody>
        <UpdatesClient />
      </PageBody>
    </>
  )
}

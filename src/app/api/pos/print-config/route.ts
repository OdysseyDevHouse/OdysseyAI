import { NextResponse, type NextRequest } from 'next/server'
import { siteIdForCapability } from '@/lib/auth'
import { isValidDeviceId } from '@/lib/site/devices'
import { printConfigForDevice } from '@/lib/site/documentPrinters'

/**
 * Where this machine's documents come out — resolved, and small.
 *
 * ── WHY IT IS ITS OWN ROUTE ───────────────────────────────────────────────
 *
 * The POS catalog feed carries this too, so a till that has been offline since
 * this morning still knows where its slips go. But the catalog is a large,
 * delta-driven sync that a BACK OFFICE never runs — and a back-office machine
 * prints invoices, statements and purchase orders. This is the small read that
 * serves everything else.
 *
 * ── ALREADY RESOLVED, DELIBERATELY ────────────────────────────────────────
 *
 * The shop's own answer and this machine's override are reconciled on the
 * server. A client holding both halves would be a second implementation of a
 * resolution rule that has to keep working with the server unreachable, and two
 * implementations of that rule is how a slip starts coming out of the wrong
 * printer after a change only one of them understood.
 */
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  /* `sales.till` rather than `setup.edit`: this is READ by whoever is standing
     at the machine in order to print, not by whoever configured it. A cashier
     with no setup rights still has to be able to produce a slip. */
  const siteId = await siteIdForCapability('sales.till')
  if (siteId === null) return NextResponse.json({ error: 'Not allowed.' }, { status: 403 })

  const deviceId = new URL(req.url).searchParams.get('deviceId') ?? ''
  if (!isValidDeviceId(deviceId)) {
    return NextResponse.json({ error: 'No machine was named.' }, { status: 400 })
  }

  const config = await printConfigForDevice(siteId, deviceId)
  /* no-store: a manager who re-points a printer expects the next print to obey,
     and this response is a few hundred bytes. */
  return NextResponse.json(config, { headers: { 'cache-control': 'no-store' } })
}

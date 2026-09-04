import { requireCapability, requireSite, requireSiteUser } from '@/lib/auth'
import { getSetting } from '@/lib/site/settings'
import { listDevices } from '@/lib/site/devices'
import { listPrinters } from '@/lib/site/printers'
import { assignmentsForDevice, type DocumentAssignment } from '@/lib/site/documentPrinters'
import { listKitchenPrinters } from '@/lib/site/kitchenPrinters'
import { PageHeader, PageBody } from '@/components/ui'
import PrintingClient from './PrintingClient'

export const dynamic = 'force-dynamic'

/**
 * Printing.
 *
 * Two subjects, in the order a shop meets them: the printers it owns, and what
 * each MACHINE prints on which of them.
 *
 * There used to be a third card between them — "how this machine reaches each
 * printer" — which asked every printer's connection question a second time. A
 * printer now knows its own location; sql/site/247 has the argument.
 *
 * The assignments are per-machine, and live on the server rather than in one
 * browser's localStorage, so a manager can see and fix a till's setup without
 * walking to it.
 */
export default async function PrintingSetupPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  await requireCapability('setup.edit')
  const site = await requireSite()
  const { modules } = await requireSiteUser()

  const footerText = await getSetting(site.id, 'receipt_footer_text')

  /* Inactive included: the panel shows them in their own "Switched off" card, so
     a printer taken out of service can be brought back without re-pointing every
     product and every document at it. */
  const printers = await listPrinters(site.id, true)
  const devices = await listDevices(site.id)

  /* Every machine's assignments, read up front rather than on selection. A shop
     has a handful of machines and each read is one small indexed query, so this
     costs less than a round trip every time somebody changes the picker — and it
     means the screen switches machines without a spinner. Same reasoning this
     page already used for the per-till kitchen maps.
     
     The printer LIST is read once and shared: since 247 a printer knows its own
     location, so there is nothing per-machine to resolve about it. */
  const assignments: Record<string, DocumentAssignment[]> = {}
  await Promise.all(
    devices.map(async (device) => {
      assignments[device.deviceId] = await assignmentsForDevice(site.id, device.deviceId, printers)
    }),
  )

  const kitchenPrinters = await listKitchenPrinters(site.id, false)

  /* Absent means ON — see pos_auto_print_kitchen in settings.ts. The feature
     does nothing at all until products are routed, so the default is read only
     by shops that deliberately set routing up. */
  const autoPrintKitchen = (await getSetting(site.id, 'pos_auto_print_kitchen')) !== '0'

  return (
    <>
      <PageHeader
        title="Printing"
        subtitle="Your printers, how each machine reaches them, and what every document prints on."
      />
      <PageBody>
        <PrintingClient
          footerText={footerText ?? ''}
          printers={printers}
          devices={devices}
          assignments={assignments}
          kitchenPrinters={kitchenPrinters}
          autoPrintKitchen={autoPrintKitchen}
          modules={[...modules.held]}
        />
      </PageBody>
    </>
  )
}

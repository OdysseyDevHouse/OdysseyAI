import { requireCapability, requireSite } from '@/lib/auth'
import { getSetting } from '@/lib/site/settings'
import { listTerminals } from '@/lib/site/terminals'
import {
  listKitchenPrinters,
  printerMapForTerminal,
  type TerminalPrinterMap,
} from '@/lib/site/kitchenPrinters'
import { PageHeader, PageBody } from '@/components/ui'
import PrintingClient from './PrintingClient'

export const dynamic = 'force-dynamic'

/**
 * Printing.
 *
 * Two very different halves on one screen, each labelled as what it is: the
 * slip FOOTER is the site's (every till prints it), while the BRIDGE and
 * printers are this machine's — a property of what is physically plugged in,
 * stored in this browser, set once per till.
 */
export default async function PrintingSetupPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  await requireCapability('setup.edit')
  const site = await requireSite()

  const footerText = await getSetting(site.id, 'receipt_footer_text')

  /* Inactive printers included: the panel shows them in their own "Switched
     off" card, so a station taken out of service can be brought back without
     re-pointing every product at it. */
  const kitchenPrinters = await listKitchenPrinters(site.id, true)
  const terminals = await listTerminals(site.id, false)

  /* Every till's mapping, read up front rather than on selection. A shop has a
     handful of tills and each query is one small indexed join, so this costs
     less than a round trip every time somebody changes the picker — and it
     means the card can switch tills without a spinner. */
  const terminalMaps: Record<number, TerminalPrinterMap[]> = {}
  await Promise.all(
    terminals.map(async (terminal) => {
      terminalMaps[terminal.id] = await printerMapForTerminal(site.id, terminal.id)
    }),
  )

  /* Absent means ON — see pos_auto_print_kitchen in settings.ts. The feature
     does nothing at all until products are routed, so the default is read only
     by shops that deliberately set routing up. */
  const autoPrintKitchen = (await getSetting(site.id, 'pos_auto_print_kitchen')) !== '0'

  return (
    <>
      <PageHeader
        title="Printing"
        subtitle="The slip's footer, the printer plugged into this till, and where food goes."
      />
      <PageBody>
        <PrintingClient
          siteName={site.displayName}
          footerText={footerText ?? ''}
          kitchenPrinters={kitchenPrinters}
          terminals={terminals.map((t) => ({ id: t.id, code: t.code, name: t.name }))}
          terminalMaps={terminalMaps}
          autoPrintKitchen={autoPrintKitchen}
        />
      </PageBody>
    </>
  )
}

'use client'

import { useEffect, useState, useTransition } from 'react'
import {
  Badge,
  Button,
  Callout,
  Field,
  Icons,
  Input,
  SegmentedControl,
  SettingGroup,
  SettingRow,
  Switch,
  Textarea,
  useToast,
} from '@/components/ui'
import {
  bridgeConfig,
  saveBridgeConfig,
  bridgeHealth,
  printRaw,
  type PrintBridgeConfig,
} from '@/lib/printBridge'
import { renderTestSlip } from '@/lib/escpos/slips'
import type { KitchenPrinter, TerminalPrinterMap } from '@/lib/site/kitchenPrinters'
import { savePrintingSettingsAction } from './actions'
import KitchenPrintersPanel from './KitchenPrintersPanel'

/**
 * Printing setup.
 *
 * The footer card writes a SITE setting; the bridge card writes THIS
 * MACHINE's localStorage — said out loud in amber, because "I configured the
 * printer" on the office PC configures nothing at the counter.
 */
export default function PrintingClient({
  siteName,
  footerText: initialFooter,
  kitchenPrinters,
  terminals,
  terminalMaps,
  autoPrintKitchen,
}: {
  siteName: string
  footerText: string
  kitchenPrinters: KitchenPrinter[]
  terminals: { id: number; code: string; name: string }[]
  terminalMaps: Record<number, TerminalPrinterMap[]>
  autoPrintKitchen: boolean
}) {
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  const [footer, setFooter] = useState(initialFooter)
  const [savedFooter, setSavedFooter] = useState(initialFooter)

  const [config, setConfig] = useState<PrintBridgeConfig>({
    url: 'http://127.0.0.1:9723',
    receiptPrinter: '',
    columns: 48,
    drawerKick: true,
  })
  const [known, setKnown] = useState<string[] | null>(null)
  const [testing, setTesting] = useState(false)

  // Hydrate after mount — localStorage during render would mismatch SSR.
  useEffect(() => {
    const stored = bridgeConfig()
    if (stored) setConfig(stored)
  }, [])

  function saveFooter() {
    startTransition(async () => {
      const result = await savePrintingSettingsAction({ footerText: footer })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setSavedFooter(footer)
      toast.success(result.message)
    })
  }

  function saveMachine() {
    saveBridgeConfig(config.url.trim() ? { ...config, url: config.url.trim() } : null)
    toast.success('Saved for this machine.')
  }

  async function testConnection() {
    setTesting(true)
    try {
      const health = await bridgeHealth(config.url)
      if (!health.ok) {
        setKnown(null)
        toast.error(health.error)
        return
      }
      setKnown(health.printers)
      toast.success(
        `Bridge ${health.version} answered — printers: ${health.printers.join(', ') || 'none configured on the bridge'}.`,
      )
    } finally {
      setTesting(false)
    }
  }

  async function testPrint() {
    // The SAVED config is what prints — save first so the test tests reality.
    saveMachine()
    const result = await printRaw('receipt', renderTestSlip({ siteName, columns: config.columns }))
    if (result.ok) toast.success('Test slip sent — check the printer.')
    else toast.error(result.error)
  }

  return (
    <div className="flex flex-col gap-4">
      <SettingGroup
        title="The slip"
        description="What every till on this site prints — the machine-specific parts live below."
      >
        <div className="px-4 py-3">
          <Field
            label="Footer line"
            hint={`${footer.length}/500 — the returns policy, a thank-you, a promo. Empty prints nothing.`}
          >
            <Textarea
              rows={2}
              value={footer}
              onChange={(e) => setFooter(e.target.value)}
              placeholder="Exchanges within 30 days with this slip. Thank you!"
            />
          </Field>
          <div className="mt-3 flex items-center justify-end gap-3">
            {footer === savedFooter && (
              <span className="text-xs text-muted">No changes to save.</span>
            )}
            <Button variant="primary" disabled={pending || footer === savedFooter} onClick={saveFooter}>
              <Icons.Save size={15} />
              {pending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </SettingGroup>

      <Callout tone="warning" title="The printer settings below are saved on THIS machine only">
        They describe what is physically plugged in here. Open this page on each till and
        set its own bridge — a printer configured on the office PC prints nothing at the
        counter.
      </Callout>

      <SettingGroup
        title="This machine's printers"
        description="The print bridge (scripts/print-bridge.mjs) runs on the till and forwards slips to the printer. See docs/print-bridge.md."
      >
        <SettingRow
          icon={<Icons.Link2 size={16} />}
          label="Bridge address"
          description="http://127.0.0.1:9723 when the bridge runs on this till; a LAN address when tills share one."
          htmlFor="bridge-url"
        >
          <div className="flex items-center gap-2">
            <Input
              id="bridge-url"
              className="w-72"
              value={config.url}
              onChange={(e) => setConfig((c) => ({ ...c, url: e.target.value }))}
              placeholder="http://127.0.0.1:9723"
            />
            <Button variant="secondary" disabled={testing} onClick={() => void testConnection()}>
              {testing ? 'Testing…' : 'Test connection'}
            </Button>
          </div>
        </SettingRow>

        <SettingRow
          icon={<Icons.Printer size={16} />}
          label="Slip printer"
          description="The bridge's name for the printer that prints receipts and bills."
          htmlFor="receipt-printer"
        >
          <div className="flex items-center gap-2">
            <Input
              id="receipt-printer"
              className="w-48"
              value={config.receiptPrinter}
              onChange={(e) => setConfig((c) => ({ ...c, receiptPrinter: e.target.value }))}
              placeholder="receipt"
            />
            {known?.includes(config.receiptPrinter) && <Badge tone="success">Found</Badge>}
          </div>
        </SettingRow>

        {/* No kitchen printer row here any more. One machine-local slot could
            not describe a shop with a bar and a grill, and it hid a till's
            routing from the back office — so kitchen stations are named per
            SITE and mapped per TILL, both on the server. See the Kitchen
            printers card below and sql/site/229. */}

        <SettingRow
          icon={<Icons.SlidersHorizontal size={16} />}
          label="Paper width"
          description="48 columns for 80mm paper; 42 for the narrower heads. The test slip shows which lines up."
        >
          <SegmentedControl
            aria-label="Slip columns"
            value={String(config.columns)}
            onChange={(v) => setConfig((c) => ({ ...c, columns: v === '42' ? 42 : 48 }))}
            options={[
              { value: '48', label: '48 (80mm)' },
              { value: '42', label: '42' },
            ]}
          />
        </SettingRow>

        <SettingRow
          icon={<Icons.Coins size={16} />}
          label="Kick the cash drawer"
          description="When a sale is paid with a tender whose ‘Opens cash drawer’ flag is on. The drawer plugs into the slip printer."
          htmlFor="drawer-kick"
        >
          <Switch
            id="drawer-kick"
            checked={config.drawerKick}
            onChange={(next) => setConfig((c) => ({ ...c, drawerKick: next }))}
          />
        </SettingRow>

        <div className="flex items-center justify-end gap-2 px-4 py-3">
          <Button variant="secondary" onClick={() => void testPrint()}>
            <Icons.Printer size={15} />
            Print test slip
          </Button>
          <Button variant="primary" onClick={saveMachine}>
            <Icons.Save size={15} />
            Save for this machine
          </Button>
        </div>
      </SettingGroup>

      {/* Rendered here rather than as its own sibling on the page so it can share
          `known` — the spool names this machine's bridge reported. Test
          connection above is what fills it, and the mapping rows below use it to
          confirm a typed name actually exists on this till. */}
      <KitchenPrintersPanel
        printers={kitchenPrinters}
        terminals={terminals}
        terminalMaps={terminalMaps}
        autoPrint={autoPrintKitchen}
        knownBridgePrinters={known}
      />
    </div>
  )
}

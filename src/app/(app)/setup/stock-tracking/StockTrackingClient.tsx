'use client'

import { useState, useTransition } from 'react'
import {
  Button,
  Callout,
  Icons,
  Input,
  Select,
  SettingGroup,
  SettingRow,
  Switch,
  useToast,
} from '@/components/ui'
import { saveStockTrackingSettingsAction, type StockTrackingSettings } from './actions'

/**
 * Which lot a sale is booked against, and how a scale barcode is read.
 *
 * ── WHY THE MODE IS THE CONSEQUENTIAL ONE ─────────────────────────────────
 *
 * It decides whether a recall trace is an observation or an inference. Under
 * "earliest expiry" the till books against the lot due to sell next, which is a
 * guess about which pack the customer actually picked up — right often enough
 * for stock figures, and not the sort of thing to phone a customer about.
 *
 * So the screen says that plainly on the row rather than in a manual nobody
 * opens, and the strictness switch is DISABLED rather than hidden under that
 * mode: a shop should be able to see what the other modes would offer them
 * without having to change one to find out.
 */
export default function StockTrackingClient({
  settings: initial,
}: {
  settings: StockTrackingSettings
}) {
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [saved, setSaved] = useState(initial)
  const [mode, setMode] = useState(initial.lotCaptureMode)
  const [strict, setStrict] = useState(initial.lotCaptureStrict)
  const [prefix, setPrefix] = useState(initial.barcodePrefix)
  const [pluLength, setPluLength] = useState(initial.barcodePluLength)
  const [divisor, setDivisor] = useState(initial.barcodeValueDivisor)

  const capturing = mode !== 'fefo'
  const dirty =
    mode !== saved.lotCaptureMode ||
    (capturing && strict !== saved.lotCaptureStrict) ||
    prefix !== saved.barcodePrefix ||
    pluLength !== saved.barcodePluLength ||
    divisor !== saved.barcodeValueDivisor

  function save() {
    startTransition(async () => {
      const result = await saveStockTrackingSettingsAction({
        lotCaptureMode: mode,
        lotCaptureStrict: strict,
        barcodePrefix: prefix,
        barcodePluLength: pluLength,
        barcodeValueDivisor: divisor,
      })

      if (!result.ok) {
        toast.error(result.error)
        return
      }

      setSaved(result.settings)
      setStrict(result.settings.lotCaptureStrict)
      toast.success(result.message)
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <SettingGroup
        title="Which lot a sale comes from"
        description="Only affects batch-tracked products. Everything else is unchanged."
      >
        <SettingRow
          icon={<Icons.Boxes size={16} />}
          label="Lot capture"
          description="How the till decides which lot left the shop."
          htmlFor="lot-mode"
        >
          <Select
            id="lot-mode"
            className="w-64"
            value={mode}
            onChange={(e) => {
              const next = e.target.value
              setMode(next === 'barcode' || next === 'prompt' ? next : 'fefo')
            }}
          >
            <option value="fefo">Earliest expiry, automatically</option>
            <option value="barcode">Read it from the barcode</option>
            <option value="prompt">Ask the clerk</option>
          </Select>
        </SettingRow>

        <SettingRow
          icon={<Icons.StatusWarning size={16} />}
          label="Refuse a sale with no lot"
          description={
            capturing
              ? 'On, an item whose lot cannot be captured cannot be sold. Off, it sells against the earliest expiry and is logged.'
              : 'Only applies when a lot is being captured.'
          }
          htmlFor="lot-strict"
        >
          <Switch
            id="lot-strict"
            checked={capturing && strict}
            disabled={!capturing}
            onChange={setStrict}
          />
        </SettingRow>
      </SettingGroup>

      {mode === 'fefo' && (
        <Callout tone="brand" title="A recall trace will be a strong lead, not proof">
          The till books each sale against the lot expiring soonest, which is a good guess about
          what left the shelf and not a record of it. Right for a grocer — a recall there means
          clearing the shelf and putting up a notice. A pharmacy or a butchery that has to answer
          for a specific lot wants one of the other two.
        </Callout>
      )}

      {mode === 'barcode' && (
        <Callout tone="brand" title="This needs the supplier to print it">
          Lots are read from GS1-128 and DataBar barcodes, which carry the batch and expiry in the
          code itself. A plain EAN-13 carries neither, so those items fall back to the earliest
          expiry unless the switch above is on.
        </Callout>
      )}

      {mode === 'prompt' && (
        <Callout tone="warning" title="This asks on every batch-tracked sale">
          The clerk picks from the lots on hand, with the one due to sell next already selected — so
          the usual case is one tap. It is still a tap per item, which is why most shops want this
          only where a lot has to be answered for.
        </Callout>
      )}

      <SettingGroup
        title="Scale barcodes"
        description="How a label printed by a scale is read. Formats vary by vendor."
      >
        <SettingRow
          icon={<Icons.Barcode size={16} />}
          label="Prefix"
          description="The leading digit or two that marks a scale label."
          htmlFor="bc-prefix"
        >
          <Input
            id="bc-prefix"
            className="w-24"
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
          />
        </SettingRow>

        <SettingRow
          icon={<Icons.Hash size={16} />}
          label="PLU length"
          description="How many digits of the code identify the product."
          htmlFor="bc-plu"
        >
          <Input
            id="bc-plu"
            className="w-24"
            value={pluLength}
            onChange={(e) => setPluLength(e.target.value)}
          />
        </SettingRow>

        <SettingRow
          icon={<Icons.Percent size={16} />}
          label="Value divisor"
          description="100 when the embedded figure is in cents, 1000 when it is in grams."
          htmlFor="bc-divisor"
        >
          <Select
            id="bc-divisor"
            className="w-32"
            value={divisor}
            onChange={(e) => setDivisor(e.target.value)}
          >
            <option value="1">1</option>
            <option value="10">10</option>
            <option value="100">100</option>
            <option value="1000">1000</option>
          </Select>
        </SettingRow>
      </SettingGroup>

      <div className="flex justify-end">
        <Button variant="primary" onClick={save} disabled={!dirty || pending}>
          {pending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </div>
  )
}

'use client'

import { useState, useTransition } from 'react'
import {
  Button,
  Callout,
  Icons,
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
  /* ── THE OLD BARCODE VALUES, HELD AND NOT EDITED ────────────────────────
   *
   * No control on this screen changes them any more — scale barcodes moved to
   * /setup/scale-barcodes. They are still READ and written straight back,
   * because this screen's action writes the whole group and dropping them from
   * the payload would blank three settings rows.
   *
   * Blanking them is not cosmetic. A till that has not synced since the deploy
   * still reads exactly these three keys for its offline scale parsing, so
   * clearing them would stop weighed items scanning on the tills least able to
   * fetch a replacement. They age out when every till has synced; until then
   * they are the fallback. */
  const legacyBarcode = {
    barcodePrefix: initial.barcodePrefix,
    barcodePluLength: initial.barcodePluLength,
    barcodeValueDivisor: initial.barcodeValueDivisor,
  }

  const capturing = mode !== 'fefo'
  const dirty =
    mode !== saved.lotCaptureMode || (capturing && strict !== saved.lotCaptureStrict)

  function save() {
    startTransition(async () => {
      const result = await saveStockTrackingSettingsAction({
        lotCaptureMode: mode,
        lotCaptureStrict: strict,
        ...legacyBarcode,
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

      {/* ── SCALE BARCODES MOVED ────────────────────────────────────────
          They were three rows here, beside lot capture. They are now a LIST —
          a shop runs several scales and each prints a different shape — and a
          list with an Add button is not a settings row. It lives at
          /setup/scale-barcodes.

          A pointer rather than a silent deletion: somebody who set this up
          once will come back to this tab looking for it, and a screen that
          simply no longer has it teaches them the feature was removed. */}
      <Callout tone="brand" title="Scale barcodes have their own screen">
        A shop can now set up more than one shape — one per scale. Find them under
        Setup → Scale barcodes.
      </Callout>

      <div className="flex justify-end">
        <Button variant="primary" onClick={save} disabled={!dirty || pending}>
          {pending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </div>
  )
}

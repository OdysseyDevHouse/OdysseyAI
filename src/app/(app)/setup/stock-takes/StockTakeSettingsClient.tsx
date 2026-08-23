'use client'

import { useState, useTransition } from 'react'
import {
  Button,
  Callout,
  CurrencyInput,
  Icons,
  NumberInput,
  SettingGroup,
  SettingRow,
  useToast,
} from '@/components/ui'
import { saveStockTakeSettingsAction, type StockTakeSettings } from './actions'

/**
 * When a count variance is large enough to need a second signature.
 *
 * ── WHY TWO INSTRUMENTS AND NOT ONE ───────────────────────────────────────
 *
 * They catch opposite failures, and either alone leaves a hole the other
 * closes:
 *
 *   percentage   books say 400, shelf holds 40. A catastrophe worth six rand
 *                that no value threshold will ever see.
 *   value        one of three missing is 33% and might sit under a percentage
 *                threshold — but if the unit is worth R14,000 it is the most
 *                important line on the sheet.
 *
 * A shop can run either, both, or neither.
 *
 * ── BOTH DEFAULT TO OFF ───────────────────────────────────────────────────
 *
 * The same convention the purchase approval threshold uses, for the same
 * reason: a control that arrives switched on gets switched off in a hurry on
 * the first busy morning, usually for good. A shop that wants this turns it on
 * having decided to.
 */
export default function StockTakeSettingsClient({
  settings: initial,
}: {
  settings: StockTakeSettings
}) {
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [saved, setSaved] = useState(initial)
  const [qtyPct, setQtyPct] = useState(Number(initial.varianceQtyPct))
  const [value, setValue] = useState(Number(initial.varianceValue))

  const dirty = qtyPct !== Number(saved.varianceQtyPct) || value !== Number(saved.varianceValue)

  /** Off entirely: nothing is ever flagged and posting is never held. */
  const allOff = qtyPct <= 0 && value <= 0
  const wasAllOff = Number(saved.varianceQtyPct) <= 0 && Number(saved.varianceValue) <= 0

  function save() {
    startTransition(async () => {
      const result = await saveStockTakeSettingsAction({
        /* Plain numbers, not toFixed — the column is a VARCHAR every reader runs
           Number() over, and writing a padded form back would present a purely
           cosmetic difference as an unsaved change. Same as purchasing. */
        varianceQtyPct: String(qtyPct),
        varianceValue: String(value),
      })

      if (!result.ok) {
        toast.error(result.error)
        return
      }

      setSaved(result.settings)
      toast.success('Stock take settings saved.')
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <SettingGroup
        title="Variances needing a signature"
        description="Checked when a count is POSTED — the act that writes the difference to the books. A line over either threshold holds the whole sheet until somebody with permission gives it a reason."
      >
        <SettingRow
          icon={<Icons.Percent size={16} />}
          label="Percentage off expected"
          description="A counted line this far from what the books said needs signing off. Catches a cheap fast-moving line where the books say 400 and the shelf holds 40. Zero switches it off."
          htmlFor="variance-qty-pct"
        >
          <div className="flex items-center gap-2">
            <NumberInput
              id="variance-qty-pct"
              className="w-28"
              value={qtyPct}
              precision={0}
              onChange={(e) => setQtyPct(Number(String(e.target.value).replace(',', '.')) || 0)}
            />
            <span className="text-sm text-muted">%</span>
          </div>
        </SettingRow>

        <SettingRow
          icon={<Icons.Coins size={16} />}
          label="Value of one line"
          description="A single line worth more than this — written on or off — needs signing off whatever the percentage says. Excluding VAT, the way stock is held. Zero switches it off."
          htmlFor="variance-value"
        >
          <CurrencyInput
            id="variance-value"
            className="w-40"
            value={value}
            onChange={(e) => setValue(Number(String(e.target.value).replace(',', '.')) || 0)}
          />
        </SettingRow>

        {/* Only while it is being turned on, and only from fully off — the rule
            every warning on the purchasing screen follows. A banner that is
            always there is furniture, and furniture does not get read. */}
        {!allOff && wasAllOff && (
          <Callout tone="brand" title="Nobody can sign off yet">
            Give someone the &ldquo;Sign off a large count variance&rdquo; permission in Setup
            &rarr; Roles. Until then, a count with a line over either threshold cannot be posted
            by anyone but an owner — and the person counting should not be the person signing.
          </Callout>
        )}
      </SettingGroup>

      <Callout tone="neutral" icon={<Icons.Info size={18} />}>
        A signature belongs to the figure it was given for. Re-typing a count, or re-freezing the
        sheet, withdraws the sign-off automatically — so a line cannot be approved at one number
        and posted at another.
      </Callout>

      <div className="flex items-center justify-end gap-3">
        {!dirty && <span className="text-xs text-muted">No changes to save.</span>}
        <Button variant="primary" disabled={!dirty || pending} onClick={save}>
          <Icons.Save size={15} />
          {pending ? 'Saving…' : 'Save settings'}
        </Button>
      </div>
    </div>
  )
}

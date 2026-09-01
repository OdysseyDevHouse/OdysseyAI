'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Callout,
  Icons,
  Select,
  SettingGroup,
  SettingRow,
  useToast,
} from '@/components/ui'
import { saveDecimalSettingsAction, type DecimalSettings } from './actions'

/**
 * Quantity and cost precision, with a worked example under each.
 *
 * ── WHY THE PREVIEW IS THE POINT ────────────────────────────────────────────
 *
 * "2 decimals" is an abstraction; "1.00" is the thing that will be on the
 * screen tomorrow. A dropdown of digits with no example is a setting somebody
 * picks, saves, and then discovers on a stock take of two hundred lines — so
 * the example is rendered live from the SAME arithmetic the formatters use.
 *
 * It is deliberately not `formatQty` itself: that function reads a module-level
 * value set for the whole page, so calling it here would show what the shop
 * currently has rather than what the dropdown is offering.
 */

/** The formatter's own rule, for a value nobody has saved yet. */
function previewQty(value: number, places: number): string {
  /* A fraction is never rounded away — the rule that keeps 1.5kg from printing
     as 2. Mirrors formatQty; see the note there about why it tests the value
     rather than a scale-item flag. */
  if (!Number.isInteger(value)) {
    return value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
  }
  return value.toFixed(places)
}

function previewCost(value: number, places: number): string {
  const [whole, fraction] = Math.abs(value).toFixed(places).split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return `R${grouped}${fraction ? `.${fraction}` : ''}`
}

export default function DecimalSettingsClient({ initial }: { initial: DecimalSettings }) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [form, setForm] = useState(initial)
  const [saved, setSaved] = useState(initial)

  const dirty = form.qty !== saved.qty || form.cost !== saved.cost
  const qtyPlaces = Number(form.qty)
  const costPlaces = Number(form.cost)

  function save() {
    startTransition(async () => {
      const result = await saveDecimalSettingsAction(form)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setSaved(result.settings)
      setForm(result.settings)
      toast.success(result.message)
      /* The layout reads these once per request and sets them on the
         formatters, so every screen has to re-render to pick them up. */
      router.refresh()
    })
  }

  return (
    <div className="flex flex-col gap-6">
      <SettingGroup
        title="Quantities"
        description="How many decimals a quantity is shown with — on stock takes, receiving, adjustments, sales lines and everywhere else a number of things appears."
      >
        <SettingRow
          icon={<Icons.Package size={16} />}
          label="Quantity decimals"
          description="Most shops count whole things and want 0. A shop selling by weight or length wants 2 or 3."
          htmlFor="qty-decimals"
        >
          <Select
            id="qty-decimals"
            className="w-24"
            value={form.qty}
            onChange={(e) => setForm((f) => ({ ...f, qty: e.target.value }))}
          >
            {['0', '1', '2', '3'].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </SettingRow>

        <div className="flex flex-col gap-3 px-6 py-4">
          <p className="text-xs font-medium text-muted">What you will see</p>
          <div className="flex flex-wrap gap-4">
            {[1, 10, 11].map((n) => (
              <span key={n} className="numeric rounded-control border border-border px-3 py-1.5 text-sm text-ink">
                {previewQty(n, qtyPlaces)}
              </span>
            ))}
            <span className="numeric rounded-control border border-brand bg-brand-soft px-3 py-1.5 text-sm text-ink">
              {previewQty(1.5, qtyPlaces)}
              <span className="ml-2 text-xs text-muted">a weighed line</span>
            </span>
          </div>

          <Callout tone="neutral" title="A weight is never rounded">
            The setting decides how a COUNT is shown. A line with a real fraction — 1.5 kg of
            cheese, 2.4 m of cable — always keeps its decimals, whatever this is set to.
            Rounding one to a whole number would not be a tidier screen, it would be a wrong
            figure on a document somebody pays against.
          </Callout>
        </div>
      </SettingGroup>

      <SettingGroup
        title="Costs"
        description="How many decimals a cost is shown with, inclusive and exclusive. This does not change any selling price — money has two decimals because that is what a customer can pay."
      >
        <SettingRow
          icon={<Icons.Coins size={16} />}
          label="Cost decimals"
          description="Two suits most shops. A distributor buying at fractions of a cent needs three or four, or the rounding hides real money."
          htmlFor="cost-decimals"
        >
          <Select
            id="cost-decimals"
            className="w-24"
            value={form.cost}
            onChange={(e) => setForm((f) => ({ ...f, cost: e.target.value }))}
          >
            {['2', '3', '4'].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </SettingRow>

        <div className="flex flex-col gap-3 px-6 py-4">
          <p className="text-xs font-medium text-muted">What you will see</p>
          <div className="flex flex-wrap gap-4">
            {[0.0875, 12.5, 1234.5].map((n) => (
              <span
                key={n}
                className="numeric rounded-control border border-border px-3 py-1.5 text-sm text-ink"
              >
                {previewCost(n, costPlaces)}
              </span>
            ))}
          </div>
          <p className="text-sm text-muted">
            Costs are stored with four decimals whatever you choose here, so lowering this hides
            precision rather than losing it — set it back and your own figures return.
          </p>
        </div>
      </SettingGroup>

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

'use client'

import { useState, useTransition } from 'react'
import {
  Button,
  Callout,
  CurrencyInput,
  Icons,
  NumberInput,
  Select,
  SettingGroup,
  SettingRow,
  useToast,
} from '@/components/ui'
import {
  savePurchasingSettingsAction,
  type PurchasingSettings,
} from './actions'

/**
 * How stock is costed, and the two guards on the act that costs it.
 *
 * ── WHY COST BASIS IS THE DANGEROUS ONE ───────────────────────────────────
 *
 * It is one select box that silently restates every margin, GP report and till
 * cost in the shop. Nothing is recalculated and nothing is lost — receiving
 * writes BOTH average_cost and last_cost on every line, so the two figures are
 * always on file and the switch is fully reversible — but the numbers a manager
 * has been reading all quarter will move the moment it is saved.
 *
 * So the screen says what will change BEFORE the save, not after, and only
 * while the choice actually differs from what is stored. A warning that is
 * always on screen is furniture; one that appears when you touch the control is
 * the thing that makes someone stop and read.
 */
export default function PurchasingSettingsClient({
  settings: initial,
}: {
  settings: PurchasingSettings
}) {
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [saved, setSaved] = useState(initial)
  const [costBasis, setCostBasis] = useState(initial.costBasis)
  const [invoiceTolerance, setInvoiceTolerance] = useState(Number(initial.invoiceTolerance))
  const [costWarnPct, setCostWarnPct] = useState(Number(initial.costWarnPct))

  const basisChanged = costBasis !== saved.costBasis
  const dirty =
    basisChanged ||
    invoiceTolerance !== Number(saved.invoiceTolerance) ||
    costWarnPct !== Number(saved.costWarnPct)

  function save() {
    startTransition(async () => {
      const result = await savePurchasingSettingsAction({
        costBasis,
        /* Sent as plain numbers, NOT toFixed(2). The column is a VARCHAR and
           every reader runs Number() over it, so '0.1' and '0.10' are the same
           setting — but writing the padded form back would rewrite a value the
           site already had, and `dirty` compares numbers precisely so that a
           cosmetic difference never presents itself as an unsaved change. */
        invoiceTolerance: String(invoiceTolerance),
        costWarnPct: String(costWarnPct),
      })

      if (!result.ok) {
        toast.error(result.error)
        return
      }

      setSaved(result.settings)
      setCostBasis(result.settings.costBasis)
      toast.success('Purchasing settings saved.')
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <SettingGroup
        title="How stock is costed"
        description="Which cost every margin, GP report and till figure is measured against."
      >
        <SettingRow
          icon={<Icons.Coins size={16} />}
          label="Cost basis"
          description="Average blends every receipt into one figure. Last cost uses only the most recent invoice."
          htmlFor="cost-basis"
        >
          <Select
            id="cost-basis"
            className="w-56"
            value={costBasis}
            onChange={(e) => setCostBasis(e.target.value === 'last' ? 'last' : 'average')}
          >
            <option value="average">Average cost</option>
            <option value="last">Last cost</option>
          </Select>
        </SettingRow>
      </SettingGroup>

      {/* Only while the choice differs from what is stored. Saved, it goes
          away — a permanent banner about a setting already in force is noise,
          and noise is what stops the next warning being read. */}
      {basisChanged && (
        <Callout tone="warning" title="This changes every cost figure in the shop">
          Margins, GP reports and the cost the till records will all switch to{' '}
          {costBasis === 'last' ? 'the last invoice price' : 'the blended average'} as soon as
          this is saved. Nothing is recalculated and no history is lost — both figures are
          kept on every product — but the numbers on your reports will move.
        </Callout>
      )}

      <SettingGroup
        title="Receiving guards"
        description="Two checks at the moment a delivery is posted. Receiving is the only act that writes average cost, so a keying error here is silent."
      >
        <SettingRow
          icon={<Icons.StatusWarning size={16} />}
          label="Invoice tolerance"
          description="How far the keyed lines may differ from the supplier's invoice total before the receipt is refused. Only applies when a total is given."
          htmlFor="invoice-tolerance"
        >
          <CurrencyInput
            id="invoice-tolerance"
            className="w-40"
            value={invoiceTolerance}
            onChange={(e) =>
              setInvoiceTolerance(Number(String(e.target.value).replace(',', '.')) || 0)
            }
          />
        </SettingRow>

        <SettingRow
          icon={<Icons.StatusWarning size={16} />}
          label="Cost-change warning"
          description="How far a unit cost may move from the last one paid before the line says so. A warning, never a refusal. Zero switches it off."
          htmlFor="cost-warn-pct"
        >
          <div className="flex items-center gap-2">
            <NumberInput
              id="cost-warn-pct"
              className="w-28"
              value={costWarnPct}
              precision={0}
              onChange={(e) =>
                setCostWarnPct(Number(String(e.target.value).replace(',', '.')) || 0)
              }
            />
            <span className="text-sm text-muted">%</span>
          </div>
        </SettingRow>
      </SettingGroup>

      <div className="flex items-center justify-end gap-3">
        {/* Says the save did nothing rather than leaving a live button that
            appears to do something. */}
        {!dirty && <span className="text-xs text-muted">No changes to save.</span>}
        <Button variant="primary" disabled={!dirty || pending} onClick={save}>
          <Icons.Save size={15} />
          {pending ? 'Saving…' : 'Save settings'}
        </Button>
      </div>
    </div>
  )
}

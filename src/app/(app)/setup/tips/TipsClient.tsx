'use client'

import { useState, useTransition } from 'react'
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Icons,
  NumberInput,
  SettingRow,
  Switch,
  useToast,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { serviceChargeFor } from '@/lib/tipMath'
import {
  saveTierAction,
  deleteTierAction,
  setTablesOnlyAction,
  type TierRow,
  type TiersResult,
} from './actions'

/**
 * Service charges, and where they apply.
 *
 * ── THE BANDS ARE HALF-OPEN, AND THE SCREEN SAYS SO ───────────────────────
 *
 * `min` is inclusive and `max` EXCLUSIVE, so 500–1000 and 1000–1500 meet at exactly 1000
 * and the second band owns it. That is not a detail a manager should have to infer: bills
 * cluster on round numbers, so a screen that read "500 to 1000" and "1000 to 1500" without
 * saying which owns 1000 invites somebody to configure a double charge. Each row states
 * the rule in words, and a live preview shows what a real bill would be charged.
 *
 * ── OVERLAPS ARE REPORTED, NOT REFUSED ────────────────────────────────────
 *
 * A manager mid-edit will always have a moment where two bands overlap, and refusing the
 * save would make the screen unusable. So the count is shown, and `serviceChargeFor`
 * resolves to the HIGHER percentage — charging more is visible and gets queried, where
 * charging less would hide the misconfiguration for months.
 */
export default function TipsClient({
  tiers: initialTiers,
  tablesOnly: initialTablesOnly,
  overlaps: initialOverlaps,
}: {
  tiers: TierRow[]
  tablesOnly: boolean
  overlaps: number
}) {
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [tiers, setTiers] = useState(initialTiers)
  const [tablesOnly, setTablesOnly] = useState(initialTablesOnly)
  const [overlaps, setOverlaps] = useState(initialOverlaps)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({ minTotal: 0, maxTotal: 0, percent: 10 })

  function apply(result: TiersResult): boolean {
    if (!result.ok) {
      toast.error(result.error)
      return false
    }
    setTiers(result.tiers)
    setTablesOnly(result.tablesOnly)
    setOverlaps(result.overlaps)
    return true
  }

  return (
    <>
      <Card>
        <CardHeader
          title="Where a service charge applies"
          description="A percentage added automatically to a bill, on top of what the goods cost."
        />
        <SettingRow
          icon={<Icons.Users size={18} />}
          label="Tables only"
          description="A service charge on a R600 table is normal; one on a R600 takeaway or a shop basket is a charge the customer did not expect. Leave this on unless you mean otherwise."
        >
          <Switch
            checked={tablesOnly}
            onChange={(next) =>
              startTransition(async () => {
                const result = await setTablesOnlyAction(next)
                if (apply(result)) {
                  toast.success(next ? 'Service charges apply to tables only.' : 'Service charges apply to every sale.')
                }
              })
            }
            disabled={pending}
            label={tablesOnly ? 'Tables only' : 'Every sale'}
          />
        </SettingRow>
      </Card>

      <Card>
        <CardHeader
          title="Service-charge bands"
          description="Added automatically once a bill reaches the band. A waiter cannot remove one — somebody with the discount-override right can, and every removal is recorded."
          action={
            !adding && (
              <Button variant="secondary" disabled={pending} onClick={() => setAdding(true)}>
                <Icons.Plus size={16} />
                Add a band
              </Button>
            )
          }
        />
        <CardBody className="space-y-3">
          {overlaps > 0 && (
            <Callout tone="warning">
              {overlaps} band{overlaps === 1 ? '' : 's'} overlap another. A bill in the
              overlap is charged the HIGHER percentage — tidy the ranges so there is one
              answer per amount.
            </Callout>
          )}

          {tiers.length === 0 && !adding ? (
            <EmptyState
              icon={<Icons.Percent size={28} />}
              title="No service charges"
              hint="Bills are charged exactly what the goods cost. Add a band to change that."
            />
          ) : (
            <ul className="space-y-2">
              {tiers.map((tier) => (
                <li
                  key={tier.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface p-3"
                >
                  <div>
                    <p className="text-sm font-medium text-ink">
                      {formatMoney(tier.minTotal)}
                      {tier.maxTotal === null
                        ? ' and above'
                        : ` up to ${formatMoney(tier.maxTotal)}`}
                      {' → '}
                      <span className="text-brand">{tier.percent}%</span>
                    </p>
                    {/* The half-open rule, in words. A manager reading "1000 up to 1500"
                        should not have to guess whether 1000 or 1500 is included. */}
                    <p className="text-xs text-muted">
                      {formatMoney(tier.minTotal)} itself is included
                      {tier.maxTotal !== null && `; ${formatMoney(tier.maxTotal)} belongs to the next band`}
                      {' · '}a {formatMoney(exampleFor(tier))} bill pays{' '}
                      {formatMoney(serviceChargeFor(exampleFor(tier), tiers))}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {!tier.isActive && <Badge tone="neutral">Off</Badge>}
                    <Switch
                      checked={tier.isActive}
                      onChange={(next) =>
                        startTransition(async () => {
                          apply(await saveTierAction({ ...tier, isActive: next }))
                        })
                      }
                      disabled={pending}
                      label=""
                    />
                    <Button
                      variant="danger-ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() =>
                        startTransition(async () => {
                          if (apply(await deleteTierAction(tier.id))) {
                            toast.success('Band removed.')
                          }
                        })
                      }
                    >
                      <Icons.Trash size={14} />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {adding && (
            <div className="flex flex-wrap items-end gap-3 rounded-card border border-border bg-surface-2 p-3">
              <Field label="From" hint="Included in the band">
                <NumberInput
                  value={draft.minTotal}
                  onChange={(e) => setDraft({ ...draft, minTotal: Number(e.target.value) || 0 })}
                />
              </Field>
              <Field label="Up to" hint="0 for no upper limit">
                <NumberInput
                  value={draft.maxTotal}
                  onChange={(e) => setDraft({ ...draft, maxTotal: Number(e.target.value) || 0 })}
                />
              </Field>
              <Field label="Percent">
                <NumberInput
                  value={draft.percent}
                  onChange={(e) => setDraft({ ...draft, percent: Number(e.target.value) || 0 })}
                />
              </Field>
              <Button
                variant="primary"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const result = await saveTierAction({
                      minTotal: draft.minTotal,
                      /* Zero means "no upper limit" on this form, because a band ending at
                         R0 is meaningless and an empty number input is awkward to
                         distinguish from a typed zero. */
                      maxTotal: draft.maxTotal > 0 ? draft.maxTotal : null,
                      percent: draft.percent,
                      isActive: true,
                    })
                    if (apply(result)) {
                      setAdding(false)
                      setDraft({ minTotal: 0, maxTotal: 0, percent: 10 })
                      toast.success('Band added.')
                    }
                  })
                }
              >
                Add
              </Button>
              <Button variant="ghost" disabled={pending} onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          )}
        </CardBody>
      </Card>
    </>
  )
}

/**
 * A bill value inside the band, for the live preview.
 *
 * Midway through a closed band, or a little above the floor of an open-ended one — so the
 * example is always an amount the band actually matches. A preview showing a figure from
 * outside its own band would be worse than none.
 */
function exampleFor(tier: TierRow): number {
  if (tier.maxTotal === null) return Math.round(tier.minTotal * 1.2) || 100
  return Math.round((tier.minTotal + tier.maxTotal) / 2)
}

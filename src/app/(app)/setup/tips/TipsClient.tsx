'use client'

import { useState, useTransition } from 'react'
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  CurrencyInput,
  EmptyState,
  Field,
  Icons,
  NumberInput,
  Select,
  SettingRow,
  Switch,
  useToast,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { serviceChargeFor, type ServiceChargeKind } from '@/lib/tipMath'
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
 * resolves to whichever band charges MORE on that bill — charging more is visible and
 * gets queried, where charging less would hide the misconfiguration for months.
 *
 * ── A BAND IS A PERCENTAGE OR A FLAT AMOUNT ───────────────────────────────
 *
 * A percentage is right for a restaurant's service charge and wrong for a tray or delivery
 * fee, or a small-order charge where a share of a small bill does not cover what it exists
 * to cover. The two are chosen between rather than combined, and the form asks for only
 * the figure the chosen kind uses — see `chargeKind` in `src/lib/tipMath.ts`.
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
  const [draft, setDraft] = useState<{
    minTotal: number
    maxTotal: number
    chargeKind: ServiceChargeKind
    percent: number
    amount: number
  }>({ minTotal: 0, maxTotal: 0, chargeKind: 'percent', percent: 10, amount: 0 })

  /* Both figures are kept in the draft while the form is open, so switching the
     selector back and forth does not lose what was typed on the other side. The
     server zeroes whichever one the saved band does not use. */
  const DRAFT_BLANK = {
    minTotal: 0,
    maxTotal: 0,
    chargeKind: 'percent' as ServiceChargeKind,
    percent: 10,
    amount: 0,
  }

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
          description="Added automatically to a bill, on top of what the goods cost — either a percentage of it or a flat amount."
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
              overlap is charged whichever band takes MORE off it — tidy the ranges so
              there is one answer per amount.
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
                      <span className="text-brand">
                        {tier.chargeKind === 'amount'
                          ? formatMoney(tier.amount)
                          : `${tier.percent}%`}
                      </span>
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
              <Field label="Charge">
                <Select
                  value={draft.chargeKind}
                  onChange={(e) =>
                    setDraft({ ...draft, chargeKind: e.target.value as ServiceChargeKind })
                  }
                >
                  <option value="percent">A percentage of the bill</option>
                  <option value="amount">A flat amount</option>
                </Select>
              </Field>
              {/* Only the figure the band actually charges is asked for. Showing both at
                  once would leave a manager wondering which one the till reads, and the
                  server zeroes the unused one anyway. */}
              {draft.chargeKind === 'amount' ? (
                <Field label="Amount" hint="Added whatever the bill comes to">
                  <CurrencyInput
                    value={draft.amount}
                    onChange={(e) => setDraft({ ...draft, amount: Number(e.target.value) || 0 })}
                  />
                </Field>
              ) : (
                <Field label="Percent">
                  <NumberInput
                    value={draft.percent}
                    onChange={(e) => setDraft({ ...draft, percent: Number(e.target.value) || 0 })}
                  />
                </Field>
              )}
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
                      chargeKind: draft.chargeKind,
                      percent: draft.percent,
                      amount: draft.amount,
                      isActive: true,
                    })
                    if (apply(result)) {
                      setAdding(false)
                      setDraft(DRAFT_BLANK)
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

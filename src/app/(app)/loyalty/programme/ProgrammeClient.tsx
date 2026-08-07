'use client'

import { useState, useTransition } from 'react'
import {
  Button,
  Card,
  CardHeader,
  CardBody,
  CardFooter,
  Field,
  NumberInput,
  Select,
  Switch,
  Callout,
  useToast,
} from '@/components/ui'
import { computeEarn, pointsToRand, type LoyaltySettings } from '@/lib/loyaltyRules'
import { saveSettingsAction } from '../actions'

/**
 * The rates, in the language a shop owner uses.
 *
 * The worked example under the rates is the point of this screen. "R1 per
 * point" and "10 points per rand" are two numbers whose COMBINED effect — what
 * the programme actually costs — is not obvious from either one. Someone
 * setting up a programme is really asking "what percentage am I giving back",
 * so the screen answers that question directly as they type.
 */
export function ProgrammeClient({
  initial,
  canEdit,
}: {
  initial: LoyaltySettings
  canEdit: boolean
}) {
  const toast = useToast()
  const [pending, start] = useTransition()
  const [form, setForm] = useState<LoyaltySettings>(initial)

  const patch = (over: Partial<LoyaltySettings>) => setForm((f) => ({ ...f, ...over }))

  // What R100 across the counter is actually worth to the customer, at the base
  // rate. Deliberately the base rate and not a tier multiplier: this is the
  // floor of what the programme costs, and the tiers are shown separately.
  const example = computeEarn(
    [{ lineTotalIncl: 100, discounted: false }],
    { ...form, enabled: true },
    null,
  )
  const exampleWorth = pointsToRand(example.points, form)
  const givebackPct = exampleWorth > 0 ? (exampleWorth / 100) * 100 : 0

  function save() {
    start(async () => {
      const result = await saveSettingsAction(form)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
    })
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader
          title="Earning and spending"
          description="What a rand earns, and what a point is worth back."
        />
        <CardBody className="space-y-4">
          <Switch
            label="Run the loyalty programme"
            hint="Off means nothing earns at the till and the loyalty tenders are hidden."
            checked={form.enabled}
            onChange={(enabled) => patch({ enabled })}
            disabled={!canEdit}
          />

          <Field
            label="Rand spent per point earned"
            hint="1 means every R1 spent earns one point."
          >
            <NumberInput
              value={form.earnRate}
              onChange={(e) => patch({ earnRate: Number(e.target.value) })}
              min={0.01}
              step={0.5}
              disabled={!canEdit}
            />
          </Field>

          <Field
            label="Points needed for R1 off"
            hint="10 means a point is worth 10c when it is spent."
          >
            <NumberInput
              value={form.redeemRate}
              onChange={(e) => patch({ redeemRate: Number(e.target.value) })}
              min={0.01}
              step={1}
              disabled={!canEdit}
            />
          </Field>

          <Field
            label="Fewest points that may be spent at once"
            hint="Zero lets any balance be spent. A floor stops one-point redemptions."
          >
            <NumberInput
              value={form.minRedeemPoints}
              onChange={(e) => patch({ minRedeemPoints: Number(e.target.value) })}
              min={0}
              step={10}
              disabled={!canEdit}
            />
          </Field>

          <Switch
            label="Discounted items still earn"
            hint="Off means a marked-down line earns nothing, so promotions do not stack with points."
            checked={form.earnOnDiscounted}
            onChange={(earnOnDiscounted) => patch({ earnOnDiscounted })}
            disabled={!canEdit}
          />

          <Callout tone="brand">
            A R100 basket earns <strong>{example.points} points</strong>, worth{' '}
            <strong>R{exampleWorth.toFixed(2)}</strong> back — about{' '}
            <strong>{givebackPct.toFixed(1)}%</strong> of the sale. Members on a higher tier earn
            their multiplier on top of this.
          </Callout>
        </CardBody>
        {canEdit && (
          <CardFooter>
            <Button variant="primary" onClick={save} disabled={pending}>
              {pending ? 'Saving…' : 'Save programme'}
            </Button>
          </CardFooter>
        )}
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader
            title="Expiry"
            description="Points that are never used sit on the books as a liability forever."
          />
          <CardBody className="space-y-4">
            <Field label="When points lapse">
              <Select
                value={form.expiryMode}
                onChange={(e) => patch({ expiryMode: e.target.value as LoyaltySettings['expiryMode'] })}
                disabled={!canEdit}
              >
                <option value="never">Never — points last forever</option>
                <option value="activity">After a quiet spell — the whole balance lapses</option>
                <option value="earn">By age — each batch lapses on its own clock</option>
              </Select>
            </Field>

            {form.expiryMode !== 'never' && (
              <Field
                label="Months"
                hint={
                  form.expiryMode === 'activity'
                    ? 'How long an account may go without earning or spending before the balance lapses.'
                    : 'How long points last from the day they were earned.'
                }
              >
                <NumberInput
                  value={form.expiryMonths}
                  onChange={(e) => patch({ expiryMonths: Number(e.target.value) })}
                  min={1}
                  max={120}
                  disabled={!canEdit}
                />
              </Field>
            )}

            <Callout tone="warning">
              Expiry only runs when someone presses “Run expiry” on the Members tab. Nothing lapses
              on its own.
            </Callout>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Tier standing"
            description="How long spending counts towards a customer’s tier."
          />
          <CardBody className="space-y-4">
            <Field label="Measured over">
              <Select
                value={form.tierBasis}
                onChange={(e) => patch({ tierBasis: e.target.value as LoyaltySettings['tierBasis'] })}
                disabled={!canEdit}
              >
                <option value="rolling">A moving window</option>
                <option value="lifetime">Everything they have ever spent</option>
              </Select>
            </Field>

            {form.tierBasis === 'rolling' && (
              <Field label="Window, in months" hint="Spending older than this stops counting.">
                <NumberInput
                  value={form.tierWindowMonths}
                  onChange={(e) => patch({ tierWindowMonths: Number(e.target.value) })}
                  min={1}
                  max={120}
                  disabled={!canEdit}
                />
              </Field>
            )}

            <Field
              label="Grace before a demotion, in months"
              hint="A customer keeps their tier this long after their spending drops, rather than losing it the same week."
            >
              <NumberInput
                value={form.tierGraceMonths}
                onChange={(e) => patch({ tierGraceMonths: Number(e.target.value) })}
                min={0}
                max={120}
                disabled={!canEdit}
              />
            </Field>

            <Callout tone="brand">
              Tier standing counts what a customer <strong>spent</strong>, never their points
              balance — so spending points can never cost someone their tier.
            </Callout>
          </CardBody>
        </Card>
      </div>
    </div>
  )
}

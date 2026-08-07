'use client'

import { useState, useTransition } from 'react'
import {
  Button,
  Card,
  CardHeader,
  CardBody,
  CardFooter,
  Field,
  Input,
  NumberInput,
  CurrencyInput,
  Select,
  Switch,
  Callout,
  Badge,
  useToast,
  Icons,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { LoyaltyTier } from '@/lib/loyaltyRules'
import { saveTiersAction } from '../actions'

type Draft = Omit<LoyaltyTier, 'id'> & { id: number | null }

/** The tokens a tier badge may use. Names, never hex — see AGENTS.md. */
const COLORS = [
  { value: 'muted', label: 'Grey' },
  { value: 'info', label: 'Blue' },
  { value: 'warning', label: 'Amber' },
  { value: 'success', label: 'Green' },
  { value: 'brand', label: 'Brand' },
  { value: 'danger', label: 'Red' },
]

/**
 * The ladder, edited as a whole.
 *
 * Saved in one go rather than row by row because the rules that matter are
 * relational — thresholds must increase, names must be unique — and a row-level
 * save cannot see the ladder it is part of. The server validates the same way.
 */
export function TiersClient({ initial, canEdit }: { initial: LoyaltyTier[]; canEdit: boolean }) {
  const toast = useToast()
  const [pending, start] = useTransition()
  const [rows, setRows] = useState<Draft[]>(initial.map((t) => ({ ...t })))

  function patch(index: number, over: Partial<Draft>) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...over } : row)))
  }

  function add() {
    const highest = rows.reduce((max, row) => Math.max(max, row.qualifyingSpend), 0)
    setRows((current) => [
      ...current,
      {
        id: null,
        name: '',
        step: current.length + 1,
        // Suggested above the current top rung, which is the only place a new
        // tier can legally go without renumbering everything below it.
        qualifyingSpend: highest > 0 ? highest * 2 : 5000,
        multiplier: 1,
        discountPct: 0,
        color: 'muted',
        isActive: true,
      },
    ])
  }

  function remove(index: number) {
    setRows((current) => current.filter((_, i) => i !== index))
  }

  function save() {
    start(async () => {
      const result = await saveTiersAction(rows.map(({ id: _id, ...rest }) => rest))
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
    })
  }

  return (
    <Card>
      <CardHeader
        title="Tier ladder"
        description="Members move up as they spend. Listed from the entry tier upwards."
      />
      <CardBody className="space-y-4">
        <Callout tone="brand">
          A member sits in the highest tier whose spend they have met. One tier must need{' '}
          <strong>no spend at all</strong> — that is where everybody starts — and each rung above it
          must need more than the one below, or it can never be reached.
        </Callout>

        <div className="space-y-3">
          {rows.map((row, index) => (
            <div
              key={row.id ?? `new-${index}`}
              className="rounded-card border border-border bg-surface-2 p-4"
            >
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Badge tone="neutral">Tier {index + 1}</Badge>
                  {row.name && <span className="font-medium text-ink">{row.name}</span>}
                  {row.qualifyingSpend === 0 && <Badge tone="success">Everyone starts here</Badge>}
                </div>
                {canEdit && rows.length > 1 && (
                  <Button
                    variant="danger-ghost"
                    size="sm"
                    iconOnly
                    aria-label={`Remove ${row.name || 'tier'}`}
                    onClick={() => remove(index)}
                  >
                    <Icons.Trash size={16} />
                  </Button>
                )}
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <Field label="Name">
                  <Input
                    value={row.name}
                    onChange={(e) => patch(index, { name: e.target.value })}
                    maxLength={40}
                    disabled={!canEdit}
                  />
                </Field>

                <Field label="Spend to reach" hint={index === 0 ? 'Zero for the entry tier' : undefined}>
                  <CurrencyInput
                    value={row.qualifyingSpend}
                    onChange={(e) => patch(index, { qualifyingSpend: Number(e.target.value) })}
                    disabled={!canEdit}
                  />
                </Field>

                <Field label="Points multiplier" hint="2 means double points">
                  <NumberInput
                    value={row.multiplier}
                    onChange={(e) => patch(index, { multiplier: Number(e.target.value) })}
                    min={0.1}
                    step={0.25}
                    disabled={!canEdit}
                  />
                </Field>

                <Field label="Standing discount %">
                  <NumberInput
                    value={row.discountPct}
                    onChange={(e) => patch(index, { discountPct: Number(e.target.value) })}
                    min={0}
                    max={100}
                    step={1}
                    disabled={!canEdit}
                  />
                </Field>

                <Field label="Badge colour">
                  <Select
                    value={row.color}
                    onChange={(e) => patch(index, { color: e.target.value })}
                    disabled={!canEdit}
                  >
                    {COLORS.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>

              <div className="mt-3">
                <Switch
                  label="In use"
                  hint="Switching a tier off leaves its members where they are until the next review."
                  checked={row.isActive}
                  onChange={(isActive) => patch(index, { isActive })}
                  disabled={!canEdit}
                />
              </div>

              {row.multiplier !== 1 && (
                <p className="mt-2 text-xs text-muted">
                  A R100 basket here earns {Math.floor(100 * row.multiplier)} points instead of 100.
                </p>
              )}
            </div>
          ))}
        </div>

        {canEdit && (
          <Button variant="secondary" size="sm" onClick={add}>
            <Icons.Plus size={16} />
            Add a tier
          </Button>
        )}
      </CardBody>

      {canEdit && (
        <CardFooter>
          <Button variant="primary" onClick={save} disabled={pending}>
            {pending ? 'Saving…' : 'Save ladder'}
          </Button>
        </CardFooter>
      )}
    </Card>
  )
}

'use client'

import { useState, useTransition } from 'react'
import {
  Badge,
  Button,
  Card,
  Checkbox,
  DataTable,
  EmptyState,
  Field,
  Icons,
  Input,
  Modal,
  NumberInput,
  Select,
  TableToolbar,
  useToast,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { DiscountKind } from '@/lib/site/discountCodes'
import { retireDiscountAction, reviveDiscountAction, saveDiscountAction } from './actions'

/**
 * The discounts list, and the editor over it.
 *
 * A client component because DataTable's columns carry cell renderers, which
 * cannot cross the server boundary — the page fetches, this draws.
 *
 * ── WHAT THE LIST SHOWS, AND WHY ─────────────────────────────────────────
 *
 * Not every column on the row. A campaign is judged on four things: what it is
 * called, what it takes off, how much has been spent through it, and whether it
 * is still running. The rest — minimums, date windows, per-customer caps — is
 * setup, and lives in the editor where it is being decided rather than in a
 * table nobody can scan.
 *
 * `Given away` is the number a shop actually wants and cannot get anywhere
 * else: what this code has cost, in money, so far.
 */

export type DiscountRow = {
  id: number
  code: string
  description: string
  kind: DiscountKind
  value: number
  minOrderIncl: number
  startsAt: string | null
  endsAt: string | null
  maxUses: number | null
  usesCount: number
  maxUsesPerCustomer: number | null
  firstOrderOnly: boolean
  departmentId: number | null
  combinesWithSpecials: boolean
  isActive: boolean
  uses: number
  givenAwayIncl: number
}

const KIND_LABEL: Record<DiscountKind, string> = {
  percent: 'Percentage off',
  amount: 'Amount off',
  free_delivery: 'Free delivery',
}

/** The blank an editor opens on for a new code. */
function emptyRow(): DiscountRow {
  return {
    id: 0,
    code: '',
    description: '',
    kind: 'percent',
    value: 10,
    minOrderIncl: 0,
    startsAt: null,
    endsAt: null,
    maxUses: null,
    usesCount: 0,
    maxUsesPerCustomer: null,
    firstOrderOnly: false,
    departmentId: null,
    combinesWithSpecials: false,
    isActive: true,
    uses: 0,
    givenAwayIncl: 0,
  }
}

export default function DiscountsTable({
  codes,
  departments,
}: {
  codes: DiscountRow[]
  departments: { id: number; name: string }[]
}) {
  const toast = useToast()
  const [busy, startAction] = useTransition()
  const [editing, setEditing] = useState<DiscountRow | null>(null)

  function run(fn: () => Promise<{ ok: true } | { ok: false; error: string }>, done: string) {
    startAction(async () => {
      const result = await fn()
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(done)
      setEditing(null)
    })
  }

  return (
    <>
      <Card>
        <TableToolbar
          inCard
          actions={
            <Button variant="primary" onClick={() => setEditing(emptyRow())}>
              <Icons.Plus size={16} />
              New code
            </Button>
          }
        />

        {codes.length === 0 ? (
          <EmptyState
            icon={<Icons.Tag size={22} />}
            title="No discount codes yet"
            hint="Create one and shoppers can type it at checkout to pay less."
            action={
              <Button variant="primary" onClick={() => setEditing(emptyRow())}>
                New code
              </Button>
            }
          />
        ) : (
          <DataTable
            rows={codes}
            getRowKey={(row) => row.id}
            columns={[
              {
                key: 'code',
                header: 'Code',
                sortValue: (row) => row.code,
                cell: (row) => (
                  <span>
                    <span className="block font-medium text-ink">{row.code}</span>
                    {row.description && (
                      <span className="block text-xs text-muted">{row.description}</span>
                    )}
                  </span>
                ),
              },
              {
                key: 'takes',
                header: 'Takes off',
                sortValue: (row) => row.value,
                cell: (row) => (
                  <span className="text-ink-2">
                    {row.kind === 'percent'
                      ? `${row.value}%`
                      : row.kind === 'amount'
                        ? formatMoney(row.value)
                        : 'Delivery'}
                  </span>
                ),
              },
              {
                key: 'uses',
                header: 'Used',
                numeric: true,
                sortValue: (row) => row.uses,
                cell: (row) => (
                  <span className="numeric text-ink-2">
                    {row.uses}
                    {row.maxUses !== null && (
                      <span className="text-muted"> / {row.maxUses}</span>
                    )}
                  </span>
                ),
              },
              {
                key: 'given',
                header: 'Given away',
                numeric: true,
                sortValue: (row) => row.givenAwayIncl,
                cell: (row) => (
                  <span className="numeric text-ink-2">{formatMoney(row.givenAwayIncl)}</span>
                ),
              },
              {
                key: 'state',
                header: 'State',
                sortValue: (row) => (row.isActive ? 1 : 0),
                // State takes a FORM, not just a word — a retired code and a
                // live one must be distinguishable at scanning speed.
                cell: (row) =>
                  row.isActive ? (
                    <Badge tone="success">Live</Badge>
                  ) : (
                    <Badge tone="neutral">Retired</Badge>
                  ),
              },
            ]}
            actions={(row) => (
              <>
                <Button variant="ghost" size="sm" onClick={() => setEditing(row)}>
                  Edit
                </Button>
                {row.isActive ? (
                  <Button
                    variant="danger-ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      run(() => retireDiscountAction(row.id), `${row.code} retired.`)
                    }
                  >
                    Retire
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      run(() => reviveDiscountAction(row.id), `${row.code} is live again.`)
                    }
                  >
                    Bring back
                  </Button>
                )}
              </>
            )}
          />
        )}
      </Card>

      {editing && (
        <DiscountEditor
          row={editing}
          departments={departments}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={(input) =>
            run(
              () => saveDiscountAction(editing.id || null, input),
              editing.id ? 'Code saved.' : 'Code created.',
            )
          }
        />
      )}
    </>
  )
}

function DiscountEditor({
  row,
  departments,
  busy,
  onClose,
  onSave,
}: {
  row: DiscountRow
  departments: { id: number; name: string }[]
  busy: boolean
  onClose: () => void
  onSave: (input: {
    code: string
    description: string
    kind: DiscountKind
    value: number
    minOrderIncl: number
    startsAt: string | null
    endsAt: string | null
    maxUses: number | null
    maxUsesPerCustomer: number | null
    firstOrderOnly: boolean
    departmentId: number | null
    combinesWithSpecials: boolean
    isActive: boolean
  }) => void
}) {
  const [form, setForm] = useState({
    code: row.code,
    description: row.description,
    kind: row.kind,
    value: row.value,
    minOrderIncl: row.minOrderIncl,
    startsAt: row.startsAt ? row.startsAt.slice(0, 10) : '',
    endsAt: row.endsAt ? row.endsAt.slice(0, 10) : '',
    maxUses: row.maxUses,
    maxUsesPerCustomer: row.maxUsesPerCustomer,
    firstOrderOnly: row.firstOrderOnly,
    departmentId: row.departmentId,
    combinesWithSpecials: row.combinesWithSpecials,
    isActive: row.isActive,
  })

  const patch = (next: Partial<typeof form>) => setForm((f) => ({ ...f, ...next }))

  return (
    <Modal
      open
      onClose={onClose}
      title={row.id ? `Edit ${row.code}` : 'New discount code'}
      /* A long form: the default 60vh cap made it read through a letterbox with
         empty desktop above and below. Still a MAX, so a short one stays short. */
      bodyGrows
      footer={
        // In the FOOTER, because the body scrolls at 60vh and a primary button
        // inside it can end up below the fold on a short screen.
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() =>
              onSave({
                ...form,
                // Dates are day-granular in the editor and stored as datetimes:
                // a start is the beginning of its day and an end is the end of
                // it, so "ends 31 March" includes the 31st rather than expiring
                // at midnight as it begins.
                startsAt: form.startsAt ? `${form.startsAt} 00:00:00` : null,
                endsAt: form.endsAt ? `${form.endsAt} 23:59:59` : null,
              })
            }
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Code" hint="What the shopper types. Stored uppercase.">
            <Input
              value={form.code}
              autoFocus
              placeholder="SAVE10"
              onChange={(e) => patch({ code: e.target.value.toUpperCase() })}
            />
          </Field>
          <Field label="Your note" hint="Never shown to shoppers.">
            <Input
              value={form.description}
              placeholder="e.g. October newsletter"
              onChange={(e) => patch({ description: e.target.value })}
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="What it does">
            <Select
              value={form.kind}
              onChange={(e) => patch({ kind: e.target.value as DiscountKind })}
            >
              {Object.entries(KIND_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>

          {/* Free delivery has no amount to set — a value box for it would be
              a control that does nothing. */}
          {form.kind !== 'free_delivery' && (
            <Field label={form.kind === 'percent' ? 'Percentage off' : 'Amount off'}>
              <NumberInput
                value={form.value}
                min={0}
                max={form.kind === 'percent' ? 100 : undefined}
                onChange={(e) => patch({ value: Number(e.target.value) || 0 })}
              />
            </Field>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Minimum order" hint="0 for no minimum.">
            <NumberInput
              value={form.minOrderIncl}
              min={0}
              onChange={(e) => patch({ minOrderIncl: Number(e.target.value) || 0 })}
            />
          </Field>
          <Field label="Only in department" hint="Leave as All for the whole basket.">
            <Select
              value={form.departmentId ?? ''}
              onChange={(e) =>
                patch({ departmentId: e.target.value ? Number(e.target.value) : null })
              }
            >
              <option value="">All departments</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Starts" hint="Leave empty to start now.">
            <Input
              type="date"
              value={form.startsAt}
              onChange={(e) => patch({ startsAt: e.target.value })}
            />
          </Field>
          <Field label="Ends" hint="Leave empty to run until you retire it.">
            <Input
              type="date"
              value={form.endsAt}
              onChange={(e) => patch({ endsAt: e.target.value })}
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Total uses" hint="Leave empty for unlimited.">
            <Input
              inputMode="numeric"
              value={form.maxUses ?? ''}
              placeholder="Unlimited"
              onChange={(e) =>
                patch({ maxUses: e.target.value ? Number(e.target.value) : null })
              }
            />
          </Field>
          <Field label="Uses per shopper" hint="Leave empty for unlimited.">
            <Input
              inputMode="numeric"
              value={form.maxUsesPerCustomer ?? ''}
              placeholder="Unlimited"
              onChange={(e) =>
                patch({
                  maxUsesPerCustomer: e.target.value ? Number(e.target.value) : null,
                })
              }
            />
          </Field>
        </div>

        <div className="flex flex-col gap-2.5 border-t border-border pt-3">
          <label className="flex cursor-pointer items-start gap-2.5">
            <Checkbox
              checked={form.firstOrderOnly}
              onChange={(e) => patch({ firstOrderOnly: e.target.checked })}
            />
            <span>
              <span className="block text-sm font-medium text-ink">First order only</span>
              <span className="block text-xs text-muted">
                Refused for anyone who has ordered from you online before.
              </span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-2.5">
            <Checkbox
              checked={form.combinesWithSpecials}
              onChange={(e) => patch({ combinesWithSpecials: e.target.checked })}
            />
            <span>
              <span className="block text-sm font-medium text-ink">
                Also discount items already on special
              </span>
              <span className="block text-xs text-muted">
                Off by default. 20% on top of a 30% special is a 44% discount — leave this off
                unless you mean it.
              </span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-2.5">
            <Checkbox
              checked={form.isActive}
              onChange={(e) => patch({ isActive: e.target.checked })}
            />
            <span>
              <span className="block text-sm font-medium text-ink">Live</span>
              <span className="block text-xs text-muted">
                Shoppers can use it right now, subject to the dates above.
              </span>
            </span>
          </label>
        </div>
      </div>
    </Modal>
  )
}

'use client'

import { useState, useTransition } from 'react'
import {
  Badge,
  Button,
  Callout,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Icons,
  Input,
  NumberInput,
  Switch,
  useToast,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { PosTable } from '@/lib/site/posTables'
import {
  createTableAction,
  retireTableAction,
  setPosModeAction,
  updateTableAction,
} from './actions'

/**
 * The floor, as a manager builds it.
 *
 * ── A LIST, NOT A FLOOR PLAN ──────────────────────────────────────────────
 *
 * A visual x/y editor is a week of work and a sectioned list covers what almost every
 * restaurant needs: tables grouped by area, in an order the staff learn. The floor plan is
 * deferred deliberately (see the plan) — and if it lands, this list is still the thing
 * that has to exist underneath it, because somebody has to be able to add a table without
 * dragging it.
 *
 * ── AND NOT A DataTable ───────────────────────────────────────────────────
 *
 * The rows carry an inline edit form and a live occupancy badge, which a DataTable cannot
 * express. Density comes from the same px-4 py-1.5 rhythm every other list uses, so it
 * still reads as one system.
 */
export default function TablesClient({
  tables: initial,
  hospitality: initialHospitality,
}: {
  tables: PosTable[]
  hospitality: boolean
}) {
  const [tables, setTables] = useState(initial)
  const [hospitality, setHospitality] = useState(initialHospitality)
  const [pending, startAction] = useTransition()
  const [editing, setEditing] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)
  const toast = useToast()

  const apply = (result: Awaited<ReturnType<typeof createTableAction>>) => {
    if (!result.ok) {
      toast.error(result.error)
      return false
    }
    setTables(result.tables)
    return true
  }

  /* Grouped for display, insertion order preserved — the same grouping the till's gate
     does, so what a manager arranges here is what a waiter sees. */
  const sections = new Map<string, PosTable[]>()
  for (const table of tables) {
    const key = table.section || ''
    const list = sections.get(key)
    if (list) list.push(table)
    else sections.set(key, [table])
  }

  const occupied = tables.filter((t) => t.documentId !== null).length

  return (
    <div className="flex flex-col gap-4">
      {/* ── The mode ────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="What kind of till is this?"
          description="A counter takes one sale at a time. A floor holds a bill per table."
        />
        <div className="p-4">
          <Switch
            checked={hospitality}
            disabled={pending}
            label="This shop serves tables"
            hint="Turns on the table screen in front of the till. Walk-in and takeaway sales still work exactly as they do now."
            onChange={(next) =>
              startAction(async () => {
                const result = await setPosModeAction(next)
                if (!result.ok) {
                  toast.error(result.error)
                  return
                }
                setHospitality(result.hospitality)
                toast.success(
                  result.hospitality
                    ? 'The till will show the floor.'
                    : 'The till is back to a counter.',
                )
              })
            }
          />

          {/* Said only when it is ON and there is nothing to show. A shop that flipped
              the switch and stopped would otherwise find an empty screen at the till
              with no clue what was missing. */}
          {hospitality && tables.length === 0 && (
            <Callout tone="warning" title="No tables yet" className="mt-4">
              The till will show the floor as empty. Add the tables below — until then,
              only walk-in sales are possible.
            </Callout>
          )}

          {/* And the reverse: tables built but the mode off is work that does nothing. */}
          {!hospitality && tables.length > 0 && (
            <Callout tone="neutral" title="These tables are not in use" className="mt-4">
              {tables.length} table{tables.length === 1 ? '' : 's'} are set up, but the till
              is running as a counter. Turn the switch on to use them.
            </Callout>
          )}
        </div>
      </Card>

      {/* ── The floor ───────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Tables"
          description="Group them by area if it helps — the till shows the same grouping."
          action={
            <div className="flex items-center gap-2">
              {occupied > 0 && (
                <Badge tone="brand">
                  {occupied} with a bill open
                </Badge>
              )}
              <Button
                variant="secondary"
                size="sm"
                disabled={pending}
                onClick={() => {
                  setAdding(true)
                  setEditing(null)
                }}
              >
                <Icons.Plus size={14} />
                Add a table
              </Button>
            </div>
          }
        />

        {adding && (
          <div className="border-b border-border bg-surface-2 p-4">
            <TableForm
              busy={pending}
              onCancel={() => setAdding(false)}
              onSave={(input) =>
                startAction(async () => {
                  if (apply(await createTableAction(input))) {
                    toast.success('Table added.')
                    setAdding(false)
                  }
                })
              }
            />
          </div>
        )}

        {tables.length === 0 ? (
          <EmptyState
            icon={<Icons.LayoutGrid size={22} />}
            title="No tables"
            hint="Add them in the order the staff read them — 1, 2, 3, or by area."
            action={
              <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
                <Icons.Plus size={14} />
                Add a table
              </Button>
            }
          />
        ) : (
          [...sections.entries()].map(([section, list]) => (
            <div key={section || '_'}>
              {section && (
                <div className="border-b border-border bg-surface-2 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
                  {section}
                </div>
              )}
              <ul className="divide-y divide-border">
                {list.map((table) =>
                  editing === table.id ? (
                    <li key={table.id} className="bg-surface-2 p-4">
                      <TableForm
                        table={table}
                        busy={pending}
                        onCancel={() => setEditing(null)}
                        onSave={(input) =>
                          startAction(async () => {
                            if (apply(await updateTableAction(table.id, input))) {
                              toast.success('Table saved.')
                              setEditing(null)
                            }
                          })
                        }
                      />
                    </li>
                  ) : (
                    <li key={table.id} className="flex items-center gap-3 px-4 py-1.5">
                      <span className="w-14 shrink-0 text-base font-bold text-ink">
                        {table.code}
                      </span>

                      <div className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-ink">
                          {table.name || <span className="text-faint">No description</span>}
                        </span>
                        <span className="text-xs text-muted">
                          {table.seats > 0 ? `${table.seats} seats` : 'Seats not set'}
                        </span>
                      </div>

                      {/* Occupancy, because it decides whether Retire will work — and
                          because a manager rearranging the floor mid-service should see
                          which tables have people at them. */}
                      {table.documentId !== null && (
                        <Badge tone={table.state === 'bill' ? 'warning' : 'brand'}>
                          {table.state === 'bill' ? 'Bill asked' : 'Open'} ·{' '}
                          {formatMoney(table.totalIncl)}
                        </Badge>
                      )}

                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        aria-label={`Edit table ${table.code}`}
                        disabled={pending}
                        onClick={() => {
                          setEditing(table.id)
                          setAdding(false)
                        }}
                      >
                        <Icons.Pencil size={15} />
                      </Button>

                      {/* Disabled rather than hidden while a bill is open, with the
                          reason in the title: a button that vanishes leaves a manager
                          wondering whether they misremembered where it was. */}
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        aria-label={`Retire table ${table.code}`}
                        title={
                          table.documentId !== null
                            ? 'Settle or clear the bill on this table first'
                            : 'Take this table out of service'
                        }
                        disabled={pending || table.documentId !== null}
                        onClick={() =>
                          startAction(async () => {
                            if (apply(await retireTableAction(table.id))) {
                              toast.success('Table taken out of service.')
                            }
                          })
                        }
                      >
                        <Icons.Trash size={15} />
                      </Button>
                    </li>
                  ),
                )}
              </ul>
            </div>
          ))
        )}
      </Card>
    </div>
  )
}

/** Add or edit, one form. The fields are identical, so two would drift. */
function TableForm({
  table,
  busy,
  onCancel,
  onSave,
}: {
  table?: PosTable
  busy: boolean
  onCancel: () => void
  onSave: (input: { code: string; name: string; section: string; seats: number }) => void
}) {
  const [code, setCode] = useState(table?.code ?? '')
  const [name, setName] = useState(table?.name ?? '')
  const [section, setSection] = useState(table?.section ?? '')
  const [seats, setSeats] = useState(table?.seats ?? 0)

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Table" hint="What the staff call it — 6, B2, Patio 3.">
          <Input
            value={code}
            maxLength={16}
            autoFocus
            disabled={busy}
            onChange={(e) => setCode(e.target.value)}
          />
        </Field>
        <Field label="Area" hint="Optional. Groups the floor.">
          <Input
            value={section}
            maxLength={40}
            placeholder="Patio"
            disabled={busy}
            onChange={(e) => setSection(e.target.value)}
          />
        </Field>
        <Field label="Seats" hint="Optional.">
          <NumberInput
            value={seats}
            min={0}
            max={99}
            disabled={busy}
            /* An event, not a number — NumberInput is an <input> underneath, so it
               reports what was typed rather than a parsed value. Empty becomes 0, which
               is what "not set" stores. */
            onChange={(e) => setSeats(Number(e.target.value) || 0)}
          />
        </Field>
        <Field label="Description" hint="Optional. 'Window', 'Booth'.">
          <Input
            value={name}
            maxLength={60}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
      </div>

      <div className="flex gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={busy || !code.trim()}
          onClick={() => onSave({ code, name, section, seats })}
        >
          {table ? 'Save' : 'Add it'}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

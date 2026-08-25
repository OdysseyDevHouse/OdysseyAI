'use client'

import { useState, useTransition } from 'react'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmModal,
  CurrencyInput,
  DataTable,
  EmptyState,
  Field,
  Icons,
  Input,
  Modal,
  Select,
  Switch,
  useToast,
  type Column,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { DeliveryZone, ZoneInput } from '@/lib/site/onlineStore'
import { deleteZoneAction, saveZoneAction } from './actions'

/**
 * Where the store delivers and what it charges.
 *
 * Matching is on suburb or postal code — plain text an owner can check against
 * what a customer will type. The alternative, a radius from the shop, needs
 * every address geocoded at checkout and an answer for what happens when that
 * fails, so it is left out rather than half-built.
 */

const BLANK: ZoneInput = {
  name: '',
  matchType: 'suburb',
  matchValue: '',
  feeIncl: 0,
  freeOverIncl: 0,
  minOrderIncl: 0,
  isActive: true,
  sortOrder: 0,
}

export default function DeliveryZones({ zones }: { zones: DeliveryZone[] }) {
  const toast = useToast()
  const [saving, startSaving] = useTransition()
  const [editing, setEditing] = useState<ZoneInput | null>(null)
  const [removing, setRemoving] = useState<DeliveryZone | null>(null)

  function save() {
    if (!editing) return
    startSaving(async () => {
      const result = await saveZoneAction(editing)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Delivery area saved.')
      setEditing(null)
    })
  }

  function confirmRemove() {
    if (!removing) return
    startSaving(async () => {
      const result = await deleteZoneAction(removing.id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(`“${removing.name}” removed.`)
      setRemoving(null)
    })
  }

  const columns: Column<DeliveryZone>[] = [
    {
      key: 'name',
      header: 'Area',
      cell: (z) => (
        <div className="min-w-0">
          <span className="block truncate font-medium text-ink">{z.name}</span>
          <span className="text-xs text-muted">
            {z.matchType === 'suburb' ? 'Suburb' : 'Postal code'}: {z.matchValue}
          </span>
        </div>
      ),
      sortValue: (z) => z.name.toLowerCase(),
      sortable: true,
    },
    {
      key: 'fee',
      header: 'Fee',
      numeric: true,
      cell: (z) => formatMoney(z.feeIncl),
      sortValue: (z) => z.feeIncl,
      sortable: true,
      width: 'w-28',
    },
    {
      key: 'freeOver',
      header: 'Free over',
      numeric: true,
      cell: (z) => (z.freeOverIncl > 0 ? formatMoney(z.freeOverIncl) : '—'),
      sortValue: (z) => z.freeOverIncl,
      width: 'w-32',
    },
    {
      key: 'minOrder',
      header: 'Minimum',
      numeric: true,
      cell: (z) => (z.minOrderIncl > 0 ? formatMoney(z.minOrderIncl) : '—'),
      sortValue: (z) => z.minOrderIncl,
      width: 'w-32',
    },
    {
      key: 'active',
      header: 'Status',
      cell: (z) =>
        // Active is the normal case — a green badge on every row would be
        // decoration. Colour goes to the exception: an area switched off.
        z.isActive ? (
          <Badge tone="neutral">On</Badge>
        ) : (
          <Badge tone="warning">Off</Badge>
        ),
      sortValue: (z) => (z.isActive ? 1 : 0),
      width: 'w-24',
    },
  ]

  return (
    <>
      <Card>
        <CardHeader
          title="Delivery areas"
          description="A customer's address has to match one of these, or their order is refused."
          action={
            <Button variant="secondary" size="sm" onClick={() => setEditing({ ...BLANK })}>
              <Icons.Plus size={15} />
              Add area
            </Button>
          }
        />

        {zones.length === 0 ? (
          <EmptyState
            icon={<Icons.Truck size={22} />}
            title="No delivery areas yet"
            hint="Until you add one, every customer who chooses delivery is told you don't deliver to them — even the shop next door."
            action={
              /* secondary: the page's one primary is "Save settings" below. */
              <Button variant="secondary" onClick={() => setEditing({ ...BLANK })}>
                <Icons.Plus size={16} />
                Add your first area
              </Button>
            }
          />
        ) : (
          <DataTable
            columns={columns}
            rows={zones}
            getRowKey={(z) => z.id}
            actions={(z) => (
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label={`Edit ${z.name}`}
                  onClick={() =>
                    setEditing({
                      id: z.id,
                      name: z.name,
                      matchType: z.matchType,
                      matchValue: z.matchValue,
                      feeIncl: z.feeIncl,
                      freeOverIncl: z.freeOverIncl,
                      minOrderIncl: z.minOrderIncl,
                      isActive: z.isActive,
                      sortOrder: z.sortOrder,
                    })
                  }
                >
                  <Icons.Pencil size={15} />
                </Button>
                <Button
                  variant="danger-ghost"
                  size="sm"
                  iconOnly
                  aria-label={`Remove ${z.name}`}
                  disabled={saving}
                  onClick={() => setRemoving(z)}
                >
                  <Icons.Trash size={15} />
                </Button>
              </div>
            )}
          />
        )}
      </Card>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.id ? 'Edit delivery area' : 'Add delivery area'}
        description="Match on the suburb or postal code a customer types at checkout."
        /* A long dialog: the default 60vh cap letterboxed it with empty desktop
           above and below. Still a MAX, so a short one stays short. */
        bodyGrows
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save area'}
            </Button>
          </>
        }
      >
        {editing && (
          <div className="flex flex-col gap-4">
            <Field label="Area name" hint="What you call it — customers never see this.">
              <Input
                value={editing.name}
                placeholder="e.g. Southern suburbs"
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Match on">
                <Select
                  value={editing.matchType}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      matchType: e.target.value as ZoneInput['matchType'],
                    })
                  }
                >
                  <option value="suburb">Suburb</option>
                  <option value="postcode">Postal code</option>
                </Select>
              </Field>

              <Field
                label={editing.matchType === 'suburb' ? 'Suburb' : 'Postal code'}
                hint="One area per value."
              >
                <Input
                  value={editing.matchValue}
                  placeholder={editing.matchType === 'suburb' ? 'e.g. Claremont' : 'e.g. 7708'}
                  onChange={(e) => setEditing({ ...editing, matchValue: e.target.value })}
                />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Delivery fee">
                <CurrencyInput
                  value={editing.feeIncl}
                  onChange={(e) =>
                    setEditing({ ...editing, feeIncl: Number(e.target.value) || 0 })
                  }
                />
              </Field>

              <Field label="Free over" hint="0 for never.">
                <CurrencyInput
                  value={editing.freeOverIncl}
                  onChange={(e) =>
                    setEditing({ ...editing, freeOverIncl: Number(e.target.value) || 0 })
                  }
                />
              </Field>

              <Field label="Minimum order" hint="0 for none.">
                <CurrencyInput
                  value={editing.minOrderIncl}
                  onChange={(e) =>
                    setEditing({ ...editing, minOrderIncl: Number(e.target.value) || 0 })
                  }
                />
              </Field>
            </div>

            <div className="flex items-center justify-between gap-4 rounded-control bg-surface-2 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">Deliver to this area</p>
                <p className="text-sm text-muted">
                  Switch off to stop delivering here without losing the settings.
                </p>
              </div>
              <Switch
                checked={editing.isActive}
                onChange={(next) => setEditing({ ...editing, isActive: next })}
                label="Area active"
              />
            </div>
          </div>
        )}
      </Modal>

      {/* Deleting throws the fees and matching away for good — the reversible
          path is switching the area off — so it has to be answered. */}
      <ConfirmModal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={confirmRemove}
        title="Remove this delivery area"
        message={
          <>
            Customers in <strong>{removing?.name}</strong> will be told you don&apos;t deliver
            to them. To stop deliveries without losing the fees you set up, switch the area off
            instead.
          </>
        }
        confirmLabel="Remove area"
        busy={saving}
      />
    </>
  )
}

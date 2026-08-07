'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmModal,
  EmptyState,
  Field,
  Icons,
  Input,
  Modal,
  NumberInput,
  SettingRow,
  Switch,
  Textarea,
  useToast,
} from '@/components/ui'
import type { StockLocation } from '@/lib/site/stockLocations'
import { saveLocationAction, deleteLocationAction, setMainLocationAction } from './actions'

/**
 * Stock location setup.
 *
 * A wholesaler with three stock rooms holds one product in three piles. This
 * screen is where those rooms are named, and where "main" is decided.
 *
 * MAIN IS THE LOAD-BEARING SETTING: sales come from it, and any receipt that
 * does not name a location lands in it. That is why it gets a badge rather
 * than a checkbox in the edit modal — changing it is a deliberate act with an
 * immediate effect on what the till can sell, not a field to tab past.
 */
export default function LocationsClient({ locations }: { locations: StockLocation[] }) {
  const [editing, setEditing] = useState<StockLocation | null>(null)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<StockLocation | null>(null)
  const [makingMain, setMakingMain] = useState<StockLocation | null>(null)
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  function run(work: () => Promise<{ ok: true; message: string } | { ok: false; error: string }>) {
    startTransition(async () => {
      const result = await work()
      if (result.ok) {
        toast.success(result.message)
        setEditing(null)
        setAdding(false)
        setDeleting(null)
        setMakingMain(null)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <>
      <Card>
        <CardHeader
          title="Locations"
          description="Stock rooms, shelves and vans within this site. Sales always come from the main location."
          action={
            <Button variant="primary" onClick={() => setAdding(true)} disabled={pending}>
              <Icons.Plus size={15} />
              Add location
            </Button>
          }
        />

        {locations.length === 0 ? (
          <EmptyState
            icon={<Icons.Warehouse size={22} />}
            title="No locations yet"
            hint="Add one for each stock room — every product’s stock is counted per location."
            action={
              // Secondary: the header's Add location stays the one primary.
              <Button variant="secondary" onClick={() => setAdding(true)} disabled={pending}>
                <Icons.Plus size={15} />
                Add location
              </Button>
            }
          />
        ) : (
          <div>
            {locations.map((location) => (
              <SettingRow
                key={location.id}
                icon={<Icons.Warehouse size={16} />}
                label={`${location.code} — ${location.name}`}
                description={describe(location)}
              >
                <div className="flex items-center gap-1.5">
                  {location.isMain && <Badge tone="success">Main</Badge>}
                  {!location.isActive && <Badge tone="neutral">Off</Badge>}

                  {!location.isMain && location.isActive && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={pending}
                      onClick={() => setMakingMain(location)}
                    >
                      <Icons.Check size={15} />
                      Make main
                    </Button>
                  )}

                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    aria-label={`Edit ${location.name}`}
                    onClick={() => setEditing(location)}
                  >
                    <Icons.Pencil size={15} />
                  </Button>
                  <Button
                    variant="danger-ghost"
                    size="sm"
                    iconOnly
                    aria-label={`Delete ${location.name}`}
                    disabled={pending || location.isMain}
                    onClick={() => setDeleting(location)}
                  >
                    <Icons.Trash size={15} />
                  </Button>
                </div>
              </SettingRow>
            ))}
          </div>
        )}
      </Card>

      <LocationModal
        location={adding ? null : editing}
        open={adding || editing !== null}
        pending={pending}
        onClose={() => {
          setAdding(false)
          setEditing(null)
        }}
        onSave={(input) => run(() => saveLocationAction(editing?.id ?? null, input))}
      />

      <ConfirmModal
        open={makingMain !== null}
        onClose={() => setMakingMain(null)}
        onConfirm={() => makingMain && run(() => setMainLocationAction(makingMain.id))}
        title={`Make ${makingMain?.name} the main location?`}
        message="Sales will come from this location from now on, and anything received without a location will land here. No stock is moved — the piles stay exactly where they are, so what the till can sell will change immediately."
        confirmLabel="Make main"
        busy={pending}
      />

      <ConfirmModal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && run(() => deleteLocationAction(deleting.id))}
        title={`Delete ${deleting?.name}?`}
        message="A location with stock movements against it cannot be deleted — that history has to keep saying where the goods were. Deactivate it instead."
        confirmLabel="Delete location"
        busy={pending}
      />
    </>
  )
}

function describe(location: StockLocation): string {
  const parts: string[] = []
  if (location.isMain) parts.push('sales come from here')
  if (location.address) parts.push(location.address)
  if (location.productCount > 0) {
    parts.push(
      `holds stock on ${location.productCount} product${location.productCount === 1 ? '' : 's'}`,
    )
  }
  if (location.movementCount > 0) {
    parts.push(
      `${location.movementCount} movement${location.movementCount === 1 ? '' : 's'}`,
    )
  }
  if (parts.length === 0) parts.push('empty')
  return parts.join(' · ')
}

function LocationModal({
  location,
  open,
  pending,
  onClose,
  onSave,
}: {
  location: StockLocation | null
  open: boolean
  pending: boolean
  onClose: () => void
  onSave: (input: {
    code: string
    name: string
    address: string | null
    note: string | null
    isActive: boolean
    sortOrder: number
  }) => void
}) {
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [note, setNote] = useState('')
  const [isActive, setIsActive] = useState(true)
  const [sortOrder, setSortOrder] = useState(0)
  const [seeded, setSeeded] = useState<number | null>(null)

  // Seeds the fields the first time the modal opens for a given record, and
  // resets when it closes — the same pattern the till setup modal uses, so a
  // reopened form never shows the previous location's values.
  if (open && seeded !== (location?.id ?? 0)) {
    setSeeded(location?.id ?? 0)
    setCode(location?.code ?? '')
    setName(location?.name ?? '')
    setAddress(location?.address ?? '')
    setNote(location?.note ?? '')
    setIsActive(location?.isActive ?? true)
    setSortOrder(location?.sortOrder ?? 0)
  }
  if (!open && seeded !== null) setSeeded(null)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={location ? `Edit ${location.name}` : 'Add a location'}
      size="sm"
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={pending}
            onClick={() =>
              onSave({
                code,
                name,
                address: address || null,
                note: note || null,
                isActive,
                sortOrder,
              })
            }
          >
            {pending ? 'Saving…' : location ? 'Save changes' : 'Add location'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Code" hint="Short handle for picking slips and reports. e.g. WH, SHOP, VAN2">
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            maxLength={24}
          />
        </Field>
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Back warehouse"
            maxLength={120}
          />
        </Field>
        <Field label="Address" hint="Optional — where it is, for a picking slip.">
          <Input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={190} />
        </Field>
        <Field label="Note" hint="Optional.">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={190} rows={2} />
        </Field>
        <Field label="Sort order" hint="Lower numbers appear first in lists.">
          {/* Narrow on purpose: a full-width box for a 1–2 digit number tells
              the user the wrong thing about what belongs in it. */}
          <div className="w-28">
            <NumberInput
              value={sortOrder}
              onChange={(e) => setSortOrder(Number(e.target.value) || 0)}
            />
          </div>
        </Field>

        {location?.isMain ? (
          // The main location cannot be switched off — every sale and every
          // unallocated receipt points at it. Saying so beats a control that
          // silently refuses on save.
          <p className="text-sm text-muted">
            This is the main location, so it cannot be deactivated. Make another location the main
            one first.
          </p>
        ) : (
          <Switch
            checked={isActive}
            onChange={setIsActive}
            label="Active"
            hint="A deactivated location is hidden from new work. Stock already in it stays counted."
          />
        )}
      </div>
    </Modal>
  )
}

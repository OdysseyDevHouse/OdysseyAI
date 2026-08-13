'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmModal,
  EmptyState,
  Field,
  Icons,
  Input,
  Modal,
  SegmentedControl,
  Textarea,
  useToast,
} from '@/components/ui'
import type { CustomerAddress, AddressKind } from '@/lib/site/customerAddresses'
import { saveCustomerAddressAction, deleteCustomerAddressAction } from '../actions'

/**
 * The customer's address book: extra billing addresses and every delivery
 * address. The PRIMARY billing address lives on the details tab — shown here
 * read-only so the book reads complete, edited where it always was.
 */
export function AddressesPanel({
  customerId,
  primaryBilling,
  addresses,
}: {
  customerId: number
  /** The customer's own billing columns, formatted. Empty when blank. */
  primaryBilling: string
  addresses: CustomerAddress[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [editing, setEditing] = useState<CustomerAddress | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<CustomerAddress | null>(null)

  function run(action: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    startTransition(async () => {
      const result = await action()
      if (result.ok) {
        toast.success(result.message ?? 'Saved.')
        router.refresh()
      } else {
        toast.error(result.error ?? 'That did not work.')
      }
    })
  }

  const billing = addresses.filter((a) => a.kind === 'billing')
  const delivery = addresses.filter((a) => a.kind === 'delivery')

  const line = (a: CustomerAddress) =>
    [a.line1, a.line2, a.city, a.province, a.postalCode].filter(Boolean).join(', ')

  const AddressRow = ({ a }: { a: CustomerAddress }) => (
    <li className="flex items-start justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm text-ink">{a.label}</span>
          {a.isDefault && <Badge tone="brand">Default</Badge>}
          {!a.isActive && <Badge>Retired</Badge>}
        </div>
        <p className="mt-0.5 text-sm text-muted">{line(a) || 'No address lines yet'}</p>
        {a.notes && <p className="mt-0.5 text-xs text-faint">{a.notes}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={`Edit ${a.label}`}
          onClick={() => setEditing(a)}
        >
          <Icons.Pencil size={15} />
        </Button>
        <Button
          variant="danger-ghost"
          size="sm"
          iconOnly
          aria-label={`Remove ${a.label}`}
          disabled={pending}
          onClick={() => setDeleting(a)}
        >
          <Icons.Trash size={15} />
        </Button>
      </div>
    </li>
  )

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader
          title="Billing"
          description="Where invoices and statements go. The main one lives on the details tab."
        />
        <CardBody>
          <div className="rounded-control bg-surface-2 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className="text-sm text-ink">Account address</span>
              <Badge>Primary</Badge>
            </div>
            <p className="mt-0.5 text-sm text-muted">
              {primaryBilling || 'None captured — add it on the details tab.'}
            </p>
          </div>
          {billing.length > 0 && (
            <ul className="mt-2 divide-y divide-border">
              {billing.map((a) => (
                <AddressRow key={a.id} a={a} />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Delivery"
          description="Where the goods go. The default prefills orders and the online checkout."
          action={
            <Button size="sm" onClick={() => setCreating(true)}>
              <Icons.Plus size={15} />
              Add address
            </Button>
          }
        />
        <CardBody>
          {delivery.length === 0 ? (
            <EmptyState
              title="No delivery addresses yet"
              hint="Orders fall back to the billing address until one is added."
              action={
                <Button variant="secondary" onClick={() => setCreating(true)}>
                  <Icons.Plus size={15} />
                  Add one
                </Button>
              }
            />
          ) : (
            <ul className="divide-y divide-border">
              {delivery.map((a) => (
                <AddressRow key={a.id} a={a} />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {(creating || editing) && (
        <AddressEditor
          address={editing}
          pending={pending}
          onClose={() => {
            setCreating(false)
            setEditing(null)
          }}
          onSave={(input, id) => {
            setCreating(false)
            setEditing(null)
            run(() => saveCustomerAddressAction(customerId, input, id))
          }}
        />
      )}

      <ConfirmModal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Remove this address?"
        tone="danger"
        confirmLabel="Remove"
        onConfirm={() => {
          const a = deleting
          setDeleting(null)
          if (a) run(() => deleteCustomerAddressAction(customerId, a.id))
        }}
        message={
          deleting
            ? `${deleting.label} comes out of the book. Documents that already used it keep the address they printed.`
            : ''
        }
      />
    </div>
  )
}

function AddressEditor({
  address,
  pending,
  onClose,
  onSave,
}: {
  address: CustomerAddress | null
  pending: boolean
  onClose: () => void
  onSave: (
    input: {
      kind: AddressKind
      label: string
      line1: string
      line2: string
      city: string
      postalCode: string
      province: string
      notes: string
      isDefault: boolean
    },
    id?: number,
  ) => void
}) {
  const [kind, setKind] = useState<AddressKind>(address?.kind ?? 'delivery')
  const [label, setLabel] = useState(address?.label ?? '')
  const [line1, setLine1] = useState(address?.line1 ?? '')
  const [line2, setLine2] = useState(address?.line2 ?? '')
  const [city, setCity] = useState(address?.city ?? '')
  const [postalCode, setPostalCode] = useState(address?.postalCode ?? '')
  const [province, setProvince] = useState(address?.province ?? '')
  const [notes, setNotes] = useState(address?.notes ?? '')
  const [isDefault, setIsDefault] = useState(address?.isDefault ?? false)

  return (
    <Modal open onClose={onClose} title={address ? `Edit ${address.label}` : 'New address'}>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Used for">
            <SegmentedControl
              aria-label="Address kind"
              options={[
                { value: 'delivery', label: 'Delivery' },
                { value: 'billing', label: 'Billing' },
              ]}
              value={kind}
              onChange={setKind}
            />
          </Field>
          <Field label="Name" hint="How the picker calls it.">
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Warehouse"
            />
          </Field>
        </div>

        <Field label="Address">
          <Input value={line1} onChange={(e) => setLine1(e.target.value)} placeholder="Street" />
        </Field>
        <Input
          aria-label="Address line 2"
          value={line2}
          onChange={(e) => setLine2(e.target.value)}
          placeholder="Suburb or complex (optional)"
        />

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="City">
            <Input value={city} onChange={(e) => setCity(e.target.value)} />
          </Field>
          <Field label="Province">
            <Input value={province} onChange={(e) => setProvince(e.target.value)} />
          </Field>
          <Field label="Postal code">
            <Input value={postalCode} onChange={(e) => setPostalCode(e.target.value)} />
          </Field>
        </div>

        <Field label="Notes" hint="Optional — gate codes, delivery instructions.">
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        <Field label={`Default ${kind} address`} hint="What orders and the checkout offer first.">
          <SegmentedControl
            aria-label="Default"
            options={[
              { value: 'no', label: 'No' },
              { value: 'yes', label: 'Make it the default' },
            ]}
            value={isDefault ? 'yes' : 'no'}
            onChange={(v) => setIsDefault(v === 'yes')}
          />
        </Field>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={pending || !label.trim()}
            onClick={() =>
              onSave(
                {
                  kind,
                  label: label.trim(),
                  line1: line1.trim(),
                  line2: line2.trim(),
                  city: city.trim(),
                  postalCode: postalCode.trim(),
                  province: province.trim(),
                  notes: notes.trim(),
                  isDefault,
                },
                address?.id,
              )
            }
          >
            <Icons.Save size={15} />
            {address ? 'Save address' : 'Add address'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

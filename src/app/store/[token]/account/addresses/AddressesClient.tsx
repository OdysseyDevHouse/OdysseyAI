'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Badge, Button, Card, Field, Icons, Input, Textarea, useToast } from '@/components/ui'
import { saveAddressAction, deleteAddressAction } from './actions'

type AddressRow = {
  id: number
  label: string
  line1: string
  line2: string
  city: string
  postalCode: string
  notes: string
  isDefault: boolean
}

const EMPTY: Omit<AddressRow, 'id' | 'isDefault'> & { isDefault: boolean } = {
  label: '',
  line1: '',
  line2: '',
  city: '',
  postalCode: '',
  notes: '',
  isDefault: false,
}

export default function AddressesClient({
  token,
  addresses,
}: {
  token: string
  addresses: AddressRow[]
}) {
  const toast = useToast()
  const router = useRouter()
  const [busy, start] = useTransition()
  const [editing, setEditing] = useState<AddressRow | 'new' | null>(
    addresses.length === 0 ? 'new' : null,
  )
  const [form, setForm] = useState(EMPTY)

  function open(target: AddressRow | 'new') {
    setEditing(target)
    setForm(target === 'new' ? EMPTY : { ...target })
  }

  function save() {
    start(async () => {
      const result = await saveAddressAction(
        token,
        {
          label: form.label,
          line1: form.line1 || null,
          line2: form.line2 || null,
          city: form.city || null,
          postalCode: form.postalCode || null,
          notes: form.notes || null,
          isDefault: form.isDefault,
        },
        editing === 'new' || editing === null ? undefined : editing.id,
      )
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Address saved.')
      setEditing(null)
      router.refresh()
    })
  }

  function remove(id: number) {
    start(async () => {
      const result = await deleteAddressAction(token, id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Address removed.')
      setEditing(null)
      router.refresh()
    })
  }

  return (
    <div className="flex flex-col gap-3">
      {addresses.map((address) => (
        <Card key={address.id}>
          <div className="flex flex-wrap items-center gap-3 p-4">
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="text-sm font-medium text-ink">{address.label}</span>
                {address.isDefault && <Badge tone="brand">Default</Badge>}
              </span>
              <span className="block text-xs text-muted">
                {[address.line1, address.line2, address.city, address.postalCode]
                  .filter(Boolean)
                  .join(', ')}
              </span>
            </span>
            <Button variant="ghost" size="sm" onClick={() => open(address)}>
              Edit
            </Button>
          </div>
        </Card>
      ))}

      {editing === null ? (
        <div>
          <Button variant="secondary" onClick={() => open('new')}>
            <Icons.Plus size={15} />
            Add an address
          </Button>
        </div>
      ) : (
        <Card>
          <div className="flex flex-col gap-3 p-4">
            <h2 className="text-base font-semibold text-ink">
              {editing === 'new' ? 'New address' : `Edit ${editing.label}`}
            </h2>
            <Field label="Name" hint="e.g. Home, Office, The farm gate">
              <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
            </Field>
            <Field label="Street address">
              <Input value={form.line1} onChange={(e) => setForm({ ...form, line1: e.target.value })} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Suburb">
                <Input value={form.line2} onChange={(e) => setForm({ ...form, line2: e.target.value })} />
              </Field>
              <Field label="City">
                <Input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
              </Field>
              <Field label="Postal code">
                <Input
                  value={form.postalCode}
                  onChange={(e) => setForm({ ...form, postalCode: e.target.value })}
                />
              </Field>
            </div>
            <Field label="Delivery notes" hint="Gate codes, which entrance, who to call.">
              <Textarea
                value={form.notes}
                rows={2}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </Field>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                className="size-4 cursor-pointer"
                checked={form.isDefault}
                onChange={(e) => setForm({ ...form, isDefault: e.target.checked })}
              />
              Use this one by default
            </label>

            <div className="flex flex-wrap justify-end gap-2">
              {editing !== 'new' && (
                <Button variant="danger-ghost" disabled={busy} onClick={() => remove(editing.id)}>
                  Remove
                </Button>
              )}
              <Button variant="secondary" disabled={busy} onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy || !form.label.trim()} onClick={save}>
                {busy ? 'Saving…' : 'Save address'}
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  )
}

'use client'

import { useState, useTransition } from 'react'
import {
  Button,
  Card,
  CardHeader,
  CardBody,
  DataTable,
  Modal,
  ConfirmModal,
  Field,
  Input,
  NumberInput,
  CurrencyInput,
  Select,
  Switch,
  Badge,
  Callout,
  EmptyState,
  useToast,
  Icons,
  type Column,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { LoyaltyCard } from '@/lib/loyaltyRules'
import { saveCardAction, setCardActiveAction, deleteCardAction } from '../actions'

export type DepartmentOption = { id: number; name: string }
export type ProductOption = { id: number; code: string; description: string }

type Draft = {
  name: string
  isActive: boolean
  requiredStamps: number
  rewardType: LoyaltyCard['rewardType']
  rewardProductId: number | null
  rewardValue: number
  oneStampPerSale: boolean
  minLineAmount: number
  voucherValidDays: number
  startsOn: string | null
  endsOn: string | null
  productIds: number[]
  departmentIds: number[]
}

const BLANK: Draft = {
  name: '',
  isActive: true,
  requiredStamps: 10,
  rewardType: 'value',
  rewardProductId: null,
  rewardValue: 50,
  oneStampPerSale: true,
  minLineAmount: 0,
  voucherValidDays: 60,
  startsOn: null,
  endsOn: null,
  productIds: [],
  departmentIds: [],
}

export function CardsClient({
  cards,
  departments,
  products,
  canEdit,
}: {
  cards: LoyaltyCard[]
  departments: DepartmentOption[]
  products: ProductOption[]
  canEdit: boolean
}) {
  const toast = useToast()
  const [pending, start] = useTransition()
  const [editingId, setEditingId] = useState<number | null>(null)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<Draft>(BLANK)
  const [deleting, setDeleting] = useState<LoyaltyCard | null>(null)

  const patch = (over: Partial<Draft>) => setForm((f) => ({ ...f, ...over }))

  function edit(card: LoyaltyCard | null) {
    if (card) {
      setEditingId(card.id)
      setForm({
        name: card.name,
        isActive: card.isActive,
        requiredStamps: card.requiredStamps,
        rewardType: card.rewardType,
        rewardProductId: card.rewardProductId,
        rewardValue: card.rewardValue,
        oneStampPerSale: card.oneStampPerSale,
        minLineAmount: card.minLineAmount,
        voucherValidDays: card.voucherValidDays,
        startsOn: card.startsOn,
        endsOn: card.endsOn,
        productIds: card.productIds,
        departmentIds: card.departmentIds,
      })
    } else {
      setEditingId(null)
      setForm(BLANK)
    }
    setOpen(true)
  }

  function save() {
    start(async () => {
      const result = await saveCardAction(editingId, form)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
      setOpen(false)
    })
  }

  function toggle(card: LoyaltyCard) {
    start(async () => {
      const result = await setCardActiveAction(card.id, !card.isActive)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
    })
  }

  function confirmDelete() {
    if (!deleting) return
    start(async () => {
      const result = await deleteCardAction(deleting.id)
      if (!result.ok) {
        toast.error(result.error)
        setDeleting(null)
        return
      }
      toast.success(result.message)
      setDeleting(null)
    })
  }

  function rewardOf(card: LoyaltyCard): string {
    if (card.rewardType === 'free_item') return card.rewardProductName ?? 'A free product'
    if (card.rewardType === 'points') return `${card.rewardValue} bonus points`
    return `${formatMoney(card.rewardValue)} voucher`
  }

  function scopeOf(card: LoyaltyCard): string {
    if (card.productIds.length === 0 && card.departmentIds.length === 0) return 'Anything in the shop'
    const bits: string[] = []
    if (card.productIds.length > 0) {
      bits.push(`${card.productIds.length} product${card.productIds.length === 1 ? '' : 's'}`)
    }
    if (card.departmentIds.length > 0) {
      const names = card.departmentIds
        .map((id) => departments.find((d) => d.id === id)?.name)
        .filter(Boolean)
      bits.push(names.length > 0 ? names.join(', ') : `${card.departmentIds.length} departments`)
    }
    return bits.join(' · ')
  }

  const columns: Column<LoyaltyCard>[] = [
    {
      key: 'name',
      header: 'Card',
      cell: (card) => (
        <div>
          <div className="font-medium text-ink">{card.name}</div>
          <div className="text-xs text-muted">{scopeOf(card)}</div>
        </div>
      ),
      sortValue: (card) => card.name,
    },
    {
      key: 'stamps',
      header: 'Stamps',
      numeric: true,
      cell: (card) => card.requiredStamps,
      sortValue: (card) => card.requiredStamps,
    },
    {
      key: 'reward',
      header: 'Reward',
      cell: (card) => rewardOf(card),
      sortValue: (card) => card.rewardValue,
    },
    {
      key: 'rule',
      header: 'Stamping',
      cell: (card) => (card.oneStampPerSale ? 'One per sale' : 'One per item'),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (card) =>
        card.isActive ? <Badge tone="success">Running</Badge> : <Badge tone="neutral">Stopped</Badge>,
      sortValue: (card) => (card.isActive ? 1 : 0),
    },
  ]

  return (
    <>
      <Card>
        <CardHeader
          title="Punch cards"
          description="Buy ten, get one free — and anything shaped like it."
          action={
            canEdit ? (
              <Button variant="primary" size="sm" onClick={() => edit(null)}>
                <Icons.Plus size={16} />
                New card
              </Button>
            ) : undefined
          }
        />
        <CardBody>
          {cards.length === 0 ? (
            <EmptyState
              icon={<Icons.Stamp />}
              title="No punch cards yet"
              hint="A punch card rewards a habit rather than a basket size — a free coffee after ten, a free wash after five."
              action={
                canEdit ? (
                  <Button variant="primary" onClick={() => edit(null)}>
                    Create the first card
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <DataTable
              columns={columns}
              rows={cards}
              getRowKey={(card) => card.id}
              actions={
                canEdit
                  ? (card) => (
                      <>
                        <Button variant="ghost" size="sm" onClick={() => edit(card)}>
                          Edit
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => toggle(card)}>
                          {card.isActive ? 'Stop' : 'Start'}
                        </Button>
                        <Button variant="danger-ghost" size="sm" onClick={() => setDeleting(card)}>
                          Delete
                        </Button>
                      </>
                    )
                  : undefined
              }
            />
          )}
        </CardBody>
      </Card>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editingId ? 'Edit punch card' : 'New punch card'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save} disabled={pending}>
              {pending ? 'Saving…' : 'Save card'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="What the card is called" hint="Customers see this on their slip.">
            <Input
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
              maxLength={100}
              placeholder="Coffee card"
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Stamps to complete">
              <NumberInput
                value={form.requiredStamps}
                onChange={(e) => patch({ requiredStamps: Number(e.target.value) })}
                min={1}
                max={100}
              />
            </Field>

            <Field
              label="Least a line must be worth"
              hint="Zero counts anything."
            >
              <CurrencyInput
                value={form.minLineAmount}
                onChange={(e) => patch({ minLineAmount: Number(e.target.value) })}
              />
            </Field>
          </div>

          <Switch
            label="One stamp per sale"
            hint="On is the usual coffee-card rule: a trolley of ten earns one stamp, not a finished card."
            checked={form.oneStampPerSale}
            onChange={(oneStampPerSale) => patch({ oneStampPerSale })}
          />

          <Field label="What completing it gives">
            <Select
              value={form.rewardType}
              onChange={(e) => patch({ rewardType: e.target.value as Draft['rewardType'] })}
            >
              <option value="value">A rand-value voucher</option>
              <option value="free_item">A free product</option>
              <option value="points">Bonus points</option>
            </Select>
          </Field>

          {form.rewardType === 'free_item' ? (
            <Field label="The free product">
              <Select
                value={form.rewardProductId ?? ''}
                onChange={(e) =>
                  patch({ rewardProductId: e.target.value ? Number(e.target.value) : null })
                }
              >
                <option value="">Choose a product…</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} — {p.description}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label={form.rewardType === 'points' ? 'Bonus points' : 'Voucher value'}>
              {form.rewardType === 'points' ? (
                <NumberInput
                  value={form.rewardValue}
                  onChange={(e) => patch({ rewardValue: Number(e.target.value) })}
                  min={1}
                />
              ) : (
                <CurrencyInput
                  value={form.rewardValue}
                  onChange={(e) => patch({ rewardValue: Number(e.target.value) })}
                />
              )}
            </Field>
          )}

          {form.rewardType !== 'points' && (
            <Field
              label="Voucher lasts, in days"
              hint="Zero means it never expires."
            >
              <NumberInput
                value={form.voucherValidDays}
                onChange={(e) => patch({ voucherValidDays: Number(e.target.value) })}
                min={0}
                max={3650}
              />
            </Field>
          )}

          <Field
            label="Departments that earn a stamp"
            hint="Leave everything unticked and the card earns on anything in the shop."
          >
            <div className="max-h-40 space-y-2 overflow-y-auto rounded-control border border-border p-3">
              {departments.length === 0 ? (
                <p className="text-sm text-muted">No departments yet.</p>
              ) : (
                departments.map((dept) => (
                  <Switch
                    key={dept.id}
                    label={dept.name}
                    checked={form.departmentIds.includes(dept.id)}
                    onChange={(on) =>
                      patch({
                        departmentIds: on
                          ? [...form.departmentIds, dept.id]
                          : form.departmentIds.filter((id) => id !== dept.id),
                      })
                    }
                  />
                ))
              )}
            </div>
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Runs from" hint="Leave blank to start now.">
              <Input
                type="date"
                value={form.startsOn ?? ''}
                onChange={(e) => patch({ startsOn: e.target.value || null })}
              />
            </Field>
            <Field label="Runs until" hint="Leave blank for no end.">
              <Input
                type="date"
                value={form.endsOn ?? ''}
                onChange={(e) => patch({ endsOn: e.target.value || null })}
              />
            </Field>
          </div>

          <Switch
            label="Card is running"
            checked={form.isActive}
            onChange={(isActive) => patch({ isActive })}
          />
        </div>
      </Modal>

      <ConfirmModal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        title={`Delete ${deleting?.name ?? 'this card'}?`}
        confirmLabel="Delete card"
        tone="danger"
        busy={pending}
        message="A card that customers have already collected stamps on cannot be deleted — stop it instead, so nobody loses progress they were promised."
      />
    </>
  )
}

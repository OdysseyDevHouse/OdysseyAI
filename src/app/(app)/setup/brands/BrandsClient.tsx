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
  DataTable,
  Field,
  Icons,
  Input,
  Modal,
  Switch,
  useToast,
  type Column,
} from '@/components/ui'
import type { Brand } from '@/lib/site/brands'
import { saveBrandAction, setBrandActiveAction, deleteBrandAction } from './actions'

/**
 * Maintaining the brand list.
 *
 * ── DEACTIVATE, DON'T DELETE ─────────────────────────────────────────────
 *
 * `fk_product_brand` is ON DELETE SET NULL, so deleting a brand that products
 * carry would succeed and silently strip the brand off every one of them, with
 * no undo. deleteBrand() refuses in that case and names the count; this screen
 * offers the switch as the way out. An inactive brand keeps every product's
 * brand_id intact and simply stops being offered on new ones — which is what
 * "we stopped stocking this" actually means.
 *
 * ── RENAMING IS GLOBAL, AND THE SCREEN SAYS SO ───────────────────────────
 *
 * There is one row per brand and every product points at it, so a rename here
 * is a rename everywhere — including on any report that groups by brand. That
 * is usually what someone wants (a misspelling), but it is not what "edit"
 * implies on a screen full of rows, so the dialog's hint names the number of
 * products it is about to change.
 */

type Draft = { name: string; isActive: boolean }

const BLANK: Draft = { name: '', isActive: true }

export default function BrandsClient({ brands }: { brands: Brand[] }) {
  const [editing, setEditing] = useState<Brand | null>(null)
  const [draft, setDraft] = useState<Draft>(BLANK)
  const [open, setOpen] = useState(false)
  const [removing, setRemoving] = useState<Brand | null>(null)
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  function openNew() {
    setEditing(null)
    setDraft(BLANK)
    setOpen(true)
  }

  function openEdit(brand: Brand) {
    setEditing(brand)
    setDraft({ name: brand.name, isActive: brand.isActive })
    setOpen(true)
  }

  function save() {
    startTransition(async () => {
      const result = await saveBrandAction(
        { name: draft.name, isActive: draft.isActive },
        editing?.id,
      )
      if (!result.ok) {
        // The clash message names the brand already holding the name, so it is
        // shown as-is rather than replaced with a generic failure.
        toast.error(result.error)
        return
      }
      toast.success(editing ? `${draft.name.trim()} updated.` : `${draft.name.trim()} added.`)
      setOpen(false)
      router.refresh()
    })
  }

  /* The switch on the row, so deactivating does not need the dialog opened.
     It is the offered alternative to a refused delete, and making somebody open
     an editor to reach it would put a step in front of the way out. */
  function toggleActive(brand: Brand, next: boolean) {
    startTransition(async () => {
      const result = await setBrandActiveAction(brand.id, next)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(`${brand.name} ${next ? 'activated' : 'deactivated'}.`)
      router.refresh()
    })
  }

  function remove() {
    if (!removing) return
    const target = removing
    startTransition(async () => {
      const result = await deleteBrandAction(target.id)
      if (!result.ok) {
        // The refusal names the product count and what to do instead.
        toast.error(result.error)
        setRemoving(null)
        return
      }
      toast.success(`${target.name} deleted.`)
      setRemoving(null)
      router.refresh()
    })
  }

  const columns: Column<Brand>[] = [
    {
      key: 'name',
      header: 'Brand',
      cell: (b) => <span className="text-ink">{b.name}</span>,
      sortValue: (b) => b.name,
    },
    {
      key: 'products',
      header: 'Products',
      numeric: true,
      /* The count is the whole reason a delete gets refused, so it sits on the
         row rather than only inside the error that refuses it. */
      cell: (b) => (b.productCount > 0 ? b.productCount : <span className="text-muted">—</span>),
      sortValue: (b) => b.productCount,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (b) =>
        b.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Inactive</Badge>,
      sortValue: (b) => (b.isActive ? 1 : 0),
    },
    {
      key: 'active',
      header: 'Offered',
      /* stopPropagation: the row opens the editor on click, and without this a
         flick of the switch would open the dialog on top of the change. */
      cell: (b) => (
        <div onClick={(e) => e.stopPropagation()}>
          <Switch
            checked={b.isActive}
            onChange={(next) => toggleActive(b, next)}
            disabled={pending}
            ariaLabel={`${b.isActive ? 'Deactivate' : 'Activate'} ${b.name}`}
          />
        </div>
      ),
    },
  ]

  return (
    <>
      <Card>
        <CardHeader
          title="Brands"
          description="A brand is offered on the product form while it is active. Deactivating one leaves it on every product that already carries it and simply stops it being chosen on new ones — which is what to do when you stop stocking a range. Deleting is only possible once nothing carries it."
          action={
            <Button variant="primary" size="sm" onClick={openNew}>
              <Icons.Plus size={15} />
              Add a brand
            </Button>
          }
        />
        <DataTable
          columns={columns}
          rows={brands}
          getRowKey={(b) => b.id}
          onRowClick={openEdit}
          actions={(b) => (
            <Button
              variant="danger-ghost"
              size="sm"
              onClick={() => setRemoving(b)}
              aria-label={`Remove ${b.name}`}
            >
              <Icons.Trash size={15} />
            </Button>
          )}
          empty={{
            title: 'No brands yet',
            hint: 'A brand groups products by who makes them, so you can filter the catalogue, scope a commission rule or a stock take to one, and reprice a whole range at once. Products work without one — add these only where the maker is something you actually sort or report by.',
            icon: <Icons.Tag size={22} />,
          }}
        />
      </Card>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? `Edit ${editing.name}` : 'New brand'}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save} disabled={pending || !draft.name.trim()}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        <CardBody className="grid gap-4 px-0 py-0">
          <Field
            label="Name"
            hint={
              editing && editing.productCount > 0
                ? `Renaming changes this on all ${editing.productCount} product${
                    editing.productCount === 1 ? '' : 's'
                  } that carry it.`
                : 'What the picker on a product shows.'
            }
          >
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              maxLength={120}
              placeholder="Coca-Cola"
            />
          </Field>
          <Switch
            checked={draft.isActive}
            onChange={(next) => setDraft({ ...draft, isActive: next })}
            label="Offered on new products"
            hint="Turning this off leaves the brand on products that already carry it."
          />
        </CardBody>
      </Modal>

      <ConfirmModal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={remove}
        title={removing ? `Delete ${removing.name}?` : 'Delete brand?'}
        message="This cannot be undone. A brand that any product still carries cannot be deleted — deactivate it instead."
        confirmLabel="Delete"
        tone="danger"
        busy={pending}
      />
    </>
  )
}

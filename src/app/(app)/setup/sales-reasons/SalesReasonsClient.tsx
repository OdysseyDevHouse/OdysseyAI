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
  NumberInput,
  Switch,
  Tabs,
  useToast,
  type Column,
  type TabItem,
} from '@/components/ui'
import type { ReasonKind, SalesReason } from '@/lib/site/salesReasons'
import { deleteSalesReasonAction, saveSalesReasonAction } from './actions'

const TABS: readonly TabItem<ReasonKind>[] = [
  { value: 'void', label: 'Voids' },
  { value: 'return', label: 'Returns' },
]

/** What each list is FOR, said where a manager is deciding what to add to it. */
const BLURB: Record<ReasonKind, string> = {
  void: 'Why a sale was cancelled at the till. These are mistakes and abandoned sales — nothing to do with goods coming back.',
  return:
    'Why goods came back. These are what a returns report groups by, and what tells you whether you have a supplier problem or a sizing problem.',
}

const EMPTY_HINT: Record<ReasonKind, string> = {
  void: 'A cashier must pick one of these to cancel a sale. Add the ones this shop actually uses — rang up twice, customer changed their mind.',
  return:
    'Whoever takes a return must pick one of these. Add the ones this shop actually uses — faulty, wrong size, changed their mind.',
}

type Draft = {
  code: string
  name: string
  allowsNote: boolean
  restocks: boolean
  isActive: boolean
  sortOrder: number
}

const BLANK: Draft = {
  code: '',
  name: '',
  allowsNote: true,
  restocks: true,
  isActive: true,
  sortOrder: 0,
}

/**
 * Maintaining the reasons a sale is voided and the reasons goods come back.
 *
 * Two lists on one screen because they are one job — a manager setting up a shop
 * does both in the same sitting — but they are genuinely separate lists, and the
 * tab makes that visible rather than merging vocabularies that do not overlap.
 *
 * A reason that has been used is retired rather than deleted: the documents
 * naming it have to keep reading correctly, the same rule an adjustment reason
 * and a location both follow.
 */
export default function SalesReasonsClient({
  voidReasons,
  returnReasons,
}: {
  voidReasons: SalesReason[]
  returnReasons: SalesReason[]
}) {
  const [kind, setKind] = useState<ReasonKind>('void')
  const [editing, setEditing] = useState<SalesReason | null>(null)
  const [draft, setDraft] = useState<Draft>(BLANK)
  const [open, setOpen] = useState(false)
  const [removing, setRemoving] = useState<SalesReason | null>(null)
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  const reasons = kind === 'void' ? voidReasons : returnReasons
  const isReturns = kind === 'return'

  function openNew() {
    setEditing(null)
    // A new reason lands at the bottom rather than fighting for position 0.
    setDraft({ ...BLANK, sortOrder: (reasons.at(-1)?.sortOrder ?? 0) + 10 })
    setOpen(true)
  }

  function openEdit(reason: SalesReason) {
    setEditing(reason)
    setDraft({
      code: reason.code,
      name: reason.name,
      allowsNote: reason.allowsNote,
      restocks: reason.restocks,
      isActive: reason.isActive,
      sortOrder: reason.sortOrder,
    })
    setOpen(true)
  }

  function save() {
    startTransition(async () => {
      const result = await saveSalesReasonAction(kind, draft, editing?.id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(editing ? 'Reason updated.' : 'Reason added.')
      setOpen(false)
      router.refresh()
    })
  }

  function remove() {
    if (!removing) return
    const target = removing
    startTransition(async () => {
      const result = await deleteSalesReasonAction(kind, target.id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(
        result.retired
          ? `${target.name} retired — the documents that used it still read correctly.`
          : `${target.name} deleted.`,
      )
      setRemoving(null)
      router.refresh()
    })
  }

  const columns: Column<SalesReason>[] = [
    {
      key: 'code',
      header: 'Code',
      cell: (r) => <span className="text-ink">{r.code}</span>,
      sortValue: (r) => r.code,
    },
    {
      key: 'name',
      header: 'Name',
      cell: (r) => <span className="text-ink-2">{r.name}</span>,
      sortValue: (r) => r.name,
    },
    ...(isReturns
      ? [
          {
            key: 'restocks',
            header: 'Stock',
            cell: (r: SalesReason) =>
              r.restocks ? (
                <Badge tone="success">Sellable again</Badge>
              ) : (
                <Badge tone="warning">Not sellable</Badge>
              ),
            sortValue: (r: SalesReason) => (r.restocks ? 1 : 0),
          },
        ]
      : []),
    {
      key: 'note',
      header: 'Note',
      cell: (r) =>
        r.allowsNote ? (
          <Badge tone="neutral">Offered</Badge>
        ) : (
          <span className="text-muted">—</span>
        ),
      sortValue: (r) => (r.allowsNote ? 1 : 0),
    },
    {
      key: 'used',
      header: 'Used on',
      numeric: true,
      cell: (r) => r.useCount,
      sortValue: (r) => r.useCount,
    },
    {
      key: 'active',
      header: 'Status',
      cell: (r) =>
        r.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Retired</Badge>,
      sortValue: (r) => (r.isActive ? 1 : 0),
    },
  ]

  return (
    <>
      <Tabs items={TABS} value={kind} onChange={setKind} aria-label="Which reasons" />

      <Card className="mt-4">
        <CardHeader
          title={isReturns ? 'Return reasons' : 'Void reasons'}
          description={BLURB[kind]}
          action={
            <Button variant="primary" size="sm" onClick={openNew}>
              <Icons.Plus size={15} />
              Add a reason
            </Button>
          }
        />
        <DataTable
          columns={columns}
          rows={reasons}
          getRowKey={(r) => r.id}
          onRowClick={openEdit}
          actions={(r) => (
            <Button
              variant="danger-ghost"
              size="sm"
              onClick={() => setRemoving(r)}
              aria-label={`Remove ${r.name}`}
            >
              <Icons.Trash size={15} />
            </Button>
          )}
          empty={{
            title: 'No reasons yet',
            hint: EMPTY_HINT[kind],
            icon: <Icons.SlidersHorizontal size={22} />,
          }}
        />
      </Card>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? `Edit ${editing.name}` : 'New reason'}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={save}
              disabled={pending || !draft.code.trim() || !draft.name.trim()}
            >
              {pending ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        <CardBody className="grid gap-4 px-0 py-0">
          <Field label="Code" hint="Short, and what a report groups by. Letters, digits, hyphens.">
            <Input
              value={draft.code}
              onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })}
              maxLength={24}
              placeholder={isReturns ? 'FAULTY' : 'WRONG-ITEM'}
            />
          </Field>

          <Field label="Name" hint="What a person picks from the list.">
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              maxLength={120}
              placeholder={isReturns ? 'Faulty or damaged' : 'Wrong item rung up'}
            />
          </Field>

          {isReturns && (
            <Switch
              checked={draft.restocks}
              onChange={(next) => setDraft({ ...draft, restocks: next })}
              label="Goods can be sold again"
              hint="Off for faulty or expired stock. Recorded at the moment of the return, while the person handling it can still see the goods."
            />
          )}

          <Switch
            checked={draft.allowsNote}
            onChange={(next) => setDraft({ ...draft, allowsNote: next })}
            label="Offer a note as well"
            hint="For reasons the code cannot say enough about on its own. Leave off where the name already says everything — an extra empty box on every sale teaches people to skip it."
          />

          <Field label="Order" hint="Where it sits in the list. Lower comes first.">
            <NumberInput
              value={draft.sortOrder}
              onChange={(e) => setDraft({ ...draft, sortOrder: Number(e.target.value) || 0 })}
            />
          </Field>

          <Switch
            checked={draft.isActive}
            onChange={(next) => setDraft({ ...draft, isActive: next })}
            label="Available to choose"
            hint="A retired reason stays on the documents that used it."
          />
        </CardBody>
      </Modal>

      <ConfirmModal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={remove}
        title={removing ? `Remove ${removing.name}?` : 'Remove reason?'}
        confirmLabel={removing && removing.useCount > 0 ? 'Retire it' : 'Delete it'}
        tone="danger"
        busy={pending}
        message={
          removing && removing.useCount > 0
            ? `${removing.useCount} document${removing.useCount === 1 ? '' : 's'} name this reason, so it is retired rather than deleted — those documents keep reading correctly and nobody can choose it again.`
            : 'Nothing has used this reason, so it is removed outright.'
        }
      />
    </>
  )
}

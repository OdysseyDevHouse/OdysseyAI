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
  Select,
  Switch,
  Tabs,
  useToast,
  type Column,
  type TabItem,
} from '@/components/ui'
import type { AdjustmentReason, ReasonDirection } from '@/lib/site/stockAdjustments'
import type { ReasonKind, SalesReason } from '@/lib/site/salesReasons'
import { deleteSalesReasonAction, saveSalesReasonAction } from './actions'
import { deleteReasonAction, saveReasonAction } from '@/app/(app)/adjustments/actions'

/**
 * The three lists this screen maintains.
 *
 * `adjustment` is deliberately not folded into `ReasonKind`: the two sales
 * lists share one table and one pair of actions keyed by that type, and
 * adjustments share neither. Widening it would let a stock reason be handed to
 * an action that goes looking for it in the wrong table.
 */
type Tab = 'adjustment' | ReasonKind

const DIRECTION_LABEL: Record<ReasonDirection, string> = {
  out: 'Writes off',
  in: 'Writes on',
  both: 'Either way',
}

const DIRECTION_TONE: Record<ReasonDirection, 'danger' | 'success' | 'neutral'> = {
  out: 'danger',
  in: 'success',
  both: 'neutral',
}

/** The heading each list carries, said as the thing it explains. */
const TITLE: Record<Tab, string> = {
  adjustment: 'Adjustment reasons',
  void: 'Void reasons',
  return: 'Return reasons',
}

/** What each list is FOR, said where a manager is deciding what to add to it. */
const BLURB: Record<Tab, string> = {
  adjustment:
    'Why stock was written on or off. A reason is required on every adjustment line, so there must always be at least one active.',
  void: 'Why a sale was cancelled at the till. These are mistakes and abandoned sales — nothing to do with goods coming back.',
  return:
    'Why goods came back. These are what a returns report groups by, and what tells you whether you have a supplier problem or a sizing problem.',
}

const EMPTY_HINT: Record<Tab, string> = {
  adjustment:
    'An adjustment records why stock moved. Add the reasons this business actually uses — damage, shrinkage, expiry.',
  void: 'A cashier must pick one of these to cancel a sale. Add the ones this shop actually uses — rang up twice, customer changed their mind.',
  return:
    'Whoever takes a return must pick one of these. Add the ones this shop actually uses — faulty, wrong size, changed their mind.',
}

/**
 * One draft covering all three lists.
 *
 * `direction` is read only on the adjustments tab and `restocks` only on
 * returns — which is what the form already did per-list. One shape means one
 * save path rather than three that drift apart.
 */
type Draft = {
  code: string
  name: string
  direction: ReasonDirection
  allowsNote: boolean
  restocks: boolean
  isActive: boolean
  sortOrder: number
}

const BLANK: Draft = {
  code: '',
  name: '',
  direction: 'out',
  allowsNote: true,
  restocks: true,
  isActive: true,
  sortOrder: 0,
}

/** A row of either kind, narrowed to what the table and the modal both need. */
type Row = AdjustmentReason | SalesReason

/**
 * Maintaining every list of reasons this business picks from.
 *
 * Three lists on one screen because they are one job — somebody setting a shop
 * up decides all of them in the same sitting, and looking for "reasons" should
 * land in one place rather than two tiles a row apart. They stay genuinely
 * separate lists behind separate tabs: a void reason and a write-off reason are
 * not interchangeable, and merging the vocabularies would put "Damaged" in
 * front of a cashier cancelling a sale.
 *
 * Adjustments belong to the inventory module and the other two do not, so on a
 * shop without it the tab is absent rather than disabled — the page is guarded
 * on `setup.edit` alone and the server sends no stock reasons at all.
 *
 * A reason that has been used is retired rather than deleted, on all three
 * lists: the documents naming it have to keep reading correctly, the same rule
 * a location follows.
 */
export default function ReasonsClient({
  adjustmentReasons,
  voidReasons,
  returnReasons,
  showAdjustments,
}: {
  adjustmentReasons: AdjustmentReason[]
  voidReasons: SalesReason[]
  returnReasons: SalesReason[]
  showAdjustments: boolean
}) {
  const tabs: TabItem<Tab>[] = [
    ...(showAdjustments ? [{ value: 'adjustment' as const, label: 'Adjustments' }] : []),
    { value: 'void' as const, label: 'Voids' },
    { value: 'return' as const, label: 'Returns' },
  ]

  // Adjustments lead where the shop has them: it is the longest list, and the
  // one a stock-keeping business opens this screen for.
  const [tab, setTab] = useState<Tab>(showAdjustments ? 'adjustment' : 'void')
  const [editing, setEditing] = useState<Row | null>(null)
  const [draft, setDraft] = useState<Draft>(BLANK)
  const [open, setOpen] = useState(false)
  const [removing, setRemoving] = useState<Row | null>(null)
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  const isAdjustments = tab === 'adjustment'
  const isReturns = tab === 'return'
  const rows: Row[] = isAdjustments
    ? adjustmentReasons
    : tab === 'void'
      ? voidReasons
      : returnReasons

  function openNew() {
    setEditing(null)
    // A new reason lands at the bottom rather than fighting for position 0.
    setDraft({ ...BLANK, sortOrder: (rows.at(-1)?.sortOrder ?? 0) + 10 })
    setOpen(true)
  }

  function openEdit(row: Row) {
    setEditing(row)
    setDraft({
      ...BLANK,
      code: row.code,
      name: row.name,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
      // Each list carries only its own extra field; the other keeps its blank
      // default, and is never read while that tab is the one open.
      ...(isAdjustments
        ? { direction: (row as AdjustmentReason).direction }
        : {
            allowsNote: (row as SalesReason).allowsNote,
            restocks: (row as SalesReason).restocks,
          }),
    })
    setOpen(true)
  }

  function save() {
    startTransition(async () => {
      const result = isAdjustments
        ? await saveReasonAction(draft, editing?.id)
        : await saveSalesReasonAction(tab, draft, editing?.id)
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
    // Read off the tab that opened the dialog, not off the row: `remove` runs
    // after an await, and the tab could otherwise be read as it is by then.
    const fromAdjustments = isAdjustments
    const kind = tab
    startTransition(async () => {
      const result = fromAdjustments
        ? await deleteReasonAction(target.id)
        : await deleteSalesReasonAction(kind as ReasonKind, target.id)
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

  const columns: Column<Row>[] = [
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
    ...(isAdjustments
      ? [
          {
            key: 'direction',
            header: 'Direction',
            cell: (r: Row) => {
              const d = (r as AdjustmentReason).direction
              return <Badge tone={DIRECTION_TONE[d]}>{DIRECTION_LABEL[d]}</Badge>
            },
            sortValue: (r: Row) => (r as AdjustmentReason).direction,
          },
        ]
      : []),
    ...(isReturns
      ? [
          {
            key: 'restocks',
            header: 'Stock',
            cell: (r: Row) =>
              (r as SalesReason).restocks ? (
                <Badge tone="success">Sellable again</Badge>
              ) : (
                <Badge tone="warning">Not sellable</Badge>
              ),
            sortValue: (r: Row) => ((r as SalesReason).restocks ? 1 : 0),
          },
        ]
      : []),
    ...(isAdjustments
      ? []
      : [
          {
            key: 'note',
            header: 'Note',
            cell: (r: Row) =>
              (r as SalesReason).allowsNote ? (
                <Badge tone="neutral">Offered</Badge>
              ) : (
                <span className="text-muted">—</span>
              ),
            sortValue: (r: Row) => ((r as SalesReason).allowsNote ? 1 : 0),
          },
        ]),
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
      <Tabs items={tabs} value={tab} onChange={setTab} aria-label="Which reasons" />

      <Card className="mt-4">
        <CardHeader
          title={TITLE[tab]}
          description={BLURB[tab]}
          action={
            <Button variant="primary" size="sm" onClick={openNew}>
              <Icons.Plus size={15} />
              Add a reason
            </Button>
          }
        />
        <DataTable
          columns={columns}
          rows={rows}
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
            hint: EMPTY_HINT[tab],
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
              placeholder={isAdjustments ? 'DAMAGE' : isReturns ? 'FAULTY' : 'WRONG-ITEM'}
            />
          </Field>

          <Field label="Name" hint="What a person picks from the list.">
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              maxLength={120}
              placeholder={
                isAdjustments ? 'Damaged' : isReturns ? 'Faulty or damaged' : 'Wrong item rung up'
              }
            />
          </Field>

          {isAdjustments && (
            <Field
              label="Direction"
              hint="Stops a write-on being reasoned as breakage. Choose either way only when it genuinely goes both."
            >
              <Select
                value={draft.direction}
                onChange={(e) =>
                  setDraft({ ...draft, direction: e.target.value as ReasonDirection })
                }
              >
                <option value="out">Writes stock off</option>
                <option value="in">Writes stock on</option>
                <option value="both">Either way</option>
              </Select>
            </Field>
          )}

          {isReturns && (
            <Switch
              checked={draft.restocks}
              onChange={(next) => setDraft({ ...draft, restocks: next })}
              label="Goods can be sold again"
              hint="Off for faulty or expired stock. Recorded at the moment of the return, while the person handling it can still see the goods."
            />
          )}

          {!isAdjustments && (
            <Switch
              checked={draft.allowsNote}
              onChange={(next) => setDraft({ ...draft, allowsNote: next })}
              label="Offer a note as well"
              hint="For reasons the code cannot say enough about on its own. Leave off where the name already says everything — an extra empty box on every sale teaches people to skip it."
            />
          )}

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
            ? `${removing.useCount} ${isAdjustments ? 'adjustment line' : 'document'}${
                removing.useCount === 1 ? '' : 's'
              } name this reason, so it is retired rather than deleted — those documents keep reading correctly and nobody can choose it again.`
            : 'Nothing has used this reason, so it is removed outright.'
        }
      />
    </>
  )
}

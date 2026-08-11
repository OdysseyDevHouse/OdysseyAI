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
  useToast,
  type Column,
} from '@/components/ui'
import type { AdjustmentReason, ReasonDirection } from '@/lib/site/stockAdjustments'
import { deleteReasonAction, saveReasonAction } from '@/app/(app)/adjustments/actions'

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

type Draft = {
  code: string
  name: string
  direction: ReasonDirection
  isActive: boolean
  sortOrder: number
}

const BLANK: Draft = { code: '', name: '', direction: 'out', isActive: true, sortOrder: 0 }

/**
 * Managing the reasons an adjustment can carry.
 *
 * The DIRECTION is the part worth getting right: it is what stops somebody
 * writing stock ON because it was damaged. The capture screen reads it and
 * refuses the mismatch on the line, so a reason set up carelessly here shows up
 * as a confusing refusal there.
 *
 * A reason that has been used is retired rather than deleted — history naming
 * it has to keep reading correctly, the same rule a location follows.
 */
export default function ReasonsClient({ reasons }: { reasons: AdjustmentReason[] }) {
  const [editing, setEditing] = useState<AdjustmentReason | null>(null)
  const [draft, setDraft] = useState<Draft>(BLANK)
  const [open, setOpen] = useState(false)
  const [removing, setRemoving] = useState<AdjustmentReason | null>(null)
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  function openNew() {
    setEditing(null)
    // A new reason lands at the bottom rather than fighting for position 0.
    setDraft({ ...BLANK, sortOrder: (reasons.at(-1)?.sortOrder ?? 0) + 10 })
    setOpen(true)
  }

  function openEdit(reason: AdjustmentReason) {
    setEditing(reason)
    setDraft({
      code: reason.code,
      name: reason.name,
      direction: reason.direction,
      isActive: reason.isActive,
      sortOrder: reason.sortOrder,
    })
    setOpen(true)
  }

  function save() {
    startTransition(async () => {
      const result = await saveReasonAction(draft, editing?.id)
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
      const result = await deleteReasonAction(target.id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(
        result.retired
          ? `${target.name} retired — adjustments that used it still read correctly.`
          : `${target.name} deleted.`,
      )
      setRemoving(null)
      router.refresh()
    })
  }

  const columns: Column<AdjustmentReason>[] = [
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
    {
      key: 'direction',
      header: 'Direction',
      cell: (r) => <Badge tone={DIRECTION_TONE[r.direction]}>{DIRECTION_LABEL[r.direction]}</Badge>,
      sortValue: (r) => r.direction,
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
        r.isActive ? (
          <Badge tone="success">Active</Badge>
        ) : (
          <Badge tone="neutral">Retired</Badge>
        ),
      sortValue: (r) => (r.isActive ? 1 : 0),
    },
  ]

  return (
    <>
      <Card>
        <CardHeader
          title="Reasons"
          description="A reason is required on every adjustment line, so there must always be at least one active."
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
            hint: 'An adjustment records why stock moved. Add the reasons this business actually uses — damage, shrinkage, expiry.',
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
              placeholder="DAMAGE"
            />
          </Field>

          <Field label="Name" hint="What a person picks from the list.">
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              maxLength={120}
              placeholder="Damaged"
            />
          </Field>

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
            hint="A retired reason stays on the adjustments that used it."
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
            ? `${removing.useCount} adjustment line${removing.useCount === 1 ? '' : 's'} name this reason, so it is retired rather than deleted — those documents keep reading correctly and nobody can choose it again.`
            : 'Nothing has used this reason, so it is removed outright.'
        }
      />
    </>
  )
}

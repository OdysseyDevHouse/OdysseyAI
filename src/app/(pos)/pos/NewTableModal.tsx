'use client'

import { useEffect, useState } from 'react'
import {
  Button,
  Field,
  Icons,
  Input,
  Modal,
  NumPad,
  Select,
  numPadValue,
} from '@/components/ui'
import type { VisitType } from '@/lib/site/visitTypes'

/** What the waiter filled in. The shell turns this into a parked bill. */
export type NewTableDetails = {
  /** The typed table number. Empty when the tab runs under a name instead. */
  tableNumber: string
  customerName: string
  /** 0 means "not counted", which is different from "a table of nobody". */
  personCount: number
  visitTypeId: number | null
}

/**
 * Which field the number pad is currently driving.
 *
 * The pad is ONE control shared by two numeric fields rather than one pad each:
 * two pads on a dialog this size would each be too small to hit, and a waiter
 * only ever fills one field at a time. The selected card says which — the same
 * gesture as tapping into a field, made big enough for a thumb.
 */
type Target = 'table' | 'customer' | 'people'

/**
 * "Open new table" — naming a tab before anything is rung up.
 *
 * ── WHY A NAME IS ASKED FOR AT ALL ─────────────────────────────────────────
 *
 * A tab that has no label cannot be found again. The floor lists open bills by
 * whatever the waiter typed here, so this dialog is the only thing standing
 * between a customer's drinks and a bill nobody can identify at the end of the
 * night. Hence the one rule below: a table number OR a customer name. Both is
 * better; neither is refused.
 *
 * ── WHY THE TABLE NUMBER IS OPTIONAL ───────────────────────────────────────
 *
 * Not every tab is a table. A regular running a bar tab under their own name,
 * a takeaway waiting at the counter, an account customer — none of them are
 * sitting anywhere, and forcing a made-up number onto them is how floors end up
 * with "table 999" meaning six different things on six different nights.
 */
export function NewTableModal({
  open,
  visitTypes,
  waiterName,
  busy = false,
  onClose,
  onSave,
}: {
  open: boolean
  /** Active visit types, in the order the shop arranged them. */
  visitTypes: readonly VisitType[]
  /** Who is signed in. Shown, never chosen — see the field itself. */
  waiterName: string
  busy?: boolean
  onClose: () => void
  onSave: (details: NewTableDetails) => void
}) {
  const [target, setTarget] = useState<Target>('table')
  const [tableNumber, setTableNumber] = useState('')
  const [customerName, setCustomerName] = useState('')
  const [people, setPeople] = useState('')
  const [visitTypeId, setVisitTypeId] = useState<number | null>(null)
  const [touched, setTouched] = useState(false)

  /* Fresh every time it opens. A dialog that remembers the last table's details
     is one that silently opens table 12 again while the waiter thinks they are
     opening 13 — and the numbers are close enough that nobody would notice. */
  useEffect(() => {
    if (!open) return
    setTarget('table')
    setTableNumber('')
    setCustomerName('')
    setPeople('')
    setTouched(false)
    setVisitTypeId(visitTypes.find((v) => v.isDefault)?.id ?? visitTypes[0]?.id ?? null)
  }, [open, visitTypes])

  const labelled = tableNumber.trim() !== '' || customerName.trim() !== ''

  function save() {
    setTouched(true)
    if (!labelled || busy) return
    onSave({
      tableNumber: tableNumber.trim(),
      customerName: customerName.trim(),
      personCount: numPadValue(people),
      visitTypeId,
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create new table"
      description="Enter table details and select a table number"
      size="lg"
      /* Half-typed work: a stray tap on the backdrop must not lose the name a
         waiter is halfway through entering. */
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="danger" size="touch" disabled={busy} onClick={onClose}>
            <Icons.Close size={18} />
            Close
          </Button>
          <Button variant="primary" size="touch" disabled={busy || !labelled} onClick={save}>
            <Icons.Check size={18} />
            {busy ? 'Opening…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* ── The three things being captured ────────────────────────────
            As cards rather than plain fields: on a touch screen the target
            has to be big, and the selected card tells the number pad below
            which field it is filling. */}
        <div className="grid gap-3 sm:grid-cols-3">
          <PickCard
            active={target === 'table'}
            icon={<Icons.LayoutGrid size={16} />}
            label="Table number"
            value={tableNumber}
            placeholder="Optional — leave blank to run a tab under the customer's name"
            onPick={() => setTarget('table')}
          />
          <PickCard
            active={target === 'customer'}
            icon={<Icons.Contact size={16} />}
            label="Customer name"
            value={customerName}
            placeholder="Tap to enter customer name"
            onPick={() => setTarget('customer')}
          />
          <PickCard
            active={target === 'people'}
            icon={<Icons.Users size={16} />}
            label="Person count"
            value={people === '' ? '0' : people}
            placeholder="0"
            onPick={() => setTarget('people')}
          />
        </div>

        {/* The customer's name is the one field a pad cannot fill, so it gets a
            real input — shown only when it is the one being edited, to keep the
            dialog from growing a permanently half-used row. */}
        {target === 'customer' && (
          <Field label="Customer name">
            <Input
              autoFocus
              size="touch"
              value={customerName}
              placeholder="Who is this tab for?"
              onChange={(e) => setCustomerName(e.target.value)}
            />
          </Field>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Visit type">
            <Select
              value={visitTypeId === null ? '' : String(visitTypeId)}
              onChange={(e) => setVisitTypeId(e.target.value ? Number(e.target.value) : null)}
            >
              {visitTypes.length === 0 && <option value="">None set up</option>}
              {visitTypes.map((v) => (
                <option key={v.id} value={String(v.id)}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>

          {/* READ-ONLY, deliberately. The bill is attributed server-side to
              whoever's PIN opened the till, and that attribution drives
              commission — so a dropdown here would either be a lie (it changes
              nothing) or a way to bill someone else's commission to yourself. */}
          <Field label="Waiter" hint="Whoever is signed in to this till.">
            <div className="flex h-control items-center gap-2 rounded-control border border-border bg-surface-2 px-3 text-sm text-ink-2">
              <Icons.Contact size={16} className="text-muted" />
              <span className="truncate">{waiterName || 'Not signed in'}</span>
            </div>
          </Field>
        </div>

        {/* One pad, aimed by the cards above. Whole numbers only: a table is
            never 2.5 and neither is a party. */}
        {target !== 'customer' && (
          <NumPad
            value={target === 'table' ? tableNumber : people}
            maxDecimals={0}
            maxLength={target === 'table' ? 6 : 3}
            disabled={busy}
            onChange={target === 'table' ? setTableNumber : setPeople}
          />
        )}

        {touched && !labelled && (
          <p className="text-sm text-danger">
            Give the tab a table number or a customer name — without one it cannot be
            found again on the floor.
          </p>
        )}
      </div>
    </Modal>
  )
}

/**
 * One of the three capture cards.
 *
 * Not `SelectableCard`: that one is a radio in a form and renders a control
 * plus a description. This is a display of a value that happens to be
 * selectable, and the value is the part that has to be readable across a
 * counter.
 */
function PickCard({
  active,
  icon,
  label,
  value,
  placeholder,
  onPick,
}: {
  active: boolean
  icon: React.ReactNode
  label: string
  value: string
  placeholder: string
  onPick: () => void
}) {
  return (
    /* data-kit-ok: a selection tile showing a live value over a hint line —
       the kit's SelectableCard is a radio with a description, which is a
       different thing and would render a control this must not have. */
    <button
      type="button"
      data-kit-ok
      onClick={onPick}
      className={`flex min-h-[104px] flex-col gap-1 rounded-card border p-3 text-left transition ${
        active
          ? 'border-brand bg-brand-soft ring-1 ring-brand'
          : 'border-border bg-surface hover:border-brand/50'
      }`}
    >
      <span className="flex items-center gap-1.5 text-[13px] font-semibold text-brand">
        {icon}
        {label}
      </span>
      {value ? (
        <span className="numeric truncate text-xl font-bold text-ink">{value}</span>
      ) : (
        <span className="text-[12px] leading-snug text-muted">{placeholder}</span>
      )}
    </button>
  )
}

'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  CurrencyInput,
  EmptyState,
  Field,
  Input,
  Modal,
  NumberInput,
  Switch,
  useToast,
} from '@/components/ui'
import { DragHandle, Lightbulb, Plus, Trash } from '@/components/ui/icons'
import type { InstructionGroup, InstructionOption } from '@/lib/site/instructions'
import {
  deleteInstructionGroupAction,
  loadInstructionGroupAction,
  saveInstructionGroupAction,
} from './instructionLibraryActions'

/**
 * The instruction library, managed without leaving the product screen.
 *
 * ── WHY THIS IS A DIALOG AND NOT A LINK ───────────────────────────────────
 *
 * The Instructions tab could only ever say "edit the options themselves under
 * Inventory → Instructions". Following that link mid-edit throws away every
 * unsaved field on the product — which meant the ordinary job of "this sandwich
 * needs a bread choice, and there isn't one yet" cost the user their work, or
 * a save they were not ready to make. A dialog is the whole point: the product
 * form stays exactly as it was underneath.
 *
 * ── WHY IT IS RENDERED OUTSIDE THE PRODUCT <form> ─────────────────────────
 *
 * Same reason as the barcode dialogs: it carries its own inputs and saves on
 * its own round trip. Inside the form its fields would be submitted with the
 * product, and its buttons would default to submitting it.
 *
 * ── WHAT IT DELIBERATELY DOES NOT EDIT ────────────────────────────────────
 *
 * An answer can also carry a stock link, a picture, per-answer quantity bounds,
 * kitchen and receipt flags, and follow-on questions it reveals. Those are
 * thirteen fields per row and they belong on the full-page editor; putting them
 * here would make the quick job as slow as the long one.
 *
 * They are still LOADED and written straight back, because `replaceOptions`
 * writes the whole set — anything not sent is deleted. Loading only what is
 * shown would have quietly stripped every stock link in the library the first
 * time somebody renamed an answer from here.
 */

/** One answer being edited. `key` is local: a new row has no id yet. */
type Row = {
  key: string
  id?: number
  name: string
  priceAdjust: number
  isDefault: boolean
  isActive: boolean
  /* Carried through untouched — see the note above. */
  productId: number | null
  productCode: string | null
  quantity: number
  maxQty: number
  minQty: number
  defaultQty: number
  imageId: number | null
  printsOnKitchen: boolean
  printsOnReceipt: boolean
  revealsGroupIds: number[]
}

/** A draft of the question itself. Mirrors GroupInput, plus what is passed through. */
type Draft = {
  name: string
  prompt: string
  isRequired: boolean
  isActive: boolean
  minChoices: number
  maxChoices: number
  /* Not edited here; the full editor owns the picture and the library order. */
  imageId: number | null
  sortOrder: number
}

const NEW_GROUP: Draft = {
  name: '',
  prompt: '',
  isRequired: false,
  isActive: true,
  minChoices: 0,
  maxChoices: 1,
  imageId: null,
  sortOrder: 0,
}

let rowSeq = 0
function blankRow(): Row {
  rowSeq += 1
  return {
    key: `new-${rowSeq}`,
    name: '',
    priceAdjust: 0,
    isDefault: false,
    isActive: true,
    productId: null,
    productCode: null,
    quantity: 1,
    maxQty: 1,
    minQty: 0,
    defaultQty: 0,
    imageId: null,
    printsOnKitchen: true,
    printsOnReceipt: true,
    revealsGroupIds: [],
  }
}

function toRow(option: InstructionOption): Row {
  return {
    key: `saved-${option.id}`,
    id: option.id,
    name: option.name,
    priceAdjust: option.priceAdjust,
    isDefault: option.isDefault,
    isActive: option.isActive,
    productId: option.productId,
    productCode: option.productCode,
    quantity: option.quantity,
    maxQty: option.maxQty,
    minQty: option.minQty,
    defaultQty: option.defaultQty,
    imageId: option.imageId,
    printsOnKitchen: option.printsOnKitchen,
    printsOnReceipt: option.printsOnReceipt,
    revealsGroupIds: option.revealsGroupIds,
  }
}

/** Whether a row carries anything this dialog cannot show, so it can say so. */
function hasExtras(row: Row): boolean {
  return (
    row.productId !== null ||
    row.imageId !== null ||
    row.revealsGroupIds.length > 0 ||
    !row.printsOnKitchen ||
    !row.printsOnReceipt ||
    row.maxQty !== 1 ||
    row.minQty !== 0
  )
}

/** "Pick one", "Choose up to 3" — the same wording the library list uses. */
function choiceRule(min: number, max: number): string {
  if (max === 1) return min > 0 ? 'Pick one' : 'Pick one (optional)'
  if (max === 0) return min > 0 ? `Choose at least ${min}` : 'Choose any number'
  if (min > 0 && min !== max) return `Choose ${min} to ${max}`
  if (min > 0 && min === max) return `Choose exactly ${min}`
  return `Choose up to ${max}`
}

export default function ManageInstructionsModal({
  open,
  onClose,
  groups,
  onGroupsChange,
}: {
  open: boolean
  onClose: () => void
  /** The whole library, held by the caller so the panel behind can attach from it. */
  groups: InstructionGroup[]
  onGroupsChange: (next: InstructionGroup[]) => void
}) {
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  /** `'new'` while an unsaved instruction is being written. */
  const [selected, setSelected] = useState<number | 'new' | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /* Every read gets a number, and only the newest one may write — see the note
     in `load`. */
  const loadSeq = useRef(0)

  /* Opened fresh every time. The dialog's own state is NOT remounted with the
     body — <Modal> keys its children, not its parent — so without this the next
     person to open it inherits the last half-written answer. */
  useEffect(() => {
    if (!open) return
    loadSeq.current += 1
    setSelected(null)
    setDraft(null)
    setRows([])
    setDirty(false)
    setError(null)
  }, [open])

  const edit = (change: Partial<Draft>) => {
    setDraft((prev) => (prev ? { ...prev, ...change } : prev))
    setDirty(true)
  }

  const setRow = <K extends keyof Row>(key: string, field: K, value: Row[K]) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, [field]: value } : r)))
    setDirty(true)
  }

  /* Ticking a default in a pick-one group unticks the others: the till can only
     preselect one answer, and two ticked would make the choice depend on order. */
  const setDefault = (key: string, next: boolean) => {
    setRows((prev) =>
      prev.map((r) =>
        r.key === key
          ? { ...r, isDefault: next }
          : draft?.maxChoices === 1 && next
            ? { ...r, isDefault: false }
            : r,
      ),
    )
    setDirty(true)
  }

  const addRow = () => {
    setRows((prev) => [...prev, blankRow()])
    setDirty(true)
  }

  const removeRow = (key: string) => {
    setRows((prev) => prev.filter((r) => r.key !== key))
    setDirty(true)
  }

  /* Dragging an answer into a new position. Nothing is saved here — sortOrder
     is written from this array's index, so the order IS the array. Keyed by the
     local `key` rather than an id, because a row added a moment ago has none. */
  const dragKeyRef = useRef<string | null>(null)
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [overKey, setOverKey] = useState<string | null>(null)

  const moveRow = (targetKey: string) => {
    const from = dragKeyRef.current
    dragKeyRef.current = null
    setDragKey(null)
    setOverKey(null)
    if (from === null || from === targetKey) return

    setRows((prev) => {
      const fromIndex = prev.findIndex((r) => r.key === from)
      const toIndex = prev.findIndex((r) => r.key === targetKey)
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return prev

      // Spliced out first, so the destination is found again in the shortened
      // array — otherwise a downward drag lands one slot short.
      const next = [...prev]
      const [moved] = next.splice(fromIndex, 1)
      const insertAt = next.findIndex((r) => r.key === targetKey)
      next.splice(fromIndex < toIndex ? insertAt + 1 : insertAt, 0, moved)
      return next
    })
    setDirty(true)
  }

  /**
   * Switching what is being edited while there are unsaved changes.
   *
   * Refused rather than confirmed with a second dialog: a <dialog> is in the
   * top layer, so an "are you sure?" over this one is a stack of two modals for
   * a question the footer already answers — Save or Discard are both one click
   * away and both say plainly what they do.
   */
  function guard(next: () => void) {
    if (dirty) {
      toast.error('Save or discard your changes first.')
      return
    }
    next()
  }

  /**
   * Reads one group from the database and makes it the draft.
   *
   * Separate from `pick` because discarding and saving both need to reload
   * WITHOUT the unsaved-changes guard — they are the two things that resolve
   * it, and routing them through the guard would have them blocked by the very
   * state they just cleared.
   */
  function load(id: number) {
    const seq = ++loadSeq.current
    setError(null)
    setSelected(id)
    startTransition(async () => {
      const result = await loadInstructionGroupAction(id)
      // A second click while the first read is still out: the network may
      // return them in either order, and a stale answer would fill the editor
      // with one question while the list highlights another.
      if (seq !== loadSeq.current) return
      if (!result.ok) {
        setError(result.error)
        setSelected(null)
        return
      }
      setDraft({
        name: result.group.name,
        prompt: result.group.prompt,
        isRequired: result.group.isRequired,
        isActive: result.group.isActive,
        minChoices: result.group.minChoices,
        maxChoices: result.group.maxChoices,
        imageId: result.group.imageId,
        sortOrder: result.group.sortOrder,
      })
      setRows(result.options.map(toRow))
      setDirty(false)
    })
  }

  function pick(id: number) {
    guard(() => load(id))
  }

  function startNew() {
    guard(() => {
      loadSeq.current += 1
      setError(null)
      setSelected('new')
      setDraft({ ...NEW_GROUP })
      // A question with no answers is not a state anybody means.
      setRows([blankRow()])
      setDirty(false)
    })
  }

  function discard() {
    setDirty(false)
    // An unsaved new instruction has nothing to go back to; an existing one is
    // re-read from the database rather than from a copy kept for the purpose.
    if (typeof selected === 'number') {
      load(selected)
      return
    }
    setSelected(null)
    setDraft(null)
    setRows([])
    setError(null)
  }

  function save() {
    if (!draft) return
    setError(null)

    // Blank rows are ones the user added and never filled in, not an error —
    // the same reading the full editor's action takes of an empty name.
    const filled = rows.filter((r) => r.name.trim() !== '')
    if (filled.length === 0) {
      setError('Add at least one answer — a question the till cannot answer is not usable.')
      return
    }

    startTransition(async () => {
      const result = await saveInstructionGroupAction(
        selected === 'new' ? null : selected,
        {
          name: draft.name,
          prompt: draft.prompt,
          isRequired: draft.isRequired,
          isActive: draft.isActive,
          minChoices: draft.minChoices,
          maxChoices: draft.maxChoices,
          imageId: draft.imageId,
          sortOrder: draft.sortOrder,
        },
        filled.map((r, i) => ({
          id: r.id,
          name: r.name.trim(),
          priceAdjust: r.priceAdjust,
          productId: r.productId,
          quantity: r.quantity,
          isDefault: r.isDefault,
          maxQty: r.maxQty,
          minQty: r.minQty,
          defaultQty: r.defaultQty,
          imageId: r.imageId,
          printsOnKitchen: r.printsOnKitchen,
          printsOnReceipt: r.printsOnReceipt,
          revealsGroupIds: r.revealsGroupIds,
          sortOrder: i,
          isActive: r.isActive,
        })),
      )

      if (!result.ok) {
        setError(result.error)
        return
      }

      onGroupsChange(result.groups)
      setDirty(false)
      toast.success(`${draft.name.trim()} saved.`)
      /* Re-read rather than left as typed, and this is load-bearing: rows that
         were new have just been INSERTED and now have ids. Without them a
         second save would send them as new again and insert duplicates. */
      load(result.id)
    })
  }

  function remove() {
    if (typeof selected !== 'number') return
    const name = draft?.name.trim() || 'That instruction'
    startTransition(async () => {
      const result = await deleteInstructionGroupAction(selected)
      if (!result.ok) {
        // deleteGroup names the count still using it, which is the thing the
        // user has to act on — so it is shown in the pane, not a toast.
        setError(result.error)
        return
      }
      onGroupsChange(result.groups)
      setSelected(null)
      setDraft(null)
      setRows([])
      setDirty(false)
      setError(null)
      toast.success(`${name} deleted.`)
    })
  }

  const single = draft?.maxChoices === 1
  const carriesExtras = rows.some(hasExtras)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Instructions library"
      description="The questions the till can ask. Shared by every product that asks them."
      size="xl"
      bodyFills
      /* Holds half-typed work — a stray click on the backdrop must not lose it. */
      closeOnBackdrop={false}
      footer={
        <>
          {typeof selected === 'number' && (
            <Button
              variant="danger-ghost"
              onClick={remove}
              disabled={pending}
              className="mr-auto"
            >
              <Trash size={15} />
              Delete
            </Button>
          )}
          {dirty && (
            <Button variant="ghost" onClick={discard} disabled={pending}>
              Discard changes
            </Button>
          )}
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Close
          </Button>
          <Button variant="primary" onClick={save} disabled={pending || !draft}>
            {pending ? 'Saving…' : 'Save instruction'}
          </Button>
        </>
      }
    >
      <div className="flex min-h-0 flex-1 gap-5">
        {/* ── The library ──────────────────────────────────────────────── */}
        <div className="flex w-60 shrink-0 flex-col gap-2 border-r border-border pr-4">
          <Button variant="secondary" size="sm" onClick={startNew} disabled={pending}>
            <Plus size={14} />
            New instruction
          </Button>

          <div className="-mr-1 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1">
            {groups.length === 0 && (
              <p className="px-1 py-3 text-xs text-muted">
                Nothing in the library yet. Create the first question above.
              </p>
            )}
            {groups.map((g) => (
              <button
                /* A selection row with a nested summary line, which no kit
                   control expresses — the same trade the panel behind this one
                   makes for its own rows. data-kit-ok */
                data-kit-ok
                key={g.id}
                type="button"
                onClick={() => pick(g.id)}
                className={`rounded-control border px-3 py-2 text-left transition ${
                  selected === g.id
                    ? 'border-brand bg-brand-soft'
                    : 'border-transparent hover:bg-surface-2'
                }`}
              >
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                    {g.name}
                  </span>
                  {!g.isActive && <Badge>off</Badge>}
                  {g.optionCount === 0 && <Badge tone="danger">0</Badge>}
                </span>
                <span className="mt-0.5 block text-xs text-muted">
                  {g.optionCount} option{g.optionCount === 1 ? '' : 's'}
                  {g.productCount > 0 && ` · ${g.productCount} product${g.productCount === 1 ? '' : 's'}`}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* ── The one being edited ─────────────────────────────────────── */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-y-auto">
          {error && (
            <Callout tone="danger" title="Could not save">
              {error}
            </Callout>
          )}

          {!draft ? (
            <EmptyState
              icon={<Lightbulb size={28} strokeWidth={1.75} />}
              title={
                groups.length === 0 ? 'No instructions yet' : 'Pick an instruction to edit it'
              }
              hint={
                groups.length === 0
                  ? 'Create one — for example “Choice of bread” with white, brown and rye — then attach it to this product.'
                  : 'Choose one on the left, or create a new one. Attaching them to this product happens behind this dialog.'
              }
              action={
                <Button variant="primary" size="sm" onClick={startNew} disabled={pending}>
                  <Plus size={14} />
                  New instruction
                </Button>
              }
            />
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Name" hint="How you refer to it here, e.g. “Choice of bread”.">
                  <Input
                    value={draft.name}
                    onChange={(e) => edit({ name: e.target.value })}
                    maxLength={120}
                    placeholder="e.g. Choice of bread"
                  />
                </Field>

                <Field label="Prompt" hint="Shown to the cashier. Falls back to the name.">
                  <Input
                    value={draft.prompt}
                    onChange={(e) => edit({ prompt: e.target.value })}
                    maxLength={190}
                    placeholder="e.g. How would you like your eggs?"
                  />
                </Field>

                <Field
                  label="Maximum choices"
                  hint={
                    single
                      ? 'One answer — the till shows radio buttons.'
                      : draft.maxChoices === 0
                        ? 'Any number of answers — the till shows checkboxes.'
                        : `Up to ${draft.maxChoices} answers — the till shows checkboxes.`
                  }
                >
                  <NumberInput
                    precision={0}
                    value={draft.maxChoices}
                    onChange={(e) => edit({ maxChoices: Number(e.target.value) || 0 })}
                    className="w-28 text-right"
                  />
                </Field>

                <Field
                  label="Minimum choices"
                  hint="0 lets the cashier skip. Cannot be above the maximum."
                >
                  <NumberInput
                    precision={0}
                    value={draft.minChoices}
                    onChange={(e) => edit({ minChoices: Number(e.target.value) || 0 })}
                    className="w-28 text-right"
                  />
                </Field>

                <div className="flex flex-col gap-3 sm:col-span-2">
                  <Switch
                    checked={draft.isRequired}
                    onChange={(next) => edit({ isRequired: next })}
                    label="Required"
                    hint="The cashier must answer before the line can be completed."
                  />
                  <Switch
                    checked={draft.isActive}
                    onChange={(next) => edit({ isActive: next })}
                    label="Active"
                    hint="Switch off to stop the till asking this, without detaching it from products."
                  />
                </div>
              </div>

              {/* ── The answers ──────────────────────────────────────────── */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-medium text-ink">
                    Answers
                    <span className="ml-2 text-xs font-normal text-muted">
                      {choiceRule(draft.minChoices, draft.maxChoices)}
                      {rows.length > 1 && ' · drag to reorder'}
                    </span>
                  </h3>
                  <Button variant="secondary" size="sm" onClick={addRow} disabled={pending}>
                    <Plus size={14} />
                    Add answer
                  </Button>
                </div>

                {carriesExtras && (
                  <Callout tone="brand">
                    Some answers here also carry a stock link, a picture or a follow-on question.
                    Those are kept exactly as they are — change them on the full editor under
                    Inventory → Instructions.
                  </Callout>
                )}

                {rows.map((row) => (
                  <div
                    key={row.key}
                    /* A full-width answer row with a drag affordance and live
                       inputs, which no kit row expresses. data-kit-ok */
                    data-kit-ok
                    onDragOver={(e) => {
                      if (dragKeyRef.current === null) return
                      // Must preventDefault on EVERY dragover or the drop is refused.
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                      if (overKey !== row.key) setOverKey(row.key)
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      moveRow(row.key)
                    }}
                    onDragEnd={() => {
                      dragKeyRef.current = null
                      setDragKey(null)
                      setOverKey(null)
                    }}
                    className={`flex items-center gap-2 rounded-control border px-3 py-2 transition ${
                      overKey === row.key && dragKey !== row.key ? 'border-brand' : 'border-border'
                    } ${dragKey === row.key ? 'opacity-40' : ''}`}
                  >
                    {/* Only the handle starts the drag, so a caret dragged
                        through the name field does not pick the row up. */}
                    <span
                      draggable={rows.length > 1}
                      onDragStart={(e) => {
                        dragKeyRef.current = row.key
                        setDragKey(row.key)
                        // Firefox will not start a drag without data on the transfer.
                        e.dataTransfer.effectAllowed = 'move'
                        e.dataTransfer.setData('text/plain', row.key)
                      }}
                      aria-hidden
                      className={`shrink-0 text-faint ${
                        rows.length > 1 ? 'cursor-grab hover:text-muted' : 'opacity-30'
                      }`}
                    >
                      <DragHandle size={15} />
                    </span>

                    <Input
                      value={row.name}
                      onChange={(e) => setRow(row.key, 'name', e.target.value)}
                      maxLength={120}
                      placeholder="Answer, e.g. Brown"
                      className="min-w-0 flex-1"
                      aria-label="Answer"
                    />

                    <CurrencyInput
                      value={row.priceAdjust}
                      onChange={(e) =>
                        setRow(row.key, 'priceAdjust', Number(e.target.value) || 0)
                      }
                      className="w-24 shrink-0 text-right"
                      aria-label={`Price change for ${row.name || 'this answer'}`}
                    />

                    <Checkbox
                      checked={row.isDefault}
                      onChange={(e) => setDefault(row.key, e.target.checked)}
                      label="Default"
                      className="shrink-0"
                    />

                    {hasExtras(row) && <Badge>more</Badge>}

                    <Button
                      variant="danger-ghost"
                      size="sm"
                      iconOnly
                      aria-label={`Remove ${row.name || 'this answer'}`}
                      onClick={() => removeRow(row.key)}
                      disabled={pending}
                    >
                      <Trash size={14} />
                    </Button>
                  </div>
                ))}

                <p className="text-xs text-muted">
                  The price is what this answer adds to the line, including VAT — leave it at 0.00
                  for an answer that costs nothing, or set a negative amount for a discount.
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}

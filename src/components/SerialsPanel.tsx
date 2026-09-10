'use client'

import { useActionState, useEffect, useState } from 'react'
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  Field,
  Input,
  Modal,
  SegmentedControl,
  Textarea,
  type Column,
  type SegmentedOption,
} from '@/components/ui'
import { StatusError, StatusSuccess, Plus, Ban, Pencil } from '@/components/ui/icons'
/* Labels from the client-safe module; the Serial shape is a type-only import,
   which erases at compile time and so cannot drag the pool into the bundle. */
import { SERIAL_LABELS, isHeld, type SerialStatus } from '@/lib/serialStatus'
import type { Serial } from '@/lib/site/serials'
import {
  addSerialsAction,
  editSerialAction,
  writeOffSerialAction,
  type SerialActionState,
} from '@/app/(app)/products/serialActions'

/**
 * The individual units of a serial-tracked product.
 *
 * Unlike every other tab on this form, these save on their own. A serial is a
 * unit of stock, not a description of the product: capturing fifty off a
 * delivery note and then losing them because an unrelated field failed
 * validation would be indefensible.
 *
 * That independence is why ProductForm renders this panel OUTSIDE its <form>:
 * the two forms below would otherwise be nested inside it, which is invalid
 * HTML and gets silently dropped by the browser. The fields still reach them by
 * `form={id}`, the same trick the Save button uses in the other direction.
 */

const CAPTURE_FORM = 'serial-capture-form'
const WRITEOFF_FORM = 'serial-writeoff-form'
const EDIT_FORM = 'serial-edit-form'

const TONE: Record<SerialStatus, 'success' | 'neutral' | 'warning' | 'danger'> = {
  in_stock: 'success',
  sold: 'neutral',
  returned: 'warning',
  written_off: 'danger',
  // Neutral, not warning: the unit has left the building and been credited, so
  // it needs no decision from anyone here. `returned` keeps the warning because
  // that one is still on a shelf waiting to be dealt with.
  returned_to_supplier: 'neutral',
}

/**
 * The three slices this tab is filtered into, and which statuses fall in each.
 *
 * There are five statuses and three slices, so two of them share. That is
 * deliberate: the question this screen answers is "what shape is my stock in",
 * and from that angle a faulty unit still sitting on the shelf is a thing I
 * hold, while one that has gone back to the supplier is a thing that has left
 * without being sold. Giving each of the five its own slice would have made two
 * tabs that are empty on almost every product, and a reader hunting a serial
 * would have to guess which of five to look in.
 *
 * Every unit lands in exactly one slice — the badge in the row still names the
 * real status, so nothing is hidden by the grouping, only gathered.
 */
const SLICES = ['in_stock', 'sold', 'written_off'] as const
type Slice = (typeof SLICES)[number]

/**
 * Which slice a status falls in.
 *
 * The In stock arm is `isHeld` itself rather than a list repeating it — the tab
 * BADGE on the product form counts with that same function, so a unit this puts
 * in the In stock slice is a unit the badge counted, by construction rather than
 * by two lists being kept in step. A faulty return is held: not sellable, but on
 * a shelf and awaiting a decision.
 *
 * Of what is left, `sold` is its own answer and everything else — written off,
 * or sent back to the supplier — is a unit that left without earning anything.
 */
function sliceOf(status: SerialStatus): Slice {
  if (isHeld(status)) return 'in_stock'
  return status === 'sold' ? 'sold' : 'written_off'
}

const SLICE_LABEL: Record<Slice, string> = {
  in_stock: 'In stock',
  sold: 'Sold',
  written_off: 'Written off',
}

/** Shown when a slice is empty, in the words of what that slice means. */
const SLICE_EMPTY: Record<Slice, { title: string; hint: string }> = {
  in_stock: {
    title: 'No units in stock',
    hint: 'Every unit captured for this product has been sold, written off or sent back. Capture the numbers off a delivery note above to bring more in.',
  },
  sold: {
    title: 'Nothing sold yet',
    hint: 'Units are marked sold automatically when they go out on a sale, and this is where they land — so you can find who bought a particular one when it comes back under warranty.',
  },
  written_off: {
    title: 'Nothing written off',
    hint: 'Units that were lost, scrapped or sent back to the supplier show here, with the reason kept against each one.',
  },
}

function formatDate(value: Date | string | null): string {
  if (!value) return '—'
  const d = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' })
}

export default function SerialsPanel({
  serials,
  productId,
  stockOnHand,
  savedAsSerial,
}: {
  serials: Serial[]
  /** Null on a product that has not been saved yet. */
  productId: number | null
  /** Compared against the in-stock count — the two must agree. */
  stockOnHand: number
  /**
   * Whether the product is serial-tracked IN THE DATABASE, not merely on
   * screen. The tab appears the moment the type dropdown changes, but this
   * panel commits on its own without going through Save — so on a product
   * whose type was switched and not yet saved, `addSerials` re-reads the old
   * type and refuses the batch. Knowing the saved type lets the screen say so
   * before fifty numbers are typed, rather than after.
   */
  savedAsSerial: boolean
}) {
  const empty: SerialActionState = { error: null, message: null }
  const [addState, addAction] = useActionState(addSerialsAction, empty)
  const [offState, offAction] = useActionState(writeOffSerialAction, empty)
  const [editState, editAction] = useActionState(editSerialAction, empty)
  const [writingOff, setWritingOff] = useState<Serial | null>(null)
  const [editing, setEditing] = useState<Serial | null>(null)

  /*
   * Closes the edit panel once the save has actually landed.
   *
   * Keyed on the message rather than closing in an onClick: the action is a
   * form submission, so at click time nothing has been saved yet and closing
   * there would hide a refusal the user needs to read. The revalidate has
   * re-rendered the rows by the time a message exists, so the panel goes away
   * exactly when the table behind it shows the new date.
   */
  useEffect(() => {
    if (editState.message) setEditing(null)
  }, [editState.message])
  /* In stock by default. It is the slice somebody opening this tab almost
     always wants — what have I got — and the other two grow forever, so
     defaulting to Sold would mean a screen that gets slower and less useful
     every year the shop trades. */
  const [slice, setSlice] = useState<Slice>('in_stock')

  if (productId === null) {
    return (
      <div className="p-6">
        <EmptyState
          title="Save the product first"
          hint="Serial numbers attach to individual units of stock, so the product needs to exist before they can be captured. Save it, then come back to this tab."
        />
      </div>
    )
  }

  /* The same refusal one step later: the product exists, but it is not
     serial-tracked where it counts. Capture writes straight to the database
     and is checked against the SAVED type, so without this the numbers get
     typed, submitted and rejected — "Only a serial-tracked product carries
     serial numbers" on a screen plainly showing a serial product. */
  if (!savedAsSerial) {
    return (
      <div className="p-6">
        <EmptyState
          title="Save the product as serial-tracked first"
          hint="The type has been changed on screen but not saved yet. Serial numbers commit on their own rather than with the rest of the form, so they are checked against the saved product. Save it, then come back to this tab."
        />
      </div>
    )
  }

  const inStock = serials.filter((s) => s.status === 'in_stock').length
  const drift = stockOnHand - inStock

  /* Derived from the units themselves rather than taken as a prop: the column
     is worth showing exactly when these units sit in more than one room, and
     that is knowable from the rows already on screen. A site with several
     locations whose units happen to be together still gets one code repeated,
     which is the correct answer to "where is it". */
  const hasLocations = new Set(serials.map((s) => s.locationCode).filter(Boolean)).size > 1

  /* Counted over ALL the units rather than the visible slice, so the bar says
     how many are behind each tab before it is opened — the count is most of the
     reason to put a number on a segment at all. */
  const sliceCount: Record<Slice, number> = { in_stock: 0, sold: 0, written_off: 0 }
  for (const s of serials) sliceCount[sliceOf(s.status)] += 1

  const sliceOptions: SegmentedOption<Slice>[] = SLICES.map((value) => ({
    value,
    label: SLICE_LABEL[value],
    count: sliceCount[value],
  }))

  const visible = serials.filter((s) => sliceOf(s.status) === slice)

  const columns: Column<Serial>[] = [
    {
      key: 'serial',
      header: 'Serial number',
      cell: (row) => <span className="numeric text-sm text-ink">{row.serial}</span>,
      sortValue: (row) => row.serial,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => <Badge tone={TONE[row.status]}>{SERIAL_LABELS[row.status]}</Badge>,
      sortValue: (row) => row.status,
    },
    /* Where the unit is. Only when there is more than one room — a
       single-location site would get a column repeating the same code on
       every row, which is a column that costs width and says nothing.

       An in-stock unit always has a room; a sold or written-off one has none,
       and the dash is the honest answer rather than a stale shelf. */
    ...(hasLocations
      ? [
          {
            key: 'location',
            header: 'Where',
            cell: (row: Serial) =>
              row.locationCode ? (
                <span className="text-sm text-ink-2">{row.locationCode}</span>
              ) : (
                <span className="text-sm text-faint">—</span>
              ),
            sortValue: (row: Serial) => row.locationCode ?? '',
          },
        ]
      : []),
    /* No "Sold on" or "Customer" column. This tab answers "which units do we
       have, and what shape is each one in" — and it grows a row per unit
       forever, so every column it carries is width taken off the serial itself
       on a list that will one day be thousands long. Who bought a unit and when
       is a question the sale already answers: the document holds the customer
       and the date, and the serial reports join through `sold_doc_id` to show
       them. The Status badge here says whether a unit has gone, which is all
       this screen needs. */
    {
      key: 'warranty',
      header: 'Warranty until',
      cell: (row) => <span className="text-sm text-ink-2">{formatDate(row.warrantyUntil)}</span>,
      sortValue: (row) => row.warrantyUntil ?? '',
    },
  ]

  return (
    <div className="flex flex-col gap-5 p-6">
      <p className="text-sm text-muted">
        Every individual unit of this product. Serials are captured here and marked sold
        automatically when the unit goes out, so the shop can answer “who bought this one” when it
        comes back under warranty. Capturing a number here also brings that unit into stock, so the
        quantity on hand keeps step with the units listed below.
      </p>

      {/* One figure, not two.

          This showed "Serials captured" beside "Quantity on hand", which was
          the second invariant made visible — in-stock serials must equal stock
          on hand. It stopped earning its place once capture began moving the
          quantity with it: from this screen the two now rise together, so a
          reader saw two tiles that always matched and reasonably wondered what
          the difference was meant to be. The count is on the tab badge and in
          the rows below in any case.

          The drift badge stays, because drift has not stopped being possible —
          it just cannot come from HERE any more. Goods received on a purchase
          receipt whose serials were never captured still land as quantity with
          no units under it, and this screen is where someone would come to fix
          that. */}
      <div className="flex flex-col gap-3 rounded-card border border-border p-4">
        <div className="flex flex-wrap items-center gap-6">
          <div>
            <span className="block text-xs text-muted">Quantity on hand</span>
            <span className="numeric text-lg font-semibold text-ink">
              {stockOnHand.toLocaleString('en-ZA')}
            </span>
          </div>
          {Math.abs(drift) > 0.0005 && (
            /* Warning, not danger: a receipt captured without its numbers is an
               ordinary half-finished job, and red on routine work trains people
               to ignore red. */
            <Badge tone="warning">
              {drift > 0
                ? `${drift.toLocaleString('en-ZA')} unit(s) on hand still need a serial number`
                : `${Math.abs(drift).toLocaleString('en-ZA')} more serial(s) captured than units on hand`}
            </Badge>
          )}
        </div>

        {/* Only when they disagree. Someone whose figures already match does not
            need the mechanism explained to them. */}
        {Math.abs(drift) > 0.0005 && (
          <p className="text-xs text-muted">
            {drift > 0
              ? 'These units were received without their serial numbers. Add them above.'
              : 'More units are recorded here than the stock figure says you hold. Write off the ones you no longer have, or check what left without being marked sold.'}
          </p>
        )}
      </div>

      {addState.error && (
        <p role="alert" className="flex items-center gap-2 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
          <StatusError size={15} />
          {addState.error}
        </p>
      )}
      {addState.message && (
        <p className="flex items-center gap-2 rounded-md bg-success-soft px-3 py-2 text-sm text-success-ink">
          <StatusSuccess size={15} />
          {addState.message}
        </p>
      )}
      {/* The edit's own confirmation, up here with the capture one rather than
          inside the panel — the panel closes on success, so a message living in
          it would unmount at the moment it had something to say. */}
      {editState.message && (
        <p className="flex items-center gap-2 rounded-md bg-success-soft px-3 py-2 text-sm text-success-ink">
          <StatusSuccess size={15} />
          {editState.message}
        </p>
      )}

      <div className="flex flex-col gap-4 rounded-card border border-border p-4">
        <span className="text-sm font-medium text-ink">Capture serial numbers</span>

        <Field
          label="Serial numbers"
          hint="One per line, or separated by commas. Duplicates are skipped and named."
        >
          <Textarea
            name="serials"
            form={CAPTURE_FORM}
            rows={4}
            placeholder={'SN-000123\nSN-000124'}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Cost each (excl. VAT)" hint="Applied to every serial in this batch">
            <Input name="costExcl" form={CAPTURE_FORM} inputMode="decimal" placeholder="0.00" />
          </Field>
          <Field label="Warranty until" hint="Optional — the manufacturer's expiry date">
            <Input name="warrantyUntil" form={CAPTURE_FORM} type="date" />
          </Field>
        </div>

        <div>
          <Button type="submit" form={CAPTURE_FORM} variant="primary">
            <Plus size={15} />
            Add serials
          </Button>
        </div>

        {/* Says where the stock comes from, because "adding" units on a product
            screen is the kind of thing an auditor asks about. Each capture
            writes a stock adjustment under the user's own name, and it shows in
            the movement history like any other. */}
        <p className="text-xs text-muted">
          Each number captured here adds one unit to stock as an adjustment, recorded against your
          name. Units arriving from a supplier should be received on a purchase receipt instead, so
          the cost and the supplier are recorded with them.
        </p>
      </div>

      {serials.length === 0 ? (
        <EmptyState
          title="No serial numbers captured"
          hint="Add the numbers off the delivery note above. A serial product cannot be sold until its units are captured."
        />
      ) : (
        /* The bar shows even when the open slice is empty — it is how somebody
           gets back out of an empty tab, and hiding it would strand them. */
        <div className="flex flex-col gap-4">
          <SegmentedControl
            options={sliceOptions}
            value={slice}
            onChange={setSlice}
            aria-label="Which units to show"
          />

          {visible.length === 0 ? (
            <EmptyState title={SLICE_EMPTY[slice].title} hint={SLICE_EMPTY[slice].hint} />
          ) : (
            <DataTable
              columns={columns}
              rows={visible}
              getRowKey={(row) => row.id}
              actions={(row) => (
                <div className="flex items-center gap-1">
                  {/* On EVERY unit, whatever its status — including sold and
                      written-off ones. That is the point rather than an
                      oversight: the warranty question is asked about units that
                      have LEFT, so refusing the correction once a unit is sold
                      would refuse it in exactly the case it exists for. */}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEditing(row)
                      setWritingOff(null)
                    }}
                  >
                    <Pencil size={15} />
                    Edit
                  </Button>
                  {(row.status === 'in_stock' || row.status === 'returned') && (
                    <Button
                      type="button"
                      variant="danger-ghost"
                      size="sm"
                      onClick={() => {
                        setWritingOff(row)
                        setEditing(null)
                      }}
                    >
                      <Ban size={15} />
                      Write off
                    </Button>
                  )}
                </div>
              )}
            />
          )}
        </div>
      )}

      {/*
        Correcting what is known about one unit.

        `key` on the panel, not just on the inputs: the fields are uncontrolled
        (defaultValue), so opening Edit on a second unit while the first was
        still open would leave the previous unit's date in the boxes above the
        new unit's number. Keying the panel to the serial id remounts it, which
        is what makes each open start from the unit actually being edited.
      */}
      {/*
        A DIALOG rather than a panel under the table.

        The row being edited can be anywhere in a list that grows a row per unit
        forever, so a panel at the bottom put the fields a long scroll away from
        the serial they belonged to — on a product with fifty units, clicking
        Edit appeared to do nothing at all. A dialog comes to the reader, names
        the unit in its own title, and dims the table so there is no question
        which row is being changed.

        Mounted only while a unit is being edited, so the uncontrolled fields
        inside start from that unit's values every time — the same reason the
        keys below exist, and the reason `editing` is the whole condition rather
        than `open={editing !== null}` on a permanently-mounted dialog.
      */}
      {editing && (
        <Modal
          open
          onClose={() => setEditing(null)}
          title={`Edit serial ${editing.serial}`}
          description="The warranty date is what the counter checks a claim against."
          size="md"
          /* Half-typed work: a stray click on the backdrop must not discard it —
             the same call ContactsPanel makes for the same reason. */
          closeOnBackdrop={false}
          footer={
            <>
              <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              {/* In the FOOTER, not the body: a dialog's body scrolls at 60vh,
                  and a primary button living in it can end up below the fold. */}
              <Button type="submit" form={EDIT_FORM} variant="primary">
                Save changes
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            {editState.error && (
              <p role="alert" className="text-sm text-danger">
                {editState.error}
              </p>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Warranty until"
                hint="The manufacturer's expiry date. Leave empty if there is none."
              >
                {/* Keyed on the UNIT.
                    These are uncontrolled inputs, so `defaultValue` is only read
                    when the element is first created. Belt and braces alongside
                    the dialog only being mounted while a unit is being edited —
                    remounting is what makes opening Edit on a second unit show
                    THAT unit's date rather than the last one's.

                    Note there is a second input named `warrantyUntil` on this
                    screen, in the capture box above. They stay separate because
                    each names its own form via `form={id}` — verified in the
                    browser: the edit form submits the unit's date while the
                    capture box independently holds whatever was typed there. */}
                <Input
                  key={`warranty-${editing.id}`}
                  name="warrantyUntil"
                  form={EDIT_FORM}
                  type="date"
                  defaultValue={editing.warrantyUntil ?? ''}
                />
              </Field>
              <Field label="Note" hint="Anything worth keeping against this unit">
                <Input
                  key={`note-${editing.id}`}
                  name="note"
                  form={EDIT_FORM}
                  maxLength={190}
                  defaultValue={editing.note ?? ''}
                />
              </Field>
            </div>
            <input type="hidden" name="serialId" form={EDIT_FORM} value={editing.id} />
            {/* Says the edit is recorded, before it is made rather than after.
                The people most likely to change a warranty date are the people
                who should know somebody can see that they did. */}
            <p className="text-xs text-muted">
              Changes are recorded against your name in the audit trail, with the old and new
              values.
            </p>
          </div>
        </Modal>
      )}

      {writingOff && (
        <div className="flex flex-col gap-3 rounded-card border border-danger p-4">
          <span className="text-sm font-medium text-ink">
            Write off serial <span className="numeric">{writingOff.serial}</span>
          </span>
          {offState.error && (
            <p role="alert" className="text-sm text-danger">
              {offState.error}
            </p>
          )}
          <Field label="Reason" hint="Lost, stolen or scrapped — kept on the unit's history">
            <Input name="reason" form={WRITEOFF_FORM} maxLength={190} />
          </Field>
          <input type="hidden" name="serialId" form={WRITEOFF_FORM} value={writingOff.id} />
          <div className="flex gap-2">
            <Button type="submit" form={WRITEOFF_FORM} variant="danger">
              Write it off
            </Button>
            <Button type="button" variant="ghost" onClick={() => setWritingOff(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* The real <form> elements the controls above submit into, kept empty
          and separate so each button targets exactly one of them. */}
      <form id={CAPTURE_FORM} action={addAction}>
        <input type="hidden" name="productId" value={productId} />
      </form>
      <form id={WRITEOFF_FORM} action={offAction}>
        <input type="hidden" name="productId" value={productId} />
      </form>
      <form id={EDIT_FORM} action={editAction}>
        <input type="hidden" name="productId" value={productId} />
      </form>
    </div>
  )
}

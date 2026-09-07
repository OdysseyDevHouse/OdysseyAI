'use client'

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import {
  Badge,
  Button,
  Checkbox,
  ConfirmModal,
  CurrencyInput,
  Field,
  Input,
  Modal,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_NUMERIC,
  TABLE_TD,
  TABLE_TD_INPUT,
  TABLE_TH,
  Textarea,
  useToast,
} from '@/components/ui'
import {
  buildGrid,
  gridProblem,
  parseAxisValues,
  regrid,
  type GridCell,
  type GridSeed,
} from '@/lib/variantGrid'
import {
  createVariantGridAction,
  gridSeedAction,
  type GridSeedData,
} from '@/app/(app)/products/variantActions'

/**
 * Setting up a whole size × colour range in one dialog.
 *
 * ── THE PROBLEM THIS SOLVES ──────────────────────────────────────────────
 *
 * The Variants panel could only ATTACH a product that already existed, which
 * is the right shape for "I already sell the small, now group it with the
 * medium" and the wrong shape for the ordinary case. A shoe in five sizes and
 * three colours is fifteen products that do not exist yet, and doing it the
 * old way meant fifteen trips through the new-product form followed by fifteen
 * searches in the panel — thirty forms to describe one shoe, with fifteen
 * chances to typo a code.
 *
 * Here it is two text boxes: the sizes, and the colours. The grid is the
 * multiplication, done for you.
 *
 * ── WHY THE GRID IS SHOWN, NOT JUST COUNTED ──────────────────────────────
 *
 * "This will create 15 products" is a number a person has to trust. The table
 * is the same information they can actually check — and it is where the two
 * things that genuinely differ per row get set: the code, which has to be
 * unique and is what they will scan, and the price, because a size 12 costs
 * more than a size 6 and that is most of the reason to have variants at all.
 *
 * ── WHY THE ROWS CAN BE UNTICKED ─────────────────────────────────────────
 *
 * A shop that carries black and white in every size but brown only in the big
 * ones has an INCOMPLETE grid, and that is normal rather than an error — the
 * till's picker already draws the gaps as unavailable (see VariantModal, and
 * the two-axis fixture on the Style Guide, which is deliberately incomplete).
 * Making somebody create fifteen and then delete four would be the wizard
 * undoing its own work.
 *
 * The expansion itself lives in `lib/variantGrid.ts` rather than here, because
 * the server builds the same rows when it writes them. Two copies would
 * disagree in the worst available way: the table would show one code and a
 * different one would be created.
 */

/**
 * One axis: what it is called, and the values it takes.
 *
 * Both halves in one component because they are one decision — a label with no
 * values creates nothing, and values under no label create children the till's
 * picker cannot caption. Splitting them let the two drift out of step in the
 * layout, which is how the first version ended up drawing the name twice.
 *
 * `fixedLabel` is the existing-group case: the name is settled, so it is stated
 * rather than offered.
 */
function AxisColumn({
  fixedLabel,
  label,
  onLabel,
  labelCaption,
  labelHint,
  values,
  onValues,
  placeholder,
  count,
}: {
  /** The group's own label, or null when it is still being chosen. */
  fixedLabel: string | null
  label: string
  onLabel: (value: string) => void
  labelCaption: string
  labelHint: string
  values: string
  onValues: (value: string) => void
  placeholder: string
  count: number
}) {
  const name = (fixedLabel ?? label).trim()
  // An axis with no name takes no values: on a new group the second box waits
  // for a label, and on an existing one-axis group there is no second axis to
  // fill in at all.
  const unnamed = name.length === 0

  return (
    <div className="flex flex-col gap-3">
      {fixedLabel === null ? (
        <Field label={labelCaption} hint={labelHint}>
          <Input value={label} onChange={(e) => onLabel(e.target.value)} placeholder={placeholder.split(',')[0].trim()} />
        </Field>
      ) : (
        <Field label="Varies by">
          {/* Not an Input: this is a settled fact rather than a box that looks
              editable and refuses to be. */}
          <p className="flex h-control items-center text-sm font-medium text-ink">
            {name || <span className="text-muted">This group has one axis</span>}
          </p>
        </Field>
      )}

      <Field
        label={unnamed ? 'Values' : `${name} values`}
        hint={
          unnamed
            ? 'Name the axis first.'
            : count > 0
              ? `${count} ${count === 1 ? 'value' : 'values'} — one per line, or comma separated.`
              : 'One per line, or comma separated.'
        }
      >
        {/* Two rows, not three. A list of sizes is usually one line long, and
            every row spent on an empty box here is a row of the grid below that
            has to be scrolled to instead — the box still scrolls itself for a
            shop that pastes forty values down a column. */}
        <Textarea
          rows={2}
          value={values}
          disabled={unnamed}
          onChange={(e) => onValues(e.target.value)}
          placeholder={placeholder}
        />
      </Field>
    </div>
  )
}

/** Blank until the dialog opens and reads the parent. */
const NO_SEED: GridSeed = {
  parentCode: '',
  parentDescription: '',
  axis1Values: [],
  axis2Values: [],
  costExcl: 0,
  sellIncl: 0,
}

export default function VariantWizard({
  open,
  productId,
  onClose,
  onCreated,
  /** Already a group? Then the axes are fixed and only rows are being added. */
  existingAxes,
}: {
  open: boolean
  productId: number
  onClose: () => void
  onCreated: () => void
  existingAxes: { position: 1 | 2; label: string }[] | null
}) {
  const toast = useToast()
  const [busy, startAction] = useTransition()

  const [seedData, setSeedData] = useState<GridSeedData | null>(null)
  const [label1, setLabel1] = useState('Size')
  const [label2, setLabel2] = useState('Colour')
  const [raw1, setRaw1] = useState('')
  const [raw2, setRaw2] = useState('')
  const [cells, setCells] = useState<GridCell[]>([])
  const [confirmingClose, setConfirmingClose] = useState(false)

  /* The seed the CURRENT cells were generated from.
     regrid needs it to tell "this code is still the one we generated" from
     "this code was typed" — comparing against the new seed would call a
     generated code hand-typed the moment the parent was renamed, and then
     stop following the rename it was supposed to follow. */
  const lastSeed = useRef<GridSeed>(NO_SEED)

  /* Read the parent once per opening. Not on mount: the dialog is rendered
     closed on every product screen, and a read per product page for a dialog
     almost nobody opens is a read wasted. */
  useEffect(() => {
    if (!open) return
    let live = true
    startAction(async () => {
      const data = await gridSeedAction(productId)
      if (!live || !data) return
      setSeedData(data)
    })
    return () => {
      live = false
    }
  }, [open, productId])

  /* Reset when the dialog closes, so re-opening it is a fresh grid rather than
     yesterday's half-filled one. */
  useEffect(() => {
    if (open) return
    setSeedData(null)
    setRaw1('')
    setRaw2('')
    setCells([])
    setConfirmingClose(false)
    lastSeed.current = NO_SEED
  }, [open])

  /* The group's own labels win when it already has them: a group set up as
     Size × Colour cannot gain a third axis, and offering to rename them from
     here would rename them for children already on the shelf. */
  const axisOne = existingAxes?.find((a) => a.position === 1)?.label ?? label1
  const axisTwo = existingAxes
    ? (existingAxes.find((a) => a.position === 2)?.label ?? '')
    : label2
  const axesFixed = existingAxes !== null && existingAxes.length > 0

  const values1 = useMemo(() => parseAxisValues(raw1), [raw1])
  const values2 = useMemo(() => parseAxisValues(raw2), [raw2])

  const seed: GridSeed = useMemo(
    () => ({
      parentCode: seedData?.code ?? '',
      parentDescription: seedData?.description ?? '',
      axis1Values: values1,
      // A group whose second axis has no label has one axis, so a second list
      // of values would produce children the picker could not caption.
      axis2Values: axisTwo.trim() ? values2 : [],
      costExcl: seedData?.costExcl ?? 0,
      sellIncl: seedData?.sellIncl ?? 0,
    }),
    [seedData, values1, values2, axisTwo],
  )

  /* Re-expand whenever the lists change, KEEPING every edit that survives.
     Adding a fourth colour must not wipe the prices just typed into the first
     twelve rows — see regrid. */
  useEffect(() => {
    setCells((previous) =>
      previous.length === 0 && lastSeed.current === NO_SEED
        ? buildGrid(seed)
        : regrid(seed, previous, lastSeed.current),
    )
    lastSeed.current = seed
  }, [seed])

  function editCell(key: string, patch: Partial<GridCell>) {
    setCells((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  }

  /*
   * ── CLOSING WITHOUT LOSING THE GRID ──────────────────────────────────────
   *
   * Nothing here is saved until Create is pressed — the whole grid lives in
   * this component — so every way out of the dialog throws away however many
   * codes and prices were typed. That is fine when nothing was typed and quite
   * bad when fifteen rows were, and the two cases are worth telling apart: a
   * confirm on an empty dialog is a prompt that trains people to dismiss
   * prompts.
   *
   * "Something to lose" is deliberately the AXIS LISTS rather than the cells,
   * because the cells are derived from them — if there are values typed there
   * is a grid, and if there are none there is nothing but two blank boxes.
   */
  const hasWork = raw1.trim().length > 0 || raw2.trim().length > 0

  function requestClose() {
    if (hasWork && !busy) {
      setConfirmingClose(true)
      return
    }
    onClose()
  }

  function discardAndClose() {
    setConfirmingClose(false)
    onClose()
  }

  const included = cells.filter((c) => c.include)
  const problem = cells.length === 0 ? null : gridProblem(cells)

  function save() {
    startAction(async () => {
      const result = await createVariantGridAction({
        parentId: productId,
        axisLabels: axesFixed ? [] : [axisOne, axisTwo].filter((l) => l.trim()),
        rows: included.map((cell) => ({
          axis1: cell.axis1,
          axis2: cell.axis2,
          code: cell.code,
          description: cell.description,
          barcode: cell.barcode,
          costExcl: cell.costExcl,
          sellIncl: cell.sellIncl,
        })),
        priceStructureId: seedData?.priceStructureId ?? null,
      })

      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(
        `${result.created} ${result.created === 1 ? 'variant' : 'variants'} created.`,
      )
      onCreated()
      onClose()
    })
  }

  return (
    <>
    <Modal
      open={open}
      onClose={requestClose}
      /* A STRAY CLICK MUST NOT DESTROY THE GRID.
         Fifteen rows of codes and prices is real work, and the backdrop is the
         easiest thing in the dialog to hit by accident — one click beside the
         panel and it was all gone with nothing asked and nothing to undo. The
         click now goes through requestClose like every other way out, which
         asks first when there is something to lose. */
      closeOnBackdrop={false}
      size="xl"
      /* The grid is the reason this dialog exists, and the default 60vh cap
         made it read through a letterbox — six rows of fifteen with empty
         desktop above and below the panel.
         `bodyPins` rather than `bodyGrows`, because the two things here scroll
         differently: the axis boxes must STAY PUT while the grid is checked,
         or changing a size means scrolling back up to find the box you type it
         in. bodyGrows scrolls the body as one and would take them with it.
         `bodyTall` with it, because bodyPins' own 72vh is a safe fraction
         rather than a correct one: it left 150px of empty panel above and
         below a grid that was already scrolling. bodyTall reserves the header,
         footer and the panel's margin instead — which is the breath at top and
         bottom — and gives the rest to the table.

         Still a cap rather than a height, so a one-axis group with three sizes
         opens as a short dialog. */
      bodyPins
      bodyTall
      title="Set up variants"
      description={
        seedData
          ? `Every combination becomes its own product under ${seedData.description}.`
          : 'Loading…'
      }
      footer={
        <>
          {/* The count is the answer to "what is about to happen", so it sits
              beside the button that makes it happen rather than at the top of
              a dialog the person has scrolled past. */}
          <span className="mr-auto text-sm text-muted">
            {included.length === 0
              ? 'Nothing to create yet.'
              : `${included.length} ${included.length === 1 ? 'product' : 'products'} will be created.`}
          </span>
          {/* Through requestClose like the backdrop and Escape: three ways out
              of one dialog that behaved differently would be three chances to
              lose the grid, and the one you happened to use would decide. */}
          <Button variant="ghost" onClick={requestClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={save}
            disabled={busy || included.length === 0 || problem !== null || !seedData}
          >
            Create {included.length > 0 ? included.length : ''}{' '}
            {included.length === 1 ? 'variant' : 'variants'}
          </Button>
        </>
      }
    >
      {/* ── The two lists ─────────────────────────────────────────────────
          One column per axis: what it is CALLED above what its values ARE.
          On an existing group the name is settled and only the values box is
          drawn — renaming an axis from here would rename it for children
          already on the shelf.

          `shrink-0` because the body is a flex column under `bodyPins`: without
          it these boxes are squeezed by the grid below rather than pinned above
          it, which is the same crush a scrolling pane always applies to a
          sibling that has not claimed its height. */}
      <div className="grid shrink-0 gap-4 sm:grid-cols-2">
        <AxisColumn
          fixedLabel={axesFixed ? axisOne : null}
          label={label1}
          onLabel={setLabel1}
          labelCaption="Varies by"
          labelHint="What tells them apart — Size, Length, Pack."
          values={raw1}
          onValues={setRaw1}
          placeholder="6, 7, 8, 9, 10"
          count={values1.length}
        />
        <AxisColumn
          fixedLabel={axesFixed ? axisTwo || '' : null}
          label={label2}
          onLabel={setLabel2}
          labelCaption="And by (optional)"
          labelHint="Leave blank for one axis only."
          values={raw2}
          onValues={setRaw2}
          placeholder="Black, White, Brown"
          count={values2.length}
        />
      </div>

      {/* ── The grid ──────────────────────────────────────────────────── */}
      {cells.length === 0 ? (
        /* Not an EmptyState: nothing is missing and nothing has gone wrong —
           the person simply has not typed yet, and a bordered empty-state box
           mid-dialog reads as a failure. */
        <p className="mt-5 shrink-0 rounded-card bg-surface-2 px-4 py-6 text-center text-sm text-muted">
          List the {axisOne.toLowerCase() || 'values'}
          {axisTwo ? ` and ${axisTwo.toLowerCase()}` : ''} above and every combination appears
          here, ready to check before it is created.
        </p>
      ) : (
        /* `flex-1 min-h-0` — this section takes whatever height the pinned
           lists above it leave, and `min-h-0` is what lets it be SHORTER than
           its content so the table inside overflows instead of growing the
           panel past the window. */
        <div className="mt-5 flex min-h-0 flex-1 flex-col">
          <div className="mb-2 flex shrink-0 items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-ink">
              {cells.length} {cells.length === 1 ? 'combination' : 'combinations'}
            </h3>
            {/* Untick, rather than "delete row": the grid is a multiplication,
                so a removed row would reappear the moment a value changed. */}
            <Checkbox
              label="Create all"
              checked={included.length === cells.length}
              indeterminate={included.length > 0 && included.length < cells.length}
              onChange={(e) =>
                setCells((rows) => rows.map((r) => ({ ...r, include: e.target.checked })))
              }
            />
          </div>

          {/* THE one thing in this dialog that scrolls, and it takes every
              pixel the window has spare rather than a fixed 24rem — fifteen
              rows read through a six-row letterbox was the complaint.

              Scrolls BOTH ways, and the table keeps a floor width rather than
              letting eight columns crush the code box down to six characters —
              a code you cannot read is a code you cannot check, which is most
              of what this table is for. */}
          <div className="min-h-0 flex-1 overflow-auto rounded-card border border-border">
            <table className={`${TABLE} min-w-[58rem]`}>
              <thead className="sticky top-0 z-10 bg-surface-2">
                <tr className={TABLE_HEAD_ROW}>
                  <th className={`${TABLE_TH} w-10`} />
                  <th className={TABLE_TH}>{axisOne || 'Variant'}</th>
                  {axisTwo && <th className={TABLE_TH}>{axisTwo}</th>}
                  <th className={TABLE_TH}>Code</th>
                  <th className={TABLE_TH}>Description</th>
                  <th className={TABLE_TH}>Barcode</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Cost excl.</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>
                    {seedData?.structureName ?? 'Selling'} incl.
                  </th>
                </tr>
              </thead>
              <tbody>
                {cells.map((cell) => (
                  <tr
                    key={cell.key}
                    className={`border-b border-border last:border-0 ${
                      cell.include ? '' : 'opacity-45'
                    }`}
                  >
                    <td className={TABLE_TD}>
                      <Checkbox
                        checked={cell.include}
                        aria-label={`Create ${cell.axis1} ${cell.axis2}`}
                        onChange={(e) => editCell(cell.key, { include: e.target.checked })}
                      />
                    </td>
                    <td className={`${TABLE_TD} whitespace-nowrap font-medium text-ink`}>
                      {cell.axis1 || '—'}
                    </td>
                    {axisTwo && (
                      <td className={`${TABLE_TD} whitespace-nowrap`}>{cell.axis2 || '—'}</td>
                    )}
                    {/* The code is the thing that has to be unique and the
                        thing that gets scanned, so it is the one column that
                        must never truncate — a derived code runs to about 18
                        characters, and reading half of it is reading none. */}
                    <td className={`${TABLE_TD_INPUT} w-[12rem] min-w-[12rem]`}>
                      <Input
                        value={cell.code}
                        disabled={!cell.include}
                        placeholder={seedData?.autoCode ? 'Auto' : 'Required'}
                        onChange={(e) => editCell(cell.key, { code: e.target.value })}
                      />
                    </td>
                    {/* The only column that gives: everything else here has a
                        length it cannot go under, and a description that has
                        run out of room is still readable by clicking into it. */}
                    <td className={`${TABLE_TD_INPUT} min-w-[12rem]`}>
                      <Input
                        value={cell.description}
                        disabled={!cell.include}
                        onChange={(e) => editCell(cell.key, { description: e.target.value })}
                      />
                    </td>
                    <td className={`${TABLE_TD_INPUT} w-[9rem] min-w-[9rem]`}>
                      <Input
                        value={cell.barcode}
                        disabled={!cell.include}
                        placeholder="Optional"
                        onChange={(e) => editCell(cell.key, { barcode: e.target.value })}
                      />
                    </td>
                    <td className={`${TABLE_TD_INPUT} w-[7rem] min-w-[7rem]`}>
                      <CurrencyInput
                        value={cell.costExcl}
                        disabled={!cell.include}
                        onChange={(e) =>
                          editCell(cell.key, { costExcl: Number(e.target.value) || 0 })
                        }
                      />
                    </td>
                    <td className={`${TABLE_TD_INPUT} w-[7rem] min-w-[7rem]`}>
                      <CurrencyInput
                        value={cell.sellIncl}
                        disabled={!cell.include}
                        onChange={(e) =>
                          editCell(cell.key, { sellIncl: Number(e.target.value) || 0 })
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* The reason Create is disabled, said where the eye already is
              rather than only in a toast after the click. */}
          {problem && (
            <p className="mt-2.5 flex shrink-0 items-center gap-2 text-sm text-danger">
              <Badge tone="danger">Fix</Badge>
              {problem}
            </p>
          )}
        </div>
      )}
    </Modal>

    {/* Over the wizard, not instead of it — a <dialog> opened with showModal()
        sits in the top layer, so this paints above the panel behind it and the
        grid stays visible underneath while the question is answered. Answering
        "Keep editing" returns to it untouched. */}
    <ConfirmModal
      open={confirmingClose}
      onClose={() => setConfirmingClose(false)}
      onConfirm={discardAndClose}
      title="Discard these variants?"
      message={
        included.length > 0
          ? `The ${included.length} ${
              included.length === 1 ? 'variant' : 'variants'
            } set up here have not been created yet. Closing now loses the codes and prices you have typed.`
          : 'The values you have typed here have not been created yet, and closing now loses them.'
      }
      confirmLabel="Discard"
      cancelLabel="Keep editing"
    />
    </>
  )
}

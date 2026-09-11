'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge, Button, ButtonLink, Callout, Card, CardBody, CardFooter, CardHeader,
  DataTable, EmptyState, Field, FileInput, Icons, LoadingBar, MiniStat, Modal,
  SegmentedControl, Select, TableSkeleton, useToast, type Column,
} from '@/components/ui'
import { readFile, aliasSet } from '@/lib/import/sheet'
import { autoMap, missingRequired, unmappedColumns, type Mapping } from '@/lib/import/map'
// From totals, not apply: apply.ts is server-only, and the wizard folds each
// batch's outcomes here in the browser as they come back.
import { BATCH_SIZE, emptyTotals, fold, type RunTotals } from '@/lib/import/totals'
import {
  prepareImportAction, planImportAction, applyBatchAction,
  type FieldDescriptor, type WirePlan,
} from '../actions'
import type { ExistingMode, RowOutcome } from '@/lib/import/spec'

/**
 * The import wizard.
 *
 * Four steps as stacked cards rather than a stepper, following the cashbook
 * importer — the kit has no stepper, and a wizard that hides the file you chose
 * behind a completed step makes correcting a mapping harder than it needs to be.
 * Everything stays on screen and collapses as it is settled.
 *
 * The two things this screen exists to make visible:
 *
 *  - what was UNDERSTOOD, before anything is written. A mapping is a guess, and
 *    a guess nobody can see is how a whole column of costs silently goes in as
 *    zero.
 *  - what will NOT import, as prominently as what will. An import screen that
 *    leads with '18,000 ready' and buries '2,000 skipped' is how two thousand
 *    products end up missing with nobody the wiser.
 */

type Stage = 'file' | 'map' | 'review' | 'applying' | 'done'

export type ImportClientProps = {
  entity: string
  title: string
  singular: string
  /** Where the imported records live, for the finish-line link. */
  listHref: string
}

export default function ImportClient({ entity, title, singular, listHref }: ImportClientProps) {
  const toast = useToast()
  const router = useRouter()

  const [fields, setFields] = useState<FieldDescriptor[] | null>(null)
  const [stage, setStage] = useState<Stage>('file')
  const [busy, setBusy] = useState(false)

  const [filename, setFilename] = useState('')
  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<string[][]>([])
  const [headerLine, setHeaderLine] = useState(1)
  const [mapping, setMapping] = useState<Mapping>({})
  const [mode, setMode] = useState<ExistingMode>('skip')

  const [plan, setPlan] = useState<WirePlan | null>(null)
  const [totals, setTotals] = useState<RunTotals>(emptyTotals())
  const [progress, setProgress] = useState(0)
  const [cursor, setCursor] = useState(0)
  const [halted, setHalted] = useState<string | null>(null)
  const [tab, setTab] = useState<'problems' | 'ready'>('problems')

  const fileRef = useRef<HTMLInputElement>(null)
  /**
   * The review card, so a check can bring its own answer into view.
   *
   * Checking a 2,000-row file leaves the verdict two screens below the button
   * that produced it, which reads as the button having done nothing at all —
   * especially when the answer is "everything was skipped" and no count moved.
   */
  const reviewRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    prepareImportAction(entity).then((result) => {
      if (!live) return
      if (result.ok) setFields(result.fields)
      else toast.error(result.error)
    })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity])

  const missing = useMemo(
    () => (fields ? missingRequired(fields, mapping) : []),
    [fields, mapping],
  )
  const ignored = useMemo(
    () => unmappedColumns(headers, mapping),
    [headers, mapping],
  )

  async function chooseFile(file: File | null) {
    if (!file || !fields) return
    setBusy(true)
    try {
      const read = await readFile(file, aliasSet(fields))
      if (!read.ok) {
        toast.error(read.error)
        // A file input keeps its selection, so re-choosing the same corrected
        // file would fire no change event without this.
        if (fileRef.current) fileRef.current.value = ''
        return
      }

      setFilename(file.name)
      setHeaders(read.sheet.headers)
      setRows(read.sheet.rows)
      setHeaderLine(read.sheet.headerLine)
      setMapping(autoMap(read.sheet.headers, fields))
      setPlan(null)
      setStage('map')
    } finally {
      setBusy(false)
    }
  }

  /**
   * Checks the file and takes the user TO the answer.
   *
   * `next` overrides the mode for this one check, so "update them instead" can
   * change the choice and re-check in a single press rather than asking the
   * user to scroll back up, change a dropdown and find the button again.
   */
  async function review(next?: ExistingMode) {
    const runMode = next ?? mode
    if (next && next !== mode) setMode(next)

    setBusy(true)
    try {
      const result = await planImportAction({
        entity, headers, rows, mapping, mode: runMode, headerLine,
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setPlan(result.plan)
      setTab(result.plan.problems.length > 0 ? 'problems' : 'ready')
      setStage('review')
      // After paint, or the card being scrolled to has not been laid out yet.
      requestAnimationFrame(() => {
        reviewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    } finally {
      setBusy(false)
    }
  }

  /**
   * Writes the file in chunks.
   *
   * Sequential and halting: two batches at once would race on creating the same
   * department, and continuing past a failed batch would leave a run that says
   * it finished with a 200-row hole nobody can name. Resuming re-runs from the
   * failed offset, which is safe with no bookkeeping because rows already
   * written come back as existing.
   */
  async function apply(from = 0) {
    if (!plan) return
    setStage('applying')
    setHalted(null)
    setBusy(true)

    const mapped = Object.entries(mapping).filter(([, c]) => c != null).map(([k]) => k)
    let running = from === 0 ? emptyTotals() : totals

    try {
      for (let i = from; i < plan.ready.length; i += BATCH_SIZE) {
        const chunk = plan.ready.slice(i, i + BATCH_SIZE)
        const result = await applyBatchAction({
          entity, mode, offset: i, mapped, dateFormat: plan.dateFormat,
          rows: chunk.map((r) => ({ line: r.line, code: r.code, draft: r.draft })),
        })

        if (!result.ok) {
          setHalted(result.error)
          setCursor(i)
          setTotals(running)
          setStage('review')
          toast.error(`Stopped at row ${chunk[0]?.line ?? i} — ${result.error}`)
          return
        }

        running = fold(running, result.outcomes as RowOutcome[])
        setTotals(running)
        setProgress(Math.min(i + BATCH_SIZE, plan.ready.length))
      }

      setCursor(plan.ready.length)
      setStage('done')
      announce(running)
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  function announce(result: RunTotals) {
    const written = result.created + result.updated
    if (written === 0) {
      toast.error(`Nothing was imported — ${result.problems[0]?.reason ?? 'every row was refused.'}`)
      return
    }

    // Rows refused at the review step count here as well. A toast that says
    // "2 imported" about a file of four, and calls it a success, is how the
    // other two get forgotten.
    const refused = result.failed + (plan?.counts.problem ?? 0)
    if (refused > 0 || result.partial > 0) {
      toast.info(
        `${written} ${written === 1 ? singular : title.toLowerCase()} written · ` +
        `${refused} not imported${result.partial > 0 ? ` · ${result.partial} incomplete` : ''}`,
      )
      return
    }
    toast.success(`${written} ${written === 1 ? singular : title.toLowerCase()} imported`)
  }

  function startOver() {
    setStage('file')
    setPlan(null)
    setTotals(emptyTotals())
    setProgress(0)
    setCursor(0)
    setHalted(null)
    setFilename('')
    if (fileRef.current) fileRef.current.value = ''
  }

  if (!fields) {
    return (
      <Card aria-busy="true">
        <CardBody><TableSkeleton columns={3} rows={4} /></CardBody>
      </Card>
    )
  }

  return (
    <>
      {/* ── 1. The file ────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Choose the file"
          description="A .csv or .xlsx export. Nothing is written until you confirm at the end."
          action={
            <ButtonLink href={`/setup/import/${entity}/template`} variant="ghost" size="sm">
              <Icons.Download size={15} /> Template
            </ButtonLink>
          }
        />
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Spreadsheet"
              hint={filename ? `${rows.length.toLocaleString('en-ZA')} rows in ${filename}` : 'Headings can be anywhere in the first 30 lines.'}
            >
              <FileInput
                ref={fileRef}
                accept=".csv,.xlsx,.xls,.tsv,.txt"
                disabled={busy || stage === 'applying'}
                onChange={(e) => chooseFile(e.target.files?.[0] ?? null)}
              />
            </Field>
            <Field
              label="When a record already exists"
              hint={
                mode === 'skip'
                  ? 'Existing records are left exactly as they are.'
                  : 'Only the columns in your file are changed. Everything else is left alone.'
              }
            >
              <Select
                value={mode}
                disabled={stage === 'applying'}
                onChange={(e) => { setMode(e.target.value as ExistingMode); setPlan(null) }}
              >
                <option value="skip">Skip it</option>
                <option value="update">Update it from the file</option>
              </Select>
            </Field>
          </div>
        </CardBody>
      </Card>

      {/* ── 2. The mapping ─────────────────────────────────────────── */}
      {stage !== 'file' && (
        <Card>
          <CardHeader
            title="Check the columns"
            description="Matched by heading. Correct anything that went to the wrong field."
            action={<Badge tone="neutral">{`${Object.values(mapping).filter((v) => v != null).length} of ${headers.length} used`}</Badge>}
          />
          <CardBody>
            {missing.length > 0 && (
              <Callout tone="danger" title="A column this import cannot do without is missing" className="mb-4">
                {missing.map((f) => f.label).join(', ')} — add the column to your file, or point one of the
                columns below at it.
              </Callout>
            )}

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {fields.map((field) => (
                <Field
                  key={field.key}
                  label={field.required ? `${field.label} (required)` : field.label}
                  hint={field.hint}
                >
                  <Select
                    value={mapping[field.key] ?? ''}
                    disabled={stage === 'applying'}
                    invalid={field.required && mapping[field.key] == null}
                    onChange={(e) => {
                      const value = e.target.value === '' ? null : Number(e.target.value)
                      setMapping((prev) => ({ ...prev, [field.key]: value }))
                      setPlan(null)
                    }}
                  >
                    <option value="">— not in this file —</option>
                    {headers.map((header, index) => (
                      <option key={index} value={index}>{header || `Column ${index + 1}`}</option>
                    ))}
                  </Select>
                </Field>
              ))}
            </div>

            {ignored.length > 0 && (
              <p className="mt-4 text-sm text-muted">
                Ignored from your file: {ignored.join(', ')}.
              </p>
            )}
          </CardBody>
          <CardFooter>
            <Button
              variant={plan ? 'secondary' : 'primary'}
              disabled={busy || missing.length > 0 || stage === 'applying'}
              /* Wrapped, not passed: review() takes an optional mode, and a
                 bare handler would hand it the click event as one. */
              onClick={() => review()}
            >
              <Icons.Search size={15} /> {plan ? 'Check again' : 'Check the file'}
            </Button>
          </CardFooter>
        </Card>
      )}

      {/* ── 3. What will happen ────────────────────────────────────── */}
      {plan && stage !== 'done' && (
        <div ref={reviewRef} className="scroll-mt-4">
          <ReviewCard
            plan={plan}
            mode={mode}
            title={title}
            busy={busy || stage === 'applying'}
            halted={halted}
            tab={tab}
            onTab={setTab}
            onApply={() => apply(halted ? cursor : 0)}
            onUpdateInstead={() => review('update')}
          />
        </div>
      )}

      {/* ── 4. Writing ─────────────────────────────────────────────── */}
      {/*
        A DIALOG rather than a fourth card, and one with no way out.

        The card version sat below the review table, which on a file of two
        thousand rows is a screen the user has already scrolled past — so the
        one moment the screen must hold their attention was the one they could
        not see. The dialog also stops the file being re-chosen or the mapping
        edited while batches are still going up, which the inline version only
        prevented by disabling each control one at a time.

        No onClose, no footer: Escape is swallowed, the backdrop ignores
        clicks, and it closes itself when apply() leaves the 'applying' stage —
        on success, or on a halt that puts the review card back with a Resume.
      */}
      <Modal
        open={stage === 'applying' && plan !== null}
        onClose={() => {}}
        closeOnBackdrop={false}
        dismissible={false}
        title="Importing"
        description="This takes a moment on a large file. Everything written stays written."
        size="sm"
      >
        <div aria-busy="true">
          {/* The indeterminate sweep says "this is running"; the meter below
              says how far. Label suppressed on the sweep so a reader is not
              told twice — the meter carries the count. */}
          <LoadingBar label={null} className="mb-4" />
          <Progress done={progress} total={plan?.ready.length ?? 0} />
          <div className="mt-4 grid grid-cols-2 gap-3">
            <MiniStat label="Created" value={String(totals.created)} />
            <MiniStat label="Updated" value={String(totals.updated)} />
            <MiniStat label="Incomplete" value={String(totals.partial)} tone={totals.partial > 0 ? 'warning' : 'default'} />
            <MiniStat label="Refused" value={String(totals.failed)} tone={totals.failed > 0 ? 'danger' : 'default'} />
          </div>
          <p className="mt-4 text-sm text-muted">
            Leaving this page stops the import — anything not yet written can be imported again.
          </p>
        </div>
      </Modal>

      {/* ── The finish line ────────────────────────────────────────── */}
      {stage === 'done' && plan && (
        <Card>
          <CardHeader
            title="Done"
            description={
              `${totals.created} created · ${totals.updated} updated · ` +
              `${plan.counts.skip} skipped · ${plan.counts.problem} never left the file`
            }
            action={
              refusedTotal(totals, plan) > 0
                ? <Badge tone="warning">{`${refusedTotal(totals, plan)} need attention`}</Badge>
                : <Badge tone="success">Clean</Badge>
            }
          />
          {refusedTotal(totals, plan) > 0 ? (
            // The rows refused at the review step are shown here too. They are
            // the ones most likely to be forgotten — the review card that named
            // them is gone by now, and "2 created" on a file of 4 is a number
            // somebody will otherwise read as done.
            <OutcomeTable
              rows={[
                ...plan.problems.map((p) => ({
                  line: p.line,
                  code: p.code,
                  status: 'failed' as const,
                  reason: p.column ? `${p.column}: ${p.reason}` : p.reason,
                })),
                ...totals.problems,
              ]}
            />
          ) : (
            <CardBody>
              <EmptyState
                icon={<Icons.Check size={22} />}
                title="Every row went in"
                hint={`All ${totals.created + totals.updated} rows were written without a problem.`}
              />
            </CardBody>
          )}
          <CardFooter>
            <Button variant="ghost" onClick={startOver}>Import another file</Button>
            <ButtonLink href={listHref} variant="primary">
              View {title.toLowerCase()}
            </ButtonLink>
          </CardFooter>
        </Card>
      )}
    </>
  )
}

/**
 * Everything that did not cleanly go in — refused at review AND at write time.
 *
 * Counted together because the user does not care which step turned a row away;
 * they care how many rows of their file are not in the system.
 */
function refusedTotal(totals: RunTotals, plan: WirePlan): number {
  return totals.failed + totals.partial + plan.counts.problem
}

/* ── Review ──────────────────────────────────────────────────────────── */

function ReviewCard({
  plan, mode, title, busy, halted, tab, onTab, onApply, onUpdateInstead,
}: {
  plan: WirePlan
  mode: ExistingMode
  title: string
  busy: boolean
  halted: string | null
  tab: 'problems' | 'ready'
  onTab: (next: 'problems' | 'ready') => void
  onApply: () => void
  /** Switches to update mode and re-checks, for the all-skipped case. */
  onUpdateInstead: () => void
}) {
  const { counts } = plan

  /*
   * Nothing would be written, and WHY differs.
   *
   * A check that produces no work looks identical to a check that did not run:
   * the same card, the same four figures, a disabled button. So the card says
   * so in words, and names the cause — every row already on file and being
   * skipped is a different situation from every row having been refused, and
   * only the first one has a one-press answer.
   */
  const nothingToDo = plan.ready.length === 0 && !halted
  const allSkipped = nothingToDo && counts.skip > 0 && counts.problem === 0
  const allRefused = nothingToDo && counts.problem > 0 && counts.skip === 0

  const importButton = (
    <Button variant="primary" disabled={busy || plan.ready.length === 0} onClick={onApply}>
      <Icons.Upload size={15} />
      {halted
        ? 'Resume the import'
        : `Import ${plan.ready.length.toLocaleString('en-ZA')} ${plan.ready.length === 1 ? 'row' : 'rows'}`}
    </Button>
  )

  return (
    <Card>
      <CardHeader
        title="What will happen"
        description="Checked against what is already on file. Nothing has been written yet."
        /* The same button as the footer's, up here as well. The footer sits
           below a table of up to 200 rows, and on a two-thousand-row file that
           is a long scroll between deciding to import and being able to. */
        action={importButton}
      />
      <CardBody>
        {allSkipped && (
          <Callout
            tone="warning"
            title="Nothing would be imported"
            className="mb-4"
          >
            <p>
              All {counts.skip.toLocaleString('en-ZA')} rows in this file match{' '}
              {counts.skip === 1 ? 'a record' : 'records'} already on file, and existing records are
              being skipped.
            </p>
            <div className="mt-3">
              <Button variant="secondary" size="sm" disabled={busy} onClick={onUpdateInstead}>
                <Icons.Refresh size={15} /> Update them from the file instead
              </Button>
            </div>
          </Callout>
        )}

        {allRefused && (
          <Callout tone="danger" title="Nothing would be imported" className="mb-4">
            Every row was refused. Fix the reasons listed below in your file, then check it again.
          </Callout>
        )}

        {nothingToDo && !allSkipped && !allRefused && (
          <Callout tone="warning" title="Nothing would be imported" className="mb-4">
            {counts.skip.toLocaleString('en-ZA')} rows are already on file and are being skipped, and{' '}
            {counts.problem.toLocaleString('en-ZA')} were refused. Nothing is left to write.
          </Callout>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MiniStat label="To create" value={counts.create.toLocaleString('en-ZA')} tone={counts.create > 0 ? 'success' : 'default'} />
          <MiniStat label="To update" value={counts.update.toLocaleString('en-ZA')} tone={counts.update > 0 ? 'warning' : 'default'} />
          <MiniStat label="Skipped" value={counts.skip.toLocaleString('en-ZA')} />
          <MiniStat label="Refused" value={counts.problem.toLocaleString('en-ZA')} tone={counts.problem > 0 ? 'danger' : 'default'} />
        </div>

        {halted && (
          <Callout tone="danger" title="The import stopped part-way" className="mt-4">
            {halted} Everything written so far stays written — resuming picks up from where it stopped.
          </Callout>
        )}

        {!halted && counts.update > 0 && mode === 'update' && (
          <Callout tone="warning" title={`${counts.update.toLocaleString('en-ZA')} existing records will be changed`} className="mt-4">
            Only the columns in your file are written. Everything else on those records is left as it is.
            There is no undo.
          </Callout>
        )}

        {plan.dateFormat && (
          <p className="mt-4 text-sm text-muted">
            Dates in this file are being read as <strong className="text-ink">{plan.dateFormat}</strong>.
          </p>
        )}

        {plan.unresolved.length > 0 && (
          <div className="mt-4 space-y-3">
            {plan.unresolved.map((group) => (
              <Callout
                key={group.kind}
                tone="danger"
                title={`${group.values.length} value${group.values.length === 1 ? '' : 's'} in "${group.column}" are not on file`}
              >
                <ul className="mt-1 space-y-0.5">
                  {group.values.slice(0, 6).map((v) => (
                    <li key={v.value}>
                      {v.value} — {v.rows} row{v.rows === 1 ? '' : 's'}
                    </li>
                  ))}
                  {group.values.length > 6 && <li>…and {group.values.length - 6} more.</li>}
                </ul>
              </Callout>
            ))}
          </div>
        )}
      </CardBody>

      {(plan.problems.length > 0 || plan.ready.length > 0) && (
        <>
          <div className="border-t border-border px-5 py-3">
            <SegmentedControl
              value={tab}
              onChange={(next) => onTab(next as 'problems' | 'ready')}
              options={[
                {
                  value: 'problems',
                  label: `Will not import (${counts.problem})`,
                  icon: <Icons.StatusWarning size={15} />,
                },
                {
                  value: 'ready',
                  label: `Will import (${plan.ready.length})`,
                  icon: <Icons.StatusSuccess size={15} />,
                },
              ]}
            />
          </div>
          {tab === 'problems' ? <ProblemTable plan={plan} /> : <ReadyTable plan={plan} />}
        </>
      )}

      {/* The same button as the header's — built once, so the two can never
          disagree about whether there is anything to import. */}
      <CardFooter>{importButton}</CardFooter>
    </Card>
  )
}

type ProblemRow = WirePlan['problems'][number] & { key: number }

function ProblemTable({ plan }: { plan: WirePlan }) {
  const columns: Column<ProblemRow>[] = [
    { key: 'line', header: 'Row', numeric: true, cell: (r) => r.line, width: 'w-20' },
    { key: 'code', header: 'Code', cell: (r) => r.code || <span className="text-faint">—</span> },
    { key: 'column', header: 'Column', cell: (r) => r.column ?? <span className="text-faint">—</span> },
    { key: 'value', header: 'Value', cell: (r) => r.value ?? <span className="text-faint">—</span> },
    // Left in normal ink deliberately: the card's own heading carries the
    // alarm, and a column that is entirely red stops marking anything.
    { key: 'reason', header: 'Why', cell: (r) => r.reason },
  ]

  if (plan.problems.length === 0) {
    return (
      <CardBody>
        <EmptyState
          icon={<Icons.Check size={22} />}
          title="Nothing was refused"
          hint="Every row in the file can be imported."
        />
      </CardBody>
    )
  }

  return (
    <>
      <DataTable
        columns={columns}
        rows={plan.problems.slice(0, 100).map((p, key) => ({ ...p, key }))}
        getRowKey={(r) => r.key}
      />
      {plan.problems.length > 100 && (
        <p className="border-t border-border px-5 py-3 text-sm text-muted">
          Showing the first 100 of {plan.problems.length.toLocaleString('en-ZA')}. Fix these in the file and
          check it again.
        </p>
      )}
    </>
  )
}

type ReadyRow = { key: number; line: number; code: string; existingId: number | null }

function ReadyTable({ plan }: { plan: WirePlan }) {
  const columns: Column<ReadyRow>[] = [
    { key: 'line', header: 'Row', numeric: true, cell: (r) => r.line, width: 'w-20' },
    { key: 'code', header: 'Code', cell: (r) => r.code || <span className="text-faint">generated</span> },
    {
      key: 'what',
      header: 'What happens',
      cell: (r) =>
        r.existingId === null
          ? <Badge tone="success">Create</Badge>
          : <Badge tone="warning">Update</Badge>,
    },
  ]

  return (
    <>
      <DataTable
        columns={columns}
        rows={plan.ready.slice(0, 200).map((r, key) => ({
          key, line: r.line, code: r.code, existingId: r.existingId,
        }))}
        getRowKey={(r) => r.key}
        empty={{ title: 'Nothing to import', hint: 'Every row was either skipped or refused.' }}
      />
      {plan.ready.length > 200 && (
        <p className="border-t border-border px-5 py-3 text-sm text-muted">
          Showing the first 200 of {plan.ready.length.toLocaleString('en-ZA')}. All of them will import.
        </p>
      )}
    </>
  )
}

function OutcomeTable({ rows }: { rows: RowOutcome[] }) {
  const columns: Column<RowOutcome & { key: number }>[] = [
    { key: 'line', header: 'Row', numeric: true, cell: (r) => r.line, width: 'w-20' },
    { key: 'code', header: 'Code', cell: (r) => r.code || <span className="text-faint">—</span> },
    {
      key: 'status',
      header: 'Result',
      cell: (r) =>
        r.status === 'failed' ? <Badge tone="danger">Refused</Badge>
          : r.warnings?.length ? <Badge tone="warning">Incomplete</Badge>
          : <Badge tone="neutral">Skipped</Badge>,
    },
    {
      key: 'reason',
      header: 'Why',
      cell: (r) => r.reason ?? r.warnings?.map((w) => `${w.step}: ${w.reason}`).join(' · ') ?? '',
    },
  ]

  return (
    <>
      <DataTable
        columns={columns}
        rows={rows.slice(0, 200).map((r, key) => ({ ...r, key }))}
        getRowKey={(r) => r.key}
      />
      {rows.length > 200 && (
        <p className="border-t border-border px-5 py-3 text-sm text-muted">
          Showing the first 200 of {rows.length.toLocaleString('en-ZA')}.
        </p>
      )}
    </>
  )
}

/** A plain meter — the kit's MeterBar is for segmented totals, not progress. */
function Progress({ done, total }: { done: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100)
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-ink-2">
          {done.toLocaleString('en-ZA')} of {total.toLocaleString('en-ZA')}
        </span>
        <span className="numeric text-muted">{pct}%</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-pill bg-surface-2">
        <div
          className="h-full rounded-pill bg-brand transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

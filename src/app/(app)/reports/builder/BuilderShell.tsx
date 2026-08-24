'use client'

import { useCallback, useMemo, useRef, useState, useTransition, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  CardHeader,
  Callout,
  CategoryTile,
  ChoiceTile,
  EmptyState,
  Field,
  Icons,
  Input,
  Modal,
  NumberInput,
  Select,
  ToolbarSearch,
  useToast,
} from '@/components/ui'
import {
  DEFAULT_ROWS,
  emptySpec,
  isSummarised,
  MAX_ROWS,
  PERIOD_KEYS,
  PERIOD_LABELS,
  validateSpec,
  type CustomReportSpec,
  type PeriodKey,
} from '@/lib/reportBuilder/spec'
import { clientOutputColumns, findField, type ClientSource } from '@/lib/reportBuilder/clientTypes'
import { categoryIcon, categoryTone, sourceIcon, sourceTone } from '../categoryStyle'
import ColumnsPanel from './ColumnsPanel'
import FiltersPanel from './FiltersPanel'
import PreviewPanel from './PreviewPanel'
import { saveReportAction } from './actions'

/**
 * The builder.
 *
 * The PREVIEW is the build surface: it sits full width, front and centre, and
 * everything that shapes it lives in a compact toolbar above. The alternative —
 * a permanent column of configuration cards beside a narrowed preview — spends
 * a third of the screen on controls that are each touched once, and squeezes
 * the one thing you actually read while working.
 *
 * So the four editors (columns, filters, sorting, and what the report reads)
 * open as pop-ups instead. Their edits apply LIVE, so the preview visibly
 * re-runs behind the dimmed backdrop while you work; OK simply closes, and
 * Cancel restores the snapshot taken when the pop-up opened. That is what makes
 * a pop-up honest here — you are never editing blind and hoping.
 *
 * The spec is still the only state. Every panel edits it, the preview re-runs
 * from it, and saving stores exactly what is on screen — so what you see really
 * is what gets saved and scheduled.
 */
export type BuilderTemplate = {
  id: string
  name: string
  description: string
  source: string
  spec: CustomReportSpec
}

/** The pop-up editors the design toolbar offers. */
type PanelKey = 'data' | 'columns' | 'filters' | 'sort'

export default function BuilderShell({
  sources,
  initialSpec,
  savedId,
  templates = [],
}: {
  sources: ClientSource[]
  initialSpec: CustomReportSpec | null
  savedId: number | null
  templates?: BuilderTemplate[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [saving, startSaving] = useTransition()

  const [spec, setSpec] = useState<CustomReportSpec | null>(initialSpec)
  const source = useMemo(
    () => (spec ? sources.find((s) => s.key === spec.source) : undefined),
    [spec, sources],
  )

  // Which pop-up is open, and the spec as it was when it opened — edits apply
  // live so the preview refreshes while you work, and Cancel puts this back.
  const [panel, setPanel] = useState<PanelKey | null>(null)
  const snapshot = useRef<CustomReportSpec | null>(null)

  const update = useCallback((changes: Partial<CustomReportSpec>) => {
    setSpec((s) => (s ? { ...s, ...changes } : s))
  }, [])

  if (!spec || !source) {
    return (
      <SourcePicker
        sources={sources}
        templates={templates}
        onPick={(key) => setSpec(emptySpec(key))}
        // A fresh copy each time, so editing one never mutates the library —
        // and the name is marked a copy, because saving it as "Sales by
        // product" next to the built-in of that name helps nobody.
        onPickTemplate={(t) =>
          setSpec({ ...structuredClone(t.spec), name: `${t.name} (copy)` })
        }
      />
    )
  }

  const check = validateSpec(spec)

  function openPanel(key: PanelKey) {
    snapshot.current = structuredClone(spec!)
    setPanel(key)
  }

  /** OK / ✕ / Esc / backdrop — the live edits are already in, just close. */
  function closeKeep() {
    setPanel(null)
  }

  /** Cancel — put the spec back exactly as it was when the pop-up opened. */
  function closeRevert() {
    if (snapshot.current) setSpec(snapshot.current)
    setPanel(null)
  }

  function onSave() {
    if (!spec) return
    if (!spec.name.trim()) {
      toast.error('Give the report a name first.')
      return
    }
    startSaving(async () => {
      const result = await saveReportAction({ savedId, spec })
      if (result.ok) {
        toast.success(savedId ? 'Report updated.' : 'Report saved.')
        router.push(`/reports/saved:${result.id}`)
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <div className="flex flex-col gap-5">
      {/* The design toolbar — everything on it shapes the preview below. */}
      <div className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-surface px-3 py-2.5 shadow-card">
        <ToolbarButton
          icon={<Icons.Database size={16} />}
          label={source.label}
          active={panel === 'data'}
          onClick={() => openPanel('data')}
        />
        <span className="mx-1 h-6 w-px shrink-0 bg-border" aria-hidden />
        <ToolbarButton
          icon={<Icons.ColumnsIcon size={16} />}
          label="Columns"
          count={spec.columns.length}
          active={panel === 'columns'}
          onClick={() => openPanel('columns')}
        />
        <ToolbarButton
          icon={<Icons.Filter size={15} />}
          label="Filters"
          count={spec.filters.length + spec.totalFilters.length}
          active={panel === 'filters'}
          onClick={() => openPanel('filters')}
        />
        <ToolbarButton
          icon={<Icons.SortIcon size={16} />}
          label="Sort & size"
          active={panel === 'sort'}
          onClick={() => openPanel('sort')}
        />
        <span className="ml-auto hidden text-xs text-muted md:block">
          Every change shows in the preview below.
        </span>
      </div>

      {/* The preview IS the build surface — full width, front and centre. */}
      <PreviewPanel spec={spec} source={source} onChange={update} />

      {/* What this report will be, in a sentence — then the way out. */}
      <div className="flex flex-wrap items-center gap-3 rounded-card border border-border bg-surface px-4 py-3 shadow-card">
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-pill ${
            check.ok ? 'bg-brand-soft text-brand' : 'bg-danger-soft text-danger'
          }`}
        >
          <Icons.Info size={16} />
        </span>
        <p className="min-w-0 flex-1 text-[13px] text-muted">
          {check.ok ? (
            <span className="font-medium text-ink">{summaryLine(spec, source)}</span>
          ) : (
            <span className="font-medium text-danger">{check.error}</span>
          )}
        </p>
        <ButtonLink href="/reports" variant="secondary">
          Cancel
        </ButtonLink>
        <Button variant="primary" onClick={onSave} disabled={saving || !check.ok}>
          <Icons.Save size={16} />
          {saving ? 'Saving…' : savedId ? 'Save changes' : 'Save report'}
        </Button>
      </div>

      {/* ── the pop-up editors ──────────────────────────────────────────────
          Edits apply live; Cancel restores the snapshot taken on open. */}
      <BuilderModal
        open={panel === 'data'}
        title="What this report reads"
        description="The dataset, what to call the report, and the period it covers."
        onOk={closeKeep}
        onCancel={closeRevert}
      >
        <ReportBody
          spec={spec}
          source={source}
          update={update}
          onChangeData={() => {
            setPanel(null)
            setSpec(null)
          }}
        />
      </BuilderModal>

      <BuilderModal
        open={panel === 'columns'}
        title="Columns"
        description="Tick what the report should show, then order it with the arrows."
        size="lg"
        onOk={closeKeep}
        onCancel={closeRevert}
      >
        <ColumnsPanel source={source} spec={spec} onChange={update} chrome={false} />
      </BuilderModal>

      <BuilderModal
        open={panel === 'filters'}
        title="Filters"
        description="Narrow the records down. Every filter must match for a record to appear."
        size="lg"
        onOk={closeKeep}
        onCancel={closeRevert}
      >
        <FiltersPanel source={source} spec={spec} onChange={update} chrome={false} />
      </BuilderModal>

      <BuilderModal
        open={panel === 'sort'}
        title="Sorting and size"
        description="How the finished report is ordered, and the most rows it may return."
        onOk={closeKeep}
        onCancel={closeRevert}
      >
        <SortBody spec={spec} source={source} update={update} />
      </BuilderModal>
    </div>
  )
}

/**
 * A toolbar button: the editor it opens, with a leading glyph and a count of
 * what is configured. `active` (its pop-up is open) wears the brand outline the
 * way a selected segment does.
 *
 * Hand-rolled rather than a <Button>: this is a toggle that reports state, and
 * the count pill sits inside it. Marked data-kit-ok for that reason.
 */
function ToolbarButton({
  icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: ReactNode
  label: string
  /** How many of the thing are configured — shown as a pill when > 0. */
  count?: number
  /** True while this button's pop-up is open. */
  active?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-kit-ok
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex h-control items-center gap-2 rounded-control border px-3 text-sm font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand ${
        active
          ? 'border-brand bg-brand-soft text-brand'
          : 'border-border bg-surface text-ink hover:bg-surface-2'
      }`}
    >
      <span className={`shrink-0 ${active ? 'text-brand' : 'text-muted'}`}>{icon}</span>
      <span className="max-w-52 truncate">{label}</span>
      {count !== undefined && count > 0 && (
        <Badge tone="brand" className="numeric">
          {count}
        </Badge>
      )}
    </button>
  )
}

/**
 * The shared pop-up wrapper: a Modal footed with OK / Cancel. Edits inside
 * apply to the spec LIVE — the preview visibly refreshes behind the dimmed
 * backdrop — so OK (and ✕/Esc/backdrop) simply closes, while Cancel restores
 * the snapshot taken when the pop-up opened.
 */
function BuilderModal({
  open,
  title,
  description,
  size = 'md',
  onOk,
  onCancel,
  children,
}: {
  open: boolean
  title: string
  description?: string
  size?: 'sm' | 'md' | 'lg'
  onOk: () => void
  onCancel: () => void
  children: ReactNode
}) {
  return (
    <Modal
      open={open}
      onClose={onOk}
      title={title}
      description={description}
      size={size}
      // Half-composed work lives in here; a stray click outside should not be
      // the thing that closes it. Esc and ✕ still do, and both keep the edits.
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onOk}>
            OK
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  )
}

/* ── what the report reads (pop-up body) ───────────────────────────────────── */

function ReportBody({
  spec,
  source,
  update,
  onChangeData,
}: {
  spec: CustomReportSpec
  source: ClientSource
  update: (changes: Partial<CustomReportSpec>) => void
  onChangeData: () => void
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 rounded-card border border-border bg-surface-2 p-3">
        <CategoryTile icon={sourceIcon(source.key)} tone={sourceTone(source.key)} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-ink">{source.label}</p>
          <p className="truncate text-xs text-muted">{source.description}</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={onChangeData}
          title="Start again from a different dataset"
        >
          Change data
        </Button>
      </div>

      <Field label="Name">
        <Input
          value={spec.name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder="e.g. Margin by department"
          maxLength={120}
        />
      </Field>

      <Field
        label="Period"
        hint={
          source.shape === 'snapshot'
            ? 'This data has no date — the period only affects date filters you add.'
            : 'Re-resolved every time the report runs, so “last month” always means last month.'
        }
      >
        <Select
          value={spec.period.key}
          onChange={(e) => update({ period: { key: e.target.value as PeriodKey } })}
        >
          {PERIOD_KEYS.map((k) => (
            <option key={k} value={k}>
              {PERIOD_LABELS[k]}
            </option>
          ))}
        </Select>
      </Field>

      {spec.period.key === 'custom' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="From">
            <Input
              type="date"
              value={spec.period.from ?? ''}
              onChange={(e) =>
                update({ period: { ...spec.period, key: 'custom', from: e.target.value } })
              }
            />
          </Field>
          <Field label="To">
            <Input
              type="date"
              value={spec.period.to ?? ''}
              onChange={(e) =>
                update({ period: { ...spec.period, key: 'custom', to: e.target.value } })
              }
            />
          </Field>
        </div>
      )}

      {source.note && <Callout tone="neutral">{source.note}</Callout>}
    </div>
  )
}

/* ── sorting and size (pop-up body) ────────────────────────────────────────── */

function SortBody({
  spec,
  source,
  update,
}: {
  spec: CustomReportSpec
  source: ClientSource
  update: (changes: Partial<CustomReportSpec>) => void
}) {
  const outputColumns = clientOutputColumns(source, spec)

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Sort by">
          <Select
            value={spec.sort?.key ?? ''}
            onChange={(e) =>
              update({
                sort: e.target.value
                  ? { key: e.target.value, dir: spec.sort?.dir ?? 'desc' }
                  : undefined,
              })
            }
          >
            <option value="">No specific order</option>
            {outputColumns.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Direction">
          <Select
            value={spec.sort?.dir ?? 'desc'}
            disabled={!spec.sort}
            onChange={(e) =>
              spec.sort &&
              update({
                sort: { key: spec.sort.key, dir: e.target.value === 'asc' ? 'asc' : 'desc' },
              })
            }
          >
            <option value="desc">Highest / newest first</option>
            <option value="asc">Lowest / oldest first</option>
          </Select>
        </Field>
      </div>

      <Field label="Maximum rows" hint={`Up to ${MAX_ROWS.toLocaleString('en-ZA')}.`}>
        <NumberInput
          value={String(spec.limit)}
          min={1}
          max={MAX_ROWS}
          className="w-40"
          onChange={(e) => update({ limit: Number(e.target.value) || DEFAULT_ROWS })}
        />
      </Field>
    </div>
  )
}

/**
 * A plain-English description of the report's shape, for the save bar. Reading
 * it back as a sentence is how you catch a report that is subtly not the one
 * you meant to build.
 */
function summaryLine(spec: CustomReportSpec, source: ClientSource): string {
  const parts: string[] = []

  if (isSummarised(spec)) {
    const names = spec.groupFields
      .map((k) => findField(source, k)?.label.toLowerCase())
      .filter(Boolean)
      .join(' and ')
    parts.push(`One row per ${names}`)
  } else {
    parts.push('One row per record')
  }

  const cols = spec.columns.length
  parts.push(`${cols} column${cols === 1 ? '' : 's'}`)

  const filters = spec.filters.length + spec.totalFilters.length
  if (filters > 0) parts.push(`${filters} filter${filters === 1 ? '' : 's'}`)
  if (spec.topPerGroup) parts.push(`top ${spec.topPerGroup} per group`)
  parts.push(PERIOD_LABELS[spec.period.key].toLowerCase())

  return parts.join(' • ')
}

/**
 * Step one: what should this report read?
 *
 * A named dataset rather than a table list. "Sales lines" is a question someone
 * can answer; "sales_document_lines joined to products" is not, and the whole
 * value of the catalog is that it does the joining for you.
 */
function SourcePicker({
  sources,
  templates,
  onPick,
  onPickTemplate,
}: {
  sources: ClientSource[]
  templates: BuilderTemplate[]
  onPick: (key: string) => void
  onPickTemplate: (template: BuilderTemplate) => void
}) {
  const [templateSearch, setTemplateSearch] = useState('')

  if (sources.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No data available to you"
          hint="Building a report needs access to at least one kind of data. An owner can grant this under Setup → Roles."
          icon={<Icons.Database size={28} strokeWidth={1.75} />}
        />
      </Card>
    )
  }

  const byCategory = new Map<string, ClientSource[]>()
  for (const s of sources) {
    const list = byCategory.get(s.category) ?? []
    list.push(s)
    byCategory.set(s.category, list)
  }

  const q = templateSearch.trim().toLowerCase()
  const shownTemplates = q
    ? templates.filter(
        (t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
      )
    : templates

  return (
    <div className="flex flex-col gap-5">
      {/* ── start from something that nearly works ────────────────────────
          Offered first, and deliberately: a blank builder is the hardest way
          to make a report, and most people want "that one, but by week". */}
      {templates.length > 0 && (
        <Card>
          <CardHeader
            title="Start from a ready-made report"
            description="Take one of the built-in reports and change whatever you like. The original is untouched."
            action={
              <ToolbarSearch
                value={templateSearch}
                onChange={setTemplateSearch}
                placeholder="Find a report…"
                className="w-56"
                aria-label="Find a report to start from"
              />
            }
          />
          <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
            {shownTemplates.map((t) => (
              <ChoiceTile
                key={t.id}
                layout="inline"
                title={t.name}
                description={t.description}
                icon={
                  <CategoryTile
                    icon={sourceIcon(t.source, 16)}
                    tone={sourceTone(t.source)}
                    size="sm"
                  />
                }
                onClick={() => onPickTemplate(t)}
              />
            ))}
            {shownTemplates.length === 0 && (
              <p className="col-span-full py-2 text-sm text-muted">
                No ready-made report matches “{templateSearch}”. Start from the raw data below.
              </p>
            )}
          </div>
        </Card>
      )}

      <div className="flex flex-col gap-1">
        <h2 className="text-[15px] font-semibold text-ink">Or start from the raw data</h2>
        <p className="text-sm text-muted">
          Everything the builder can read. Pick the one your question is about.
        </p>
      </div>

      {[...byCategory.entries()].map(([category, list]) => (
        <Card key={category}>
          <div className="flex items-center gap-3 border-b border-border px-4 py-3.5">
            <CategoryTile icon={categoryIcon(category)} tone={categoryTone(category)} />
            <h3 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">
              {category}
            </h3>
            <Badge tone="neutral">{list.length}</Badge>
          </div>
          <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
            {list.map((s) => (
              <ChoiceTile
                key={s.key}
                title={s.label}
                description={s.description}
                icon={<CategoryTile icon={sourceIcon(s.key)} tone={sourceTone(s.key)} />}
                // Says whether the date range will do anything here — the one
                // thing that surprises people about a snapshot source.
                footer={
                  <Badge tone="neutral">
                    {s.shape === 'snapshot' ? 'As it is now' : 'Over a period'}
                  </Badge>
                }
                onClick={() => onPick(s.key)}
              />
            ))}
          </div>
        </Card>
      ))}
    </div>
  )
}

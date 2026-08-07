'use client'

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react'
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
  Select,
  ToolbarSearch,
  useToast,
} from '@/components/ui'
import {
  emptySpec,
  PERIOD_KEYS,
  PERIOD_LABELS,
  type CustomReportSpec,
  type PeriodKey,
} from '@/lib/reportBuilder/spec'
import { findField, type ClientSource } from '@/lib/reportBuilder/clientTypes'
import { categoryIcon, categoryTone, sourceIcon, sourceTone } from '../categoryStyle'
import ColumnsPanel from './ColumnsPanel'
import FiltersPanel from './FiltersPanel'
import PreviewPanel from './PreviewPanel'
import { saveReportAction } from './actions'

/**
 * The builder.
 *
 * Laid out as CONFIGURE on the left, PREVIEW on the right, because the single
 * thing that makes a report builder usable is seeing the effect of a change
 * immediately. Building blind and pressing "run" at the end is how people end
 * up with a report that is subtly wrong and never notice.
 *
 * The spec is the only state. Every panel edits it, the preview re-runs from
 * it, and saving stores exactly what is on screen — so what you see really is
 * what gets saved and scheduled.
 */
export type BuilderTemplate = {
  id: string
  name: string
  description: string
  source: string
  spec: CustomReportSpec
}

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
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
      {/* ── configure ─────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-5">
        <Card>
          <CardHeader
            title="Report"
            description={source.label}
            action={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSpec(null)}
                title="Start again from a different dataset"
              >
                Change data
              </Button>
            }
          />
          <div className="flex flex-col gap-4 p-4 pt-0">
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
        </Card>

        <ColumnsPanel source={source} spec={spec} onChange={update} />
        <FiltersPanel source={source} spec={spec} onChange={update} />
      </div>

      {/* ── preview ───────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-5">
        <PreviewPanel spec={spec} source={source} onChange={update} />

        <div className="flex items-center justify-end gap-2">
          <ButtonLink href="/reports" variant="secondary">
            Cancel
          </ButtonLink>
          <Button variant="primary" onClick={onSave} disabled={saving}>
            <Icons.Save size={16} />
            {saving ? 'Saving…' : savedId ? 'Save changes' : 'Save report'}
          </Button>
        </div>
      </div>
    </div>
  )
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
          <div className="grid grid-cols-1 gap-3 p-4 pt-0 sm:grid-cols-2 xl:grid-cols-3">
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

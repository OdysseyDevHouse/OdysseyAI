'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  ButtonLink,
  Callout,
  Card,
  CardHeader,
  Field,
  Icons,
  Input,
  TableSkeleton,
  useToast,
} from '@/components/ui'
import type { CustomReportSpec, ReportColumn } from '@/lib/reportBuilder/spec'
import ReportGrid from '../ReportGrid'
import { askReportAction, saveAskReportAction } from './actions'

/**
 * Ask, see, keep.
 *
 * The generated report is RUN immediately rather than described — the numbers
 * are the only way to tell whether it understood the question, and a
 * description of a report nobody can check is worth nothing.
 */
export default function AskPanel({
  canBuild,
  examples,
}: {
  canBuild: boolean
  examples: string[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [asking, startAsking] = useTransition()
  const [saving, startSaving] = useTransition()

  const [question, setQuestion] = useState('')
  const [asked, setAsked] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{
    spec: CustomReportSpec
    reasoning: string
    columns: ReportColumn[]
    rows: Record<string, unknown>[]
    totals: Record<string, number>
    range: { from: string; to: string }
  } | null>(null)

  function ask(text: string) {
    const q = text.trim()
    if (!q) return
    setError(null)
    setAsked(q)
    startAsking(async () => {
      const res = await askReportAction(q)
      if (res.ok) {
        setResult({
          spec: res.spec,
          reasoning: res.reasoning,
          columns: res.columns,
          rows: res.rows,
          totals: res.totals,
          range: res.range,
        })
      } else {
        setResult(null)
        setError(res.error)
      }
    })
  }

  function save() {
    if (!result) return
    startSaving(async () => {
      const res = await saveAskReportAction({ spec: result.spec, question: asked })
      if (res.ok) {
        toast.success('Report saved.')
        router.push(`/reports/saved:${res.id}`)
      } else {
        toast.error(res.error)
      }
    })
  }

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <div className="flex flex-col gap-4 p-4">
          <Field
            label="What do you want to see?"
            hint="Plain English. Name a period if you have one in mind — “last month”, “this week”."
          >
            <div className="flex gap-2">
              <Input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !asking) ask(question)
                }}
                placeholder="e.g. Top 10 products by profit last month"
                maxLength={500}
                className="flex-1"
              />
              <Button variant="primary" onClick={() => ask(question)} disabled={asking || !question.trim()}>
                <Icons.Sparkles size={16} />
                {asking ? 'Building…' : 'Generate'}
              </Button>
            </div>
          </Field>

          {examples.length > 0 && !result && !asking && (
            <div className="flex flex-col gap-2">
              <span className="text-xs text-muted">Or try one of these:</span>
              <div className="flex flex-wrap gap-2">
                {examples.map((ex) => (
                  <Button
                    key={ex}
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setQuestion(ex)
                      ask(ex)
                    }}
                  >
                    {ex}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {error && (
            <Callout tone="danger" title="Could not build that report">
              {error}
            </Callout>
          )}
        </div>
      </Card>

      {asking && (
        <Card>
          <CardHeader title="Working on it…" description="Reading your data and composing the report." />
          <div className="p-4">
            <TableSkeleton rows={6} />
          </div>
        </Card>
      )}

      {result && !asking && (
        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                {result.spec.name}
                <Badge tone="brand">
                  <Icons.Sparkles size={11} />
                  Generated
                </Badge>
              </span>
            }
            description={`${result.range.from} to ${result.range.to}${
              result.reasoning ? ` · ${result.reasoning}` : ''
            }`}
            action={
              <div className="flex items-center gap-2">
                {canBuild && (
                  <ButtonLink
                    href={`/reports/builder?spec=${encodeURIComponent(JSON.stringify(result.spec))}`}
                    variant="secondary"
                  >
                    <Icons.Pencil size={16} />
                    Adjust
                  </ButtonLink>
                )}
                <Button variant="primary" onClick={save} disabled={saving}>
                  <Icons.Save size={16} />
                  {saving ? 'Saving…' : 'Save report'}
                </Button>
              </div>
            }
          />

          <ReportGrid
            columns={result.columns}
            rows={result.rows}
            totals={result.totals}
            emptyHint="The report was built, but nothing matched over that period. Try a different period or rephrase the question."
          />

          <div className="border-t border-border px-4 py-3">
            <p className="text-xs text-muted">
              Showing the first {result.rows.length} rows. Save it to run the whole report, export
              it, or put it on a schedule.
            </p>
          </div>
        </Card>
      )}
    </div>
  )
}

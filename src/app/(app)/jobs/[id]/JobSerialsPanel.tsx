'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Icons,
  Input,
  useToast,
} from '@/components/ui'
import { TABLE, TABLE_TD, TABLE_TH } from '@/components/ui/styles'
import { checkSerialsAction, allocateSerialsAction } from '../actions'
import {
  SERIAL_ALLOC_LABEL,
  SERIAL_ALLOC_TONE,
  SERIAL_ALLOC_HINT,
  type SerialAllocState,
} from '@/lib/serialStatus'

/**
 * Which units are going on this job (§31).
 *
 * ── WHY THIS IS NOT A COLUMN IN THE PARTS TABLE ────────────────────────────
 *
 * The parts panel answers "how many", in a row. This answers "which ones", and
 * a serial-tracked line for three compressors needs three boxes, each of which
 * can be wrong in six different ways with a different fix for each. That does
 * not fit in a cell, and squeezing it in would produce the thing §31 warns
 * against — a state carried by colour because there was no room for a word.
 *
 * So the parts table keeps its "Fitted from the workshop" badge, which is the
 * true summary of a serial line from ITS point of view, and this card is where
 * the units get named.
 *
 * ── CHECKING IS NOT SAVING ─────────────────────────────────────────────────
 *
 * `Check` reads and writes nothing, so it can be pressed freely — a technician
 * scanning four boxes wants to know about the third one before committing to
 * any of them. `Save` re-runs every check on the server regardless of what this
 * screen concluded, because §39.2 is explicit that a screen having validated
 * something is not a reason for the server to skip it.
 */

export type SerialCheckRow = {
  entered: string
  serialId: number | null
  state: SerialAllocState
  locationName: string | null
}

export type SerialLine = {
  lineId: number
  productId: number
  description: string
  qty: number
  /** What has already been named, in allocation order. */
  serials: string[]
}

export default function JobSerialsPanel({
  jobId,
  jobClosed,
  lines,
  canEdit,
}: {
  jobId: number
  jobClosed: boolean
  lines: SerialLine[]
  canEdit: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  /*
   * Draft text per line, seeded from what is saved.
   *
   * One box per unit rather than a single comma-separated field: a scanner
   * types a serial and then Enter, and a shared box would need somebody to
   * remember a separator while holding a compressor.
   */
  const [drafts, setDrafts] = useState<Record<number, string[]>>(() =>
    Object.fromEntries(
      lines.map((l) => [
        l.lineId,
        Array.from({ length: l.qty }, (_, i) => l.serials[i] ?? ''),
      ]),
    ),
  )
  const [checks, setChecks] = useState<Record<number, SerialCheckRow[]>>({})

  if (lines.length === 0) return null

  const editable = canEdit && !jobClosed

  function setBox(lineId: number, index: number, value: string) {
    setDrafts((prev) => {
      const next = [...(prev[lineId] ?? [])]
      next[index] = value
      return { ...prev, [lineId]: next }
    })
    // A stale verdict beside a changed box is worse than no verdict: it says
    // "ready" about something nobody has looked at.
    setChecks((prev) => ({ ...prev, [lineId]: [] }))
  }

  function check(line: SerialLine) {
    start(async () => {
      const entries = (drafts[line.lineId] ?? []).filter((e) => e.trim() !== '')
      if (entries.length === 0) {
        setChecks((prev) => ({ ...prev, [line.lineId]: [] }))
        return
      }
      const result = await checkSerialsAction(line.productId, line.lineId, entries)
      setChecks((prev) => ({ ...prev, [line.lineId]: result }))
    })
  }

  function save(line: SerialLine) {
    start(async () => {
      const entries = (drafts[line.lineId] ?? []).filter((e) => e.trim() !== '')
      const result = await allocateSerialsAction(jobId, line.lineId, entries)
      if (result.ok) {
        toast.success(
          entries.length === 0
            ? 'Serial numbers cleared.'
            : `${entries.length} ${entries.length === 1 ? 'unit' : 'units'} recorded.`,
        )
        setChecks((prev) => ({ ...prev, [line.lineId]: [] }))
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <Card>
      <CardHeader
        title="Which units are going in"
        description="Serial-tracked parts. The person fitting it knows which one it is — the invoice cannot be raised until somebody says."
      />
      <CardBody>
        {lines.length === 0 ? (
          <EmptyState
            icon={<Icons.Hash size={20} />}
            title="Nothing serial-tracked on this job"
          />
        ) : (
          <div className="flex flex-col gap-6">
            {lines.map((line) => {
              const boxes = drafts[line.lineId] ?? []
              const verdicts = checks[line.lineId] ?? []
              const named = boxes.filter((b) => b.trim() !== '').length

              return (
                <div key={line.lineId} className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="flex items-baseline gap-2">
                      <span className="font-medium text-ink">{line.description}</span>
                      <Badge tone={named >= line.qty ? 'success' : 'warning'}>
                        {named} of {line.qty} named
                      </Badge>
                    </div>
                    {editable && (
                      <div className="flex gap-1.5">
                        <Button variant="ghost" size="sm" onClick={() => check(line)} disabled={pending}>
                          Check
                        </Button>
                        <Button size="sm" onClick={() => save(line)} disabled={pending}>
                          Save
                        </Button>
                      </div>
                    )}
                  </div>

                  <table className={TABLE}>
                    <thead>
                      <tr>
                        <th className={TABLE_TH} style={{ width: '3rem' }}>
                          #
                        </th>
                        <th className={TABLE_TH}>Serial number</th>
                        <th className={TABLE_TH}>State</th>
                      </tr>
                    </thead>
                    <tbody>
                      {boxes.map((value, index) => {
                        /*
                         * Verdicts come back only for the boxes that had text,
                         * so they are matched by ENTERED VALUE rather than by
                         * position — a blank second box would otherwise shift
                         * every verdict below it onto the wrong row.
                         */
                        const verdict = verdicts.find((v) => v.entered === value.trim())
                        return (
                          <tr key={index}>
                            <td className={`${TABLE_TD} text-muted`}>{index + 1}</td>
                            <td className={TABLE_TD}>
                              <Input
                                value={value}
                                disabled={!editable || pending}
                                onChange={(e) => setBox(line.lineId, index, e.target.value)}
                                placeholder="Scan or type"
                                className="max-w-[16rem]"
                              />
                            </td>
                            <td className={TABLE_TD}>
                              {verdict ? (
                                <div className="flex flex-col gap-0.5">
                                  {/* Label AND tone, never tone alone — §31 is
                                      explicit, and two of these six states are
                                      only distinguishable by their words. */}
                                  <Badge tone={SERIAL_ALLOC_TONE[verdict.state]}>
                                    {SERIAL_ALLOC_LABEL[verdict.state]}
                                  </Badge>
                                  <span className="text-xs text-muted">
                                    {verdict.state === 'elsewhere' && verdict.locationName
                                      ? `On file at ${verdict.locationName}. Transfer it across first.`
                                      : SERIAL_ALLOC_HINT[verdict.state]}
                                  </span>
                                </div>
                              ) : (
                                <span className="text-faint">—</span>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )
            })}
          </div>
        )}
      </CardBody>
    </Card>
  )
}

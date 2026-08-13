'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Callout,
  Card,
  CardHeader,
  CardBody,
  Field,
  NumberInput,
  Modal,
  Select,
  Icons,
  useToast,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_TD_INPUT,
  TABLE_NUMERIC,
  TextLink,
} from '@/components/ui'
import { formatQty } from '@/lib/decimals'
import type { JobPartLine, VanHolding } from '@/lib/site/jobParts'
import { issuePartsAction, returnPartsAction, vansAction } from '../actions'

/**
 * Parts on a job: what is needed, what is on a van, and what is still on the shelf.
 *
 * ── WHY THIS IS NOT PART OF THE LINE EDITOR ────────────────────────────────
 *
 * The Costs tab edits what a job WILL cost — descriptions, quantities, prices. This
 * moves physical goods. They read the same rows and they are different acts with
 * different permissions: `jobs.edit` changes a number, `stock.transfer` empties a
 * shelf. Putting an Issue button inside the line editor would put those one
 * mis-click apart.
 *
 * ── WHAT THE ISSUED COLUMN IS FOR ──────────────────────────────────────────
 *
 * "What is on my bakkie for this job that I have not billed yet." That question is
 * unanswerable without it, and it is the question a technician and a parts clerk
 * both ask. It is deliberately NOT a reservation: a part on a van has already left
 * the sellable pile, so counting it as promised too would deduct the same unit
 * twice from what the shop can sell.
 */
export default function JobPartsPanel({
  jobId,
  jobClosed,
  parts,
  vanHoldings,
  canIssue,
}: {
  jobId: number
  jobClosed: boolean
  parts: JobPartLine[]
  /** What is on a van right now, so somebody can see it without leaving the job. */
  vanHoldings: VanHolding[]
  canIssue: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  const [vans, setVans] = useState<{ id: number; code: string; name: string }[]>([])
  const [mode, setMode] = useState<'issue' | 'return' | null>(null)
  const [vanId, setVanId] = useState<number | null>(null)
  const [picked, setPicked] = useState<Record<number, number>>({})

  useEffect(() => {
    if (!canIssue) return
    let live = true
    vansAction()
      .then((found) => {
        if (!live) return
        setVans(found)
        if (found.length === 1) setVanId(found[0].id)
      })
      .catch(() => {
        if (live) setVans([])
      })
    return () => {
      live = false
    }
  }, [canIssue])

  const stocked = parts.filter((p) => p.productId !== null)
  const issuable = stocked.filter((p) => !p.isSerial && p.outstandingQty > 0)
  const returnable = stocked.filter((p) => p.issuedQty > 0)
  const outOnVan = stocked.reduce((sum, p) => sum + p.issuedQty, 0)

  // Site-wide holdings narrowed to the products on THIS job. See the table below.
  const jobProductIds = new Set(stocked.map((p) => p.productId))
  const relevantHoldings = vanHoldings.filter((h) => jobProductIds.has(h.productId))

  function open(next: 'issue' | 'return') {
    setMode(next)
    setPicked({})
    if (vans.length === 1) setVanId(vans[0].id)
  }

  function run() {
    if (vanId === null || mode === null) return
    const lines = Object.entries(picked)
      .filter(([, qty]) => qty > 0)
      .map(([lineId, qty]) => {
        const part = parts.find((p) => p.lineId === Number(lineId))!
        return { jobCardLineId: part.lineId, productId: part.productId as number, qty }
      })

    if (lines.length === 0) {
      toast.error(mode === 'issue' ? 'Choose a part to issue.' : 'Choose a part to bring back.')
      return
    }

    start(async () => {
      const result =
        mode === 'issue'
          ? await issuePartsAction(jobId, vanId, lines)
          : await returnPartsAction(jobId, vanId, lines)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      // Name the transfer: it is a real document somebody may need to find.
      toast.success(
        `${result.lineCount} ${result.lineCount === 1 ? 'part' : 'parts'} moved on ${result.documentNumber}.`,
      )
      setMode(null)
      setPicked({})
      router.refresh()
    })
  }

  const rows = mode === 'issue' ? issuable : returnable

  return (
    <>
      <Card>
        <CardHeader
          title="Parts"
          description="What the job needs, and what has already left the shelf."
          action={
            canIssue && !jobClosed ? (
              <div className="flex gap-2">
                {returnable.length > 0 && (
                  <Button variant="secondary" size="sm" onClick={() => open('return')} disabled={pending}>
                    <Icons.Undo size={14} />
                    Bring back
                  </Button>
                )}
                {issuable.length > 0 && (
                  <Button variant="primary" size="sm" onClick={() => open('issue')} disabled={pending}>
                    <Icons.Truck size={14} />
                    Issue to a van
                  </Button>
                )}
              </div>
            ) : undefined
          }
        />
        <CardBody className={stocked.length === 0 ? '' : 'p-0'}>
          {stocked.length === 0 ? (
            <p className="text-sm text-muted">
              No stocked parts on this job yet. Add them on the Costs tab, then issue them to a van.
            </p>
          ) : (
            <table className={TABLE}>
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th className={TABLE_TH}>Part</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Needed</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>On a van</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>To pick</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>On the shelf</th>
                </tr>
              </thead>
              <tbody>
                {stocked.map((part) => (
                  <tr key={part.lineId}>
                    <td className={TABLE_TD}>
                      <span className="text-ink-2">{part.description}</span>
                      {part.productCode && (
                        <span className="ml-2 text-xs text-muted">{part.productCode}</span>
                      )}
                      {/* Said on the row, not only in the refusal: a technician
                          planning a load should see it before pressing Issue. */}
                      {part.isSerial && (
                        <Badge tone="neutral">Fitted from the workshop</Badge>
                      )}
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatQty(part.qty)}</td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                      {part.issuedQty > 0 ? (
                        <span className="text-ink">{formatQty(part.issuedQty)}</span>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                      {part.outstandingQty > 0 ? (
                        <span className="text-ink-2">{formatQty(part.outstandingQty)}</span>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                      {/* Short is the one thing on this table worth a colour: it
                          is the reason a technician cannot leave. */}
                      <span
                        className={
                          part.outstandingQty > part.mainOnHand ? 'text-warning' : 'text-muted'
                        }
                      >
                        {formatQty(part.mainOnHand)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      {outOnVan > 0 && (
        /* The consumed-from-the-wrong-pile trap, said plainly on the screen where
           somebody can act on it. salesPosting writes every sale movement to MAIN,
           so a part invoiced while it is still on a bakkie debits a pile it is not
           in — and every stock invariant still holds, so nothing else would catch
           it. Bringing it back first is the whole fix. */
        <Callout tone="neutral" title="Parts still out on a van">
          Bring them back before the job is invoiced. Stock is always sold from the
          main location, so billing a part while it is on a vehicle would take it off
          the wrong pile.{' '}
          <TextLink href="/setup/reconciliation">The reconciliation screen</TextLink> lists
          any that were missed.
        </Callout>
      )}

      {/*
        Only the parts THIS job needs.

        vanHoldings is site-wide because the bring-back dialog needs the whole
        fleet — a part can come back off any vehicle. But as a table on one job it
        would grow a row per van per product, so a shop with fifteen bakkies gets
        fifteen rows about other people's work on a screen about this one.
        Narrowing it here rather than fetching twice keeps the dialog complete.
      */}
      {relevantHoldings.length > 0 && (
        <Card>
          {/*
            "of the parts this job needs", not "this job's parts". A pile on a
            vehicle is not tagged with a job — two jobs needing the same part see
            the same quantity — and a heading claiming otherwise would have
            somebody bring back a unit another technician is about to fit.
          */}
          <CardHeader
            title="On the vans"
            description="Vehicles currently carrying any of the parts this job needs — whichever job they were loaded for."
          />
          <CardBody className="p-0">
            <table className={TABLE}>
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th className={TABLE_TH}>Van</th>
                  <th className={TABLE_TH}>Part</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Quantity</th>
                </tr>
              </thead>
              <tbody>
                {relevantHoldings.map((holding) => (
                  <tr key={`${holding.locationId}-${holding.productId}`}>
                    <td className={TABLE_TD}>{holding.locationName}</td>
                    <td className={TABLE_TD}>
                      <span className="text-ink-2">{holding.description}</span>
                      <span className="ml-2 text-xs text-muted">{holding.productCode}</span>
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatQty(holding.qty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      )}

      {/* ── Issue or bring back ───────────────────────────────────────── */}
      <Modal
        open={mode !== null}
        onClose={() => setMode(null)}
        title={mode === 'issue' ? 'Issue parts to a van' : 'Bring parts back'}
        size="md"
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            {mode === 'issue'
              ? 'This posts an ordinary stock transfer, so the movement history shows one act — a van being loaded.'
              : 'This posts a stock transfer back to the shelf, so the parts can be billed from the main location.'}
          </p>

          {vans.length === 0 ? (
            <Callout tone="warning" title="No vans are set up">
              A van is a stock location marked as a vehicle. Add one under{' '}
              <TextLink href="/setup/locations">stock locations</TextLink> and it appears here.
            </Callout>
          ) : (
            <>
              <Field label="Which van">
                <Select
                  value={vanId === null ? '' : String(vanId)}
                  onChange={(e) => setVanId(e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">Choose…</option>
                  {vans.map((van) => (
                    <option key={van.id} value={van.id}>
                      {van.name} ({van.code})
                    </option>
                  ))}
                </Select>
              </Field>

              {rows.length === 0 ? (
                <p className="text-sm text-muted">
                  {mode === 'issue' ? 'Nothing left to pick.' : 'Nothing is out on a van.'}
                </p>
              ) : (
                <table className={TABLE}>
                  <thead>
                    <tr className={TABLE_HEAD_ROW}>
                      <th className={TABLE_TH}>Part</th>
                      <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>
                        {mode === 'issue' ? 'To pick' : 'On a van'}
                      </th>
                      <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Quantity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((part) => {
                      const most = mode === 'issue' ? part.outstandingQty : part.issuedQty
                      return (
                        <tr key={part.lineId}>
                          <td className={TABLE_TD}>
                            <span className="text-ink-2">{part.description}</span>
                            {mode === 'issue' && part.outstandingQty > part.mainOnHand && (
                              <span className="ml-2 text-xs text-warning">
                                only {formatQty(part.mainOnHand)} on the shelf
                              </span>
                            )}
                          </td>
                          <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatQty(most)}</td>
                          <td className={TABLE_TD_INPUT}>
                            <div className="flex justify-end">
                              <NumberInput
                                value={picked[part.lineId] ?? 0}
                                onChange={(e) =>
                                  setPicked({ ...picked, [part.lineId]: Number(e.target.value) })
                                }
                                className="numeric w-20 text-right"
                              />
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setMode(null)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={run}
              disabled={pending || vanId === null || rows.length === 0}
            >
              {mode === 'issue' ? 'Issue them' : 'Bring them back'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}

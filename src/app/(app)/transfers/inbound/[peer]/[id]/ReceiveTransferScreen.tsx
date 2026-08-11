'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Field,
  Icons,
  NumberInput,
  PageBody,
  Select,
  Textarea,
  useToast,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_ROW,
  TABLE_TD,
  TABLE_TD_INPUT,
  TABLE_TH,
} from '@/components/ui'
import { formatQty } from '@/lib/decimals'
import { receiveFromStoreAction } from '@/app/(app)/transfers/actions'

type LocationOption = { id: number; code: string; name: string; isMain: boolean }
type InboundLine = { id: number; productCode: string; description: string; qty: number }

/**
 * Confirming a delivery from another store.
 *
 * The counted quantity defaults to what was sent, because that is what usually
 * arrives and making somebody retype twenty lines to agree with the note is how
 * a receipt gets rubber-stamped. What matters is that changing one is EASY and
 * that a shortfall is visible before it posts.
 *
 * A short line is not an error and is not blocked: goods do go missing on a
 * truck. It is called out so the person confirming knows they are recording a
 * loss the sending store will wear.
 */
export default function ReceiveTransferScreen({
  peerSiteId,
  peerSiteName,
  transferId,
  documentNumber,
  reference,
  note,
  status,
  lines,
  locations,
}: {
  peerSiteId: number
  peerSiteName: string
  transferId: number
  documentNumber: string
  reference: string | null
  note: string | null
  status: string
  lines: InboundLine[]
  locations: LocationOption[]
}) {
  const main = locations.find((l) => l.isMain) ?? locations[0]

  const [locationId, setLocationId] = useState<number>(main?.id ?? 0)
  const [counted, setCounted] = useState<Record<number, number>>(() =>
    Object.fromEntries(lines.map((l) => [l.id, l.qty])),
  )
  const [receiveNote, setReceiveNote] = useState('')
  const [pending, startTransition] = useTransition()

  const toast = useToast()
  const router = useRouter()

  const short = lines.filter((l) => (counted[l.id] ?? 0) < l.qty)
  const overCounted = lines.filter((l) => (counted[l.id] ?? 0) > l.qty)
  const totalSent = lines.reduce((sum, l) => sum + l.qty, 0)
  const totalCounted = lines.reduce((sum, l) => sum + (counted[l.id] ?? 0), 0)
  const nothingArrived = totalCounted === 0

  const ready =
    !!locationId &&
    status === 'in_transit' &&
    overCounted.length === 0 &&
    !nothingArrived &&
    lines.every((l) => Number.isFinite(counted[l.id]) && (counted[l.id] ?? -1) >= 0)

  function submit() {
    startTransition(async () => {
      const result = await receiveFromStoreAction({
        peerSiteId,
        peerTransferId: transferId,
        toLocationId: locationId,
        received: lines.map((l) => ({ lineId: l.id, qty: counted[l.id] ?? 0 })),
        note: receiveNote || null,
      })

      if (!result.ok) {
        toast.error(result.error)
        return
      }
      // The stock is genuinely on the shelf even when the far end could not be
      // told, so this is never an error toast — but it must not be a silent
      // success either.
      if (result.warning) toast.info(result.warning)
      else toast.success(`${result.documentNumber} received — the stock is on the shelf.`)
      router.push(`/transfers/${result.id}`)
    })
  }

  if (status !== 'in_transit') {
    return (
      <PageBody>
        <Callout tone="warning" title="Nothing to receive">
          {status === 'received'
            ? 'This dispatch has already been received.'
            : 'The sending store recalled this dispatch, so the goods are not coming.'}
        </Callout>
      </PageBody>
    )
  }

  return (
    <PageBody>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Card>
            <CardHeader
              title="Where it goes"
              description="The room these goods are being put into, here."
            />
            <CardBody className="grid gap-4 sm:grid-cols-2">
              <Field label="Location">
                <Select
                  value={String(locationId)}
                  onChange={(e) => setLocationId(Number(e.target.value))}
                >
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.code} — {l.name}
                      {l.isMain ? ' (main)' : ''}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Note" hint="Optional — anything about the state it arrived in.">
                <Textarea
                  value={receiveNote}
                  onChange={(e) => setReceiveNote(e.target.value)}
                  maxLength={400}
                  rows={2}
                />
              </Field>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="What arrived"
              description="Counted quantities start at what was sent. Change any that did not turn up."
            />
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <colgroup>
                  <col />
                  <col style={{ width: '9rem' }} />
                  <col style={{ width: '9rem' }} />
                  <col style={{ width: '8rem' }} />
                </colgroup>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Product</th>
                    <th className={`${TABLE_TH} text-right`}>Sent</th>
                    <th className={`${TABLE_TH} text-right`}>Counted</th>
                    <th className={`${TABLE_TH} text-right`}>Short by</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => {
                    const got = counted[line.id] ?? 0
                    const missing = line.qty - got
                    return (
                      <tr key={line.id} className={TABLE_ROW}>
                        <td className={TABLE_TD}>
                          <div className="text-ink">{line.description}</div>
                          <div className="text-xs text-muted">{line.productCode}</div>
                        </td>
                        <td className={`${TABLE_TD} numeric text-right`}>
                          {formatQty(line.qty)}
                        </td>
                        <td className={TABLE_TD_INPUT}>
                          <NumberInput
                            value={got}
                            precision={3}
                            min="0"
                            max={String(line.qty)}
                            onChange={(e) =>
                              setCounted((c) => ({
                                ...c,
                                [line.id]: Number(e.target.value) || 0,
                              }))
                            }
                          />
                        </td>
                        <td className={`${TABLE_TD} numeric text-right`}>
                          {missing > 0 ? (
                            <Badge tone="danger">{formatQty(missing)}</Badge>
                          ) : got > line.qty ? (
                            <Badge tone="danger">too many</Badge>
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
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card className="p-4">
            <div className="text-sm text-ink-2">
              {documentNumber} from {peerSiteName}
            </div>
            {reference && <div className="mt-1 text-xs text-muted">Ref {reference}</div>}
            {note && <div className="mt-1 text-xs text-muted">{note}</div>}

            <div className="mt-3 flex items-baseline justify-between border-t border-border pt-3">
              <span className="font-medium text-ink">Units arriving</span>
              <span className="numeric text-xl font-semibold text-ink">
                {formatQty(totalCounted)}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted">of {formatQty(totalSent)} sent</p>
          </Card>

          {overCounted.length > 0 && (
            <Card className="p-3">
              <p className="text-xs text-danger-ink">
                A line cannot receive more than was sent. If there is extra stock in the delivery,
                receive what was on the note and ask {peerSiteName} to dispatch the rest.
              </p>
            </Card>
          )}

          {nothingArrived && overCounted.length === 0 && (
            <Card className="p-3">
              <p className="text-xs text-danger-ink">
                Nothing is counted. If the delivery never arrived, ask {peerSiteName} to recall the
                dispatch rather than receiving it empty.
              </p>
            </Card>
          )}

          {short.length > 0 && !nothingArrived && (
            <Card className="p-3">
              <p className="text-xs text-warning-ink">
                {short.length} line{short.length === 1 ? '' : 's'} short. What did not arrive is
                written off by {peerSiteName} — it left their shelf and reached nobody, so the loss
                is theirs and it will show on their books, not yours.
              </p>
            </Card>
          )}

          <Button variant="primary" disabled={!ready || pending} onClick={submit}>
            <Icons.Check size={16} />
            {pending ? 'Receiving…' : 'Confirm the delivery'}
          </Button>

          <Card className="p-3">
            <p className="text-xs text-muted">
              Confirming adds these goods to this store’s stock and blends their cost into your
              average, because you did not own them a moment ago. It also releases them from{' '}
              {peerSiteName}.
            </p>
          </Card>
        </div>
      </div>
    </PageBody>
  )
}

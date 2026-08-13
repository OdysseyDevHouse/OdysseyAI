'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Callout,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Icons,
  Input,
  Modal,
  PinPad,
  useToast,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
} from '@/components/ui'
import { deviceId } from '@/lib/deviceId'
import {
  formatClock,
  formatDuration,
  looksForgotten,
  minutesBetween,
  type TimeEntry,
} from '@/lib/timeModel'
import { clockAction, closeForgottenAction } from './actions'

type Terminal = { id: number; code: string; deviceId: string | null }

/**
 * The clock.
 *
 * ONE PAD, ONE ACTION. The same PIN clocks a person in if they are out and out
 * if they are in — deliberately not two buttons. At 07:00 with a queue behind
 * them, asking somebody to remember which state they are in produces either a
 * second open entry or a refusal, and both need a manager to unpick.
 *
 * The result says which happened, by name and time, because the one thing
 * somebody needs from this screen is confidence it registered.
 */
export default function ClockScreen({
  onTheClock,
  terminals,
  canSeeAll,
  canEdit,
}: {
  onTheClock: TimeEntry[]
  terminals: Terminal[]
  canSeeAll: boolean
  canEdit: boolean
}) {
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ action: 'in' | 'out'; userName: string; at: string } | null>(
    null,
  )
  const [closing, setClosing] = useState<TimeEntry | null>(null)
  const [pending, startTransition] = useTransition()

  const router = useRouter()

  // Which till this is, resolved after mount — the device id is browser-only.
  const [terminalId, setTerminalId] = useState<number | null>(null)
  useEffect(() => {
    const id = deviceId()
    setTerminalId(terminals.find((t) => t.deviceId === id)?.id ?? null)
  }, [terminals])

  // Re-renders once a minute so the "on the clock" durations count up rather
  // than freezing at whatever they were when the page loaded.
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 60_000)
    return () => clearInterval(timer)
  }, [])

  function submit(pin: string) {
    setError(null)
    startTransition(async () => {
      const outcome = await clockAction(pin, terminalId)
      if (!outcome.ok) {
        setError(outcome.error)
        return
      }
      setResult({ action: outcome.action, userName: outcome.userName, at: outcome.at })
      router.refresh()
    })
  }

  return (
    <>
      <div className="grid gap-5 lg:grid-cols-[auto_1fr]">
        <Card className="lg:w-[26rem]">
          <div className="flex flex-col items-center gap-5 px-6 py-7">
            <div className="text-center">
              <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-brand/10">
                <Icons.Clock size={22} className="text-brand" />
              </div>
              <h2 className="text-lg font-semibold text-ink">Enter your PIN</h2>
              <p className="text-sm text-muted">
                The same PIN clocks you in or out — whichever you are not.
              </p>
            </div>

            <PinPad onSubmit={submit} error={error} busy={pending} />
          </div>
        </Card>

        {canSeeAll && (
          <Card>
            <CardHeader
              title="On the clock"
              description={
                onTheClock.length === 0
                  ? 'Nobody is clocked in.'
                  : `${onTheClock.length} ${onTheClock.length === 1 ? 'person' : 'people'} at work.`
              }
            />

            {onTheClock.length === 0 ? (
              <EmptyState
                title="Nobody is on the clock"
                hint="Somebody entering their PIN will appear here."
                icon={<Icons.Clock size={28} strokeWidth={1.75} />}
              />
            ) : (
              <div className="overflow-x-auto">
                <table className={TABLE}>
                  <thead>
                    <tr className={TABLE_HEAD_ROW}>
                      <th className={TABLE_TH}>Person</th>
                      <th className={TABLE_TH}>Since</th>
                      <th className={`${TABLE_TH} text-right`}>So far</th>
                      {canEdit && <th className={`${TABLE_TH} text-right`}>&nbsp;</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {onTheClock.map((e) => {
                      const forgotten = looksForgotten(e.startedAt)
                      return (
                        <tr key={e.id} className={TABLE_ROW}>
                          <td className={TABLE_TD}>
                            <span className="font-medium text-ink">{e.userName}</span>
                          </td>
                          <td className={TABLE_TD}>
                            <span className="text-muted">{formatClock(e.startedAt)}</span>
                          </td>
                          <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                            {/* An entry running past midnight is nearly always
                                a forgotten clock-out, not a 20-hour day. Said
                                out loud rather than left as a big number. */}
                            {forgotten ? (
                              <Badge tone="warning">
                                {formatDuration(minutesBetween(e.startedAt, new Date()))}
                              </Badge>
                            ) : (
                              <span className="text-ink">
                                {formatDuration(minutesBetween(e.startedAt, new Date()))}
                              </span>
                            )}
                          </td>
                          {canEdit && (
                            <td className={`${TABLE_TD} text-right`}>
                              {forgotten && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setClosing(e)}
                                >
                                  Close it
                                </Button>
                              )}
                            </td>
                          )}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}
      </div>

      {result && (
        <ClockedModal result={result} onClose={() => setResult(null)} />
      )}

      {closing && (
        <CloseForgottenModal entry={closing} onClose={() => setClosing(null)} />
      )}
    </>
  )
}

/**
 * What just happened, large enough to read at arm's length.
 *
 * Somebody clocking in at a counter is not looking closely at a screen — they
 * need to know it registered and walk away.
 */
function ClockedModal({
  result,
  onClose,
}: {
  result: { action: 'in' | 'out'; userName: string; at: string }
  onClose: () => void
}) {
  // Closes itself, so the next person in the queue gets a clean pad without
  // anybody having to tap Done.
  useEffect(() => {
    const timer = setTimeout(onClose, 4000)
    return () => clearTimeout(timer)
  }, [onClose])

  return (
    <Modal
      open
      onClose={onClose}
      title={result.action === 'in' ? 'Clocked in' : 'Clocked out'}
      size="sm"
      footer={
        <div className="flex justify-end">
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      }
    >
      <div className="flex flex-col items-center gap-3 py-4 text-center">
        <div
          className={`flex size-14 items-center justify-center rounded-full ${
            result.action === 'in' ? 'bg-success-soft' : 'bg-brand/10'
          }`}
        >
          <Icons.Check size={26} className={result.action === 'in' ? 'text-success' : 'text-brand'} />
        </div>
        <div>
          <p className="text-lg font-semibold text-ink">{result.userName}</p>
          <p className="text-sm text-muted">
            {result.action === 'in' ? 'Started' : 'Finished'} at {formatClock(result.at)}
          </p>
        </div>
      </div>
    </Modal>
  )
}

function CloseForgottenModal({ entry, onClose }: { entry: TimeEntry; onClose: () => void }) {
  // Defaults to the end of the day they clocked in on, which is the likeliest
  // truth for somebody who forgot — and a manager can change it.
  const started = new Date(entry.startedAt)
  const guess = new Date(started)
  guess.setHours(17, 0, 0, 0)

  const [endedAt, setEndedAt] = useState(toLocalInput(guess))
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const toast = useToast()
  const router = useRouter()

  function submit() {
    setError(null)
    startTransition(async () => {
      const result = await closeForgottenAction(entry.id, new Date(endedAt).toISOString())
      if (!result.ok) {
        setError(result.error)
        return
      }
      toast.success(result.message)
      router.refresh()
      onClose()
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Close ${entry.userName}'s shift`}
      description="They clocked in but never clocked out. Set when they actually left."
      closeOnBackdrop={false}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={pending}>
            {pending ? 'Closing…' : 'Close the shift'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        {error && <Callout tone="danger">{error}</Callout>}

        <Callout tone="neutral">
          Clocked in {formatClock(entry.startedAt)} on{' '}
          {/* Explicit locale, or the server and the browser format this
              differently and hydration fails. */}
          {new Date(entry.startedAt).toLocaleDateString('en-ZA')}.
        </Callout>

        <Field
          label="Left at"
          hint="This is recorded as a correction, with your name against it."
        >
          <Input
            type="datetime-local"
            value={endedAt}
            onChange={(e) => setEndedAt(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  )
}

/** A Date as the value a datetime-local input expects, in local time. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

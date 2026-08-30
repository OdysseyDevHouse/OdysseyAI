'use client'

import { useState, useTransition } from 'react'
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Checkbox,
  Field,
  Icons,
  Input,
  NumberInput,
  SettingRow,
  Switch,
  WeekHours,
  useToast,
  type HoursRange,
} from '@/components/ui'
import type { OpeningHours } from '@/lib/reservationTypes'
import {
  deleteTradingExceptionAction,
  saveTradingExceptionAction,
  saveTradingHoursAction,
  setAcceptingOrdersAction,
  setHorizonAction,
} from './actions'

/**
 * When this shop is open, and whether it is taking orders right now.
 *
 * ── THE LOUDEST THING IS THE QUEUE ──────────────────────────────────────────
 *
 * Trading hours are set once and edited twice a year. Whether the kitchen is
 * accepting orders changes on a Friday night, in a hurry, by somebody who needs
 * it to take one tap. So the switch is at the top, in its own card, and it says
 * what is true right now rather than making a manager infer it from the week
 * below.
 */

export type ExceptionRow = {
  onDate: string
  isClosed: boolean
  openTime: string | null
  closeTime: string | null
  note: string
}

export default function TradingForm({
  initialHours,
  acceptingOrders,
  acceptingNote,
  horizonDays,
  leadTimeMinutes,
  exceptions,
  openNow,
}: {
  initialHours: OpeningHours
  acceptingOrders: boolean
  acceptingNote: string
  horizonDays: number
  leadTimeMinutes: number
  exceptions: ExceptionRow[]
  /** What the storefront is telling shoppers at this moment. */
  openNow: { state: 'open' | 'closed' | 'paused'; label: string }
}) {
  const toast = useToast()
  const [saving, startSaving] = useTransition()

  const [hours, setHours] = useState<Record<string, HoursRange[]>>(
    initialHours as Record<string, HoursRange[]>,
  )
  const [accepting, setAccepting] = useState(acceptingOrders)
  const [note, setNote] = useState(acceptingNote)
  const [horizon, setHorizon] = useState(horizonDays)

  const [exceptionDate, setExceptionDate] = useState('')
  const [exceptionClosed, setExceptionClosed] = useState(true)
  const [exceptionOpen, setExceptionOpen] = useState('09:00')
  const [exceptionClose, setExceptionClose] = useState('13:00')
  const [exceptionNote, setExceptionNote] = useState('')

  const alwaysOpen = Object.keys(hours).length === 0

  function toggleAccepting(next: boolean) {
    setAccepting(next)
    startSaving(async () => {
      const result = await setAcceptingOrdersAction(next, next ? '' : note)
      if (!result.ok) {
        setAccepting(!next)
        toast.error(result.error)
        return
      }
      toast.success(next ? 'Taking online orders again.' : 'Online orders paused.')
    })
  }

  function saveHours() {
    startSaving(async () => {
      const result = await saveTradingHoursAction(hours as OpeningHours)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(
        Object.keys(hours).length === 0
          ? 'Hours cleared — the shop is always open online.'
          : 'Trading hours saved.',
      )
    })
  }

  function addException() {
    startSaving(async () => {
      const result = await saveTradingExceptionAction({
        onDate: exceptionDate,
        isClosed: exceptionClosed,
        openTime: exceptionOpen,
        closeTime: exceptionClose,
        note: exceptionNote,
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Date saved.')
      setExceptionDate('')
      setExceptionNote('')
    })
  }

  function removeException(onDate: string) {
    startSaving(async () => {
      const result = await deleteTradingExceptionAction(onDate)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Date removed.')
    })
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Loudest, because it is the one thing that changes in a hurry. */}
      <Card>
        <CardHeader
          title="Taking orders"
          description="Stop the queue without touching your trading hours — for a broken fryer, a rush, or load-shedding."
          action={
            openNow.state === 'open' ? (
              <Badge tone="success">{openNow.label}</Badge>
            ) : openNow.state === 'closed' ? (
              <Badge tone="warning">{openNow.label}</Badge>
            ) : (
              <Badge tone="danger">{openNow.label}</Badge>
            )
          }
        />
        <CardBody>
          <SettingRow
            icon={<Icons.Store size={16} />}
            label="Accept online orders"
            description="Off stops new orders immediately. Orders already placed are unaffected."
          >
            <Switch
              checked={accepting}
              onChange={toggleAccepting}
              disabled={saving}
              ariaLabel="Accept online orders"
            />
          </SettingRow>

          {!accepting && (
            <div className="mt-4">
              <Field
                label="What shoppers are told"
                hint="Shown on the shop. A reason reads as busy; silence reads as broken."
              >
                <Input
                  value={note}
                  maxLength={200}
                  placeholder="Kitchen closed, back at 18:00"
                  onChange={(e) => setNote(e.target.value)}
                  onBlur={() => void setAcceptingOrdersAction(false, note)}
                />
              </Field>
            </div>
          )}
        </CardBody>
      </Card>

      <Card id="trading-hours">
        <CardHeader
          title="Trading hours"
          description="When this shop can have an online order ready. Leave every day closed to stay always open."
        />
        <CardBody>
          <div className="flex flex-col gap-4">
            {alwaysOpen && (
              <Callout tone="brand" title="No hours set">
                The shop takes online orders at any time of day. Add a day below to offer
                collection times instead.
              </Callout>
            )}

            <WeekHours
              hours={hours}
              onChange={setHours}
              rangeNoun="service"
              addFirstLabel="Open this day"
              defaultRange={['09:00', '17:00']}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Order ahead by"
                hint="Days a shopper may order for. 0 offers today only."
              >
                <NumberInput
                  value={horizon}
                  min={0}
                  max={30}
                  onChange={(e) => setHorizon(Number(e.target.value) || 0)}
                  onBlur={() => void setHorizonAction(horizon)}
                />
              </Field>
              <Field label="Preparation time" hint="Set on the Setup screen.">
                <Input value={`${leadTimeMinutes} minutes`} readOnly disabled />
              </Field>
            </div>
          </div>
        </CardBody>
        <CardFooter>
          {/* The one primary on this screen: the week is the thing being edited. */}
          <Button variant="primary" onClick={saveHours} disabled={saving}>
            {saving ? 'Saving…' : 'Save hours'}
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader
          title="Public holidays and one-off changes"
          description="A date that does not follow the week above. Past dates drop off by themselves."
        />
        <CardBody>
          <div className="flex flex-col gap-4">
            {exceptions.length === 0 ? (
              <p className="text-sm text-muted">Nothing coming up.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {exceptions.map((e) => (
                  <div
                    key={e.onDate}
                    className="flex flex-wrap items-center gap-3 rounded-card border border-border px-4 py-2.5"
                  >
                    <span className="numeric w-28 shrink-0 text-sm font-medium text-ink">
                      {e.onDate}
                    </span>
                    {e.isClosed ? (
                      <Badge tone="danger">Closed</Badge>
                    ) : (
                      <Badge tone="warning">
                        {e.openTime}–{e.closeTime}
                      </Badge>
                    )}
                    {e.note && <span className="min-w-0 flex-1 truncate text-sm text-muted">{e.note}</span>}
                    <Button
                      variant="danger-ghost"
                      size="sm"
                      iconOnly
                      aria-label={`Remove ${e.onDate}`}
                      disabled={saving}
                      onClick={() => removeException(e.onDate)}
                      className="ml-auto"
                    >
                      <Icons.Close size={15} />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-4 sm:items-end">
              <Field label="Date">
                <Input
                  type="date"
                  value={exceptionDate}
                  onChange={(e) => setExceptionDate(e.target.value)}
                />
              </Field>
              <Field label="Note">
                <Input
                  value={exceptionNote}
                  maxLength={200}
                  placeholder="Christmas Day"
                  onChange={(e) => setExceptionNote(e.target.value)}
                />
              </Field>
              <div className="sm:col-span-2 flex flex-wrap items-end gap-3">
                <Checkbox
                  checked={exceptionClosed}
                  onChange={(e) => setExceptionClosed(e.target.checked)}
                  label="Closed all day"
                />
                {!exceptionClosed && (
                  <>
                    <div className="w-32">
                      <Field label="Opens">
                        <Input
                          type="time"
                          value={exceptionOpen}
                          onChange={(e) => setExceptionOpen(e.target.value)}
                        />
                      </Field>
                    </div>
                    <div className="w-32">
                      <Field label="Closes">
                        <Input
                          type="time"
                          value={exceptionClose}
                          onChange={(e) => setExceptionClose(e.target.value)}
                        />
                      </Field>
                    </div>
                  </>
                )}
                <Button
                  variant="secondary"
                  onClick={addException}
                  disabled={saving || !exceptionDate}
                >
                  <Icons.Plus size={15} />
                  Add date
                </Button>
              </div>
            </div>
          </div>
        </CardBody>
      </Card>
    </div>
  )
}

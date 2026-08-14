'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  Icons,
  Input,
  Modal,
  NumberInput,
  Select,
  Switch,
  useToast,
  type BadgeTone,
} from '@/components/ui'
import { TABLE, TABLE_HEAD_ROW, TABLE_NUMERIC, TABLE_TD, TABLE_TH } from '@/components/ui/styles'
import type { TicketLane } from '@/lib/site/tickets'
import { CLOCK_ACTIONS, CLOCK_LABEL, type ClockAction } from '@/lib/ticketModel'
import { saveLaneAction, deleteLaneAction } from '../../tickets/actions'

const TONE: Record<string, BadgeTone> = {
  neutral: 'neutral',
  brand: 'brand',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
}

const TONES = ['neutral', 'brand', 'success', 'warning', 'danger'] as const

/**
 * The lanes, and what each one does to the clock.
 *
 * ── THE EXPLANATION IS PART OF THE SCREEN ──────────────────────────────────
 *
 * The three flags are not self-evident from three icons, and the rule that a
 * flag belongs to one lane only is not guessable at all. So it is written out
 * above the list rather than hidden in a tooltip somebody has to discover —
 * this is a screen an owner visits twice a year, and it has to explain itself
 * to somebody who has forgotten.
 */
export default function LanesPanel({ lanes }: { lanes: TicketLane[] }) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  const [editing, setEditing] = useState<TicketLane | null>(null)
  const [creating, setCreating] = useState(false)
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [tone, setTone] = useState('neutral')
  const [sortOrder, setSortOrder] = useState(0)
  const [clock, setClock] = useState<ClockAction>('')
  const [isLanding, setIsLanding] = useState(false)
  const [isClosedStage, setIsClosedStage] = useState(false)
  const [isCancelledStage, setIsCancelledStage] = useState(false)
  const [isActive, setIsActive] = useState(true)

  function open(lane: TicketLane | null) {
    setEditing(lane)
    setCreating(lane === null)
    setCode(lane?.code ?? '')
    setName(lane?.name ?? '')
    setTone(lane?.tone ?? 'neutral')
    setSortOrder(lane?.sortOrder ?? (lanes.length + 1) * 10)
    setClock(lane?.clock ?? '')
    setIsLanding(lane?.isLanding ?? false)
    setIsClosedStage(lane?.isClosedStage ?? false)
    setIsCancelledStage(lane?.isCancelledStage ?? false)
    setIsActive(lane?.isActive ?? true)
  }

  function close() {
    setEditing(null)
    setCreating(false)
  }

  function save() {
    start(async () => {
      const result = await saveLaneAction({
        id: editing?.id ?? null,
        code,
        name,
        tone,
        sortOrder,
        clock,
        isLanding,
        isClosedStage,
        isCancelledStage,
        isActive,
      })
      if (result.ok) {
        toast.success('Lane saved.')
        close()
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function remove(lane: TicketLane) {
    start(async () => {
      const result = await deleteLaneAction(lane.id)
      if (result.ok) {
        toast.success(`${lane.name} removed.`)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  const open_ = editing !== null || creating

  return (
    <>
      <Card>
        <CardHeader
          title="Lanes"
          description="The columns on the ticket board, and what dragging a ticket into each one does."
          action={
            <Button variant="secondary" size="sm" onClick={() => open(null)}>
              <Icons.Plus size={14} />
              Add a lane
            </Button>
          }
        />
        <CardBody className="space-y-3">
          {/* Written out, not a tooltip. See the header. */}
          <div className="space-y-2 rounded-card bg-surface-2 p-3 text-xs text-muted">
            <p>
              New tickets land in the lane marked <strong className="text-ink-2">Landing</strong>.
              The clock flags say what dragging a ticket into a lane does to its timer:{' '}
              <strong className="text-ink-2">starts</strong> it,{' '}
              <strong className="text-ink-2">pauses</strong> it, or{' '}
              <strong className="text-ink-2">ends</strong> it. Each flag belongs to one lane only —
              setting it here takes it off the lane that had it. Most lanes hold none.
            </p>
            <p>
              A <strong className="text-ink-2">Done</strong> lane means the work is finished: a
              ticket landing in one counts as completed and stops its service clock. Flag as many
              as you like — if your team finishes in both Resolved and Closed, flag both. The board
              has to keep at least one.
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className={TABLE}>
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th className={TABLE_TH}>Lane</th>
                  <th className={TABLE_TH}>Does to the clock</th>
                  <th className={TABLE_TH}>Marks</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Tickets</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`} />
                </tr>
              </thead>
              <tbody>
                {lanes.map((lane) => (
                  <tr key={lane.id}>
                    <td className={TABLE_TD}>
                      <div className="flex items-center gap-2">
                        <Badge tone={TONE[lane.tone] ?? 'neutral'}>{lane.name}</Badge>
                        {!lane.isActive && <span className="text-xs text-muted">off</span>}
                      </div>
                    </td>
                    <td className={TABLE_TD}>
                      {lane.clock === '' ? (
                        <span className="text-sm text-muted">Nothing</span>
                      ) : (
                        <span className="flex items-center gap-1.5 text-sm text-ink-2">
                          {lane.clock === 'start' && (
                            <Icons.Play size={12} className="text-success" />
                          )}
                          {lane.clock === 'pause' && (
                            <Icons.Pause size={12} className="text-warning" />
                          )}
                          {lane.clock === 'end' && (
                            <Icons.Square size={12} className="text-danger" />
                          )}
                          {CLOCK_LABEL[lane.clock]}
                        </span>
                      )}
                    </td>
                    <td className={TABLE_TD}>
                      <div className="flex flex-wrap gap-1">
                        {lane.isLanding && <Badge tone="brand">Landing</Badge>}
                        {lane.isClosedStage && <Badge tone="success">Done</Badge>}
                        {lane.isCancelledStage && <Badge tone="danger">Called off</Badge>}
                      </div>
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                      <span className="numeric text-sm text-ink-2">{lane.ticketCount}</span>
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          iconOnly
                          aria-label={`Edit ${lane.name}`}
                          onClick={() => open(lane)}
                        >
                          <Icons.Pencil size={15} />
                        </Button>
                        {!lane.isSystem && lane.ticketCount === 0 && (
                          <Button
                            variant="danger-ghost"
                            size="sm"
                            iconOnly
                            aria-label={`Remove ${lane.name}`}
                            disabled={pending}
                            onClick={() => remove(lane)}
                          >
                            <Icons.Trash size={15} />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>

      <Modal
        open={open_}
        onClose={close}
        title={editing ? `${editing.name}` : 'New lane'}
        size="sm"
        closeOnBackdrop={false}
        footer={
          <>
            <Button variant="secondary" onClick={close} disabled={pending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save} disabled={pending || !name.trim() || !code.trim()}>
              {pending ? 'Saving…' : 'Save lane'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </Field>

          <Field label="Code" hint="Used by rules and reports. Lowercase, no spaces.">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={editing?.isSystem}
              maxLength={40}
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Colour">
              <Select value={tone} onChange={(e) => setTone(e.target.value)}>
                {TONES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Position">
              <NumberInput
                value={sortOrder}
                onChange={(e) => setSortOrder(Number(e.target.value))}
                className="numeric w-24 text-right"
              />
            </Field>
          </div>

          <Field
            label="Does to the clock"
            hint="Only one lane can hold each — setting it here takes it off whichever lane had it."
          >
            <Select value={clock} onChange={(e) => setClock(e.target.value as ClockAction)}>
              {CLOCK_ACTIONS.map((c) => (
                <option key={c} value={c}>
                  {CLOCK_LABEL[c]}
                </option>
              ))}
            </Select>
          </Field>

          <Switch
            checked={isLanding}
            onChange={setIsLanding}
            label="New tickets land here"
            hint="Exactly one lane. Setting it here takes it off the lane that had it."
          />
          <Switch
            checked={isClosedStage}
            onChange={setIsClosedStage}
            label="Counts as done"
            hint="Stops the service clock. Flag as many lanes as your team finishes work in."
          />
          <Switch
            checked={isCancelledStage}
            onChange={setIsCancelledStage}
            label="Called off rather than finished"
            hint="Closed, but not done — kept apart so reports can tell the two outcomes apart."
          />
          <Switch
            checked={isActive}
            onChange={setIsActive}
            label="In use"
            hint="A lane switched off leaves the board. Tickets already in it keep their history."
          />
        </div>
      </Modal>
    </>
  )
}

'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmModal,
  EmptyState,
  Field,
  Icons,
  Input,
  Modal,
  Select,
  SettingRow,
  Skeleton,
  Switch,
  useToast,
} from '@/components/ui'
import { deviceId } from '@/lib/deviceId'
import type { Terminal } from '@/lib/site/terminals'
import { POS_MODES, POS_MODE_LABELS, toPosMode } from '@/lib/posMode'
import {
  saveTerminalAction,
  deleteTerminalAction,
  setTerminalPosModeAction,
  setTerminalStockLocationAction,
} from './actions'

/** A room a till can be pointed at. Trimmed on the server — see page.tsx. */
export type LocationOption = { id: number; name: string; isMain: boolean }

/**
 * Till setup.
 *
 * The screen has two jobs: registering tills as master data, and letting THIS
 * machine claim one. Those are deliberately separate — a manager registers
 * TILL01 through TILL04 from the back office, and each machine then claims its
 * own, rather than a till having to be set up at the counter it will live on.
 */
export default function TerminalsClient({
  terminals,
  locations,
  suggestedCode,
}: {
  terminals: Terminal[]
  locations: LocationOption[]
  /** The next code auto-numbering would issue, or null when it is switched off. */
  suggestedCode: string | null
}) {
  const [editing, setEditing] = useState<Terminal | null>(null)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<Terminal | null>(null)
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  // Device identity is only knowable in the browser, so it is read after mount
  // rather than during render — otherwise the server and client markup differ.
  // `ready` gates the status cells: until the effect has run, device.id is
  // null for one frame even on a machine that HAS claimed a till, and showing
  // "unclaimed" for that frame is a lie. A skeleton holds the space instead.
  const [device, setDevice] = useState<{ id: string | null; ready: boolean }>({
    id: null,
    ready: false,
  })
  useEffect(() => {
    setDevice({ id: deviceId(), ready: true })
  }, [])

  function run(work: () => Promise<{ ok: true; message: string } | { ok: false; error: string }>) {
    startTransition(async () => {
      const result = await work()
      if (result.ok) {
        toast.success(result.message)
        setEditing(null)
        setAdding(false)
        setDeleting(null)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  /* ── NO "THIS MACHINE" CARD, AND NO CLAIM BUTTONS ────────────────────────
     There used to be a card here that registered this browser against a till,
     and a "Use here" button on each row below doing the same thing. Both
     pre-date POS licensing, and they bound a TERMINAL without touching the
     LICENCE — so a supervisor could register a machine, see it confirmed on
     this screen, and still be blocked at the till, with nothing on the page
     hinting at why. (Observed exactly that way.)

     Linking now happens once, under Till licences below, in a single action
     that sets both. This card is a list of the shop's registers again — what a
     sale records, not which machine is standing at one. */
  return (
    <>
      <Card>
        <CardHeader
          icon={<Icons.Terminal size={16} />}
          title="Tills"
          /* Says what the screen a cashier stands at is set FROM, because that
             is now a per-till choice and the control is one small select in a
             row of icon buttons. A shop with a wholesale desk and a retail
             counter needs to know that is possible before they go looking. */
          description="Every register in the store. A sale records which one rang it up, and each till runs its own screen — so a wholesale desk and a retail counter can differ."
          /* Always primary now. It used to step down to `secondary` when
             claiming a till was the more urgent act on this screen — but
             claiming no longer happens here, so registering one is the only
             thing this card does. */
          action={
            <Button variant="primary" onClick={() => setAdding(true)} disabled={pending}>
              <Icons.Plus size={15} />
              Register a till
            </Button>
          }
        />

        {terminals.length === 0 ? (
          <EmptyState
            icon={<Icons.Terminal size={22} />}
            title="No tills registered yet"
            hint="Add one for each register — the codes print on the slip and group every report."
            action={
              // Secondary: the header's Register a till stays the one primary.
              <Button variant="secondary" onClick={() => setAdding(true)} disabled={pending}>
                <Icons.Plus size={15} />
                Register a till
              </Button>
            }
          />
        ) : (
          <div>
            {terminals.map((terminal) => (
              <SettingRow
                key={terminal.id}
                icon={<Icons.Terminal size={16} />}
                label={`${terminal.code} — ${terminal.name}`}
                description={describe(terminal, device.id)}
              >
                <div className="flex items-center gap-1.5">
                  {!device.ready ? (
                    // The claim state is unknowable until the browser has been
                    // asked — hold the space rather than flash "unclaimed".
                    <Skeleton className="h-4 w-24" />
                  ) : (
                    <>
                      {!terminal.isActive && <Badge tone="neutral">Off</Badge>}
                      {terminal.deviceId === device.id && device.id && (
                        <Badge tone="success">This machine</Badge>
                      )}
                      {terminal.deviceId && terminal.deviceId !== device.id && (
                        <Badge tone="brand">In use</Badge>
                      )}
                    </>
                  )}

                  {/* ── WHAT KIND OF TILL THIS ONE IS ──────────────────────
                      On the ROW, not in the edit dialog, because the question a
                      manager actually has is comparative: "which of my four
                      tills runs what". That is a column you read down, not four
                      modals you open in turn.

                      A select rather than the three explanatory cards this
                      replaced. Those earned their room while the choice was
                      made ONCE for the whole shop; repeated per till they would
                      be three paragraphs of identical prose per row. The hint
                      is carried once, above the list. */}
                  <Select
                    aria-label={`What kind of till ${terminal.code} is`}
                    value={terminal.posMode}
                    disabled={pending}
                    onChange={(e) => {
                      const next = toPosMode(e.target.value)
                      if (next === terminal.posMode) return
                      run(() => setTerminalPosModeAction(terminal.id, next))
                    }}
                    className="h-8 w-[150px] text-[13px]"
                  >
                    {POS_MODES.map((value) => (
                      <option key={value} value={value}>
                        {POS_MODE_LABELS[value]}
                      </option>
                    ))}
                  </Select>

                  {/* ── WHICH ROOM THIS TILL SELLS OUT OF ──────────────────
                      Beside the mode and on the row for the same reason: the
                      question is comparative. "Which of my tills sells from
                      where" is a column a manager reads down, and getting it
                      wrong is the kind of mistake you spot by seeing two rows
                      disagree.

                      Hidden entirely on a single-room shop. With one location
                      there is nothing to choose, and a select whose only option
                      is the one already in force is a control that asks a
                      question the shop does not have — which is how somebody
                      ends up believing it matters. */}
                  {locations.length > 1 && (
                    <Select
                      aria-label={`Which stock location ${terminal.code} sells from`}
                      value={terminal.stockLocationId === null ? '' : String(terminal.stockLocationId)}
                      disabled={pending}
                      onChange={(e) => {
                        const raw = e.target.value
                        const next = raw === '' ? null : Number(raw)
                        if (next === terminal.stockLocationId) return
                        run(() => setTerminalStockLocationAction(terminal.id, next))
                      }}
                      className="h-8 w-[150px] text-[13px]"
                    >
                      {/* Empty value, not the main location's id. Choosing this
                          stores NULL, which means "whichever room is main" and
                          keeps following it if the shop later moves main
                          elsewhere. Storing today's main id would freeze that
                          answer and quietly stop tracking. */}
                      <option value="">Main location</option>
                      {locations.map((l) => (
                        <option key={l.id} value={String(l.id)}>
                          {l.name}
                          {l.isMain ? ' (main)' : ''}
                        </option>
                      ))}
                    </Select>
                  )}

                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    aria-label={`Edit ${terminal.name}`}
                    onClick={() => setEditing(terminal)}
                  >
                    <Icons.Pencil size={15} />
                  </Button>
                  <Button
                    variant="danger-ghost"
                    size="sm"
                    iconOnly
                    aria-label={`Delete ${terminal.name}`}
                    disabled={pending}
                    onClick={() => setDeleting(terminal)}
                  >
                    <Icons.Trash size={15} />
                  </Button>
                </div>
              </SettingRow>
            ))}
          </div>
        )}
      </Card>

      <TerminalModal
        terminal={adding ? null : editing}
        open={adding || editing !== null}
        suggestedCode={suggestedCode}
        pending={pending}
        onClose={() => {
          setAdding(false)
          setEditing(null)
        }}
        onSave={(input) => run(() => saveTerminalAction(editing?.id ?? null, input))}
      />

      <ConfirmModal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && run(() => deleteTerminalAction(deleting.id))}
        title={`Delete ${deleting?.name}?`}
        message="A till that has rung up sales cannot be deleted — that history has to keep saying which register it came from. Deactivate it instead."
        confirmLabel="Delete till"
        busy={pending}
      />
    </>
  )
}

function describe(terminal: Terminal, thisDevice: string | null): string {
  const parts: string[] = []
  if (terminal.location) parts.push(terminal.location)
  if (terminal.deviceId === thisDevice && thisDevice) parts.push('registered to this machine')
  else if (terminal.deviceLabel) parts.push(terminal.deviceLabel)
  else parts.push('unclaimed')
  if (terminal.documentCount > 0) {
    parts.push(`${terminal.documentCount} document${terminal.documentCount === 1 ? '' : 's'}`)
  }
  if (terminal.lastSeenAt) parts.push(`last used ${terminal.lastSeenAt.toLocaleDateString('en-ZA')}`)
  return parts.join(' · ')
}

function TerminalModal({
  terminal,
  open,
  suggestedCode,
  pending,
  onClose,
  onSave,
}: {
  terminal: Terminal | null
  open: boolean
  suggestedCode: string | null
  pending: boolean
  onClose: () => void
  onSave: (input: { code: string; name: string; location: string | null; isActive: boolean }) => void
}) {
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [location, setLocation] = useState('')
  const [isActive, setIsActive] = useState(true)
  const [seeded, setSeeded] = useState<number | null>(null)

  if (open && seeded !== (terminal?.id ?? 0)) {
    setSeeded(terminal?.id ?? 0)
    /* A NEW till opens on the suggestion; an existing one always keeps its own
       code, which is why `terminal?.code` is read first. Clearing the field is
       how somebody asks for the next code instead of the one on screen — the
       server issues it from the sequence when a blank arrives. */
    setCode(terminal?.code ?? suggestedCode ?? '')
    setName(terminal?.name ?? '')
    setLocation(terminal?.location ?? '')
    setIsActive(terminal?.isActive ?? true)
  }
  if (!open && seeded !== null) setSeeded(null)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={terminal ? `Edit ${terminal.name}` : 'Register a till'}
      size="sm"
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={pending}
            onClick={() => onSave({ code, name, location: location || null, isActive })}
          >
            {pending ? 'Saving…' : terminal ? 'Save changes' : 'Register'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* The hint changes with the suggestion, because "clear it for the next
            one" is only true when there IS a next one to fall back to. */}
        <Field
          label="Code"
          hint={
            !terminal && suggestedCode
              ? 'Prints on the slip and groups reports. Type over it, or clear it for the next code.'
              : 'Prints on the slip and groups reports. e.g. TILL01'
          }
        >
          <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={24} />
        </Field>
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Front counter"
            maxLength={60}
          />
        </Field>
        <Field label="Location" hint="Optional — where in the store it sits.">
          <Input value={location} onChange={(e) => setLocation(e.target.value)} maxLength={60} />
        </Field>
        <Switch
          checked={isActive}
          onChange={setIsActive}
          label="Active"
          hint="A deactivated till stops working on its next sale, not at the next sign-in."
        />
      </div>
    </Modal>
  )
}

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
  SettingRow,
  Skeleton,
  Switch,
  useToast,
} from '@/components/ui'
import { deviceId } from '@/lib/deviceId'
import type { Terminal } from '@/lib/site/terminals'
import {
  saveTerminalAction,
  deleteTerminalAction,
} from './actions'

/**
 * Till setup.
 *
 * The screen has two jobs: registering tills as master data, and letting THIS
 * machine claim one. Those are deliberately separate — a manager registers
 * TILL01 through TILL04 from the back office, and each machine then claims its
 * own, rather than a till having to be set up at the counter it will live on.
 */
export default function TerminalsClient({ terminals }: { terminals: Terminal[] }) {
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
          title="Tills"
          description="Every register in the store. A sale records which one rang it up."
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
  pending,
  onClose,
  onSave,
}: {
  terminal: Terminal | null
  open: boolean
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
    setCode(terminal?.code ?? '')
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
        <Field label="Code" hint="Prints on the slip and groups reports. e.g. TILL01">
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

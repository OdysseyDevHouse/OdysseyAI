'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmModal,
  Field,
  Icons,
  Input,
  Modal,
  SettingRow,
  Switch,
  useToast,
} from '@/components/ui'
import { deviceId, deviceLabel, isDesktopShell } from '@/lib/deviceId'
import type { Terminal } from '@/lib/site/terminals'
import {
  saveTerminalAction,
  deleteTerminalAction,
  releaseTerminalAction,
  claimTerminalAction,
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
  const [device, setDevice] = useState<{ id: string | null; label: string; desktop: boolean }>({
    id: null,
    label: '',
    desktop: false,
  })
  useEffect(() => {
    setDevice({ id: deviceId(), label: deviceLabel(), desktop: isDesktopShell() })
  }, [])

  const claimedHere = device.id ? terminals.find((t) => t.deviceId === device.id) : undefined

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

  return (
    <>
      <Card>
        <CardHeader
          title="This machine"
          description={
            device.desktop
              ? 'Running in the desktop app, which supplies a stable machine id.'
              : 'Running in a browser. The id is kept in this browser’s storage.'
          }
        />
        <SettingRow
          icon={<Icons.Terminal size={16} />}
          label={claimedHere ? `Registered as ${claimedHere.name}` : 'Not registered to a till'}
          description={
            claimedHere
              ? `${claimedHere.code} · ${device.label}`
              : device.id
                ? `${device.label} · claim a till below to ring up sales from this machine`
                : 'This browser cannot store an identifier, so a till must be chosen each time.'
          }
        >
          {claimedHere && (
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => run(() => releaseTerminalAction(claimedHere.id))}
            >
              <Icons.Close size={15} />
              Release
            </Button>
          )}
        </SettingRow>
      </Card>

      <Card>
        <CardHeader
          title="Tills"
          description="Every register in the store. A sale records which one rang it up."
          action={
            <Button variant="primary" onClick={() => setAdding(true)} disabled={pending}>
              <Icons.Plus size={15} />
              Register a till
            </Button>
          }
        />

        {terminals.length === 0 ? (
          <div className="px-6 py-8 text-center text-sm text-muted">
            No tills registered yet. Add one for each register — the codes print on the slip and
            group every report.
          </div>
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
                  {!terminal.isActive && <Badge tone="neutral">Off</Badge>}
                  {terminal.deviceId === device.id && device.id && (
                    <Badge tone="success">This machine</Badge>
                  )}
                  {terminal.deviceId && terminal.deviceId !== device.id && (
                    <Badge tone="brand">Claimed</Badge>
                  )}

                  {terminal.isActive && terminal.deviceId !== device.id && device.id && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={pending}
                      onClick={() =>
                        run(() => claimTerminalAction(terminal.id, device.id!, device.label))
                      }
                    >
                      <Icons.Check size={15} />
                      Use here
                    </Button>
                  )}

                  <Button variant="ghost" size="sm" onClick={() => setEditing(terminal)}>
                    <Icons.Pencil size={15} />
                    Edit
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
          <Button variant="ghost" onClick={onClose} disabled={pending}>
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

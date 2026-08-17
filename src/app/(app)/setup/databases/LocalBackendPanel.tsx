'use client'

import { useState } from 'react'
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Field,
  Icons,
  Input,
  Modal,
  useToast,
} from '@/components/ui'
import { revealDbPasswordAction } from './localBackendActions'

/**
 * What support needs to see about a shop that holds its own data.
 *
 * ── WHY A VERDICT AT THE TOP ────────────────────────────────────────────────
 *
 * A local-backend site has state in three places — the machine's lease, what it
 * escrowed here, and whether its replica is keeping up — and a support call
 * begins with one question: "why can this shop not X". An agent should not have
 * to know which of three subsystems is the likely culprit before they can start
 * reading, so the screen synthesises the answer and the detail sits under it.
 */

export type MachineView = {
  deviceSerial: string
  dbPort: number | null
  dbName: string | null
  escrowedAt: string | null
  lastSeenAt: string | null
  hasEscrowedPassword: boolean
  hasUnlockSecret: boolean
  unlockCount: number
  lastUnlockAt: string | null
}

export type RevealView = {
  deviceSerial: string | null
  credential: string
  revealedByName: string | null
  reason: string
  createdAt: string | null
}

export type LocalBackendPanelProps = {
  verdict: { tone: 'success' | 'warning' | 'danger' | 'neutral'; headline: string }
  machines: MachineView[]
  lease: {
    licenceStatus: string
    checkedAt: string | null
    expiresAt: string | null
    daysSilent: number
    unlockCounter: number
  } | null
  replica: {
    status: string
    secondsBehind: number | null
    lastContactAt: string | null
    lastError: string | null
    databaseName: string
  } | null
  reveals: RevealView[]
}

const VERDICT_TONE = {
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  neutral: 'neutral',
} as const

function when(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toISOString().slice(0, 16).replace('T', ' ')
}

export default function LocalBackendPanel({
  verdict,
  machines,
  lease,
  replica,
  reveals,
}: LocalBackendPanelProps) {
  const toast = useToast()
  const [revealing, setRevealing] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [shown, setShown] = useState<{ password: string; port: number | null; dbName: string | null } | null>(null)

  async function reveal() {
    if (!revealing || busy) return
    setBusy(true)
    try {
      const result = await revealDbPasswordAction(revealing, reason)
      if (result.ok) {
        setShown({ password: result.password, port: result.port, dbName: result.dbName })
        toast.info('Recorded against your name.')
      } else {
        toast.error(result.error)
      }
    } catch {
      toast.error('That could not be read. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  function closeReveal() {
    setRevealing(null)
    setReason('')
    setShown(null)
  }

  return (
    <Card>
      <CardHeader
        icon={<Icons.Database size={18} />}
        title="This shop holds its own data"
        description="The database is on the shop's machine. We keep a licence record, an escrowed password and a reporting copy."
      />
      <CardBody>
        <div className="flex flex-col gap-5">
          {/* The loudest thing on the panel, and the only thing an agent has to
              read if the answer is "it is fine". */}
          <Callout tone={VERDICT_TONE[verdict.tone]}>{verdict.headline}</Callout>

          {machines.length === 0 ? (
            <p className="text-sm text-muted">
              No machine has registered yet. It appears here the first time the shop signs in
              after installing.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {machines.map((m) => (
                <div key={m.deviceSerial} className="rounded-control border border-border bg-surface-2 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <code className="block select-all break-all text-[13px] font-semibold text-ink">
                        {m.deviceSerial}
                      </code>
                      <p className="mt-1 text-xs text-muted">
                        {m.dbName ?? 'database unknown'}
                        {m.dbPort ? ` · port ${m.dbPort}` : ''} · last heard from {when(m.lastSeenAt)}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {/* A machine that has phoned in repeatedly is the fact
                          worth surfacing without anybody going to look for it. */}
                      {m.unlockCount > 0 && (
                        <Badge tone={m.unlockCount >= 3 ? 'danger' : 'warning'}>
                          {m.unlockCount} unlock{m.unlockCount === 1 ? '' : 's'}
                        </Badge>
                      )}
                      {!m.hasUnlockSecret && <Badge tone="warning">No unlock secret</Badge>}
                      {m.hasEscrowedPassword ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setRevealing(m.deviceSerial)}
                        >
                          <Icons.Lock size={16} />
                          Reveal password
                        </Button>
                      ) : (
                        <Badge tone="danger">No password escrowed</Badge>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Licence lease</h3>
              {lease ? (
                <dl className="mt-2 flex flex-col gap-1 text-sm">
                  <Row label="Last checked" value={when(lease.checkedAt)} />
                  <Row label="Locks at" value={when(lease.expiresAt)} />
                  <Row label="Silent for" value={`${lease.daysSilent} day${lease.daysSilent === 1 ? '' : 's'}`} />
                  <Row label="Status" value={lease.licenceStatus} />
                </dl>
              ) : (
                <p className="mt-2 text-sm text-muted">
                  Not readable from here — the shop's database is on its own machine, so this is
                  normal unless you are sitting at it.
                </p>
              )}
            </section>

            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Reporting replica</h3>
              {replica ? (
                <dl className="mt-2 flex flex-col gap-1 text-sm">
                  <Row label="Status" value={replica.status} />
                  <Row
                    label="Behind by"
                    value={
                      replica.secondsBehind === null
                        ? 'not running'
                        : `${Math.round(replica.secondsBehind / 60)} min`
                    }
                  />
                  <Row label="Last contact" value={when(replica.lastContactAt)} />
                  <Row label="Database" value={replica.databaseName} />
                </dl>
              ) : (
                <p className="mt-2 text-sm text-muted">
                  None yet. Head-office reports cannot include this shop until one is provisioned.
                </p>
              )}
              {replica?.lastError && (
                <Callout tone="danger" className="mt-2">
                  {replica.lastError}
                </Callout>
              )}
            </section>
          </div>

          {reveals.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
                Credentials read
              </h3>
              <ul className="mt-2 flex flex-col gap-1.5">
                {reveals.map((r, i) => (
                  <li key={i} className="flex flex-wrap items-baseline gap-x-2 text-sm text-ink-2">
                    <span className="numeric text-xs text-muted">{when(r.createdAt)}</span>
                    <span className="font-medium text-ink">{r.revealedByName ?? 'unknown'}</span>
                    <span className="text-muted">— {r.reason}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </CardBody>

      <Modal
        open={revealing !== null}
        onClose={closeReveal}
        title={shown ? 'Database password' : 'Reveal the database password'}
      >
        {shown ? (
          <div className="flex flex-col gap-4">
            <Callout tone="warning">
              Never give this to the customer. It opens their live trading database, and a shop
              that can edit its own takings has figures nobody can rely on.
            </Callout>
            <div className="rounded-control border border-border bg-surface-2 px-4 py-3">
              <span className="block text-xs font-semibold uppercase tracking-wide text-muted">
                Password
              </span>
              <code className="mt-1 block select-all break-all text-[15px] text-ink">
                {shown.password}
              </code>
              <p className="mt-2 text-xs text-muted">
                {shown.dbName ?? 'database'} on 127.0.0.1
                {shown.port ? `:${shown.port}` : ''}, on the shop's own machine.
              </p>
            </div>
            <div className="flex justify-end">
              <Button variant="secondary" onClick={closeReveal}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted">
              This is recorded against your name and shown on this screen afterwards.
            </p>
            <Field
              label="Why is this needed?"
              hint="A sentence. Support recovering a machine, not a customer request."
            >
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Machine will not start after a Windows update; rebuilding the service."
                autoFocus
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={closeReveal} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => void reveal()}
                disabled={busy || reason.trim().length < 5}
              >
                {busy ? 'Recording…' : 'Reveal'}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </Card>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="numeric text-ink-2">{value}</dd>
    </div>
  )
}

'use client'

import { useState } from 'react'
import {
  Button,
  Card,
  CardHeader,
  CardBody,
  Callout,
  Field,
  Input,
  Textarea,
  Icons,
  Badge,
} from '@/components/ui'
import { issueUnlockAction, type IssueResult } from './unlockActions'

/**
 * The support desk's half of the telephone unlock.
 *
 * A shop rings in because its machine has locked itself after a week with no
 * line. The cashier reads out the code on their screen, this turns it into the
 * code that releases them, and the whole exchange happens over the phone —
 * nothing travels between the two machines, because one of them has no way to
 * send anything.
 *
 * ── WHY THE PRIOR-GRANT COUNT IS SHOWN SO PROMINENTLY ───────────────────────
 *
 * Because it is the only thing standing between this feature and a permanent
 * free tier. No cryptography can stop an agent issuing a code to a shop that
 * simply is not paying — granting access without verification is what the
 * scheme is FOR. What can be done is put the history in front of the person
 * about to grant the next one, at the moment they are deciding.
 *
 * A shop on its fourth unlock is not a connectivity problem, and the agent
 * should be able to see that without going to look for it.
 */
export default function UnlockPanel() {
  const [challenge, setChallenge] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<IssueResult | null>(null)

  async function issue() {
    if (!challenge.trim() || busy) return
    setBusy(true)
    setResult(null)
    try {
      setResult(await issueUnlockAction(challenge, reason))
    } catch {
      setResult({ ok: false, error: 'The code could not be issued. Please try again.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader
        icon={<Icons.Phone size={18} />}
        title="Unlock a machine over the phone"
        description="For a local installation that has been offline too long to check its licence."
      />
      <CardBody>
        <div className="flex flex-col gap-4">
          <Field
            label="Code the customer read out"
            hint="Nine letters and numbers, usually shown as three groups."
          >
            <Input
              value={challenge}
              onChange={(e) => setChallenge(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void issue()
              }}
              placeholder="ACD-EFG-HJK"
              autoComplete="off"
              spellCheck={false}
              className="numeric text-lg uppercase tracking-[0.15em]"
            />
          </Field>

          <Field
            label="Why this is being granted"
            hint="Kept against your name. A site that keeps needing this is a conversation, not a fault."
          >
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="Line down since Friday, engineer booked for Tuesday."
            />
          </Field>

          <div>
            <Button
              variant="primary"
              onClick={() => void issue()}
              disabled={busy || challenge.trim().length === 0}
            >
              <Icons.Lock size={18} />
              {busy ? 'Checking…' : 'Issue unlock code'}
            </Button>
          </div>

          {result && !result.ok && <Callout tone="danger">{result.error}</Callout>}

          {result?.ok && (
            <div className="flex flex-col gap-3">
              {/* The number that should give an agent pause, placed where it
                  cannot be missed while reading the code out. */}
              {result.priorGrants > 0 && (
                <Callout tone={result.priorGrants >= 3 ? 'danger' : 'warning'}>
                  This machine has already been unlocked{' '}
                  <strong>
                    {result.priorGrants} {result.priorGrants === 1 ? 'time' : 'times'}
                  </strong>
                  . {result.priorGrants >= 3
                    ? 'That is a pattern rather than an outage — check the account before granting another.'
                    : 'Worth asking why it keeps losing its connection.'}
                </Callout>
              )}

              <div className="rounded-control border border-success/30 bg-success-soft px-4 py-3">
                <span className="block text-xs font-semibold uppercase tracking-wide text-success">
                  Read this back to the customer
                </span>
                <code className="numeric mt-1 block select-all text-2xl font-semibold tracking-[0.2em] text-ink">
                  {result.response}
                </code>
                <p className="mt-2 text-xs text-muted">
                  Unlocks <span className="numeric">{result.deviceSerial}</span> for{' '}
                  {result.days} days. It can only be used once.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <Badge tone="neutral">Recorded against your name</Badge>
              </div>
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  )
}

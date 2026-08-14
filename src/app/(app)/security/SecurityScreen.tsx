'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Badge, Button, Card, CardBody, CardHeader, Field, Icons, Input, useToast } from '@/components/ui'
import { beginEnrolmentAction, confirmEnrolmentAction, disableTotpAction } from './actions'

export default function SecurityScreen({ enabled, email }: { enabled: boolean; email: string }) {
  const toast = useToast()
  const router = useRouter()
  const [busy, start] = useTransition()
  const [enrolment, setEnrolment] = useState<{ secret: string; uri: string } | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')

  function begin() {
    start(async () => {
      const result = await beginEnrolmentAction()
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setEnrolment({ secret: result.secret, uri: result.uri })
      setCode('')
      setError('')
    })
  }

  function confirm() {
    start(async () => {
      const result = await confirmEnrolmentAction(code)
      if (!result.ok) {
        setError(result.error)
        return
      }
      toast.success('Two-factor is on. From now on, sign-in asks for the code.')
      setEnrolment(null)
      router.refresh()
    })
  }

  function turnOff() {
    start(async () => {
      const result = await disableTotpAction(code)
      if (!result.ok) {
        setError(result.error)
        return
      }
      toast.success('Two-factor is off.')
      setCode('')
      router.refresh()
    })
  }

  if (enabled) {
    return (
      <Card>
        <CardHeader
          title="Two-factor authentication"
          description={`On for ${email}. Signing in asks for the app's six digits after the password.`}
          action={<Badge tone="success" dot>On</Badge>}
        />
        <CardBody>
          <div className="flex max-w-md flex-col gap-3">
            <Field
              label="Turn it off"
              hint="Needs a current code — a found unlocked laptop must not be enough."
              error={error || undefined}
            >
              <Input
                value={code}
                inputMode="numeric"
                maxLength={6}
                placeholder="123456"
                onChange={(e) => {
                  setCode(e.target.value)
                  setError('')
                }}
              />
            </Field>
            <div>
              <Button variant="danger" disabled={busy || code.length !== 6} onClick={turnOff}>
                Turn two-factor off
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader
        title="Two-factor authentication"
        description="A code from an authenticator app, asked for after your password. A stolen password alone stops working."
        action={<Badge tone="neutral">Off</Badge>}
      />
      <CardBody>
        {enrolment === null ? (
          <Button variant="primary" disabled={busy} onClick={begin}>
            <Icons.ShieldCheck size={15} />
            Turn on two-factor
          </Button>
        ) : (
          <div className="flex max-w-lg flex-col gap-4">
            <div>
              <p className="text-sm font-medium text-ink">
                1. Add the account to your authenticator app
              </p>
              <p className="mt-1 text-sm text-muted">
                In Google Authenticator, Aegis, 1Password or any TOTP app, choose{' '}
                <span className="font-medium text-ink-2">Enter a setup key</span> and type:
              </p>
              <p className="numeric mt-2 select-all break-all rounded-control bg-surface-2 px-3 py-2 text-sm font-semibold tracking-wider text-ink">
                {enrolment.secret}
              </p>
              <p className="mt-1 text-xs text-muted">
                Account name: {email} · Type: time-based · Or paste the full link:{' '}
                <span className="numeric select-all break-all">{enrolment.uri}</span>
              </p>
            </div>

            <Field
              label="2. Type the six digits the app shows"
              hint="This proves the app holds the key before the lock turns on."
              error={error || undefined}
            >
              <Input
                value={code}
                inputMode="numeric"
                maxLength={6}
                placeholder="123456"
                autoFocus
                onChange={(e) => {
                  setCode(e.target.value)
                  setError('')
                }}
              />
            </Field>

            <div className="flex gap-2">
              <Button variant="secondary" disabled={busy} onClick={() => setEnrolment(null)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy || code.length !== 6} onClick={confirm}>
                {busy ? 'Checking…' : 'Confirm and turn on'}
              </Button>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  )
}

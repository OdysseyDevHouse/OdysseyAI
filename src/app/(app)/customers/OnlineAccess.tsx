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
  Input,
  useToast,
} from '@/components/ui'
import type { LoginSummary } from '@/lib/site/customerAuth'
import { setOnlineAccessAction, setOnlineAccessActiveAction } from './onlineAccessActions'

/**
 * Giving a customer a sign-in for the online store.
 *
 * ── STAFF SET THE PASSWORD, AND IT EXPIRES ON FIRST USE ──────────────────
 *
 * There is no email sending in this app yet, so a self-service reset would be
 * a link that goes nowhere. Instead staff choose a password, tell the customer
 * over the counter or the phone, and it is marked `must change` — so the
 * moment the customer signs in they are made to replace it. A shared secret
 * that stays shared is the thing to avoid, not the initial handover.
 *
 * ── THE PASSWORD IS NEVER SHOWN BACK ─────────────────────────────────────
 *
 * Once saved it is a bcrypt hash and nobody can read it, including us. The
 * field always starts empty and the panel says "reset" rather than "change",
 * because there is nothing to change from.
 */
export default function OnlineAccess({
  customerId,
  customerEmail,
  login,
}: {
  customerId: number
  /** Prefills the form — most customers sign in with the address already on file. */
  customerEmail: string
  login: LoginSummary | null
}) {
  const router = useRouter()
  const toast = useToast()
  const [busy, start] = useTransition()
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState(login?.email || customerEmail)
  const [password, setPassword] = useState('')

  function save() {
    start(async () => {
      const result = await setOnlineAccessAction(customerId, email, password)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(
        login ? 'Password reset. Give the customer the new one.' : 'Online access set up.',
      )
      setPassword('')
      setOpen(false)
      router.refresh()
    })
  }

  function toggleActive(active: boolean) {
    start(async () => {
      const result = await setOnlineAccessActiveAction(customerId, active)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(active ? 'Online access restored.' : 'Online access withdrawn.')
      router.refresh()
    })
  }

  const locked = login?.lockedUntil && login.lockedUntil > new Date()

  return (
    <Card>
      <CardHeader
        title="Online store access"
        description="Lets this customer sign in to your shop and order on their account."
        action={
          login ? (
            login.isActive ? (
              <Badge tone="success">Active</Badge>
            ) : (
              <Badge tone="neutral">Withdrawn</Badge>
            )
          ) : undefined
        }
      />
      <CardBody className="flex flex-col gap-3">
        {login && !open && (
          <div className="flex flex-col gap-1 text-sm">
            <p className="text-ink">
              Signs in as <span className="font-medium">{login.email}</span>
            </p>
            <p className="text-muted">
              {login.lastLoginAt
                ? `Last signed in ${login.lastLoginAt.toLocaleDateString('en-ZA')}.`
                : 'Has not signed in yet.'}
              {login.mustChange && ' Still using the password you set.'}
            </p>
            {locked && (
              <p className="text-warning">
                Locked after too many wrong passwords. Resetting the password unlocks it.
              </p>
            )}
          </div>
        )}

        {!login && !open && (
          <p className="text-sm text-muted">
            No online access yet. Set one up and give the customer the password.
          </p>
        )}

        {open && (
          <>
            <Field label="Email they sign in with">
              <Input value={email} type="email" onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field
              label={login ? 'New password' : 'Password'}
              hint="At least 8 characters. They will be asked to change it when they sign in."
            >
              <Input
                value={password}
                type="text"
                autoComplete="off"
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            {/* Shown, not masked: staff have to read it out to the customer,
                and a masked field they cannot check is how the wrong password
                gets handed over. */}
          </>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {open ? (
            <>
              <Button onClick={save} disabled={busy}>
                {busy ? 'Saving…' : login ? 'Reset password' : 'Set up access'}
              </Button>
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={() => setOpen(true)} disabled={busy}>
                {login ? 'Reset password' : 'Set up access'}
              </Button>
              {login &&
                (login.isActive ? (
                  /* Withdrawn, not deleted: the customer may need it back, and
                     deleting loses the record that they ever had access. */
                  <Button variant="danger-ghost" onClick={() => toggleActive(false)} disabled={busy}>
                    Withdraw access
                  </Button>
                ) : (
                  <Button variant="ghost" onClick={() => toggleActive(true)} disabled={busy}>
                    Restore access
                  </Button>
                ))}
            </>
          )}
        </div>
      </CardBody>
    </Card>
  )
}

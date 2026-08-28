'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  CopyLink,
  SettingGroup,
  SettingRow,
  Switch,
  useToast,
} from '@/components/ui'
import { savePortalAccountSettingsAction } from './actions'

/**
 * What a customer may see of their own account.
 *
 * ── THE SUB-SWITCHES STAY VISIBLE WHEN THE PORTAL IS OFF ──────────────────
 *
 * Disabled, not hidden. Somebody deciding whether to turn this on needs to see
 * WHAT it would turn on — a panel that collapses to a single switch asks them
 * to commit before they can read the consequences. They are stored either way
 * (see the action), so switching the portal on restores the choices already
 * made rather than resetting them.
 */
export default function PortalSettingsForm({
  initial,
  portalUrl,
  canTakePayments,
}: {
  initial: {
    accountsEnabled: boolean
    showTransactions: boolean
    showStatement: boolean
    allowPay: boolean
  }
  /** Null when SESSION_SECRET is missing. */
  portalUrl: string | null
  /** Whether a payment gateway is configured — the Pay switch is inert without one. */
  canTakePayments: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [busy, start] = useTransition()
  const [form, setForm] = useState(initial)

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  function save() {
    start(async () => {
      const result = await savePortalAccountSettingsAction(form)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Saved.')
      router.refresh()
    })
  }

  const off = !form.accountsEnabled

  return (
    <div className="flex flex-col gap-4">
      {/* SettingGroup IS the titled card — it brings its own header and frame,
          so wrapping it in another Card would double the border and the
          padding. */}
      <SettingGroup
        title="Customer account portal"
        description="Lets your customers sign in to see their own details, transactions and statement."
      >
        <SettingRow
          label="Let customers see their account"
          description="They sign in with the email address on their record — we email them a link each time. There is no password."
        >
          <Switch
            checked={form.accountsEnabled}
            ariaLabel="Let customers see their account"
            onChange={(value) => set('accountsEnabled', value)}
          />
        </SettingRow>

        <SettingRow
          label="Transaction history"
          description="Every invoice, payment and credit on the account, with a PDF of each."
        >
          <Switch
            checked={form.showTransactions}
            ariaLabel="Transaction history"
            disabled={off}
            onChange={(value) => set('showTransactions', value)}
          />
        </SettingRow>

        <SettingRow
          label="Statement"
          description="What is still owed, document by document, and a PDF on your own stationery."
        >
          <Switch
            checked={form.showStatement}
            ariaLabel="Statement"
            disabled={off}
            onChange={(value) => set('showStatement', value)}
          />
        </SettingRow>

        <SettingRow
          label="Let them pay online"
          description={
            canTakePayments
              ? 'Puts a Pay button on every outstanding invoice.'
              : 'Set up a payment gateway first — until then there is nothing for the button to do.'
          }
        >
          <Switch
            checked={form.allowPay}
            ariaLabel="Let them pay online"
            /* Disabled on the gateway too: a switch that can be turned on
               and changes nothing is worse than one that explains why. */
            disabled={off || !canTakePayments}
            onChange={(value) => set('allowPay', value)}
          />
        </SettingRow>
      </SettingGroup>

      <div>
        <Button onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>

      <Card>
        <CardHeader
          title="Your account link"
          description="The same address for every customer — they prove who they are by signing in."
        />
        <CardBody className="flex flex-col gap-3">
          {portalUrl ? (
            <>
              <CopyLink value={portalUrl} copiedMessage="Account link copied." />
              <p className="text-sm text-muted">
                Put this behind a “Your account” link on your website, in the footer of your
                emails, or on your statements. It is safe to publish: it names your business and
                nothing else, and everything past it needs a sign-in link sent to an address you
                already hold.
              </p>
            </>
          ) : (
            <Callout tone="danger" title="The link cannot be generated">
              This installation is missing its session secret. Please contact support.
            </Callout>
          )}
        </CardBody>
      </Card>
    </div>
  )
}

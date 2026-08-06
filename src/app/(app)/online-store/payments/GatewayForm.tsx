'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Field,
  Icons,
  Input,
  Switch,
  useToast,
} from '@/components/ui'
import { saveGatewayAction } from './actions'

/**
 * Connect a PayFast account.
 *
 * The secrets are write-only from this screen's point of view: they go in, and
 * the screen never gets them back. A "connected" indicator is all it can show,
 * because reading a stored payment credential into a browser would put it in
 * the DOM, in memory, and in any extension that cares to look.
 */

type GatewayState = {
  isActive: boolean
  isSandbox: boolean
  merchantId: string
  hasKey: boolean
  hasPassphrase: boolean
  credentialsUsable: boolean
}

export default function GatewayForm({
  gateway,
  encryptionReady,
  paymentMode,
}: {
  gateway: GatewayState | null
  /** Without an encryption key, credentials cannot be stored safely at all. */
  encryptionReady: boolean
  paymentMode: 'on_collection' | 'online'
}) {
  const toast = useToast()
  const [saving, startSaving] = useTransition()

  const [isActive, setIsActive] = useState(gateway?.isActive ?? false)
  const [isSandbox, setIsSandbox] = useState(gateway?.isSandbox ?? true)
  const [merchantId, setMerchantId] = useState(gateway?.merchantId ?? '')
  const [merchantKey, setMerchantKey] = useState('')
  const [passphrase, setPassphrase] = useState('')

  const alreadyHasKey = gateway?.hasKey ?? false

  function save() {
    startSaving(async () => {
      const result = await saveGatewayAction({
        isActive,
        isSandbox,
        merchantId,
        // Left blank means "keep what is stored". Requiring the key to be
        // retyped on every unrelated change is how people end up pasting
        // credentials into the wrong window.
        merchantKey: merchantKey.trim(),
        passphrase: passphrase.trim(),
      })

      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(isActive ? 'Payment account connected.' : 'Payment account disconnected.')
      setMerchantKey('')
      setPassphrase('')
    })
  }

  // Blank key on a store that has none, while switching on — the save will be
  // refused, so say so before they try.
  const missingKey = isActive && !alreadyHasKey && merchantKey.trim() === ''

  return (
    <>
      {!encryptionReady && (
        <Card>
          <div className="flex items-start gap-3 px-6 py-4">
            <Icons.StatusError size={18} className="mt-0.5 shrink-0 text-danger" />
            <div className="text-sm">
              <p className="font-medium text-ink">ENCRYPTION_KEY is not set.</p>
              <p className="text-muted">
                Payment credentials are stored encrypted, so they cannot be saved until it is
                configured in your environment.
              </p>
            </div>
          </div>
        </Card>
      )}

      {gateway && !gateway.credentialsUsable && (
        <Card>
          <div className="flex items-start gap-3 px-6 py-4">
            <Icons.StatusWarning size={18} className="mt-0.5 shrink-0 text-warning" />
            <div className="text-sm">
              <p className="font-medium text-ink">
                The stored credentials cannot be read back.
              </p>
              <p className="text-muted">
                ENCRYPTION_KEY has changed since they were saved. Enter your merchant key and
                passphrase again to reconnect.
              </p>
            </div>
          </div>
        </Card>
      )}

      {isActive && isSandbox && (
        // The most important warning on the screen. Test mode satisfies every
        // other check, so without this a store could open to the public and
        // collect play money for days before noticing.
        <Card>
          <div className="flex items-start gap-3 px-6 py-4">
            <Icons.StatusWarning size={18} className="mt-0.5 shrink-0 text-warning" />
            <div className="text-sm">
              <p className="font-medium text-ink">Test mode — no real money is taken.</p>
              <p className="text-muted">
                Customers can order and everything will look as though they paid. Switch test
                mode off before you share your shop link.
              </p>
            </div>
          </div>
        </Card>
      )}

      <Card>
        <CardHeader
          title="PayFast"
          description="Your own PayFast account. Customers pay you directly — the money never passes through us."
          action={
            gateway?.isActive && gateway.credentialsUsable ? (
              <Badge tone={gateway.isSandbox ? 'warning' : 'success'}>
                {gateway.isSandbox ? 'Test mode' : 'Live'}
              </Badge>
            ) : (
              <Badge tone="neutral">Not connected</Badge>
            )
          }
        />

        <CardBody className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4 rounded-control bg-surface-2 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">Take payments online</p>
              <p className="text-sm text-muted">
                Off means customers pay when they collect or receive their order.
              </p>
            </div>
            <Switch
              checked={isActive}
              onChange={setIsActive}
              disabled={!encryptionReady}
              label="Take payments online"
            />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-control bg-surface-2 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">Test mode</p>
              <p className="text-sm text-muted">
                Uses PayFast&apos;s sandbox. Nothing is really charged.
              </p>
            </div>
            <Switch checked={isSandbox} onChange={setIsSandbox} label="Test mode" />
          </div>

          <Field
            label="Merchant ID"
            hint="From your PayFast dashboard. All digits."
            error={isActive && merchantId.trim() === '' ? 'Enter your merchant ID.' : undefined}
          >
            <Input
              value={merchantId}
              inputMode="numeric"
              placeholder="10000100"
              onChange={(e) => setMerchantId(e.target.value)}
            />
          </Field>

          <Field
            label="Merchant key"
            hint={
              alreadyHasKey
                ? 'Stored. Leave blank to keep the current one.'
                : 'From your PayFast dashboard.'
            }
            error={missingKey ? 'Enter your merchant key.' : undefined}
          >
            <Input
              value={merchantKey}
              type="password"
              autoComplete="off"
              placeholder={alreadyHasKey ? '••••••••••••' : 'Your merchant key'}
              onChange={(e) => setMerchantKey(e.target.value)}
            />
          </Field>

          <Field
            label="Passphrase"
            hint={
              gateway?.hasPassphrase
                ? 'Stored. Leave blank to keep the current one.'
                : 'Set one in PayFast under Settings → Security. Strongly recommended.'
            }
          >
            <Input
              value={passphrase}
              type="password"
              autoComplete="off"
              placeholder={gateway?.hasPassphrase ? '••••••••••••' : 'Your passphrase'}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </Field>
        </CardBody>

        <CardFooter>
          <Button variant="primary" onClick={save} disabled={saving || !encryptionReady}>
            {saving ? 'Saving…' : 'Save payment settings'}
          </Button>
        </CardFooter>
      </Card>

      {gateway?.isActive && gateway.credentialsUsable && paymentMode !== 'online' && (
        <Card>
          <div className="flex items-start gap-3 px-6 py-4">
            <Icons.Info size={18} className="mt-0.5 shrink-0 text-muted" />
            <div className="text-sm">
              <p className="font-medium text-ink">
                Your shop still asks customers to pay on collection.
              </p>
              <p className="text-muted">
                Connecting an account does not change that by itself — choose “Pay online when
                ordering” in{' '}
                <Link href="/online-store/setup" className="font-medium text-brand hover:underline">
                  setup
                </Link>
                .
              </p>
            </div>
          </div>
        </Card>
      )}
    </>
  )
}

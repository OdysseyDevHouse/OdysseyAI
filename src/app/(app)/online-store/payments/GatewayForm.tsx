'use client'

import { useState, useTransition } from 'react'
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Field,
  Icons,
  Input,
  SettingRow,
  Switch,
  TextLink,
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
  /** Field errors only appear after a save attempt — flipping the switch on
      must not instantly paint the form red. */
  const [attempted, setAttempted] = useState(false)

  const alreadyHasKey = gateway?.hasKey ?? false

  function save() {
    setAttempted(true)
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
      setAttempted(false)
    })
  }

  // Blank key on a store that has none, while switching on — the save will be
  // refused, so say so once they have tried.
  const missingKey = attempted && isActive && !alreadyHasKey && merchantKey.trim() === ''

  /*
   * The screen's one banner. Several conditions can hold at once, but four
   * stacked cards bury the one that matters — show only the most severe:
   * cannot save at all > stored credentials broken > collecting play money >
   * connected but not switched on.
   */
  const banner = !encryptionReady ? (
    <Callout tone="danger" title="ENCRYPTION_KEY is not set.">
      Payment credentials are stored encrypted, so they cannot be saved until it is configured
      in your environment.
    </Callout>
  ) : gateway && !gateway.credentialsUsable ? (
    <Callout tone="warning" title="The stored credentials cannot be read back.">
      ENCRYPTION_KEY has changed since they were saved. Enter your merchant key and passphrase
      again to reconnect.
    </Callout>
  ) : isActive && isSandbox ? (
    // Test mode satisfies every other check, so without this a store could
    // open to the public and collect play money for days before noticing.
    <Callout tone="warning" title="Test mode — no real money is taken.">
      Customers can order and everything will look as though they paid. Switch test mode off
      before you share your shop link.
    </Callout>
  ) : gateway?.isActive && gateway.credentialsUsable && paymentMode !== 'online' ? (
    <Callout tone="neutral" title="Your shop still asks customers to pay on collection.">
      Connecting an account does not change that by itself — choose “Pay online when ordering”
      in <TextLink href="/online-store/setup">setup</TextLink>.
    </Callout>
  ) : null

  return (
    <>
      {banner}

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

        {/* SettingRows sit flush to the card edge (their dividers span it),
            so they live between header and body rather than inside CardBody. */}
        <SettingRow
          icon={<Icons.CreditCard size={18} />}
          label="Take payments online"
          description="Off means customers pay when they collect or receive their order."
        >
          <Switch
            checked={isActive}
            onChange={setIsActive}
            disabled={!encryptionReady}
            label="Take payments online"
          />
        </SettingRow>

        <SettingRow
          icon={<Icons.StatusWarning size={18} />}
          label="Test mode"
          description="Uses PayFast's sandbox. Nothing is really charged."
        >
          <Switch checked={isSandbox} onChange={setIsSandbox} label="Test mode" />
        </SettingRow>

        <CardBody className="flex flex-col gap-4">
          <Field
            label="Merchant ID"
            hint="From your PayFast dashboard. All digits."
            error={
              attempted && isActive && merchantId.trim() === ''
                ? 'Enter your merchant ID.'
                : undefined
            }
          >
            {/* An 8-digit id in a full-width box hints at the wrong content. */}
            <div className="w-40">
              <Input
                value={merchantId}
                inputMode="numeric"
                placeholder="10000100"
                onChange={(e) => setMerchantId(e.target.value)}
              />
            </div>
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
    </>
  )
}

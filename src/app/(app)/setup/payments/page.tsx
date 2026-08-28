import { requireCapability } from '@/lib/auth'
import { getGateway } from '@/lib/site/payments'
import { getOnlineSettings } from '@/lib/site/onlineStore'
import { encryptionKeyConfigured } from '@/lib/crypto/secrets'
import { PageHeader, PageBody, Badge } from '@/components/ui'
import GatewayForm from './GatewayForm'

/**
 * Online payments — the store's own payment account.
 *
 * The money moves shopper → store directly. This software never holds it, and
 * that is deliberate: routing store takings through one platform account would
 * make us a payment aggregator, which is a regulated activity.
 *
 * ── WHY THIS SITS IN SETUP AND NOT UNDER THE ONLINE STORE ─────────────────
 *
 * It lived there because the storefront was the first thing that needed a
 * gateway, and for a while it was the only one. It is not any more: a pay link
 * on an emailed invoice, a QR on a printed statement and an instalment against
 * a lay-by all need the same connected account, and none of them involves a
 * storefront at all.
 *
 * Behind the `online_store` MODULE it was worse than merely misfiled — a shop
 * that never bought the storefront could not reach the screen, so it could not
 * connect a gateway, so its invoice pay links silently never appeared and the
 * setting that enables them looked broken. The capability moves with it:
 * `setup.edit`, like everything else on this hub.
 */

export const dynamic = 'force-dynamic'

export default async function PaymentsPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('setup.edit')

  const [gateway, settings] = await Promise.all([getGateway(siteId), getOnlineSettings(siteId)])

  const live = gateway?.isActive && gateway.credentialsUsable && !gateway.isSandbox
  const testing = gateway?.isActive && gateway.credentialsUsable && gateway.isSandbox

  return (
    <>
      <PageHeader
        title="Online payments"
        subtitle="How customers pay you for online orders"
        action={
          live ? (
            <Badge tone="success">Live</Badge>
          ) : testing ? (
            <Badge tone="warning">Test mode</Badge>
          ) : (
            <Badge tone="neutral">Not connected</Badge>
          )
        }
      />
      <PageBody>
        <GatewayForm
          gateway={
            gateway
              ? {
                  isActive: gateway.isActive,
                  isSandbox: gateway.isSandbox,
                  merchantId: gateway.merchantId,
                  // The secrets themselves are NEVER sent to the browser —
                  // only whether they are present and readable.
                  hasKey: gateway.merchantKey !== '',
                  hasPassphrase: gateway.passphrase !== '',
                  credentialsUsable: gateway.credentialsUsable,
                }
              : null
          }
          encryptionReady={encryptionKeyConfigured()}
          paymentMode={settings.paymentMode}
        />
      </PageBody>
    </>
  )
}

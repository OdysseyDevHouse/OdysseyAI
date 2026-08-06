import { requireSiteId } from '@/lib/auth'
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
 */

export const dynamic = 'force-dynamic'

export default async function PaymentsPage() {
  const siteId = await requireSiteId()

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

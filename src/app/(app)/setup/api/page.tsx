import { requireCapability } from '@/lib/auth'
import { listApiKeys } from '@/lib/site/apiKeys'
import { listEndpoints, listDeliveries } from '@/lib/site/webhooks'
import { PageHeader, PageBody } from '@/components/ui'
import ApiScreen from './ApiScreen'

export const dynamic = 'force-dynamic'

/**
 * API keys and outbound webhooks — the store's machine door.
 *
 * Everything here is standing access with no person behind it, which is why
 * it wears its own capability (setup.api) rather than riding setup.edit.
 */
export default async function ApiSetupPage() {
  const { siteId } = await requireCapability('setup.api')

  const [keys, endpoints, deliveries] = await Promise.all([
    listApiKeys(siteId),
    listEndpoints(siteId),
    listDeliveries(siteId, { limit: 50 }),
  ])

  return (
    <>
      <PageHeader
        title="API & webhooks"
        subtitle="Keys that let outside programs read this store, and where events get pushed"
      />
      <PageBody>
        <ApiScreen
          keys={keys.map((k) => ({
            id: k.id,
            name: k.name,
            keyPrefix: k.keyPrefix,
            scopes: k.scopes,
            createdBy: k.createdBy,
            createdAt: k.createdAt ? k.createdAt.toISOString().slice(0, 10) : '',
            lastUsedAt: k.lastUsedAt ? k.lastUsedAt.toISOString().slice(0, 16).replace('T', ' ') : null,
            revoked: k.revokedAt !== null,
          }))}
          endpoints={endpoints.map((e) => ({
            id: e.id,
            url: e.url,
            events: e.events,
            isActive: e.isActive,
            lastSuccessAt: e.lastSuccessAt
              ? e.lastSuccessAt.toISOString().slice(0, 16).replace('T', ' ')
              : null,
            lastFailureAt: e.lastFailureAt
              ? e.lastFailureAt.toISOString().slice(0, 16).replace('T', ' ')
              : null,
          }))}
          deliveries={deliveries.map((d) => ({
            id: d.id,
            endpointUrl: d.endpointUrl,
            event: d.event,
            status: d.status,
            attempts: d.attempts,
            lastStatusCode: d.lastStatusCode,
            lastError: d.lastError,
            createdAt: d.createdAt ? d.createdAt.toISOString().slice(0, 16).replace('T', ' ') : '',
          }))}
        />
      </PageBody>
    </>
  )
}

'use server'

import { revalidatePath } from 'next/cache'
import { actorFor, requireCapability } from '@/lib/auth'
import { listApiKeys } from '@/lib/site/apiKeys'
import { listEndpoints, listDeliveries } from '@/lib/site/webhooks'
import { API_ENDPOINTS } from '@/app/api/v1/_lib/openapi'
import type {
  KeyRow,
  EndpointRow,
  DeliveryRow,
  ReferenceRow,
} from './ApiScreen'
import { logActivity } from '@/lib/site/activityLog'
import {
  createApiKey,
  revokeApiKey,
  isApiScope,
  type ApiScope,
} from '@/lib/site/apiKeys'
import {
  createEndpoint,
  updateEndpoint,
  setEndpointActive,
  deleteEndpoint,
  rotateEndpointSecret,
  redeliver,
  sendTestPing,
  isWebhookEvent,
  type WebhookEvent,
} from '@/lib/site/webhooks'

/* ── API keys ─────────────────────────────────────────────────────────────── */

export async function createApiKeyAction(input: {
  name: string
  scopes: string[]
  expiresInDays?: number | null
}): Promise<{ ok: true; rawKey: string } | { ok: false; error: string }> {
  const { siteId, actor } = await requireCapability('setup.api')
  const result = await createApiKey(siteId, actor, {
    name: input.name,
    scopes: input.scopes.filter(isApiScope) as ApiScope[],
    expiresInDays: input.expiresInDays ?? null,
  })
  if (!result.ok) return result
  await logActivity(siteId, actor, {
    entity: 'setting',
    entityId: result.id,
    action: 'api_key_created',
    detail: `API key "${input.name}" minted`,
  })
  revalidatePath('/settings')
  return { ok: true, rawKey: result.rawKey }
}

export async function revokeApiKeyAction(
  id: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { siteId, actor } = await requireCapability('setup.api')
  const result = await revokeApiKey(siteId, Number(id))
  if (!result.ok) return result
  await logActivity(siteId, actor, {
    entity: 'setting',
    entityId: Number(id),
    action: 'api_key_revoked',
    detail: `API key ${id} revoked`,
  })
  revalidatePath('/settings')
  return { ok: true }
}

/* ── Webhook endpoints ────────────────────────────────────────────────────── */

export async function createEndpointAction(input: {
  url: string
  events: string[]
}): Promise<{ ok: true; secret: string } | { ok: false; error: string }> {
  const { siteId, actor } = await requireCapability('setup.api')
  const result = await createEndpoint(siteId, {
    url: input.url,
    events: input.events.filter(isWebhookEvent) as WebhookEvent[],
  })
  if (!result.ok) return result
  await logActivity(siteId, actor, {
    entity: 'setting',
    entityId: result.id,
    action: 'webhook_created',
    detail: `Webhook endpoint added: ${input.url}`,
  })
  revalidatePath('/settings')
  return { ok: true, secret: result.secret }
}

export async function updateEndpointAction(input: {
  id: number
  url: string
  events: string[]
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { siteId } = await requireCapability('setup.api')
  const result = await updateEndpoint(siteId, Number(input.id), {
    url: input.url,
    events: input.events.filter(isWebhookEvent) as WebhookEvent[],
  })
  if (result.ok) revalidatePath('/settings')
  return result
}

export async function setEndpointActiveAction(id: number, active: boolean): Promise<void> {
  const { siteId } = await requireCapability('setup.api')
  await setEndpointActive(siteId, Number(id), active)
  revalidatePath('/settings')
}

export async function rotateEndpointSecretAction(
  id: number,
): Promise<{ ok: true; secret: string } | { ok: false; error: string }> {
  const { siteId, actor } = await requireCapability('setup.api')
  const result = await rotateEndpointSecret(siteId, Number(id))
  if (!result.ok) return result
  await logActivity(siteId, actor, {
    entity: 'setting',
    entityId: Number(id),
    action: 'webhook_secret_rotated',
    detail: `Webhook ${id} signing secret rotated`,
  })
  revalidatePath('/settings')
  return result
}

export async function deleteEndpointAction(id: number): Promise<void> {
  const { siteId, actor } = await requireCapability('setup.api')
  await deleteEndpoint(siteId, Number(id))
  await logActivity(siteId, actor, {
    entity: 'setting',
    entityId: Number(id),
    action: 'webhook_deleted',
    detail: `Webhook endpoint ${id} deleted`,
  })
  revalidatePath('/settings')
}

export async function sendTestPingAction(
  endpointId: number,
): Promise<{ ok: true; statusCode: number } | { ok: false; error: string }> {
  const { siteId } = await requireCapability('setup.api')
  const result = await sendTestPing(siteId, Number(endpointId))
  revalidatePath('/settings')
  return result
}

export async function redeliverAction(
  deliveryId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { siteId } = await requireCapability('setup.api')
  const result = await redeliver(siteId, Number(deliveryId))
  if (result.ok) revalidatePath('/settings')
  return result
}

/**
 * What the System panel renders, in one read.
 *
 * New with the move out of /setup/api: that screen was a route whose page.tsx
 * did these three reads on the server and mapped the rows for the client. As a
 * TAB of /settings there is no page of its own, so the panel asks when opened —
 * see `usePanelData`.
 *
 * `actorFor` rather than the `requireCapability` the actions above use: this is
 * called from the browser when a tab opens, and a redirect out of a fetch is
 * not something the panel can render. The guard is the same `setup.api` either
 * way — standing machine access with no person behind it, which is why it wears
 * its own capability rather than riding setup.edit.
 */
export type SystemPanelState =
  | {
      ok: true
      keys: KeyRow[]
      endpoints: EndpointRow[]
      deliveries: DeliveryRow[]
      reference: ReferenceRow[]
    }
  | { ok: false; error: string }

export async function loadSystemPanelAction(): Promise<SystemPanelState> {
  const ctx = await actorFor('setup.api')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const [keys, endpoints, deliveries] = await Promise.all([
    listApiKeys(siteId),
    listEndpoints(siteId),
    listDeliveries(siteId, { limit: 50 }),
  ])

  /* Dates flattened to strings here rather than in the panel: a Date does not
     survive the server/client boundary intact, and formatting in three places
     is how two screens end up disagreeing about what "last used" means. */
  return {
    ok: true,
    keys: keys.map((k) => ({
      id: k.id,
      name: k.name,
      keyPrefix: k.keyPrefix,
      scopes: k.scopes,
      createdBy: k.createdBy,
      createdAt: k.createdAt ? k.createdAt.toISOString().slice(0, 10) : '',
      lastUsedAt: k.lastUsedAt ? k.lastUsedAt.toISOString().slice(0, 16).replace('T', ' ') : null,
      revoked: k.revokedAt !== null,
      expiresAt: k.expiresAt ? k.expiresAt.toISOString().slice(0, 10) : null,
      expired: k.expired,
    })),
    endpoints: endpoints.map((e) => ({
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
    })),
    deliveries: deliveries.map((d) => ({
      id: d.id,
      endpointUrl: d.endpointUrl,
      event: d.event,
      status: d.status,
      attempts: d.attempts,
      lastStatusCode: d.lastStatusCode,
      lastError: d.lastError,
      createdAt: d.createdAt ? d.createdAt.toISOString().slice(0, 16).replace('T', ' ') : '',
    })),
    reference: API_ENDPOINTS.map((e) => ({
      method: e.method.toUpperCase(),
      path: e.path,
      scope: e.scope,
      summary: e.summary,
    })),
  }
}

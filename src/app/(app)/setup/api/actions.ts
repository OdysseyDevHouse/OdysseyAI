'use server'

import { revalidatePath } from 'next/cache'
import { requireCapability } from '@/lib/auth'
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
  isWebhookEvent,
  type WebhookEvent,
} from '@/lib/site/webhooks'

/* ── API keys ─────────────────────────────────────────────────────────────── */

export async function createApiKeyAction(input: {
  name: string
  scopes: string[]
}): Promise<{ ok: true; rawKey: string } | { ok: false; error: string }> {
  const { siteId, actor } = await requireCapability('setup.api')
  const result = await createApiKey(siteId, actor, {
    name: input.name,
    scopes: input.scopes.filter(isApiScope) as ApiScope[],
  })
  if (!result.ok) return result
  await logActivity(siteId, actor, {
    entity: 'setting',
    entityId: result.id,
    action: 'api_key_created',
    detail: `API key "${input.name}" minted`,
  })
  revalidatePath('/setup/api')
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
  revalidatePath('/setup/api')
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
  revalidatePath('/setup/api')
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
  if (result.ok) revalidatePath('/setup/api')
  return result
}

export async function setEndpointActiveAction(id: number, active: boolean): Promise<void> {
  const { siteId } = await requireCapability('setup.api')
  await setEndpointActive(siteId, Number(id), active)
  revalidatePath('/setup/api')
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
  revalidatePath('/setup/api')
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
  revalidatePath('/setup/api')
}

export async function redeliverAction(
  deliveryId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { siteId } = await requireCapability('setup.api')
  const result = await redeliver(siteId, Number(deliveryId))
  if (result.ok) revalidatePath('/setup/api')
  return result
}

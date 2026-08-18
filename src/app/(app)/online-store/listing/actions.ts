'use server'

import { revalidatePath } from 'next/cache'
import { actorForModule } from '@/lib/auth'
import { logActivity } from '@/lib/site/activityLog'
import { clearListingPreset, saveListingPreset } from '@/lib/site/listingPresets'
import { readListingPreset, writeSet } from '@/lib/storefront/listing'

type SaveResult = { ok: true } | { ok: false; error: string }

/**
 * Store how one listing looks.
 *
 * `departmentId` null is the shop's default — the row almost every shop will
 * ever have. Everything arrives as `unknown` and goes through
 * `readListingPreset`, because a form is no more trustworthy than a shopper:
 * this is a browser posting to a server action, and the fact that a capability
 * check passed says who is asking, not what they sent.
 */
export async function saveListingAction(
  departmentId: number | null,
  name: string,
  input: unknown,
): Promise<SaveResult> {
  const ctx = await actorForModule('online_store', 'online.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const raw = (input ?? {}) as Record<string, unknown>
  const preset = readListingPreset({
    department_id: departmentId,
    columns_desktop: raw.columnsDesktop,
    columns_phone: raw.columnsPhone,
    per_page: raw.perPage,
    default_sort: raw.defaultSort,
    layout: raw.layout,
    card_fields: writeSet(Array.isArray(raw.cardFields) ? (raw.cardFields as string[]) : []),
    facets: writeSet(Array.isArray(raw.facets) ? (raw.facets as string[]) : []),
  })

  const result = await saveListingPreset(siteId, { ...preset, departmentId }, actor.userName)
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'online_store',
    entityId: departmentId,
    action: 'listing',
    detail: departmentId
      ? `Listing settings changed for “${name}”`
      : 'Listing settings changed for the whole shop',
  })

  revalidatePath('/online-store/listing')
  return { ok: true }
}

/**
 * Stop overriding: this department follows the shop again.
 *
 * Audited like the save, because "follow the shop" is a real change to how a
 * department renders — and the one most likely to be a surprise later, since it
 * takes effect again every time the shop's own settings move.
 */
export async function clearListingAction(departmentId: number, name: string): Promise<SaveResult> {
  const ctx = await actorForModule('online_store', 'online.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  await clearListingPreset(siteId, departmentId)

  await logActivity(siteId, actor, {
    entity: 'online_store',
    entityId: departmentId,
    action: 'listing',
    detail: `“${name}” follows the shop’s listing settings again`,
  })

  revalidatePath('/online-store/listing')
  return { ok: true }
}

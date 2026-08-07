'use server'

import { revalidatePath } from 'next/cache'
import { requireActor, actorFor } from '@/lib/auth'
import { logActivity } from '@/lib/site/activityLog'
import { setDepartmentVisibility, type SaveResult } from '@/lib/site/onlineStore'

/**
 * Publishing a department exposes every product under it to the public, so the
 * change is audited the same way opening the store itself is.
 */
export async function setDepartmentVisibilityAction(
  departmentId: number,
  name: string,
  showOnline: boolean,
): Promise<SaveResult> {
  const ctx = await actorFor('online.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await setDepartmentVisibility(siteId, departmentId, showOnline)
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'online_store',
    entityId: departmentId,
    action: showOnline ? 'publish' : 'unpublish',
    detail: `Department “${name}” ${showOnline ? 'shown in' : 'hidden from'} the online store`,
  })

  revalidatePath('/online-store/departments')
  // The Setup screen's publish counts and its go-live guard both read these
  // flags, so a tick here has to invalidate that page too.
  revalidatePath('/online-store/setup')
  return { ok: true }
}

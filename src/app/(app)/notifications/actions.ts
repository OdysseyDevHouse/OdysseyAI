'use server'

import { revalidatePath } from 'next/cache'
import { requireSiteUser } from '@/lib/auth'
import { markAllRead, markRead } from '@/lib/site/notifications'

/**
 * Session-only, like the security page: notifications are personal, and which
 * rows a person may touch is decided inside the lib from their own
 * capabilities — there is no site-level capability to demand here.
 */

export async function markAllReadAction(): Promise<void> {
  const { site, user, capabilities } = await requireSiteUser()
  await markAllRead(site.id, user.id, capabilities)
  revalidatePath('/notifications')
}

export async function markReadAction(notificationId: number): Promise<void> {
  const { site, user } = await requireSiteUser()
  await markRead(site.id, user.id, Number(notificationId))
  revalidatePath('/notifications')
}

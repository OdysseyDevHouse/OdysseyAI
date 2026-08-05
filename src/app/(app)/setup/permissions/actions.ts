'use server'

import { revalidatePath } from 'next/cache'
import { requireSite } from '@/lib/auth'
import { setCapability, type Capability } from '@/lib/site/permissions'
import type { SiteRole } from '@/lib/sites'

/**
 * Changing who may do what.
 *
 * Only an owner may change permissions. Checked here rather than relying on the
 * screen hiding the controls: a server action is a public endpoint, and a
 * manager who can grant themselves void rights makes the whole model
 * decorative.
 */
export async function setCapabilityAction(
  role: SiteRole,
  capability: Capability,
  allowed: boolean,
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const site = await requireSite()

  if (site.role !== 'owner') {
    return { ok: false, error: 'Only an owner can change permissions.' }
  }

  const result = await setCapability(site.id, role, capability, allowed)
  if (!result.ok) return result

  revalidatePath('/setup/permissions')
  // Every screen that gates on a capability reads it per request, so the change
  // takes effect on the next navigation rather than the next sign-in.
  revalidatePath('/sales', 'layout')

  return { ok: true, message: allowed ? 'Permission granted.' : 'Permission removed.' }
}

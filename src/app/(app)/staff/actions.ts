'use server'

import { revalidatePath } from 'next/cache'
import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { saveEmployment } from '@/lib/site/employment'
import type { EmploymentInput } from '@/lib/employmentModel'

/**
 * Staff actions.
 *
 * Employment terms are guarded by `staff.cost` rather than `staff.edit`,
 * because this form carries the pay rate. Someone who may correct a colleague's
 * clocked hours has no business setting what they earn.
 */
export async function saveEmploymentAction(
  userId: number,
  input: EmploymentInput,
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const ctx = await requireSiteUser()
  if (!can(ctx.capabilities, 'staff.cost')) {
    return { ok: false, error: 'You do not have permission to set pay.' }
  }

  const result = await saveEmployment(ctx.site.id, userId, input)
  if (!result.ok) return result

  revalidatePath('/staff')
  return { ok: true, message: 'Employment details saved.' }
}

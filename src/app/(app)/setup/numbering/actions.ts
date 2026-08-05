'use server'

import { revalidatePath } from 'next/cache'
import { requireSiteId } from '@/lib/auth'
import { updateSequence } from '@/lib/site/sequences'
import { setSetting, type SettingKey } from '@/lib/site/settings'

export type NumberingActionResult = { ok: true; message: string } | { ok: false; error: string }

export async function saveSequenceAction(
  docType: string,
  input: { prefix: string; nextNumber: number; padding: number; resetPeriod: 'none' | 'yearly' },
): Promise<NumberingActionResult> {
  const siteId = await requireSiteId()
  const result = await updateSequence(siteId, docType, input)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath('/setup/numbering')
  return { ok: true, message: 'Numbering updated.' }
}

export async function saveSettingAction(
  key: SettingKey,
  value: string,
): Promise<NumberingActionResult> {
  const siteId = await requireSiteId()
  const result = await setSetting(siteId, key, value)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath('/setup/numbering')
  return { ok: true, message: 'Saved.' }
}

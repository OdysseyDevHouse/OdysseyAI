'use server'

import { revalidatePath } from 'next/cache'
import { requireSite } from '@/lib/auth'
import { setSetting, getSettings } from '@/lib/site/settings'

/**
 * Lay-by setup.
 *
 * Owner-only, like permissions: the cancellation fee decides what a customer
 * gets back when a lay-by ends early, and a server action is a public endpoint
 * regardless of who can see the screen.
 */
export async function saveLaybySettingsAction(input: {
  feePct: string
  defaultDays: string
  termsText: string
}): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const site = await requireSite()

  if (site.role !== 'owner') {
    return { ok: false, error: 'Only an owner can change lay-by terms.' }
  }

  // The store's own ceiling, checked here because it needs BOTH settings in
  // view. Section 62(6) lets the Minister prescribe a maximum and none is set
  // in the Act, so this is house policy — refused rather than clamped, so
  // someone typing 5 is told why instead of quietly getting 1.
  const settings = await getSettings(site.id, ['layby_max_fee_pct'])
  const ceiling = Number(settings.layby_max_fee_pct) || 0
  const wanted = Number(input.feePct.trim() || '0')

  if (Number.isFinite(wanted) && wanted > ceiling) {
    return {
      ok: false,
      error: `This store caps its lay-by cancellation fee at ${ceiling}%. Raise the ceiling first if that is genuinely intended.`,
    }
  }

  // Each is validated by setSetting, and the FIRST refusal is returned rather
  // than saving what passed — a half-saved policy is worse than none, because
  // the store would believe the whole of it applied.
  for (const [key, value] of [
    ['layby_cancellation_fee_pct', input.feePct.trim() || '0'],
    ['layby_default_days', input.defaultDays.trim() || '90'],
    ['layby_terms_text', input.termsText.trim()],
  ] as const) {
    const result = await setSetting(site.id, key, value)
    if (!result.ok) return result
  }

  revalidatePath('/setup/laybys')
  revalidatePath('/sales/laybys')

  return { ok: true, message: 'Lay-by terms saved.' }
}

'use server'

import { redirect } from 'next/navigation'
import { signInLocal } from '@/lib/localSignIn'

export type LocalLoginState = { error: string | null }

/**
 * Sign in on a shop's own machine, with a name and a PIN.
 *
 * Separate from `loginAction` rather than a branch inside it, because the two
 * verify different credentials against different databases and share nothing
 * but the word "sign in". Folding them together would mean one action whose
 * every line asked which kind of install it was running on.
 */
export async function localLoginAction(
  _prev: LocalLoginState,
  formData: FormData,
): Promise<LocalLoginState> {
  const name = String(formData.get('name') ?? '')
  const pin = String(formData.get('pin') ?? '')

  const result = await signInLocal(name, pin)
  if (!result.ok) return { error: result.error }

  /* No `next` handling and no site picker. A local install is one shop on one
     machine — the site was decided at provisioning, the session already
     carries it, and there is nothing to choose. */
  redirect('/')
}

'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { setSetting } from '@/lib/site/settings'

/**
 * Hiding and restoring the Getting started checklist.
 *
 * ── THE ACTION IS THE BOUNDARY ──────────────────────────────────────────────
 *
 * `actorFor` re-checks the capability here rather than trusting the screen. The
 * page hides the control from anybody without it, but that is a courtesy to the
 * reader — this is a POST anyone can construct, and it changes a setting for the
 * whole shop.
 *
 * ── WHY setup.edit RATHER THAN NO CAPABILITY AT ALL ─────────────────────────
 *
 * The PAGE is deliberately ungated: a new owner with no role yet must still be
 * able to read it, which is the whole reason it exists. Dismissing it is a
 * different act — one person's press removes a menu row for every colleague, so
 * it wants the same permission as the other shop-wide settings. A cashier who
 * finds the checklist irrelevant is not the person who should decide that on
 * everyone's behalf.
 */

export type DismissResult = { ok: true; message: string } | { ok: false; error: string }

async function write(hidden: boolean, message: string): Promise<DismissResult> {
  const actor = await actorFor('setup.edit')
  if ('ok' in actor) return actor

  const saved = await setSetting(actor.siteId, 'getting_started_hidden', hidden ? '1' : '0')
  if (!saved.ok) return { ok: false, error: saved.error }

  /* The LAYOUT, not this page: the sidebar is rendered there, and the row has
     just appeared or disappeared from it. Revalidating only '/getting-started'
     would leave the menu showing a link to a screen that no longer wants to be
     linked until the next full load. `layout` covers both — the sidebar and the
     page under it. */
  revalidatePath('/', 'layout')
  return { ok: true, message }
}

/**
 * "Don't show this again."
 *
 * Nothing is deleted and no progress is recorded — see the note on
 * `getting_started_hidden` in settings.ts. This hides a menu row and stops the
 * sign-in redirect; every step remains exactly as done or not-done as it was,
 * because those are read from the shop's data rather than stored here.
 */
export async function hideGettingStarted(): Promise<DismissResult> {
  return write(true, 'Getting started hidden. Open /getting-started?show=1 to bring it back.')
}

/** The way back, for the person who hid it and wants it again. */
export async function showGettingStarted(): Promise<DismissResult> {
  return write(false, 'Getting started is back in the menu.')
}

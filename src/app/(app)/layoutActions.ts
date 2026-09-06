'use server'

import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { requireSession } from '@/lib/auth'
import {
  LAYOUT_PREF_COOKIE,
  LAYOUT_PREF_DESKTOP,
  LAYOUT_PREF_PHONE,
} from '@/lib/phoneLayoutKeys'

/**
 * "Show me the desktop site" / "Show me the phone layout".
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
 *
 * `isPhoneLayout()` guesses, from client hints and failing that a user-agent
 * string, and a guess about devices is a guess that is WRONG for somebody: a
 * folding phone, a browser with a spoofed UA, a big handset whose owner would
 * rather squint at the real tables than tap through a one-column menu.
 *
 * Without this, being wrong is a support call that ends in "nothing I can do".
 * With it, being wrong is one tap. That asymmetry is the entire justification —
 * the cookie costs almost nothing and it is the difference between a heuristic
 * and a trap.
 *
 * ── NO CAPABILITY CHECK, ON PURPOSE ─────────────────────────────────────────
 *
 * This changes how a page is SHAPED and nothing else. There is no screen the
 * phone layout can reach that the desktop one cannot: both are drawn by the
 * same layout, after the same session check, from the same capability-filtered
 * nav. Gating it behind a permission would mean a cashier stuck in a layout
 * that does not fit their phone, protecting nothing.
 *
 * `requireSession` still runs, because an unauthenticated caller has no screen
 * to prefer a layout FOR — and an action that writes a cookie for anybody who
 * posts to it is an action worth not having.
 */
export async function setLayoutPreference(pref: 'phone' | 'desktop') {
  await requireSession()

  const jar = await cookies()
  jar.set(LAYOUT_PREF_COOKIE, pref === 'phone' ? LAYOUT_PREF_PHONE : LAYOUT_PREF_DESKTOP, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' && process.env.APP_MODE !== 'desktop',
    path: '/',
    /* A year, as with the shell cookie. This is a preference about a DEVICE and
       a device does not change its mind — an expiry short enough to lapse
       mid-use would show up as the layout reverting for no reason, which is
       precisely the confusing behaviour the switch exists to fix. */
    maxAge: 60 * 60 * 24 * 365,
  })

  /*
   * The shell itself is what changed, so the whole tree has to be redrawn —
   * revalidating the current page only would leave the layout that DECIDED to
   * draw a phone bar still drawing one. 'layout' rather than 'page' for that
   * reason.
   */
  revalidatePath('/', 'layout')
}

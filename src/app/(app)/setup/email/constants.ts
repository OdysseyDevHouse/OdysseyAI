/**
 * Shared constants for the outgoing-mail screen.
 *
 * These live here rather than in actions.ts because that file is `'use server'`,
 * and a "use server" module may only export async functions — every other
 * export is a build error that takes the whole dev server down with it, not
 * just this screen. A plain constant needs a plain module.
 */

/**
 * What the screen shows instead of the stored SMTP password.
 *
 * The password is never sent to the browser. The form posts this mask back
 * unchanged when nobody retyped it, which is how the save action tells "leave
 * it alone" apart from "clear it" (an empty string) — see saveMailSettings.
 */
export const SMTP_PASS_MASK = '••••••••'

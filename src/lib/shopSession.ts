/**
 * The storefront's analytics session id.
 *
 * ── WHAT IT IS, AND WHAT IT DELIBERATELY IS NOT ──────────────────────────
 *
 * 32 random hex characters, minted per browser session. It exists for exactly
 * one purpose: joining a product view to the purchase that followed it, so a
 * funnel is a ratio rather than four unrelated counts.
 *
 * It is NOT an identity. It carries no customer id, no email, no address, and
 * it is not derived from anything about the visitor — no IP, no user agent, no
 * fingerprint. Two visits by the same person on different days are two
 * different shoppers as far as anything reading it knows.
 *
 * That limitation is the feature. It is what makes this first-party analytics
 * rather than tracking, and why the storefront needs no consent banner.
 *
 * Lives in lib/ rather than beside the action that reads it because a
 * `'use server'` module may only export async functions — a shared constant in
 * one would be a build error.
 */

export const SHOP_SESSION_COOKIE = 'ody_shop_sid'

/** A session lasts a shopping trip, not a lifetime. */
export const SHOP_SESSION_MAX_AGE = 60 * 60 * 12

/** True when a value looks like one of ours: 32 lowercase hex characters. */
export function isShopSessionKey(raw: string): boolean {
  return /^[a-f0-9]{32}$/.test((raw ?? '').trim().toLowerCase())
}

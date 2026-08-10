import { redirect } from 'next/navigation'

/**
 * The old desk till. Now a redirect to `/pos`.
 *
 * ── WHY A REDIRECT AND NOT A DELETED ROUTE ────────────────────────────────
 *
 * `/sales/new` was the busiest screen in the product for years. It is bookmarked, it is
 * in browser histories, it is written on training notes, and six screens still link to
 * it. Deleting the route would answer all of that with a 404 — so it answers with the
 * till instead, and every one of those paths keeps working.
 *
 * The links themselves are updated in the same commit. This exists for the ones nobody
 * can edit: a bookmark, a pinned tab, somebody's muscle memory.
 *
 * ── WHAT REPLACED IT ──────────────────────────────────────────────────────
 *
 * `(pos)/pos` — the same sale, the same posting engine, a screen built for a finger
 * instead of a mouse. What made this deletion safe rather than brave is that the ENGINE
 * was always shared: `saveDraft`, `finaliseDocument`, `documentMath`, `specialsEngine`
 * and `tenderMath` were never duplicated, so retiring this screen removed a screen and
 * nothing else.
 *
 * The touch till also does everything this one did — including loyalty, which was the
 * last gap and was closed deliberately BEFORE this file was emptied. Deleting the only
 * screen that could redeem points would have been a regression dressed as cleanup.
 *
 * ── WHEN THIS FILE CAN GO ─────────────────────────────────────────────────
 *
 * Once the redirect has been live long enough that the bookmarks are gone — a release or
 * two. Until then a 79-line screen has become a 3-line redirect, which is the whole
 * point: there is no second till to keep in step, and no 1,040-line component for
 * somebody to edit by mistake.
 */
export default function NewSaleRedirect() {
  redirect('/pos')
}

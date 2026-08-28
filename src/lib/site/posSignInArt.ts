import 'server-only'
import { getSetting, setSetting } from './settings'
import { storeImageUpload, deleteStoredFile, readStoredFile, sniffImage } from '../uploads'

/**
 * The photograph behind the till's sign-in screen.
 *
 * ── WHY THIS IS NOT `document_logo_file` ──────────────────────────────────
 *
 * The shop already has a logo, and the obvious move is to use it for both. It
 * is the wrong move: a document logo is a small dark mark printed on white
 * paper, and this is a wide photograph read from across a room. One file cannot
 * be good at both jobs, and a shop asked to choose would be choosing which of
 * its two screens to make look wrong.
 *
 * The gate uses BOTH — the logo on top of this picture — so they are two
 * settings that appear together rather than one that compromises.
 *
 * ── A MISSING PICTURE IS THE NORMAL CASE, NOT AN ERROR ────────────────────
 *
 * Almost every shop will never upload one. So empty is not a broken state to be
 * reported: the gate falls back to a STOCK photograph chosen by what kind of
 * shop this is — see `stockBackdropUrl` — and looks finished rather than
 * unfinished. Everything here degrades to '' the way documentLogo does, and ''
 * is what tells the caller to reach for the stock picture. A database restored
 * without its uploads directory shows a bakery, not a broken image on the one
 * screen customers see.
 *
 * The two are ordered, and only one way round makes sense: a shop that took the
 * trouble to photograph its own room must beat anything we shipped.
 *
 * ── WHAT IS STORED IS THE DISK NAME, NEVER A PATH ─────────────────────────
 *
 * lib/uploads.ts generates a UUID plus a normalised extension, and the name the
 * browser sent is discarded. Same reasoning as the document logo: nothing is
 * ever downloaded under its original name, so there is nothing to keep it for,
 * and the sent name is attacker-controlled.
 */

/* ────────────────────────────────────────────────────────────────────────────
   THE STOCK PICTURE, CHOSEN BY WHAT KIND OF SHOP THIS IS
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Where the bundled sign-in photographs live.
 *
 * `public/`, not the uploads directory, and the difference matters. These ship
 * WITH the application: they are the same fifteen files on every installation,
 * they are not a shop's data, and a till that has never reached the server must
 * still paint one. An upload lives on a disk the desktop build may not have; a
 * file under `public/` is served by the Next server running on the till itself,
 * so this works with the line down — which is the whole condition this screen is
 * designed around.
 */
const STOCK_DIR = '/signin'

/**
 * Which photograph each kind of shop gets.
 *
 * Keyed on `cp2_site_types.id` rather than on the type's NAME, deliberately. The
 * name is editable in the control panel — somebody renaming "Bottle Store" to
 * "Liquor Store" is a reasonable afternoon's admin, and it must not silently
 * blank the picture on every one of those tills. The id is what the foreign key
 * actually holds.
 *
 * Absent ids are NOT an error and not a gap to be filled with a placeholder:
 * eleven of the twenty-six types have no photograph yet, a brand new type
 * added in the control panel tomorrow will have none either, and all of them
 * fall to the default below. See `stockBackdrop`.
 */
const STOCK_BY_SITE_TYPE: Record<number, string> = {
  1: 'bakery',
  2: 'bar',
  3: 'beauty-salon',
  4: 'biltong-deli',
  5: 'bottle-store',
  6: 'boutique',
  7: 'butchery',
  8: 'clothing-shoes',
  9: 'coffee-shop',
  10: 'cosmetics',
  11: 'cycling-shop',
  12: 'electronics',
  13: 'fast-food-cafe',
  14: 'general-retailer',
  15: 'golf-club-shop',
}

/**
 * What an unclassified shop shows.
 *
 * The bottle store, by instruction rather than by inference — it is a warm,
 * well-lit room full of stock that reads as "a shop" from across a counter
 * without claiming to be any particular trade. Every failure lands here: no site
 * type set, a type with no photograph, a type id that no longer exists.
 */
const STOCK_FALLBACK = 'bottle-store'

/**
 * The bundled photograph for this kind of shop.
 *
 * Never returns '' — unlike `backdropUrl` below, which returns '' to mean "this
 * shop uploaded nothing". There is always a stock picture; the question is only
 * which one.
 *
 * If the FILE is missing the panel degrades on its own and needs no help here:
 * PosSignInArt paints the brand gradient underneath every backdrop precisely so
 * that a picture which fails to load leaves the screen looking deliberate rather
 * than broken. That is what makes it safe to ship this mapping before all
 * twenty-six photographs exist.
 */
export function stockBackdropUrl(siteTypeId: number | null): string {
  const slug = (siteTypeId !== null && STOCK_BY_SITE_TYPE[siteTypeId]) || STOCK_FALLBACK
  /* WebP, and one extension for the whole set rather than a per-entry filename.
     The map then says which SHOP gets which picture and nothing about file
     formats, and a slug that has no file yet still produces a URL that simply
     404s onto the gradient — see the docblock. */
  return `${STOCK_DIR}/${slug}.webp`
}

export type BackdropResult = { ok: true } | { ok: false; error: string }

/** Where the till gate fetches it from. */
export const POS_SIGNIN_ART_URL = '/api/pos/signin-art'

/** The stored disk name, or '' when this site has no backdrop. */
export async function backdropFileName(siteId: number): Promise<string> {
  try {
    return (await getSetting(siteId, 'pos_signin_backdrop_file')) || ''
  } catch {
    return ''
  }
}

/**
 * The URL the gate points an `<img>` at, or '' when there is no picture.
 *
 * Cache-busted on the STORED NAME rather than on a timestamp: the URL is
 * constant per site, so without it replacing the picture would leave the old
 * one on screen until somebody hard-refreshed a machine that is never
 * refreshed. A name-based buster also means the browser keeps the file cached
 * for as long as it really is the current one, which matters on a till that
 * paints this screen every time a cashier signs out.
 */
export async function backdropUrl(siteId: number): Promise<string> {
  const file = await backdropFileName(siteId)
  if (!file) return ''
  return `${POS_SIGNIN_ART_URL}?v=${encodeURIComponent(file)}`
}

/** The bytes, with the format proved again on the way out. */
export async function readBackdrop(
  siteId: number,
): Promise<{ bytes: Buffer; format: 'png' | 'jpeg' | 'gif' | 'webp' } | null> {
  const file = await backdropFileName(siteId)
  if (!file) return null

  const bytes = await readStoredFile(file)
  if (!bytes) return null

  /*
   * Sniffed again here, not only at upload — the same belt-and-braces the
   * document logo wears. The check at upload proves what was accepted; this
   * proves what is being SERVED, and deriving the Content-Type from the bytes
   * in hand means the header can never disagree with what is on disk.
   */
  const format = sniffImage(bytes)
  if (!format) return null

  return { bytes, format }
}

/**
 * Replace the backdrop.
 *
 * The old file is removed AFTER the new name is committed, so a failure part
 * way through leaves the till with a picture rather than without one. An
 * orphaned file is disk; a half-applied change is the screen customers look at.
 */
export async function setBackdrop(siteId: number, file: File): Promise<BackdropResult> {
  const stored = await storeImageUpload(file)
  if (!stored.ok) return { ok: false, error: stored.error }

  const previous = await backdropFileName(siteId)

  const saved = await setSetting(siteId, 'pos_signin_backdrop_file', stored.file.storedName)
  if (!saved.ok) {
    // Roll the file back: nothing points at it, so leaving it is pure litter.
    await deleteStoredFile(stored.file.storedName).catch(() => {})
    return { ok: false, error: saved.error }
  }

  if (previous && previous !== stored.file.storedName) {
    await deleteStoredFile(previous).catch(() => {})
  }
  return { ok: true }
}

export async function clearBackdrop(siteId: number): Promise<BackdropResult> {
  const previous = await backdropFileName(siteId)

  const saved = await setSetting(siteId, 'pos_signin_backdrop_file', '')
  if (!saved.ok) return { ok: false, error: saved.error }

  if (previous) await deleteStoredFile(previous).catch(() => {})
  return { ok: true }
}

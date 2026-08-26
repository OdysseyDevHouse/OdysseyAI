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
 * reported: the gate paints its brand gradient instead and looks deliberate
 * rather than unfinished. Everything here degrades to '' the way documentLogo
 * does — a database restored without its uploads directory shows the gradient,
 * not a broken image on the one screen customers see.
 *
 * ── WHAT IS STORED IS THE DISK NAME, NEVER A PATH ─────────────────────────
 *
 * lib/uploads.ts generates a UUID plus a normalised extension, and the name the
 * browser sent is discarded. Same reasoning as the document logo: nothing is
 * ever downloaded under its original name, so there is nothing to keep it for,
 * and the sent name is attacker-controlled.
 */

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

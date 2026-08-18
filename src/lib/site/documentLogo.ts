import 'server-only'
import { getSetting, setSetting } from './settings'
import { storeImageUpload, deleteStoredFile, readStoredFile, sniffImage } from '../uploads'

/**
 * The business's logo, as it appears on printed documents.
 *
 * ── WHY IT IS A SETTING AND NOT A TABLE ───────────────────────────────────
 *
 * One answer per site that nothing joins to — the exact thing the settings
 * header says belongs there. The stationery TEMPLATES earned a table because
 * they carry behaviour (validation, draft and published, one active per
 * document type). "Which file is our logo" carries none of that.
 *
 * ── WHAT IS STORED IS THE DISK NAME, NEVER A PATH ─────────────────────────
 *
 * lib/uploads.ts generates a UUID plus a normalised extension and that is all
 * that is kept. The name the browser sent is attacker-controlled and is
 * discarded outright: a logo is never downloaded under its original name, so
 * unlike an attachment there is nothing to keep it for.
 *
 * ── A MISSING LOGO IS NOT AN ERROR ────────────────────────────────────────
 *
 * A database restored without the uploads directory leaves a setting pointing
 * at bytes that are gone. Every reader here degrades to "no logo", and every
 * template prints nothing rather than a broken image on a document going to a
 * supplier. See lib/stationery/adapters — `site.logo` resolves to empty.
 */

export type LogoResult = { ok: true } | { ok: false; error: string }

/** Where the print routes and the designer fetch it from. */
export const LOGO_URL = '/api/document-logo'

/** The stored disk name, or '' when this site has no logo. */
export async function logoFileName(siteId: number): Promise<string> {
  try {
    return (await getSetting(siteId, 'document_logo_file')) || ''
  } catch {
    return ''
  }
}

/**
 * The `<img>` a template's `{site.logo}` becomes, or ''.
 *
 * Built here rather than in the template so a site cannot be made to point the
 * tag anywhere else: the sanitiser already refuses an off-site `src`, and this
 * means the only image a document can carry is the one this shop uploaded.
 *
 * A cache-busting query on the stored name, because the URL is constant per
 * site — without it, replacing the logo would leave the old one on screen
 * until someone hard-refreshed, and "I changed it and nothing happened" is how
 * a feature gets reported as broken.
 */
export async function logoImgTag(siteId: number, maxHeightPx = 56): Promise<string> {
  const file = await logoFileName(siteId)
  if (!file) return ''
  const v = encodeURIComponent(file)
  return `<img src="${LOGO_URL}?v=${v}" alt="" style="max-height:${maxHeightPx}px;width:auto">`
}

/** The bytes, with the format proved again on the way out. */
export async function readLogo(
  siteId: number,
): Promise<{ bytes: Buffer; format: 'png' | 'jpeg' | 'gif' | 'webp' } | null> {
  const file = await logoFileName(siteId)
  if (!file) return null

  const bytes = await readStoredFile(file)
  if (!bytes) return null

  /*
   * Sniffed again here, not only at upload. The check at upload proves what was
   * accepted; this proves what is being SERVED, and the two differ if the
   * uploads directory is ever written to by anything else. Cheap, and it is the
   * difference between serving a picture and serving whatever is on disk.
   */
  const format = sniffImage(bytes)
  if (!format) return null

  return { bytes, format }
}

/**
 * Replace the logo.
 *
 * The old file is removed AFTER the new name is committed, so a failure part
 * way through leaves a site with a logo rather than without one. An orphaned
 * file is disk; a missing logo is every document printing wrong.
 */
export async function setLogo(siteId: number, file: File): Promise<LogoResult> {
  const stored = await storeImageUpload(file)
  if (!stored.ok) return { ok: false, error: stored.error }

  const previous = await logoFileName(siteId)

  const saved = await setSetting(siteId, 'document_logo_file', stored.file.storedName)
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

export async function clearLogo(siteId: number): Promise<LogoResult> {
  const previous = await logoFileName(siteId)

  const saved = await setSetting(siteId, 'document_logo_file', '')
  if (!saved.ok) return { ok: false, error: saved.error }

  if (previous) await deleteStoredFile(previous).catch(() => {})
  return { ok: true }
}

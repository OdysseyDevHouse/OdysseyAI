import 'server-only'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises'
import path from 'node:path'

/**
 * Where uploaded files live on disk.
 *
 * The database keeps only metadata — see the header of
 * 028_party_contacts_documents_comments.sql for why the bytes are not in a
 * BLOB column. This module owns the other half of that decision: turning a
 * browser upload into a file on disk, and a stored name back into bytes.
 *
 * ── THE ONE RULE ─────────────────────────────────────────────────────────
 *
 * A filename from a browser is attacker-controlled. It may contain "..",
 * absolute paths, NUL bytes, or Windows device names, and on a bad day it
 * resolves to somewhere outside the uploads directory entirely.
 *
 * So the name the user sees and the name on disk are two different strings.
 * The disk name is generated here (a UUID plus a normalised extension) and is
 * the only thing any path is ever built from. The user's name is stored as
 * data, echoed back in Content-Disposition on download, and never touched by
 * the filesystem. resolveStoredPath() then re-checks containment even for the
 * generated name, because a defence that is only applied at write time is one
 * bad refactor away from not being applied at all.
 */

/**
 * The uploads root.
 *
 * Outside .next/ deliberately: anything under it is wiped by a rebuild, and a
 * deploy that deletes the customer paperwork is not a recoverable mistake. Set
 * UPLOADS_DIR to move it onto a mounted volume, which is what a container
 * deployment should do — the default is only right for a single-server or
 * desktop install where the working directory is stable.
 */
const UPLOADS_ROOT = path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'))

/**
 * Largest file accepted, in bytes.
 *
 * Matches the serverActions.bodySizeLimit in next.config.mjs. The two must
 * agree: a file over the Next limit is rejected by the framework before any
 * code here runs, and the user gets an opaque error instead of a sentence
 * naming the limit. Raise them together or not at all.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

/**
 * Extensions accepted.
 *
 * An allowlist, not a blocklist: a blocklist is a promise to have thought of
 * every dangerous extension, and .svg alone (which executes script when opened
 * from the same origin) shows how that promise breaks. These are the formats a
 * back office actually attaches to an account — signed applications, invoices,
 * proof of payment, a photo of a delivery note.
 */
const ALLOWED_EXTENSIONS = new Set([
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.heic',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.csv',
  '.txt',
  '.rtf',
  '.odt',
  '.ods',
  '.msg',
  '.eml',
  '.zip',
])

/** Human-readable list for an error message, so the user knows what to convert to. */
export const ALLOWED_EXTENSIONS_LABEL = 'PDF, image, Office, text, email or ZIP'

export type StoredFile = {
  /** The generated name on disk. The only string a path is built from. */
  storedName: string
  /** What the user called it, cleaned but still recognisable. */
  filename: string
  mimeType: string | null
  sizeBytes: number
}

export type StoreResult = { ok: true; file: StoredFile } | { ok: false; error: string }

/**
 * The display name, stripped of anything that could make it a path.
 *
 * This value never reaches the filesystem — it is stored as data. It is
 * sanitised anyway because it is echoed into a Content-Disposition header on
 * download, where a newline would let a caller inject headers, and because it
 * is rendered on screen.
 */
function cleanDisplayName(raw: string): string {
  const base = path
    .basename(raw)
    // Control characters (a newline here would let a caller inject headers on
    // download), quotes (they terminate the filename in Content-Disposition)
    // and separators (path-shaped input). Written as explicit escapes rather
    // than a character range so the intent survives the next reader.
    .replace(/[\u0000-\u001f\u007f"'\\/]/g, '')
    .trim()
  return base.slice(0, 255) || 'file'
}

/** The extension, lowercased, or '' when there is none. */
function extensionOf(name: string): string {
  const ext = path.extname(name).toLowerCase()
  // A pathological name like "x.<200 chars>" is not a real extension.
  return ext.length <= 12 ? ext : ''
}

/**
 * Writes one uploaded file and returns what to record in the database.
 *
 * Validates before writing, so a rejected upload leaves nothing behind. The
 * caller inserts the returned metadata; if that insert then fails it must call
 * deleteStoredFile, or the bytes are orphaned.
 */
export async function storeUpload(file: File): Promise<StoreResult> {
  if (!file || file.size === 0) return { ok: false, error: 'That file is empty.' }

  if (file.size > MAX_UPLOAD_BYTES) {
    const mb = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))
    return { ok: false, error: `Files must be ${mb}MB or smaller.` }
  }

  const filename = cleanDisplayName(file.name)
  const ext = extensionOf(filename)

  if (!ext) return { ok: false, error: 'That file has no extension, so its type is unknown.' }
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return { ok: false, error: `${ext} files are not accepted. Attach a ${ALLOWED_EXTENSIONS_LABEL} file.` }
  }

  // UUID + allowlisted extension. Both halves are known-safe by construction,
  // so this name cannot escape the uploads root no matter what was uploaded.
  const storedName = `${randomUUID()}${ext}`

  await mkdir(UPLOADS_ROOT, { recursive: true })
  const bytes = Buffer.from(await file.arrayBuffer())

  // Re-check after buffering: File.size is a claim made by the caller, and the
  // bytes actually delivered are what fills the disk.
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    const mb = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))
    return { ok: false, error: `Files must be ${mb}MB or smaller.` }
  }

  await writeFile(path.join(UPLOADS_ROOT, storedName), bytes)

  return {
    ok: true,
    file: {
      storedName,
      filename,
      // Advisory only — the browser said so. The download route sends
      // Content-Disposition: attachment so nothing depends on it being true.
      mimeType: file.type ? file.type.slice(0, 120) : null,
      sizeBytes: bytes.byteLength,
    },
  }
}

/**
 * The absolute path for a stored name, or null if it escapes the root.
 *
 * Every read and delete goes through here. The containment check is belt and
 * braces given storeUpload generates the name, but a stored_name that came
 * from a hand-edited row or a future import path must not be able to read
 * /etc/passwd, and the check costs nothing.
 */
function resolveStoredPath(storedName: string): string | null {
  if (!storedName || storedName.includes('\u0000')) return null

  // basename() first: a stored name is a bare filename by construction, so
  // anything with a separator in it is already wrong.
  if (path.basename(storedName) !== storedName) return null

  const resolved = path.resolve(UPLOADS_ROOT, storedName)
  const root = UPLOADS_ROOT.endsWith(path.sep) ? UPLOADS_ROOT : UPLOADS_ROOT + path.sep
  if (!resolved.startsWith(root)) return null

  return resolved
}

/** The bytes of a stored file, or null when it is not on disk. */
export async function readStoredFile(storedName: string): Promise<Buffer | null> {
  const full = resolveStoredPath(storedName)
  if (!full) return null
  try {
    return await readFile(full)
  } catch {
    // Missing file rather than a thrown 500: a row can outlive its bytes if the
    // database was restored without the uploads directory, and the caller
    // renders a 404 that says so.
    return null
  }
}

/**
 * Removes a stored file. Never throws.
 *
 * Called after the metadata row is already gone, so a failure here leaks a file
 * rather than breaking the delete the user asked for. An orphaned file is
 * invisible and cheap; a delete that reports failure after succeeding is not.
 */
export async function deleteStoredFile(storedName: string): Promise<void> {
  const full = resolveStoredPath(storedName)
  if (!full) return
  try {
    await unlink(full)
  } catch (error) {
    console.error('upload delete failed', storedName, error)
  }
}

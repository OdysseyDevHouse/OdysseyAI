import 'server-only'
import type { RowDataPacket } from 'mysql2'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'
import { storeImageUpload, deleteStoredFile, readStoredFile, sniffImage } from '../uploads'

/**
 * The pictures a shop can put on its printed documents.
 *
 * ── THE LOGO'S RULES, FOR MORE THAN ONE PICTURE ───────────────────────────
 *
 * lib/site/documentLogo.ts is the model and every rule it states holds here:
 * the disk name is stored and never a path, the bytes are proved to be a
 * picture at upload AND again on the way out, and a file that has gone missing
 * degrades to "no picture" rather than to a broken image on a customer's
 * document.
 *
 * What differs is only that there are several, so they live in a table and are
 * named by id — which is why the serving route has to be careful in a way the
 * logo's does not. See app/api/stationery-images.
 *
 * ── A PICTURE IS NOT A LOGO ───────────────────────────────────────────────
 *
 * They are kept apart deliberately. The logo is what the letterhead prints and
 * every document has one; these are decoration a shop adds where it likes, and
 * merging them would mean the letterhead had to ask which of eight pictures it
 * meant.
 */

export type StationeryImage = {
  id: number
  storedName: string
  filename: string
  label: string
  mimeType: string
  sizeBytes: number
  createdAt: string
}

/** What the shop sees it called. The upload name is a poor label but a real one. */
export function imageLabel(image: StationeryImage): string {
  return image.label.trim() || image.filename
}

/**
 * A picture cannot be bigger than this.
 *
 * The same ceiling documentLogo explains: an emailed PDF carries the file
 * itself, so a large picture is attached to every invoice that goes out. Said
 * before the upload rather than after, so a shop is not made to wait to be told
 * no.
 */
export const MAX_PICTURE_BYTES = 500 * 1024

/** A page of documents is finite and so is a sensible library. */
export const MAX_IMAGES = 40

function mapRow(row: Record<string, unknown>): StationeryImage {
  return {
    id: Number(row.id),
    storedName: String(row.stored_name ?? ''),
    filename: String(row.filename ?? ''),
    label: String(row.label ?? ''),
    mimeType: String(row.mime_type ?? ''),
    sizeBytes: Number(row.size_bytes ?? 0),
    createdAt: String(row.created_at ?? ''),
  }
}

/**
 * Whether this site has the table yet.
 *
 * Sites are migrated one at a time, and a designer opening before the migration
 * has run should see "no pictures" rather than a crashed screen — the same
 * courtesy stationeryTemplates extends.
 */
async function tableExists(siteId: number): Promise<boolean> {
  try {
    const row = await siteQueryOne<RowDataPacket>(
      siteId,
      `SELECT COUNT(*) AS n FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = 'stationery_images'`,
    )
    return Number((row as { n?: unknown } | null)?.n ?? 0) > 0
  } catch {
    return false
  }
}

export async function listImages(siteId: number): Promise<StationeryImage[]> {
  if (!(await tableExists(siteId))) return []
  const rows = await siteQuery<RowDataPacket>(
    siteId,
    'SELECT * FROM stationery_images ORDER BY created_at DESC, id DESC',
  )
  return rows.map((r) => mapRow(r as Record<string, unknown>))
}

export async function getImage(siteId: number, id: number): Promise<StationeryImage | null> {
  if (!Number.isInteger(id) || id <= 0) return null
  if (!(await tableExists(siteId))) return null
  const row = await siteQueryOne<RowDataPacket>(
    siteId,
    'SELECT * FROM stationery_images WHERE id = ?',
    [id],
  )
  return row ? mapRow(row as Record<string, unknown>) : null
}

/**
 * The bytes, with the format proved AGAIN on the way out.
 *
 * The check at upload proves what was accepted; this proves what is being
 * served, and the two differ if the uploads directory is ever written to by
 * anything else. It is the difference between serving a picture and serving
 * whatever happens to be on disk.
 */
export async function readImage(
  siteId: number,
  id: number,
): Promise<{ bytes: Buffer; format: 'png' | 'jpeg' | 'gif' | 'webp' } | null> {
  const image = await getImage(siteId, id)
  if (!image) return null

  const bytes = await readStoredFile(image.storedName)
  if (!bytes) return null

  const format = sniffImage(bytes)
  if (!format) return null

  return { bytes, format }
}

export type ImageResult = { ok: true; image: StationeryImage } | { ok: false; error: string }

export async function addImage(
  siteId: number,
  file: File,
  label: string,
  actor: { userId: number; userName: string },
): Promise<ImageResult> {
  if (!(await tableExists(siteId))) {
    return {
      ok: false,
      error: 'Pictures are not set up on this site yet. Run the database migrations.',
    }
  }

  const existing = await listImages(siteId)
  if (existing.length >= MAX_IMAGES) {
    return { ok: false, error: `You can keep ${MAX_IMAGES} pictures. Delete one to add another.` }
  }

  /*
   * Size is checked BEFORE the file is written, not after. Storing it and then
   * refusing would leave litter on disk for every oversized attempt.
   */
  if (file.size > MAX_PICTURE_BYTES) {
    return {
      ok: false,
      error: `Keep it under ${Math.round(MAX_PICTURE_BYTES / 1024)} KB — an emailed PDF carries the picture itself, so a big one is attached to every document you send.`,
    }
  }

  const stored = await storeImageUpload(file)
  if (!stored.ok) return { ok: false, error: stored.error }

  try {
    const result = await siteExecute(
      siteId,
      `INSERT INTO stationery_images
         (stored_name, filename, label, mime_type, size_bytes, created_by, created_by_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        stored.file.storedName,
        stored.file.filename.slice(0, 255),
        label.trim().slice(0, 120),
        // Nullable on StoredFile, but storeImageUpload only returns a VERIFIED
        // image, so the format is the honest source for it.
        stored.file.mimeType ?? `image/${stored.file.format}`,
        stored.file.sizeBytes,
        actor.userId,
        actor.userName.slice(0, 120),
      ],
    )

    const id = Number((result as { insertId?: number }).insertId ?? 0)
    const image = await getImage(siteId, id)
    if (!image) return { ok: false, error: 'The picture was saved but could not be read back.' }
    return { ok: true, image }
  } catch (e) {
    // Roll the file back: no row points at it, so leaving it is pure litter.
    await deleteStoredFile(stored.file.storedName).catch(() => {})
    return { ok: false, error: e instanceof Error ? e.message : 'That picture could not be saved.' }
  }
}

/**
 * Remove a picture.
 *
 * ── DESIGNS POINTING AT IT ARE NOT REWRITTEN ──────────────────────────────
 *
 * A block naming a picture that has gone renders nothing, exactly as a design
 * naming a retired token does. Hunting through every saved design to edit them
 * would be a write nobody asked for, and the failure it prevents — an empty
 * space where a picture was — is the same failure a missing FILE already
 * produces and which the renderers already handle.
 */
export async function removeImage(
  siteId: number,
  id: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const image = await getImage(siteId, id)
  if (!image) return { ok: false, error: 'That picture no longer exists.' }

  await siteExecute(siteId, 'DELETE FROM stationery_images WHERE id = ?', [id])
  await deleteStoredFile(image.storedName).catch(() => {})
  return { ok: true }
}

export async function renameImage(
  siteId: number,
  id: number,
  label: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await tableExists(siteId))) return { ok: false, error: 'That picture no longer exists.' }
  await siteExecute(siteId, 'UPDATE stationery_images SET label = ? WHERE id = ?', [
    label.trim().slice(0, 120),
    id,
  ])
  return { ok: true }
}

/* ── what the renderers need ─────────────────────────────────────────────── */

/**
 * The ids of every picture this site has, for renderTemplate.
 *
 * ONE helper rather than each print route assembling its own, because this set
 * is a security boundary: a picture resolves only if its id is in here, so a
 * route that forgot to build it would silently print no pictures, and a route
 * that built it wrongly could print somebody else's. Six callers doing it by
 * hand is six chances to get it wrong.
 *
 * Never throws. A site without the table, or a database that blinks, yields an
 * empty set — every picture block then prints nothing, which is the same
 * outcome as a design that names none.
 */
export async function pictureIds(siteId: number): Promise<ReadonlySet<number>> {
  try {
    return new Set((await listImages(siteId)).map((i) => i.id))
  } catch {
    return new Set()
  }
}

/**
 * The BYTES of every picture a spec actually uses, for the PDF renderer.
 *
 * Only what the design names: a shop with forty pictures and one on its invoice
 * should not have forty files read off disk to email one document.
 *
 * A picture whose file has gone is left out rather than failing the render — an
 * invoice that emails without its picture is a document; an invoice that throws
 * is a customer waiting.
 */
export async function pictureBytes(
  siteId: number,
  ids: readonly number[],
): Promise<Map<number, Buffer>> {
  const out = new Map<number, Buffer>()
  for (const id of new Set(ids)) {
    try {
      const found = await readImage(siteId, id)
      if (found) out.set(id, found.bytes)
    } catch {
      /* one unreadable picture must not cost the whole document */
    }
  }
  return out
}

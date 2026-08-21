import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { logActivity, type Actor } from './activityLog'
import { partyDb, partyTables } from './partyStore'
import type { CommentEntity } from './partyComments'

/**
 * Files attached to a customer or supplier — the signed credit application,
 * the BEE certificate, a proof of payment someone emailed in.
 *
 * Metadata only. The bytes live on disk via lib/uploads.ts; see the header of
 * 028_party_contacts_documents_comments.sql for why they are not in a BLOB.
 *
 * The (entity, entity_id) pair has no foreign key, exactly as activity_log.
 * That is what lets a product or a purchase order gain attachments later
 * without a new table — and it is why removeDocumentsFor() exists and must be
 * called when an account is deleted, since no CASCADE will do it.
 */

export type PartyDocument = {
  id: number
  entity: CommentEntity
  entityId: number
  filename: string
  storedName: string
  mimeType: string | null
  sizeBytes: number
  description: string | null
  uploadedBy: number | null
  uploadedName: string
  createdAt: Date
}

export type DocumentInput = {
  filename: string
  storedName: string
  mimeType?: string | null
  sizeBytes: number
  description?: string | null
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }
export type DeleteResult =
  /** The disk name to unlink. Returned so the caller removes the row and the file in that order. */
  | { ok: true; storedName: string }
  | { ok: false; error: string }

type Row = RowDataPacket & Record<string, unknown>

function mapDocument(r: Row): PartyDocument {
  return {
    id: Number(r.id),
    entity: String(r.entity) as CommentEntity,
    entityId: Number(r.entity_id),
    filename: String(r.filename),
    storedName: String(r.stored_name),
    mimeType: (r.mime_type as string | null) ?? null,
    sizeBytes: Number(r.size_bytes),
    description: (r.description as string | null) ?? null,
    uploadedBy: r.uploaded_by === null ? null : Number(r.uploaded_by),
    uploadedName: String(r.uploaded_name ?? ''),
    createdAt: r.created_at as Date,
  }
}

/**
 * The column list, against whichever table this entity's documents live in.
 *
 * A function rather than a constant since 207 split the one table into three —
 * see partyStore.ts for which entity lands where and why. The table name comes
 * from partyTables() and never from a caller, so it cannot be user input.
 */
const selectDocument = (entity: CommentEntity) => `
  SELECT id, entity, entity_id, filename, stored_name, mime_type, size_bytes,
         description, uploaded_by, uploaded_name, created_at
    FROM ${partyTables(entity).documents}
`

/** One account's documents, newest first. */
export async function listDocuments(
  siteId: number,
  entity: CommentEntity,
  entityId: number,
): Promise<PartyDocument[]> {
  const rows = await partyDb(entity).query<Row>(
    siteId,
    `${selectDocument(entity)}
      WHERE entity = ? AND entity_id = ?
      ORDER BY created_at DESC, id DESC`,
    [entity, entityId],
  )
  return rows.map(mapDocument)
}

/**
 * One document, by id, scoped to the account it belongs to.
 *
 * The entity pair is part of the lookup rather than checked afterwards: the
 * download route takes both from the URL, and a query that matched on id alone
 * would let a guessed id read another account's paperwork.
 */
export async function getDocument(
  siteId: number,
  entity: CommentEntity,
  entityId: number,
  id: number,
): Promise<PartyDocument | null> {
  const row = await partyDb(entity).queryOne<Row>(
    siteId,
    `${selectDocument(entity)} WHERE id = ? AND entity = ? AND entity_id = ? LIMIT 1`,
    [id, entity, entityId],
  )
  return row ? mapDocument(row) : null
}

/**
 * Records an already-stored file.
 *
 * Called only after storeUpload() has written the bytes. If this insert fails
 * the caller must unlink them — the file is on disk before its row exists, and
 * nothing else knows the name.
 */
export async function createDocument(
  siteId: number,
  actor: Actor,
  entity: CommentEntity,
  entityId: number,
  input: DocumentInput,
): Promise<SaveResult> {
  const res = await partyDb(entity).execute(
    siteId,
    `INSERT INTO ${partyTables(entity).documents}
       (entity, entity_id, filename, stored_name, mime_type, size_bytes,
        description, uploaded_by, uploaded_name)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      entity,
      entityId,
      input.filename.slice(0, 255),
      input.storedName,
      input.mimeType?.slice(0, 120) ?? null,
      input.sizeBytes,
      input.description?.trim().slice(0, 400) || null,
      actor.userId,
      actor.userName.slice(0, 120),
    ],
  )

  await logActivity(siteId, actor, {
    entity,
    entityId,
    action: 'document',
    detail: `Attached ${input.filename}`,
  })

  return { ok: true, id: res.insertId }
}

/** Renames a document or changes its description. The bytes are untouched. */
export async function updateDocument(
  siteId: number,
  actor: Actor,
  entity: CommentEntity,
  entityId: number,
  id: number,
  patch: { filename?: string; description?: string | null },
): Promise<SaveResult> {
  const existing = await getDocument(siteId, entity, entityId, id)
  if (!existing) return { ok: false, error: 'That document no longer exists.' }

  const filename = patch.filename?.trim() || existing.filename
  if (!filename) return { ok: false, error: 'A document needs a name.' }

  await partyDb(entity).execute(
    siteId,
    `UPDATE ${partyTables(entity).documents} SET filename = ?, description = ? WHERE id = ?`,
    [filename.slice(0, 255), patch.description?.trim().slice(0, 400) || null, id],
  )

  await logActivity(siteId, actor, {
    entity,
    entityId,
    action: 'document',
    detail: `Renamed ${existing.filename} to ${filename}`,
  })

  return { ok: true, id }
}

/**
 * Removes the metadata row and hands back the disk name.
 *
 * The row goes first and the file second, deliberately. A file deleted before
 * its row leaves a row pointing at nothing — which looks like data loss on the
 * screen. A row deleted before its file leaves an orphaned file, which is
 * invisible and costs only disk.
 */
export async function deleteDocument(
  siteId: number,
  actor: Actor,
  entity: CommentEntity,
  entityId: number,
  id: number,
): Promise<DeleteResult> {
  const existing = await getDocument(siteId, entity, entityId, id)
  if (!existing) return { ok: false, error: 'That document no longer exists.' }

  await partyDb(entity).execute(
    siteId,
    `DELETE FROM ${partyTables(entity).documents} WHERE id = ?`,
    [id],
  )

  await logActivity(siteId, actor, {
    entity,
    entityId,
    action: 'document',
    detail: `Removed ${existing.filename}`,
  })

  return { ok: true, storedName: existing.storedName }
}

/**
 * Every stored name for one account, then the rows.
 *
 * For deleting an account. No foreign key means no CASCADE, so this runs inside
 * a transaction — see deleteCustomer. The names are returned rather than
 * unlinked here because the files must not be removed until that transaction
 * has actually committed.
 *
 * ── THE CONNECTION MUST MATCH THE ENTITY ─────────────────────────────────
 *
 * `tx` comes from the caller, and since 207 the table this writes to depends on
 * the entity — customer rows are on the customer owner, supplier rows on the
 * supplier owner. Passing a transaction opened against the wrong database is
 * not a type error and not a crash: the table simply is not there, or worse, is
 * there and empty.
 *
 * So a caller must open its transaction with the matching helper —
 * customerTransaction for 'customer', supplierTransaction for 'supplier',
 * siteTransaction for anything branch-local. partyDb(entity).transaction gives
 * exactly that, and is what deleteCustomer and deleteSupplier use.
 */
export async function removeDocumentsFor(
  tx: PoolConnection,
  entity: CommentEntity,
  entityId: number,
): Promise<string[]> {
  const [rows] = await tx.execute(
    `SELECT stored_name FROM ${partyTables(entity).documents}
      WHERE entity = ? AND entity_id = ?`,
    [entity, entityId] as never,
  )
  const names = (rows as Row[]).map((r) => String(r.stored_name))

  await tx.execute(
    `DELETE FROM ${partyTables(entity).documents} WHERE entity = ? AND entity_id = ?`,
    [entity, entityId] as never,
  )

  return names
}

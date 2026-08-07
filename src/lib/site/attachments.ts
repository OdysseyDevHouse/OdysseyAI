import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'
import { logActivity, type Actor } from './activityLog'
import type { Capability } from './permissions'
import {
  ATTACHMENT_TARGETS,
  type AttachmentTarget,
  type AttachmentCapability,
} from '../attachmentTargets'

/**
 * Files attached to any record — the transaction side of party_documents.
 *
 * The same table, deliberately. Its header called this out from the start:
 * "That is what lets a product or a purchase order gain attachments later
 * without a new table." A second table would mean a second upload path, a
 * second download route, and a second place for the orphan-file cleanup to be
 * forgotten.
 *
 * partyDocuments.ts still owns the customer and supplier screens and is left
 * exactly as it was. This module is the general form; the two coexist over one
 * table rather than one being rewritten in terms of the other, because
 * rewriting a working, security-reviewed path to gain nothing is how a
 * regression gets in.
 */

/**
 * THE CHECK THAT MATTERS.
 *
 * Every capability named in attachmentTargets.ts must be one that actually
 * exists. That file is pure — it cannot import `Capability` from the
 * `server-only` permissions module — so the assertion lives here, where the
 * import is legal.
 *
 * A typo like 'expenses.view' (no such capability) would otherwise sail
 * through: `can()` returns false for an unknown key, so the attachment panel
 * would silently deny everyone, on every screen, with no error anywhere.
 * This turns that into a build failure.
 */
const _capabilitiesExist: Capability = null as unknown as AttachmentCapability
void _capabilitiesExist

export type Attachment = {
  id: number
  entity: AttachmentTarget
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

export type AttachmentInput = {
  filename: string
  storedName: string
  mimeType?: string | null
  sizeBytes: number
  description?: string | null
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }
export type DeleteResult =
  /** The disk name to unlink. Returned so the caller removes the row, then the file. */
  | { ok: true; storedName: string }
  | { ok: false; error: string }

type Row = RowDataPacket & Record<string, unknown>

function mapAttachment(r: Row): Attachment {
  return {
    id: Number(r.id),
    entity: String(r.entity) as AttachmentTarget,
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

const SELECT_ATTACHMENT = `
  SELECT id, entity, entity_id, filename, stored_name, mime_type, size_bytes,
         description, uploaded_by, uploaded_name, created_at
    FROM party_documents
`

/** One record's attachments, newest first. */
export async function listAttachments(
  siteId: number,
  entity: AttachmentTarget,
  entityId: number,
): Promise<Attachment[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_ATTACHMENT} WHERE entity = ? AND entity_id = ? ORDER BY created_at DESC, id DESC`,
    [entity, entityId],
  )
  return rows.map(mapAttachment)
}

/**
 * How many files hang off each of these records.
 *
 * One query for a whole list screen, so a table of 200 GRVs can show a paper
 * clip on the right rows without 200 round trips. Returns a Map rather than an
 * array so the caller looks up by id instead of scanning.
 */
export async function attachmentCounts(
  siteId: number,
  entity: AttachmentTarget,
  entityIds: number[],
): Promise<Map<number, number>> {
  const ids = [...new Set(entityIds)].filter((id) => Number.isFinite(id) && id > 0)
  if (ids.length === 0) return new Map()

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT entity_id, COUNT(*) AS n FROM party_documents
      WHERE entity = ? AND entity_id IN (${ids.map(() => '?').join(',')})
      GROUP BY entity_id`,
    [entity, ...ids],
  )
  return new Map(rows.map((r) => [Number(r.entity_id), Number(r.n)]))
}

/**
 * One attachment, looked up by (id, entity, entity_id).
 *
 * NEVER by id alone. A document id is a guessable integer, and a query that
 * matched on it by itself would let anyone with an account walk the range and
 * read every other record's paperwork. Requiring the caller to also name the
 * record it hangs off means a wrong guess returns null rather than someone
 * else's supplier invoice.
 */
export async function getAttachment(
  siteId: number,
  entity: AttachmentTarget,
  entityId: number,
  id: number,
): Promise<Attachment | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `${SELECT_ATTACHMENT} WHERE id = ? AND entity = ? AND entity_id = ? LIMIT 1`,
    [id, entity, entityId],
  )
  return row ? mapAttachment(row) : null
}

export async function createAttachment(
  siteId: number,
  actor: Actor,
  entity: AttachmentTarget,
  entityId: number,
  input: AttachmentInput,
): Promise<SaveResult> {
  if (!input.filename.trim()) return { ok: false, error: 'That file has no name.' }
  if (!input.storedName.trim()) return { ok: false, error: 'That file was not stored.' }
  if (!Number.isFinite(entityId) || entityId <= 0) {
    return { ok: false, error: 'That record could not be identified.' }
  }

  const res = await siteExecute(
    siteId,
    `INSERT INTO party_documents
       (entity, entity_id, filename, stored_name, mime_type, size_bytes,
        description, uploaded_by, uploaded_name)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      entity,
      entityId,
      input.filename.slice(0, 255),
      input.storedName.slice(0, 190),
      input.mimeType?.slice(0, 120) ?? null,
      Math.max(0, Math.trunc(input.sizeBytes)),
      input.description?.trim().slice(0, 400) || null,
      actor.userId,
      actor.userName.slice(0, 120),
    ],
  )

  await logActivity(siteId, actor, {
    entity: 'attachment',
    entityId,
    action: 'attachment.add',
    detail: `${ATTACHMENT_TARGETS[entity].label} #${entityId} — ${input.filename}`,
  })

  return { ok: true, id: res.insertId }
}

/** Renames an attachment, or changes the line describing what it is. */
export async function updateAttachment(
  siteId: number,
  actor: Actor,
  entity: AttachmentTarget,
  entityId: number,
  id: number,
  input: { filename?: string; description?: string | null },
): Promise<SaveResult> {
  const existing = await getAttachment(siteId, entity, entityId, id)
  if (!existing) return { ok: false, error: 'That attachment no longer exists.' }

  const filename = input.filename?.trim() || existing.filename
  if (!filename) return { ok: false, error: 'Give the file a name.' }

  await siteExecute(
    siteId,
    'UPDATE party_documents SET filename = ?, description = ? WHERE id = ?',
    [
      filename.slice(0, 255),
      input.description === undefined
        ? existing.description
        : input.description?.trim().slice(0, 400) || null,
      id,
    ],
  )

  await logActivity(siteId, actor, {
    entity: 'attachment',
    entityId,
    action: 'attachment.update',
    detail: `${ATTACHMENT_TARGETS[entity].label} #${entityId} — ${filename}`,
  })

  return { ok: true, id }
}

/**
 * Removes the row and reports the disk name so the caller can unlink the file.
 *
 * In that order — row first, then bytes. The reverse leaves a row pointing at
 * nothing if the delete fails, which reads on screen as a working attachment
 * that 404s when clicked.
 */
export async function deleteAttachment(
  siteId: number,
  actor: Actor,
  entity: AttachmentTarget,
  entityId: number,
  id: number,
): Promise<DeleteResult> {
  const existing = await getAttachment(siteId, entity, entityId, id)
  if (!existing) return { ok: false, error: 'That attachment no longer exists.' }

  await siteExecute(siteId, 'DELETE FROM party_documents WHERE id = ?', [id])

  await logActivity(siteId, actor, {
    entity: 'attachment',
    entityId,
    action: 'attachment.delete',
    detail: `${ATTACHMENT_TARGETS[entity].label} #${entityId} — ${existing.filename}`,
  })

  return { ok: true, storedName: existing.storedName }
}

/**
 * Every attachment on a record, for deleting the record itself.
 *
 * There is no foreign key and so no CASCADE — that looseness is exactly what
 * lets one table serve every entity. The trade is that whoever deletes a
 * record must call this and unlink the files, or the bytes stay on disk with
 * nothing pointing at them.
 */
export async function attachmentsFor(
  siteId: number,
  entity: AttachmentTarget,
  entityId: number,
): Promise<string[]> {
  const rows = await siteQuery<Row>(
    siteId,
    'SELECT stored_name FROM party_documents WHERE entity = ? AND entity_id = ?',
    [entity, entityId],
  )
  return rows.map((r) => String(r.stored_name))
}

/** Drops every attachment row for a record. Returns the disk names to unlink. */
export async function removeAttachmentsFor(
  siteId: number,
  entity: AttachmentTarget,
  entityId: number,
): Promise<string[]> {
  const names = await attachmentsFor(siteId, entity, entityId)
  if (names.length > 0) {
    await siteExecute(siteId, 'DELETE FROM party_documents WHERE entity = ? AND entity_id = ?', [
      entity,
      entityId,
    ])
  }
  return names
}

import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'
import { logActivity, type Actor } from './activityLog'
/**
 * What a comment or a document can be ABOUT.
 *
 * ── WHY THIS IS NOT `PartyKind` ────────────────────────────────────────────
 *
 * It used to be. `PartyKind` is `'customer' | 'supplier'` and means "which book
 * a CONTACT belongs to" — it selects a table and a foreign key column, which is
 * a real job this type does not have.
 *
 * Comments never branch on it: `party_comments.entity` is a free-text
 * VARCHAR(40), and nothing here looks a table up from it. So borrowing
 * `PartyKind` was a convenience that had already become a lie — job cards have
 * been passing `'job_card'` through these helpers since 104, with a cast to
 * keep the compiler quiet.
 *
 * Naming it honestly costs one type and buys back the compiler: adding
 * `'ticket'` (165) is now a declaration rather than another cast.
 */
export type CommentEntity = 'customer' | 'supplier' | 'job_card' | 'ticket'

/**
 * Dated remarks by named people about an account.
 *
 * Three things could hold this text, and they are not the same:
 *
 *   notes column  — one editable field describing the account as it stands
 *                   today. Overwritten, undated, unattributed.
 *   activity_log  — what the SYSTEM observed a person do. Append-only, never
 *                   editable, because an audit trail that can be changed is not
 *                   one.
 *   comments      — what a person chose to SAY. "Spoke to Sarah, paying
 *                   Friday." Dated, attributed, and editable, because a thread
 *                   that cannot fix a typo is a nuisance.
 *
 * Editing is recorded by updated_at moving past created_at rather than by an
 * edited flag, so the two can never disagree.
 */

export type PartyComment = {
  id: number
  entity: CommentEntity
  entityId: number
  body: string
  isPinned: boolean
  authorId: number | null
  authorName: string
  createdAt: Date
  updatedAt: Date
  /** Derived: updated_at has moved past created_at. */
  edited: boolean
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }
export type DeleteResult = { ok: true } | { ok: false; error: string }

type Row = RowDataPacket & Record<string, unknown>

function mapComment(r: Row): PartyComment {
  return {
    id: Number(r.id),
    entity: String(r.entity) as CommentEntity,
    entityId: Number(r.entity_id),
    body: String(r.body),
    isPinned: !!r.is_pinned,
    authorId: r.author_id === null ? null : Number(r.author_id),
    authorName: String(r.author_name ?? ''),
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
    // A stored flag, NOT a comparison of the two timestamps.
    //
    // Comparing them was the first attempt and it is unreliable: DATETIME holds
    // whole seconds, so an edit made in the same second as the insert is
    // invisible, and one made in the next second is a delta of exactly 1000ms —
    // which a "> 1000" test reads as unedited. The flag depended on where the
    // two writes happened to fall inside a second, which is not a thing the
    // user did.
    edited: !!r.is_edited,
  }
}

const SELECT_COMMENT = `
  SELECT id, entity, entity_id, body, is_pinned, is_edited, author_id, author_name,
         created_at, updated_at
    FROM party_comments
`

/**
 * The thread: pinned first, then newest.
 *
 * Matches ix_pcomment_entity exactly so the index covers the sort.
 */
export async function listComments(
  siteId: number,
  entity: CommentEntity,
  entityId: number,
  limit = 200,
): Promise<PartyComment[]> {
  const capped = Math.min(Math.max(limit, 1), 500)
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_COMMENT}
      WHERE entity = ? AND entity_id = ?
      ORDER BY is_pinned DESC, created_at DESC, id DESC
      LIMIT ${capped}`,
    [entity, entityId],
  )
  return rows.map(mapComment)
}

/** Longest a comment may be. TEXT holds more; this is what a remark should be. */
const MAX_BODY = 4000

function validateBody(body: string): string | null {
  const trimmed = body?.trim() ?? ''
  if (!trimmed) return 'Write something before saving the comment.'
  if (trimmed.length > MAX_BODY) return `A comment is at most ${MAX_BODY} characters.`
  return null
}

export async function createComment(
  siteId: number,
  actor: Actor,
  entity: CommentEntity,
  entityId: number,
  body: string,
  isPinned = false,
): Promise<SaveResult> {
  const invalid = validateBody(body)
  if (invalid) return { ok: false, error: invalid }

  const res = await siteExecute(
    siteId,
    `INSERT INTO party_comments (entity, entity_id, body, is_pinned, author_id, author_name)
     VALUES (?,?,?,?,?,?)`,
    [entity, entityId, body.trim(), isPinned ? 1 : 0, actor.userId, actor.userName.slice(0, 120)],
  )

  // Logged so the Activity tab shows that a note was left, without duplicating
  // the text — the comment itself is the record, and copying it would mean two
  // places to read and one of them silently stale after an edit.
  await logActivity(siteId, actor, {
    entity,
    entityId,
    action: 'comment',
    detail: 'Added a comment',
  })

  return { ok: true, id: res.insertId }
}

/**
 * Edits a comment.
 *
 * Anyone with access to the account may edit any comment on it. This is a
 * shared back office, not a forum: the person who took the call is often not
 * the one correcting it afterwards, and author_name still records who wrote it.
 */
export async function updateComment(
  siteId: number,
  actor: Actor,
  entity: CommentEntity,
  entityId: number,
  id: number,
  body: string,
): Promise<SaveResult> {
  const invalid = validateBody(body)
  if (invalid) return { ok: false, error: invalid }

  const existing = await siteQueryOne<Row>(
    siteId,
    'SELECT id FROM party_comments WHERE id = ? AND entity = ? AND entity_id = ? LIMIT 1',
    [id, entity, entityId],
  )
  if (!existing) return { ok: false, error: 'That comment no longer exists.' }

  await siteExecute(siteId, 'UPDATE party_comments SET body = ?, is_edited = 1 WHERE id = ?', [
    body.trim(),
    id,
  ])

  return { ok: true, id }
}

/** Pins or unpins, so a standing warning sits above the routine call notes. */
export async function setCommentPinned(
  siteId: number,
  actor: Actor,
  entity: CommentEntity,
  entityId: number,
  id: number,
  pinned: boolean,
): Promise<SaveResult> {
  const existing = await siteQueryOne<Row>(
    siteId,
    'SELECT id FROM party_comments WHERE id = ? AND entity = ? AND entity_id = ? LIMIT 1',
    [id, entity, entityId],
  )
  if (!existing) return { ok: false, error: 'That comment no longer exists.' }

  // is_edited is deliberately not touched: pinning is not editing. Now that the
  // flag is stored rather than inferred from updated_at, this needs no trick to
  // hold the timestamp still.
  await siteExecute(siteId, 'UPDATE party_comments SET is_pinned = ? WHERE id = ?', [
    pinned ? 1 : 0,
    id,
  ])

  return { ok: true, id }
}

export async function deleteComment(
  siteId: number,
  actor: Actor,
  entity: CommentEntity,
  entityId: number,
  id: number,
): Promise<DeleteResult> {
  const existing = await siteQueryOne<Row>(
    siteId,
    'SELECT id FROM party_comments WHERE id = ? AND entity = ? AND entity_id = ? LIMIT 1',
    [id, entity, entityId],
  )
  if (!existing) return { ok: false, error: 'That comment no longer exists.' }

  await siteExecute(siteId, 'DELETE FROM party_comments WHERE id = ?', [id])

  await logActivity(siteId, actor, {
    entity,
    entityId,
    action: 'comment',
    detail: 'Removed a comment',
  })

  return { ok: true }
}

/**
 * Clears an account's comments. For deleting the account.
 *
 * Same reasoning as removeDocumentsFor: the loose entity pair has no foreign
 * key, so nothing removes these automatically.
 */
export async function removeCommentsFor(
  tx: PoolConnection,
  entity: CommentEntity,
  entityId: number,
): Promise<void> {
  await tx.execute('DELETE FROM party_comments WHERE entity = ? AND entity_id = ?', [
    entity,
    entityId,
  ] as never)
}

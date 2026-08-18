import 'server-only'
import type { RowDataPacket } from 'mysql2'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { sanitiseTemplate } from '../stationery/sanitise'
import { validateTemplate, summarise } from '../stationery/validate'
import { isDocType } from '../stationery/catalog'

/**
 * Reading and writing a site's designed stationery.
 *
 * The DB half of src/lib/stationery/*, which is deliberately pure and
 * client-safe. Everything that touches a database lives here, so the designer
 * UI can import the catalog and the validator without dragging a connection
 * pool into the browser bundle.
 *
 * ── THE WRITE PATH IS THE SECURITY BOUNDARY ───────────────────────────────
 *
 * `body` is markup a person typed, rendered later into a page in this app's own
 * origin. saveTemplate() is the ONLY way a row gets here, and it sanitises
 * before it writes — so what is in the table is already clean, and a future
 * reader cannot forget to clean it. Client-side cleaning would be theatre:
 * anyone can post straight to the action.
 *
 * ── THE READ PATH TRUSTS NOTHING ANYWAY ───────────────────────────────────
 *
 * Belt and braces, for the same reason saved_reports re-validates: a template
 * outlives the catalog that produced it. A row stored when a token existed, or
 * before a field became required, is not automatically fit to print today. So
 * resolution re-validates (see stationery/resolve.ts) and falls back rather
 * than trusting the row because it is in the database.
 */

export type StationeryTemplate = {
  id: number
  docType: string
  name: string
  format: 'html' | 'slip'
  body: string
  /** Work in progress. Null when there is nothing unpublished. */
  draftBody: string | null
  isActive: boolean
  version: number
  createdByName: string
  updatedAt: Date
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }

/**
 * Whether the table has actually reached this site.
 *
 * Schema drifts between sites: a file in sql/site/ is only real once the runner
 * has applied it there. Printing must not depend on a migration having landed,
 * so every read degrades to "this site has no custom stationery" — which is
 * exactly right, because a site without the table has none.
 */
async function tableExists(siteId: number): Promise<boolean> {
  const row = await siteQueryOne<RowDataPacket>(
    siteId,
    `SELECT 1 AS ok FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stationery_templates' LIMIT 1`,
  )
  return !!row
}

function mapRow(r: Record<string, unknown>): StationeryTemplate {
  return {
    id: Number(r.id),
    docType: String(r.doc_type),
    name: String(r.name),
    format: r.format === 'slip' ? 'slip' : 'html',
    body: String(r.body ?? ''),
    draftBody: r.draft_body === null || r.draft_body === undefined ? null : String(r.draft_body),
    isActive: Number(r.is_active) === 1,
    version: Number(r.version ?? 1),
    createdByName: String(r.created_by_name ?? ''),
    updatedAt: r.updated_at as Date,
  }
}

/**
 * The template that should print for this document type, or null.
 *
 * Never throws. A print route calling this is about to put paper in front of a
 * supplier, and a missing table or a database hiccup must degrade to the
 * shipped default rather than to a 500 — the same rule the slip footer follows.
 *
 * Takes the newest active row rather than asserting there is one. The
 * "exactly one active" invariant is setActive()'s job; if it is ever broken,
 * a document still prints.
 */
export async function activeTemplateBody(
  siteId: number,
  docType: string,
): Promise<string | null> {
  try {
    if (!isDocType(docType)) return null
    if (!(await tableExists(siteId))) return null

    const row = await siteQueryOne<RowDataPacket>(
      siteId,
      `SELECT body FROM stationery_templates
        WHERE doc_type = ? AND is_active = 1
        ORDER BY updated_at DESC, id DESC LIMIT 1`,
      [docType],
    )
    const body = row ? String((row as Record<string, unknown>).body ?? '') : ''
    return body.trim() === '' ? null : body
  } catch {
    return null
  }
}

/** Everything designed for one document type, newest first. */
export async function listTemplates(
  siteId: number,
  docType?: string,
): Promise<StationeryTemplate[]> {
  if (!(await tableExists(siteId))) return []

  const rows = docType
    ? await siteQuery<RowDataPacket>(
        siteId,
        `SELECT * FROM stationery_templates WHERE doc_type = ? ORDER BY updated_at DESC`,
        [docType],
      )
    : await siteQuery<RowDataPacket>(
        siteId,
        `SELECT * FROM stationery_templates ORDER BY doc_type, updated_at DESC`,
      )

  return rows.map((r) => mapRow(r as Record<string, unknown>))
}

export async function getTemplate(
  siteId: number,
  id: number,
): Promise<StationeryTemplate | null> {
  if (!(await tableExists(siteId))) return null
  const row = await siteQueryOne<RowDataPacket>(
    siteId,
    'SELECT * FROM stationery_templates WHERE id = ?',
    [id],
  )
  return row ? mapRow(row as Record<string, unknown>) : null
}

export type TemplateInput = {
  docType: string
  name: string
  body: string
  format?: 'html' | 'slip'
  /** Save as a draft rather than publishing over what currently prints. */
  asDraft?: boolean
}

/**
 * Create or replace a template.
 *
 * Order matters and is the whole point:
 *
 *   1. SANITISE — the untrusted half, before anything else looks at it.
 *   2. VALIDATE — the CLEANED markup, not what was typed. Validating the input
 *      and storing the output would let a save pass on a token inside a
 *      <script> the sanitiser then removed.
 *   3. WRITE.
 *
 * A save that fails validation is refused outright rather than stored as a
 * draft: the designer must not be able to leave a document in a state where a
 * later "publish" quietly ships something unlawful.
 */
export async function saveTemplate(
  siteId: number,
  input: TemplateInput,
  actor: { userId: number; userName: string },
  id?: number,
): Promise<SaveResult> {
  if (!isDocType(input.docType)) return { ok: false, error: 'Unknown document type.' }

  const name = input.name.trim().slice(0, 120)
  if (!name) return { ok: false, error: 'Give the template a name.' }

  if (!(await tableExists(siteId))) {
    return {
      ok: false,
      error: 'Stationery is not set up on this site yet. Run the database migrations.',
    }
  }

  const clean = sanitiseTemplate(input.body)
  if (clean.trim() === '') return { ok: false, error: 'The template is empty.' }

  const check = validateTemplate(input.docType, clean)
  if (!check.ok) return { ok: false, error: summarise(check) }

  const format = input.format ?? 'html'

  if (id) {
    // A draft edit leaves what prints alone; a publish replaces it and clears
    // the draft, so "what is on paper" and "what I am editing" cannot drift.
    if (input.asDraft) {
      await siteExecute(
        siteId,
        'UPDATE stationery_templates SET name = ?, draft_body = ? WHERE id = ?',
        [name, clean, id],
      )
    } else {
      await siteExecute(
        siteId,
        'UPDATE stationery_templates SET name = ?, body = ?, draft_body = NULL WHERE id = ?',
        [name, clean, id],
      )
    }
    return { ok: true, id }
  }

  const res = await siteExecute(
    siteId,
    `INSERT INTO stationery_templates
       (doc_type, name, format, body, draft_body, is_active, created_by, created_by_name)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    [
      input.docType,
      name,
      format,
      clean,
      input.asDraft ? clean : null,
      actor.userId,
      actor.userName.slice(0, 120),
    ],
  )
  return { ok: true, id: res.insertId }
}

/**
 * Make one template the one that prints, and no other.
 *
 * Both statements in one transaction, because the intermediate state — no
 * active template for a document type — is a state in which a supplier gets the
 * house default instead of this shop's letterhead. Brief, but it is a wrong
 * document rather than a slow one.
 */
export async function setActive(siteId: number, id: number): Promise<SaveResult> {
  const tpl = await getTemplate(siteId, id)
  if (!tpl) return { ok: false, error: 'That template no longer exists.' }

  // Re-checked here and not only at save: this is the moment it starts
  // printing, and the required set may have grown since it was written.
  const check = validateTemplate(tpl.docType, tpl.body)
  if (!check.ok) return { ok: false, error: summarise(check) }

  await siteTransaction(siteId, async (tx) => {
    await tx.execute(
      'UPDATE stationery_templates SET is_active = 0 WHERE doc_type = ? AND id <> ?',
      [tpl.docType, id] as never,
    )
    await tx.execute('UPDATE stationery_templates SET is_active = 1 WHERE id = ?', [id] as never)
  })

  return { ok: true, id }
}

/**
 * Stop using a custom design for this document type.
 *
 * Deactivates rather than deletes: "reset to default" and "throw away the work"
 * are different intentions, and a shop that reverts a letterhead in a hurry
 * should be able to put it back. Deletion is its own action.
 */
export async function resetToDefault(siteId: number, docType: string): Promise<SaveResult> {
  if (!isDocType(docType)) return { ok: false, error: 'Unknown document type.' }
  if (!(await tableExists(siteId))) return { ok: true, id: 0 }

  await siteExecute(
    siteId,
    'UPDATE stationery_templates SET is_active = 0 WHERE doc_type = ?',
    [docType],
  )
  return { ok: true, id: 0 }
}

export async function deleteTemplate(siteId: number, id: number): Promise<SaveResult> {
  if (!(await tableExists(siteId))) return { ok: false, error: 'That template no longer exists.' }
  await siteExecute(siteId, 'DELETE FROM stationery_templates WHERE id = ?', [id])
  return { ok: true, id }
}

/** Throw away an unpublished draft, leaving what prints untouched. */
export async function discardDraft(siteId: number, id: number): Promise<SaveResult> {
  if (!(await tableExists(siteId))) return { ok: false, error: 'That template no longer exists.' }
  await siteExecute(siteId, 'UPDATE stationery_templates SET draft_body = NULL WHERE id = ?', [id])
  return { ok: true, id }
}

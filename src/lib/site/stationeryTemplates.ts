import 'server-only'
import type { RowDataPacket } from 'mysql2'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { sanitiseTemplate } from '../stationery/sanitise'
import { validateTemplate, summarise } from '../stationery/validate'
import { isDocType, getDocType } from '../stationery/catalog'
import { parseSlip, validateSlip, serialiseSlip } from '../stationery/slip'
import { parseSpec, validateSpec, serialiseSpec } from '../stationery/blocks'
import { compileDocument } from '../stationery/compile'

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
  format: 'html' | 'slip' | 'blocks'
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
    // A format this build does not know reads as markup — the historical shape.
    format: r.format === 'slip' ? 'slip' : r.format === 'blocks' ? 'blocks' : 'html',
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

/**
 * The active template WITH how it is written.
 *
 * A print route needs both: a `blocks` body is JSON that must be compiled
 * before it means anything, and reading one as markup would put a page of
 * escaped braces in front of a supplier.
 *
 * `activeTemplateBody` stays as the body-only reader for callers that predate
 * the visual designer, so nothing had to change to keep working.
 *
 * Never throws, same as the body-only version: a print route calling this is
 * about to put paper in front of somebody.
 */
export async function activeTemplate(
  siteId: number,
  docType: string,
): Promise<{ body: string; format: 'html' | 'slip' | 'blocks' } | null> {
  try {
    if (!isDocType(docType)) return null
    if (!(await tableExists(siteId))) return null

    const row = await siteQueryOne<RowDataPacket>(
      siteId,
      `SELECT body, format FROM stationery_templates
        WHERE doc_type = ? AND is_active = 1
        ORDER BY updated_at DESC, id DESC LIMIT 1`,
      [docType],
    )
    if (!row) return null

    const r = row as Record<string, unknown>
    const body = String(r.body ?? '')
    if (body.trim() === '') return null

    const raw = String(r.format ?? 'html')
    // A format this build does not know is read as markup — the historical
    // shape, and the one that degrades to a visible page rather than to JSON.
    const format = raw === 'slip' || raw === 'blocks' ? raw : 'html'
    return { body, format }
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
  format?: 'html' | 'slip' | 'blocks'
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

  /*
   * A slip is not markup, so it takes the other road entirely: no sanitiser
   * (there is no HTML to clean — the body is JSON), and the block validator
   * rather than the token one. Running sanitiseTemplate over a JSON spec would
   * quietly mangle it into something parseSlip could not read.
   */
  const doc = getDocType(input.docType)
  const isSlip = doc?.medium === 'slip'

  /*
   * The FORMAT decides the road, not the medium.
   *
   * A slip is always a block list. An A4 page is markup or blocks — same
   * medium, different storage — so the caller says which, and only a slip is
   * inferred. Keying this off `medium` would send every block document through
   * the markup sanitiser, which would quietly mangle the JSON into something
   * parseSpec could not read.
   */
  const format: 'html' | 'slip' | 'blocks' = isSlip ? 'slip' : (input.format ?? 'html')

  let clean: string
  if (format === 'slip') {
    const spec = parseSlip(input.body)
    if (!spec) return { ok: false, error: 'That slip design cannot be read.' }
    const check = validateSlip(spec)
    if (!check.ok) return { ok: false, error: check.errors.join(' ') }
    // Stored re-serialised, so what is on disk is what the parser accepted
    // rather than whatever the browser happened to send.
    clean = serialiseSlip(spec)
  } else if (format === 'blocks') {
    const spec = parseSpec(input.body, input.docType)
    if (!spec) return { ok: false, error: 'That design cannot be read.' }

    const structure = validateSpec(spec, input.docType)
    if (!structure.ok) return { ok: false, error: structure.errors.join(' ') }

    /*
     * The legal check runs against the COMPILED markup, not the spec.
     *
     * One set of rules for both editors: a document designed by dragging must
     * carry everything a typed one must, and the only honest way to know that
     * is to ask the question of what will actually print.
     */
    const compiled = compileDocument(spec, input.docType)
    const legal = validateTemplate(input.docType, compiled)
    if (!legal.ok) return { ok: false, error: summarise(legal) }

    clean = serialiseSpec(spec)
  } else {
    clean = sanitiseTemplate(input.body)
    if (clean.trim() === '') return { ok: false, error: 'The template is empty.' }

    const check = validateTemplate(input.docType, clean)
    if (!check.ok) return { ok: false, error: summarise(check) }
  }

  if (id) {
    /*
     * FORMAT IS WRITTEN ON EVERY UPDATE, not only on insert.
     *
     * "Edit as HTML" converts a block design to markup in place, and a row left
     * saying 'blocks' while holding markup would be read back as a spec, fail
     * to parse, and silently print the shipped default instead of the shop's
     * own document. The body and the word for how to read it must move
     * together or not at all.
     */
    if (input.asDraft) {
      await siteExecute(
        siteId,
        'UPDATE stationery_templates SET name = ?, format = ?, draft_body = ? WHERE id = ?',
        [name, format, clean, id],
      )
    } else {
      await siteExecute(
        siteId,
        'UPDATE stationery_templates SET name = ?, format = ?, body = ?, draft_body = NULL WHERE id = ?',
        [name, format, clean, id],
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

  /*
   * Re-checked here and not only at save: this is the moment it starts
   * printing, and the required set may have grown since it was written.
   *
   * Through whichever validator suits the medium — running the token validator
   * over a slip's JSON would reject every slip ever designed, and running the
   * block validator over markup would accept anything.
   */
  if (tpl.format === 'slip') {
    const spec = parseSlip(tpl.body)
    if (!spec) return { ok: false, error: 'That slip design can no longer be read.' }
    const check = validateSlip(spec)
    if (!check.ok) return { ok: false, error: check.errors.join(' ') }
  } else if (tpl.format === 'blocks') {
    const spec = parseSpec(tpl.body, tpl.docType)
    if (!spec) return { ok: false, error: 'That design can no longer be read.' }
    const structure = validateSpec(spec, tpl.docType)
    if (!structure.ok) return { ok: false, error: structure.errors.join(' ') }
    // Against what will print, for the same reason as at save.
    const legal = validateTemplate(tpl.docType, compileDocument(spec, tpl.docType))
    if (!legal.ok) return { ok: false, error: summarise(legal) }
  } else {
    const check = validateTemplate(tpl.docType, tpl.body)
    if (!check.ok) return { ok: false, error: summarise(check) }
  }

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

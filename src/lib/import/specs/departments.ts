import 'server-only'
import { createDepartment, updateDepartment, getDepartment } from '@/lib/site/departments'
import { loadLookups, norm, splitPath, PATH_SEPARATOR } from '../lookups'
import { text } from '../fields'
import type {
  ApplyContext, ExistingMode, ImportSpec, LookupTables, RowOutcome,
} from '../spec'

/**
 * Importing the department tree.
 *
 * Departments are the one thing an import CREATES on the way in rather than
 * refusing when it does not recognise them, and this is where that lives — both
 * for a department file of its own and for the Department column on a product
 * file, which walks the same function.
 *
 * The reasoning: a department is a name and a parent, which is exactly what a
 * path in a cell already says. Nothing is being invented. Every other reference
 * a file can make — a brand, a VAT code, a location, a supplier — carries
 * settings the cell cannot state, so inventing one would mean inventing those
 * too. Refusing those and creating these is not inconsistency; it is the line
 * between a name and a record.
 *
 * The alternative was tried on paper and is worse: a first-time import of
 * 20,000 products refusing every row until somebody hand-builds a 200-node tree
 * from a list they can only get by reading the file they are trying to import.
 */

export type DepartmentDraft = {
  path?: string
  code?: string
  color?: string
}

/**
 * Finds or creates every node on a path, returning the leaf's id.
 *
 * Walks left to right so 'Fresh Produce › Fruit › Citrus' creates at most three
 * departments and reuses whichever already exist. Each id created is written
 * straight back into `lookups.departmentByPath`, which does two jobs: the next
 * 900 rows naming that path resolve from memory instead of re-querying, and two
 * rows naming the same new path cannot create it twice.
 *
 * Matching is case-insensitive per segment, because a sheet writes 'FRESH
 * PRODUCE' and the tree holds 'Fresh Produce'. `nameClash` compares under
 * MySQL's default collation, which is case-insensitive too — so a case-only
 * difference would be refused there anyway, and matching here means the row
 * quietly succeeds instead of failing with a message about a department that
 * looks identical to the one in the cell.
 */
export async function ensureDepartmentPath(
  siteId: number,
  lookups: LookupTables,
  path: string,
): Promise<{ ok: true; id: number; created: string[] } | { ok: false; error: string }> {
  const segments = splitPath(path)
  if (segments.length === 0) return { ok: false, error: 'No department name given.' }

  const created: string[] = []
  let parentId: number | null = null
  let walked = ''

  for (const segment of segments) {
    walked = walked ? `${walked} ${PATH_SEPARATOR} ${segment}` : segment

    const known = lookups.departmentByPath.get(norm(walked))
    if (known !== undefined) {
      parentId = known
      continue
    }

    const result = await createDepartment(siteId, { name: segment, parentId })
    if (!result.ok) {
      return {
        ok: false,
        error: `Could not create the department "${segment}" — ${lower(result.error)}`,
      }
    }

    const fullKey = norm(walked)
    const leafKey = norm(segment)

    lookups.departmentByPath.set(fullKey, result.id)

    // A bare leaf name is only a safe key while it names ONE department. If
    // something else already answers to it, both become unreachable by the
    // bare name and a row using it is asked for the full path instead.
    //
    // The `fullKey !== leafKey` guard matters: a top-level department's path IS
    // its name, so without it the line above would look like a pre-existing
    // clash with itself and delete the key it had just written.
    if (fullKey !== leafKey) {
      if (lookups.departmentByPath.has(leafKey) || lookups.departmentAmbiguous.has(leafKey)) {
        lookups.departmentAmbiguous.add(leafKey)
        lookups.departmentByPath.delete(leafKey)
      } else {
        lookups.departmentByPath.set(leafKey, result.id)
      }
    }

    created.push(walked)
    parentId = result.id
  }

  return { ok: true, id: parentId as number, created }
}

const lower = (message: string): string =>
  message.charAt(0).toLowerCase() + message.slice(1)

export const departmentSpec: ImportSpec<DepartmentDraft> = {
  entity: 'departments',
  title: 'Departments',
  singular: 'department',
  description: 'The tree products are filed under. Write a full path to create a branch at once.',
  capability: 'products.edit',
  matchKey: 'path',

  fields: [
    {
      ...text<DepartmentDraft>({
        key: 'path',
        label: 'Department',
        aliases: ['Department', 'Department Path', 'Name', 'Category', 'Group'],
        required: true,
        hint: `Full path, separated by ${PATH_SEPARATOR} or /. Every level named is created if it does not exist.`,
        example: `Fresh Produce ${PATH_SEPARATOR} Fruit ${PATH_SEPARATOR} Citrus`,
        max: 120,
      }),
      // Stored normalised so the match key and the lookup agree exactly.
      parse: (cell) => {
        const segments = splitPath(cell.text)
        if (segments.length === 0) {
          return { kind: 'problem', reason: 'No department name in this row.' }
        }
        const tooLong = segments.find((s) => s.length > 120)
        if (tooLong) {
          return { kind: 'problem', reason: `"${tooLong}" is longer than 120 characters.` }
        }
        return { kind: 'value', value: segments.join(` ${PATH_SEPARATOR} `) }
      },
    },
    text<DepartmentDraft>({
      key: 'code',
      label: 'Code',
      aliases: ['Code', 'Department Code'],
      hint: 'Optional short handle. Not required to be unique.',
      example: 'FRT',
      max: 32,
    }),
    {
      key: 'color',
      label: 'Colour',
      aliases: ['Colour', 'Color'],
      hint: 'Hex, like #2f6fed. Used on till tiles and reports.',
      example: '#2f6fed',
      // Checked here rather than left to validateDepartment, so a whole file of
      // colours in some other notation is reported on the review screen instead
      // of failing row by row after the writing has already started.
      parse: (cell) => {
        const value = cell.text.trim()
        const hex = value.startsWith('#') ? value : `#${value}`
        if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
          return { kind: 'problem', reason: `"${value}" is not a colour. Write it as #2f6fed.` }
        }
        return { kind: 'value', value: hex.toLowerCase() }
      },
    },
  ],

  loadLookups: (siteId) => loadLookups(siteId, { departments: true, existing: 'departments' }),

  async applyRow(
    ctx: ApplyContext,
    draft: Record<string, unknown>,
    existingId: number | null,
    mode: ExistingMode,
  ): Promise<RowOutcome> {
    const path = String(draft.path ?? '')
    const base = { line: 0, code: path }

    if (existingId !== null && mode === 'skip') {
      return { ...base, status: 'skipped', reason: 'Already on file.' }
    }

    // An update names an existing path, so the tree already holds every node —
    // only the leaf's own details can change.
    if (existingId !== null) {
      const result = await writeLeafDetails(ctx, existingId, draft)
      return result.ok
        ? { ...base, status: 'updated', id: existingId }
        : { ...base, status: 'failed', reason: result.error }
    }

    const walked = await ensureDepartmentPath(ctx.siteId, ctx.lookups, path)
    if (!walked.ok) return { ...base, status: 'failed', reason: walked.error }

    // Code and colour belong to the leaf, not to the branches walked to reach
    // it — a colour on 'Fresh Produce › Fruit › Citrus' means Citrus is blue,
    // not that all three are.
    const warnings: { step: string; reason: string }[] = []
    if (ctx.mapped.has('code') || ctx.mapped.has('color')) {
      const result = await writeLeafDetails(ctx, walked.id, draft)
      if (!result.ok) warnings.push({ step: 'Code and colour', reason: result.error })
    }

    return {
      ...base,
      status: 'created',
      id: walked.id,
      warnings: warnings.length > 0 ? warnings : undefined,
    }
  },
}

/**
 * Writes the leaf's own code and colour, leaving everything else as it stands.
 *
 * `updateDepartment` writes every column it is given, INCLUDING pos_image_id
 * and online_image_id — so a call that names only the fields this import knows
 * about would blank the department's till tile and its shop picture. The stored
 * row is loaded and overlaid for the same reason `mergeForUpdate` exists on the
 * product side; this is that pattern at department scale.
 */
async function writeLeafDetails(
  ctx: ApplyContext,
  id: number,
  draft: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const existing = await getDepartment(ctx.siteId, id)
  if (!existing) return { ok: false, error: 'It was deleted while this ran.' }

  const result = await updateDepartment(ctx.siteId, id, {
    name: existing.name,
    parentId: existing.parentId,
    code: ctx.mapped.has('code') ? ((draft.code as string | null) ?? null) : existing.code,
    color: ctx.mapped.has('color') ? ((draft.color as string | null) ?? null) : existing.color,
    sortOrder: existing.sortOrder,
    isActive: existing.isActive,
    posImageId: existing.posImageId,
    onlineImageId: existing.onlineImageId,
  })
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}

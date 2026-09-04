import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { isCapability } from './permissions'
import { ALL_SWATCH_TOKENS } from '../../components/ui/tiles'
import {
  quickKeySig,
  quickKeyCapability,
  quickKeyAllowedOnSection,
  actionForSlug,
  QUICK_KEY_ICON_NAMES,
  SUPERVISOR_GROUP_SIG,
  type QuickKeyKind,
  type QuickKeyRow,
  type QuickKeySection,
  type QuickKeyTarget,
} from '../quickKeys'

/**
 * Reading and writing the shop's quick keys.
 *
 * The rules that keep the model honest live HERE rather than in the designer, because
 * the designer is a client component and every one of its requests is an endpoint
 * somebody can call directly:
 *
 *   · ONE LEVEL of nesting. A group cannot go inside a group.
 *   · `sig` is server-written, always. It is what makes `uq_slot` mean anything, and a
 *     client that could set it independently could make it disagree with the columns it
 *     is derived from.
 *   · `position` is renumbered per scope on every move, so the client never sends one.
 *   · `capability` is validated against the real list, so a key cannot be saved
 *     demanding a right nobody can hold.
 *   · `colour_token` is validated against the palette, because a stored hex would
 *     survive a restyle and then be the one key that did not change colour.
 *
 * Every mutation returns the WHOLE fresh list. Positions are renumbered server-side, so
 * a client applying its own guess at the new order drifts from what the till will draw.
 */

type Row = RowDataPacket & Record<string, unknown>

const SELECT_KEY = `
  SELECT id, parent_id, section, kind, action_slug, product_id, department_id,
         caption, icon, colour_token, position, is_hidden, require_auth, capability, sig
    FROM pos_quick_keys
`

function mapKey(r: Row): QuickKeyRow {
  return {
    id: Number(r.id),
    parentId: r.parent_id === null ? null : Number(r.parent_id),
    section: String(r.section) as QuickKeySection,
    kind: String(r.kind) as QuickKeyKind,
    actionSlug: String(r.action_slug ?? ''),
    productId: r.product_id === null ? null : Number(r.product_id),
    departmentId: r.department_id === null ? null : Number(r.department_id),
    caption: String(r.caption ?? ''),
    icon: String(r.icon ?? ''),
    colourToken: String(r.colour_token ?? ''),
    position: Number(r.position ?? 0),
    isHidden: !!r.is_hidden,
    requireAuth: !!r.require_auth,
    capability: String(r.capability ?? ''),
    sig: String(r.sig ?? ''),
  }
}

export type SaveResult = { ok: true; keys: QuickKeyRow[] } | { ok: false; error: string }

/**
 * Every key for a section, groups and members together.
 *
 * One query, not one per group. The designer and the till both need the whole tree to
 * draw anything, and `topLevelKeys`/`groupMembers` in the pure module arrange it — so
 * the shape is decided in one place that a test can reach without a database.
 */
export async function listQuickKeys(
  siteId: number,
  section: QuickKeySection = 'main',
): Promise<QuickKeyRow[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_KEY} WHERE section = ? ORDER BY position, id`,
    [section],
  )
  return rows.map(mapKey)
}

export async function getQuickKey(siteId: number, id: number): Promise<QuickKeyRow | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_KEY} WHERE id = ? LIMIT 1`, [id])
  return row ? mapKey(row) : null
}

/**
 * Every key on every bar.
 *
 * What a mutation returns, always — the designer holds both bars at once, and an action
 * that replied with one section would have the canvas replace its whole list with half
 * of it and the other bar would vanish until a reload. Cheap: a shop's entire key set is
 * a few dozen rows.
 *
 * `listQuickKeys` stays section-scoped for the till, which draws one bar and has no use
 * for the other.
 */
export async function listAllQuickKeys(siteId: number): Promise<QuickKeyRow[]> {
  const rows = await siteQuery<Row>(siteId, `${SELECT_KEY} ORDER BY section, position, id`)
  return rows.map(mapKey)
}

/* ── Validation ──────────────────────────────────────────────────────────── */

/**
 * The colours a key may wear.
 *
 * ── ASKED OF THE PALETTES, NOT LISTED HERE ────────────────────────────────
 *
 * This used to name TILE_SWATCHES and TILE_GRADIENTS explicitly, which was
 * right when the inspector drew those. It now draws the shared <SwatchPicker>,
 * whose palette is CATEGORY_SWATCHES — so every one of the twenty colours on
 * screen was a colour the server refused, and the only thing that saved was the
 * "None" button. The set said what the picker USED to offer, and nothing links
 * the two but a person remembering.
 *
 * ALL_SWATCH_TOKENS is derived from the palettes themselves, so adding a swatch
 * makes it selectable and storable together. See the note there.
 *
 * The empty string stays, and is not a palette entry: it is what a row written
 * before there was a colour holds, and what `icon` uses for "not chosen". Only
 * `tile-none` means somebody deliberately chose no colour.
 */
const VALID_TOKENS = new Set<string>([...ALL_SWATCH_TOKENS, ''])

export type QuickKeyInput = {
  section?: QuickKeySection
  parentId?: number | null
  target: QuickKeyTarget
  caption?: string
  icon?: string
  colourToken?: string
  requireAuth?: boolean
}

function validate(input: QuickKeyInput): string | null {
  if ((input.caption ?? '').length > 60) return 'A caption must be 60 characters or fewer.'
  if (!VALID_TOKENS.has(input.colourToken ?? '')) {
    // Refused rather than coerced: a hex that silently became tile-1 would leave the
    // shop believing it had chosen a colour it had not.
    return 'That is not a colour from the palette.'
  }
  if (input.target.kind === 'action' && !actionForSlug(input.target.actionSlug)) {
    return 'That is not something a quick key can do.'
  }
  if (input.target.kind === 'group' && input.parentId != null) {
    // The one-level rule. Enforced here, not only in the designer's drag handling.
    return 'A group cannot go inside another group.'
  }
  /* Which BAR the key is allowed on. The designer greys these out in the rail, but the
     rail is a screen and this is an endpoint. */
  const banned = quickKeyAllowedOnSection(
    {
      kind: input.target.kind,
      actionSlug: input.target.kind === 'action' ? input.target.actionSlug : '',
    },
    input.section ?? 'main',
  )
  if (banned) return banned
  return null
}

/* ── Writes ──────────────────────────────────────────────────────────────── */

/**
 * Adds a key to the end of its scope.
 *
 * `position` is `MAX + 1` within the scope, read inside the transaction so two
 * simultaneous adds cannot both claim the same slot — they would render in id order,
 * which looks like one of them moved on its own.
 */
export async function createQuickKey(siteId: number, input: QuickKeyInput): Promise<SaveResult> {
  const invalid = validate(input)
  if (invalid) return { ok: false, error: invalid }

  const section = input.section ?? 'main'
  const parentId = input.parentId ?? null
  const caption = (input.caption ?? '').trim()
  const sig = quickKeySig(input.target, caption)

  if (parentId !== null) {
    const parent = await getQuickKey(siteId, parentId)
    if (!parent) return { ok: false, error: 'That group no longer exists.' }
    if (parent.kind !== 'group') return { ok: false, error: 'Keys can only go inside a group.' }
  }

  /* Checked in code as well as by uq_slot, because MySQL treats NULLs as distinct in a
     unique index — so the index does NOT constrain top-level keys, where parent_id is
     always NULL. Without this a shop could put one product on a bar twice. */
  const clash = await siteQueryOne<Row>(
    siteId,
    parentId === null
      ? `SELECT id FROM pos_quick_keys WHERE section = ? AND parent_id IS NULL AND sig = ? LIMIT 1`
      : `SELECT id FROM pos_quick_keys WHERE section = ? AND parent_id = ? AND sig = ? LIMIT 1`,
    parentId === null ? [section, sig] : [section, parentId, sig],
  )
  if (clash) return { ok: false, error: 'That is already on this bar.' }

  const capability = quickKeyCapability(input.target.kind, sigSlug(input.target)) ?? ''
  if (capability && !isCapability(capability)) {
    return { ok: false, error: 'That key needs a permission this system does not have.' }
  }

  await siteTransaction(siteId, async (tx) => {
    const [maxRows] = await tx.query(
      parentId === null
        ? `SELECT COALESCE(MAX(position), -1) AS p FROM pos_quick_keys
            WHERE section = ? AND parent_id IS NULL FOR UPDATE`
        : `SELECT COALESCE(MAX(position), -1) AS p FROM pos_quick_keys
            WHERE section = ? AND parent_id = ? FOR UPDATE`,
      parentId === null ? [section, parentId] : [section, parentId],
    )
    const next = Number((maxRows as Row[])[0]?.p ?? -1) + 1

    await tx.execute(
      `INSERT INTO pos_quick_keys
         (parent_id, section, kind, action_slug, product_id, department_id,
          caption, icon, colour_token, position, require_auth, capability, sig)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        parentId,
        section,
        input.target.kind,
        input.target.kind === 'action' ? input.target.actionSlug : '',
        input.target.kind === 'product' ? input.target.productId : null,
        input.target.kind === 'department' ? input.target.departmentId : null,
        caption.slice(0, 60),
        (input.icon ?? '').slice(0, 40),
        input.colourToken ?? '',
        next,
        input.requireAuth ? 1 : 0,
        capability,
        sig,
      ] as never,
    )
  })

  return { ok: true, keys: await listAllQuickKeys(siteId) }
}

/** The action slug out of a target, or '' — for capability lookup. */
function sigSlug(target: QuickKeyTarget): string {
  return target.kind === 'action' ? target.actionSlug : ''
}

/**
 * Renumbers one scope to 0..n-1.
 *
 * Called after ANY change that removes a key from a scope, not only a move. Filing three
 * keys into a group leaves the bar at `0,1,4,5`; deleting a group leaves it at
 * `0,1,2,4,5`. Both render fine, which is exactly why the gap survives — and then
 * "insert at index 3" stops meaning anything, because there is no 3.
 *
 * Takes the open transaction rather than opening its own, so the renumber commits with
 * the change that caused it. A scope momentarily visible with gaps is a scope a
 * concurrent read could draw.
 */
async function renumberScope(
  tx: Parameters<Parameters<typeof siteTransaction>[1]>[0],
  section: QuickKeySection,
  parentId: number | null,
): Promise<void> {
  const [rows] = await tx.query(
    parentId === null
      ? `SELECT id FROM pos_quick_keys WHERE section = ? AND parent_id IS NULL
          ORDER BY position, id FOR UPDATE`
      : `SELECT id FROM pos_quick_keys WHERE section = ? AND parent_id = ?
          ORDER BY position, id FOR UPDATE`,
    parentId === null ? [section] : [section, parentId],
  )
  for (const [index, row] of (rows as Row[]).entries()) {
    await tx.execute(`UPDATE pos_quick_keys SET position = ? WHERE id = ?`, [
      index,
      Number(row.id),
    ] as never)
  }
}

/**
 * Creates a group and files the given keys into it, in ONE request.
 *
 * Deliberately not "create a group, then move keys into it": a dropped connection
 * between the two leaves an empty folder on the bar that the shop then has to notice
 * and delete. One transaction means either the group exists with its members or nothing
 * happened.
 */
export async function createQuickKeyGroup(
  siteId: number,
  input: { section?: QuickKeySection; caption: string; icon?: string; colourToken?: string },
  memberIds: readonly number[],
): Promise<SaveResult> {
  const section = input.section ?? 'main'
  const caption = input.caption.trim()
  if (!caption) return { ok: false, error: 'Name the group.' }

  const invalid = validate({ target: { kind: 'group' }, ...input, caption })
  if (invalid) return { ok: false, error: invalid }

  const members = await Promise.all(memberIds.map((id) => getQuickKey(siteId, id)))
  if (members.some((m) => !m)) return { ok: false, error: 'One of those keys no longer exists.' }
  if (members.some((m) => m!.kind === 'group')) {
    return { ok: false, error: 'A group cannot go inside another group.' }
  }

  await siteTransaction(siteId, async (tx) => {
    const [maxRows] = await tx.query(
      `SELECT COALESCE(MAX(position), -1) AS p FROM pos_quick_keys
        WHERE section = ? AND parent_id IS NULL FOR UPDATE`,
      [section],
    )
    const next = Number((maxRows as Row[])[0]?.p ?? -1) + 1

    const [res] = await tx.execute(
      `INSERT INTO pos_quick_keys
         (parent_id, section, kind, caption, icon, colour_token, position, sig)
       VALUES (NULL,?, 'group', ?,?,?,?,?)`,
      [
        section,
        caption.slice(0, 60),
        (input.icon ?? '').slice(0, 40),
        input.colourToken ?? '',
        next,
        quickKeySig({ kind: 'group' }, caption),
      ] as never,
    )
    const groupId = (res as { insertId: number }).insertId

    /* Members re-positioned from zero inside their new home. Keeping their old
       positions would leave a group whose first key sits at index 7. */
    for (const [index, id] of memberIds.entries()) {
      await tx.execute(
        `UPDATE pos_quick_keys SET parent_id = ?, section = ?, position = ? WHERE id = ?`,
        [groupId, section, index, id] as never,
      )
    }

    /* And close the gaps the members left on the bar. Without this a bar of five keys
       whose middle two were grouped reads 0,1,4,5 — which draws correctly and then makes
       every later "insert at index 2" land somewhere unexpected. */
    await renumberScope(tx, section, null)
  })

  return { ok: true, keys: await listAllQuickKeys(siteId) }
}

/**
 * Moves a key: into a group, out to the bar, or to a different slot.
 *
 * Renumbers the whole destination scope afterwards, so positions stay 0..n-1 with no
 * gaps. A gap is harmless to render and poisonous to reason about — "insert at 3" stops
 * meaning anything once 3 is missing.
 */
export async function moveQuickKey(
  siteId: number,
  id: number,
  destination: { parentId: number | null; index: number; section?: QuickKeySection },
): Promise<SaveResult> {
  const key = await getQuickKey(siteId, id)
  if (!key) return { ok: false, error: 'That key no longer exists.' }

  /* Which bar the key ends up on. Defaults to the one it is already on, so every
     existing caller — every reorder and every file-into-a-group — behaves exactly as
     before and only a deliberate cross-bar move passes it. */
  const section = destination.section ?? key.section

  if (section !== key.section) {
    const banned = quickKeyAllowedOnSection(key, section)
    if (banned) return { ok: false, error: banned }

    /* A GROUP carries its members across, so a folder holding a banned key would
       smuggle it onto a bar it may not be on. Named, because "that group cannot go
       there" leaves a manager opening folders to find out which key is the problem. */
    if (key.kind === 'group') {
      const members = await siteQuery<Row>(
        siteId,
        `SELECT kind, action_slug FROM pos_quick_keys WHERE parent_id = ?`,
        [id],
      )
      for (const m of members) {
        const memberBanned = quickKeyAllowedOnSection(
          { kind: String(m.kind) as QuickKeyKind, actionSlug: String(m.action_slug ?? '') },
          section,
        )
        if (memberBanned) return { ok: false, error: memberBanned }
      }
    }
  }

  if (destination.parentId !== null) {
    if (key.kind === 'group') return { ok: false, error: 'A group cannot go inside another group.' }
    const parent = await getQuickKey(siteId, destination.parentId)
    if (!parent) return { ok: false, error: 'That group no longer exists.' }
    if (parent.kind !== 'group') return { ok: false, error: 'Keys can only go inside a group.' }
    if (parent.id === id) return { ok: false, error: 'A group cannot hold itself.' }
    /* A member's section is DERIVED from its group's — it is the group that sits on a
       bar. Filing into a folder on the other bar therefore moves the key there too,
       so the ban has to be tested against the folder's section, not the asked-for one. */
    const intoBan = quickKeyAllowedOnSection(key, parent.section)
    if (intoBan) return { ok: false, error: intoBan }
  }

  /* Where the key actually lands. Filing into a group means adopting that group's bar,
     whatever the caller asked for — the group is the thing that sits on a bar. */
  const landingSection = destination.parentId !== null
    ? (await getQuickKey(siteId, destination.parentId))!.section
    : section

  await siteTransaction(siteId, async (tx) => {
    await tx.execute(
      `UPDATE pos_quick_keys SET parent_id = ?, section = ? WHERE id = ?`,
      [destination.parentId, landingSection, id] as never,
    )

    /* A group carries its members. Their section is derived from the folder's, so
       moving a folder between bars without this would leave its keys behind on the old
       one — present in the data, drawn on neither bar, since the till reads a section
       and a member whose parent is elsewhere matches no scope. */
    if (key.kind === 'group' && landingSection !== key.section) {
      await tx.execute(`UPDATE pos_quick_keys SET section = ? WHERE parent_id = ?`, [
        landingSection,
        id,
      ] as never)
    }

    // Read the destination scope, drop the moved key, re-insert it at the index, then
    // write every position back. Done as a list rather than with +1/-1 arithmetic
    // because arithmetic on a scope that already has a duplicate makes it worse.
    const [rows] = await tx.query(
      destination.parentId === null
        ? `SELECT id FROM pos_quick_keys WHERE section = ? AND parent_id IS NULL
            ORDER BY position, id FOR UPDATE`
        : `SELECT id FROM pos_quick_keys WHERE section = ? AND parent_id = ?
            ORDER BY position, id FOR UPDATE`,
      destination.parentId === null
        ? [landingSection]
        : [landingSection, destination.parentId],
    )
    const ids = (rows as Row[]).map((r) => Number(r.id)).filter((n) => n !== id)
    const at = Math.max(0, Math.min(destination.index, ids.length))
    ids.splice(at, 0, id)

    for (const [index, memberId] of ids.entries()) {
      await tx.execute(`UPDATE pos_quick_keys SET position = ? WHERE id = ?`, [
        index,
        memberId,
      ] as never)
    }

    /* The scope the key LEFT also has a gap now. Skipped only when it is genuinely the
       same scope — which now means the same bar AND the same parent, since a key can
       move between bars at the same parent level. */
    if (key.parentId !== destination.parentId || key.section !== landingSection) {
      await renumberScope(tx, key.section, key.parentId)
    }
  })

  return { ok: true, keys: await listAllQuickKeys(siteId) }
}

export async function updateQuickKey(
  siteId: number,
  id: number,
  input: { caption?: string; icon?: string; colourToken?: string; requireAuth?: boolean; isHidden?: boolean },
): Promise<SaveResult> {
  const key = await getQuickKey(siteId, id)
  if (!key) return { ok: false, error: 'That key no longer exists.' }

  if ((input.caption ?? '').length > 60) return { ok: false, error: 'A caption must be 60 characters or fewer.' }
  /*
   * Only a GROUP may be named. Every other key reads what it points at — the action's
   * label, the product's description, the department's name — so a stored caption would
   * be a key saying something other than what it does, which is the support call this
   * rule exists to prevent. The designer hides the field; this is the boundary.
   *
   * Compared against the CURRENT caption rather than refused outright, so an update
   * that merely passes the existing value through (a colour change sent with the whole
   * form) is not rejected.
   */
  if (
    input.caption !== undefined &&
    key.kind !== 'group' &&
    input.caption.trim() !== key.caption
  ) {
    return { ok: false, error: 'Only a group can be renamed. A key reads the name of what it points at.' }
  }
  if (input.colourToken !== undefined && !VALID_TOKENS.has(input.colourToken)) {
    return { ok: false, error: 'That is not a colour from the palette.' }
  }
  /* Same reasoning as the colour token: a name outside the offered set would render as
     nothing on the till, and an invented one stored today is a blank key tomorrow. The
     empty string is allowed and means "no icon chosen". */
  if (input.icon !== undefined && input.icon !== '' && !QUICK_KEY_ICON_NAMES.has(input.icon)) {
    return { ok: false, error: 'That is not an icon a key can use.' }
  }

  const caption = input.caption !== undefined ? input.caption.trim() : key.caption

  /* Renaming a GROUP changes its signature, because a folder is identified by nothing
     else. Left stale, two folders could end up sharing one signature and uq_slot would
     refuse an unrelated edit later, in a place nobody would connect to a rename. */
  const sig = key.kind === 'group' ? quickKeySig({ kind: 'group' }, caption) : key.sig

  await siteExecute(
    siteId,
    `UPDATE pos_quick_keys
        SET caption = ?, icon = ?, colour_token = ?, require_auth = ?, is_hidden = ?, sig = ?
      WHERE id = ?`,
    [
      caption.slice(0, 60),
      (input.icon !== undefined ? input.icon : key.icon).slice(0, 40),
      input.colourToken !== undefined ? input.colourToken : key.colourToken,
      (input.requireAuth !== undefined ? input.requireAuth : key.requireAuth) ? 1 : 0,
      (input.isHidden !== undefined ? input.isHidden : key.isHidden) ? 1 : 0,
      sig,
      id,
    ],
  )

  return { ok: true, keys: await listAllQuickKeys(siteId) }
}

/**
 * Deletes a key, or a group WITHOUT its members.
 *
 * ⚠ The FK is `ON DELETE CASCADE`, which would take the members with it. That is the
 * one place the schema and the intended behaviour disagree, and the reason is that
 * cascade is the right backstop for a row removed any other way while promotion is the
 * right answer for a person pressing Delete on a folder — they are tidying the bar, not
 * throwing away six keys they spent ten minutes arranging.
 *
 * So the members are re-parented to NULL FIRST, in the same transaction. Reverse that
 * order and the cascade eats them.
 */
export async function deleteQuickKey(siteId: number, id: number): Promise<SaveResult> {
  const key = await getQuickKey(siteId, id)
  if (!key) return { ok: false, error: 'That key no longer exists.' }

  if (key.kind === 'group' && key.sig === SUPERVISOR_GROUP_SIG) {
    return { ok: false, error: 'The supervisor group cannot be removed.' }
  }

  await siteTransaction(siteId, async (tx) => {
    if (key.kind === 'group') {
      // BEFORE the delete. See the note above.
      const [rows] = await tx.query(
        `SELECT id FROM pos_quick_keys WHERE parent_id = ? ORDER BY position, id`,
        [id],
      )
      const [maxRows] = await tx.query(
        `SELECT COALESCE(MAX(position), -1) AS p FROM pos_quick_keys
          WHERE section = ? AND parent_id IS NULL FOR UPDATE`,
        [key.section],
      )
      let next = Number((maxRows as Row[])[0]?.p ?? -1) + 1
      for (const row of rows as Row[]) {
        await tx.execute(
          `UPDATE pos_quick_keys SET parent_id = NULL, position = ? WHERE id = ?`,
          [next++, Number(row.id)] as never,
        )
      }
    }
    await tx.execute(`DELETE FROM pos_quick_keys WHERE id = ?`, [id] as never)

    /* The deleted key left a gap in its own scope. Renumbering the bar also settles the
       promoted members, which were appended at the end above. */
    await renumberScope(tx, key.section, key.parentId)
    if (key.parentId !== null) await renumberScope(tx, key.section, null)
  })

  return { ok: true, keys: await listAllQuickKeys(siteId) }
}

/**
 * The supervisor group, created if a shop has none.
 *
 * Every till gets one, so the keys a manager has to authorise have an obvious home
 * rather than being scattered through the bar. Idempotent by signature, so calling it
 * on every designer load is free.
 */
export async function ensureSupervisorGroup(siteId: number): Promise<number> {
  const existing = await siteQueryOne<Row>(
    siteId,
    `SELECT id FROM pos_quick_keys WHERE section = 'main' AND sig = ? LIMIT 1`,
    [SUPERVISOR_GROUP_SIG],
  )
  if (existing) return Number(existing.id)

  const result = await siteExecute(
    siteId,
    `INSERT INTO pos_quick_keys
       (parent_id, section, kind, caption, icon, colour_token, position, sig)
     VALUES (NULL, 'main', 'group', 'Supervisor', 'ShieldCheck', 'tile-4',
             (SELECT COALESCE(MAX(p.position), -1) + 1 FROM pos_quick_keys p
               WHERE p.section = 'main' AND p.parent_id IS NULL), ?)`,
    [SUPERVISOR_GROUP_SIG],
  )
  return result.insertId
}

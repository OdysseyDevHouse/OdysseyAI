'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import {
  listAllQuickKeys,
  createQuickKey,
  createQuickKeyGroup,
  moveQuickKey,
  updateQuickKey,
  deleteQuickKey,
  ensureSupervisorGroup,
  type SaveResult,
} from '@/lib/site/quickKeys'
import {
  actionForSlug,
  quickKeyAllowedOnTill,
  quickKeySig,
  SUPERVISOR_GROUP_SIG,
  type QuickKeySection,
  type QuickKeyTarget,
} from '@/lib/quickKeys'
import { listTerminals } from '@/lib/site/terminals'
import { browseForTill, type TillProduct } from '@/lib/site/tillSearch'
import { listPriceStructures } from '@/lib/site/lookups'
import { STARTER_TEMPLATES } from './templates'

/**
 * The quick-key designer's actions.
 *
 * ── EVERY ONE RETURNS THE WHOLE FRESH LIST ────────────────────────────────
 *
 * Not the changed key, and not "ok". Positions are renumbered server-side on every
 * move, group and delete — so a canvas that applied its own guess at the new order
 * would drift from what the till is about to draw, and the drift would only show up
 * after a reload. Replacing the state wholesale costs one small payload and removes a
 * whole class of "the designer and the till disagree" bug.
 *
 * ── GUARDED ON setup.edit, ONE CAPABILITY THROUGHOUT ──────────────────────
 *
 * Arranging till buttons is configuration, like tender types and terminals beside it.
 * Not `sales.till`: a cashier who may USE the keys has no business rearranging them,
 * and the person who does this is the same person who set the shop up.
 *
 * The guard is the real boundary. A server action is a public endpoint, so hiding the
 * screen changes what is easy rather than what is possible.
 *
 * ── AND NOTHING HERE IS WRITTEN TO THE ACTIVITY LOG ───────────────────────
 *
 * Matching every other setup screen. `activity_log` is about what people did to master
 * data and to money — who changed a price, who put a customer on hold — and its
 * `entity` list has no member that a till button honestly belongs to. Arranging keys is
 * also a rapid, exploratory act: a shop lays out its bar with twenty drags in a minute,
 * and twenty "moved a key" rows would bury the entries somebody actually needs to find.
 *
 * The arrangement IS its own record — the keys are right there on the screen. If this
 * ever needs a trail, the honest fix is a `setup` entity on ActivityEntity rather than
 * borrowing one that means something else.
 */

export type QuickKeysResult = SaveResult

export async function listQuickKeysAction(): Promise<QuickKeysResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  /* Created on read rather than by a migration seed, because a shop that has never
     opened this screen has no keys at all and the folder would be the only thing on an
     otherwise empty canvas. Idempotent, so calling it on every load is free. */
  await ensureSupervisorGroup(siteId)
  return { ok: true, keys: await listAllQuickKeys(siteId) }
}

export async function createQuickKeyAction(input: {
  section?: QuickKeySection
  parentId?: number | null
  target: QuickKeyTarget
  caption?: string
  icon?: string
  colourToken?: string
  requireAuth?: boolean
}): Promise<QuickKeysResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  /* Whether this shop can use the action at all. Checked here rather than in
     `createQuickKey` because it depends on the TILLS, and threading the mode down
     into the data layer would make every caller fetch it — including the till, which
     already knows. The designer hides these rows; this is the boundary.

     "Any till runs tables" rather than "this shop is hospitality": the mode is
     per register now, and a key is arranged once for whichever tills show that
     bar. Refusing a table action because the FIRST till happens to be retail
     would block a merchant whose restaurant counter is register four. */
  if (input.target.kind === 'action') {
    const terminals = await listTerminals(siteId, false)
    const hospitality = terminals.some((t) => t.posMode === 'hospitality')
    const wrongTill = quickKeyAllowedOnTill(
      { kind: 'action', actionSlug: input.target.actionSlug },
      hospitality,
    )
    if (wrongTill) return { ok: false, error: wrongTill }
  }

  const result = await createQuickKey(siteId, input)
  if (!result.ok) return result


  revalidatePath('/setup/quick-keys')
  return result
}

export async function createQuickKeyGroupAction(
  input: { section?: QuickKeySection; caption: string; icon?: string; colourToken?: string },
  memberIds: number[],
): Promise<QuickKeysResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const result = await createQuickKeyGroup(siteId, input, memberIds)
  if (!result.ok) return result


  revalidatePath('/setup/quick-keys')
  return result
}

export async function moveQuickKeyAction(
  id: number,
  /* `section` is optional and means "move it to this bar". Omitted — which is every
     reorder and every file-into-a-group — the key stays on the bar it is already on. */
  destination: { parentId: number | null; index: number; section?: QuickKeySection },
): Promise<QuickKeysResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const result = await moveQuickKey(siteId, id, destination)
  if (result.ok) revalidatePath('/setup/quick-keys')
  return result
}

export async function updateQuickKeyAction(
  id: number,
  input: {
    caption?: string
    icon?: string
    colourToken?: string
    requireAuth?: boolean
    isHidden?: boolean
  },
): Promise<QuickKeysResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const result = await updateQuickKey(siteId, id, input)
  if (!result.ok) return result


  revalidatePath('/setup/quick-keys')
  return result
}

/**
 * The same change, to several keys at once.
 *
 * ── ONE ROUND TRIP, NOT ONE PER KEY ───────────────────────────────────────
 *
 * The client could loop `updateQuickKeyAction`, and the first version of this screen
 * would have. It is wrong for two reasons: every call returns the WHOLE key list, so
 * ten selected keys means ten full payloads of which nine are thrown away; and the
 * calls would have to be sequential — fired in parallel they race, each replying with
 * a snapshot that does not include the others' writes, and the last one home wins.
 *
 * Applied in order, stopping at the first refusal. A partial apply is reported as
 * such rather than rolled back: the keys that changed HAVE changed, and telling a
 * manager "nothing happened" when six of ten moved would be a lie they discover later.
 */
export async function bulkUpdateQuickKeysAction(
  ids: number[],
  changes: { colourToken?: string; requireAuth?: boolean; isHidden?: boolean },
): Promise<QuickKeysResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  for (const id of ids) {
    const result = await updateQuickKey(siteId, id, changes)
    if (!result.ok) return result
  }

  revalidatePath('/setup/quick-keys')
  return { ok: true, keys: await listAllQuickKeys(siteId) }
}

/**
 * Files several keys into one group, or takes several out onto the bar.
 *
 * Each lands at the END of the destination rather than at a chosen index — a bulk move
 * has no single insertion point to speak of, and asking for one per key would be the
 * drag gesture again with extra steps.
 */
export async function bulkMoveQuickKeysAction(
  ids: number[],
  parentId: number | null,
): Promise<QuickKeysResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  for (const id of ids) {
    /* A large index is clamped server-side to the end of the scope, which is exactly
       what "put it last" means — and it stays correct as the scope grows under the
       loop, which a pre-computed index would not. */
    const result = await moveQuickKey(siteId, id, { parentId, index: Number.MAX_SAFE_INTEGER })
    if (!result.ok) return result
  }

  revalidatePath('/setup/quick-keys')
  return { ok: true, keys: await listAllQuickKeys(siteId) }
}

export async function bulkDeleteQuickKeysAction(ids: number[]): Promise<QuickKeysResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  for (const id of ids) {
    const result = await deleteQuickKey(siteId, id)
    if (!result.ok) return result
  }

  revalidatePath('/setup/quick-keys')
  return { ok: true, keys: await listAllQuickKeys(siteId) }
}

/**
 * Lays a starter set down on an empty till.
 *
 * ── REFUSED ON A TILL THAT ALREADY HAS KEYS ───────────────────────────────
 *
 * Guarded server-side rather than only by hiding the button. A template is additive —
 * it creates rows, it does not replace them — so running it over an arranged bar would
 * silently append a dozen keys among a shop's own and leave them to work out which
 * were theirs. The empty test is the whole safety of this action.
 *
 * The supervisor group is ADOPTED, not duplicated: `ensureSupervisorGroup` has already
 * put `g:supervisor` on the bar, and the template's group carries the same caption, so
 * its signature matches the row that is already there.
 *
 * Keys are created one at a time, in order, because `position` is MAX+1 per scope — the
 * order they are written IS the order they appear.
 */
export async function applyQuickKeyTemplateAction(
  templateKey: string,
): Promise<QuickKeysResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const template = STARTER_TEMPLATES.find((t) => t.key === templateKey)
  if (!template) return { ok: false, error: 'That is not a starter set.' }

  const existing = await listAllQuickKeys(siteId)
  /* The supervisor folder does not count as "already set up" — every till has one from
     the moment this screen first loaded, so counting it would mean no shop could ever
     apply a starter. */
  const real = existing.filter((k) => k.sig !== SUPERVISOR_GROUP_SIG)
  if (real.length > 0) {
    return {
      ok: false,
      error: 'This till already has keys on it. A starter set is only for an empty one.',
    }
  }

  /* Groups first, so a key naming one has somewhere to go. Adopted by signature where
     the folder already exists. */
  const groupIds = new Map<string, number>()
  for (const group of template.groups) {
    const already = existing.find((k) => k.sig === quickKeySig({ kind: 'group' }, group.caption))
    if (already) {
      groupIds.set(group.caption, already.id)
      continue
    }
    const made = await createQuickKeyGroup(
      siteId,
      {
        section: group.section,
        caption: group.caption,
        icon: group.icon,
        colourToken: group.colourToken,
      },
      [],
    )
    if (!made.ok) return made
    const found = made.keys.find((k) => k.sig === quickKeySig({ kind: 'group' }, group.caption))
    if (found) groupIds.set(group.caption, found.id)
  }

  for (const key of template.keys) {
    const parentId = key.group ? (groupIds.get(key.group) ?? null) : null
    /* A key inside a group takes the GROUP's bar — the group is the thing on a bar, and
       a member whose section disagreed with its parent's would be drawn on neither. */
    const section = key.group
      ? (template.groups.find((g) => g.caption === key.group)?.section ?? key.section)
      : key.section

    const result = await createQuickKey(siteId, {
      section,
      parentId,
      target: { kind: 'action', actionSlug: key.action },
      icon: actionForSlug(key.action)?.icon ?? '',
      colourToken: key.colourToken ?? 'tile-1',
    })
    if (!result.ok) return result
  }

  revalidatePath('/setup/quick-keys')
  return { ok: true, keys: await listAllQuickKeys(siteId) }
}

export async function deleteQuickKeyAction(id: number): Promise<QuickKeysResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const result = await deleteQuickKey(siteId, id)
  if (!result.ok) return result


  revalidatePath('/setup/quick-keys')
  return result
}


/**
 * The catalogue behind the library's Products and Depts tabs.
 *
 * ── WHY THIS IS NOT `browseProductsAction` ────────────────────────────────
 *
 * The till's own browse action is guarded by `sales.till`, and the person arranging a
 * bar is not necessarily the person who rings up sales — capabilities are set per role,
 * so a shop can perfectly well have a manager with `setup.edit` and no till rights. That
 * manager could open this screen and find the Products tab throwing on every keystroke.
 *
 * So the designer browses under its OWN capability. It is the same `browseForTill`
 * underneath, which is the part that matters: the tiles here and the tiles on the till
 * come from one query, so a department that looks empty in the designer is empty on the
 * till too.
 *
 * ── THE PRICE IS THE SHOP'S DEFAULT STRUCTURE ─────────────────────────────
 *
 * Resolved here rather than passed in. A price structure is a property of a TILL —
 * which register is selling at which list — and a manager laying out keys is at none,
 * so there is nothing for the client to send. The default structure is the shelf price,
 * which is the figure a manager recognises a product by.
 *
 * It must be resolved rather than left null: `browseForTill` reads a structure id
 * straight into its price join and coalesces a miss to zero, so passing null prices the
 * entire grid at R0.00 — tiles that look like a broken product file rather than like a
 * catalogue. The location is left null on purpose, which counts the main pile; the tile
 * shows no stock figure, so there is nothing for a room to change.
 *
 * None of it decides anything downstream. A key stores a product id and nothing else,
 * so what this tile shows never affects what the till later charges.
 */
export async function browseCatalogueAction(options: {
  term?: string
  departmentId?: number | null
  limit?: number
}): Promise<TillProduct[]> {
  const ctx = await actorFor('setup.edit')
  // An empty grid rather than a throw: this feeds a tile grid on every keystroke, and
  // the screen behind it has already been guarded. Nothing here is a write.
  if ('ok' in ctx) return []

  /* The same fallback chain the till's page uses — the flagged default, else the first
     structure, else nothing. One rule in two places rather than two rules. */
  const structures = await listPriceStructures(ctx.siteId)
  const priceStructureId = (structures.find((s) => s.isDefault) ?? structures[0])?.id ?? null

  return browseForTill(ctx.siteId, {
    ...options,
    priceStructureId,
    limit: options.limit ?? 60,
  })
}

'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import {
  createGroup,
  deleteGroup,
  getGroup,
  listGroups,
  listOptions,
  replaceOptions,
  updateGroup,
  type GroupInput,
  type InstructionGroup,
  type InstructionOption,
  type OptionInput,
} from '@/lib/site/instructions'

/**
 * The instruction library, edited from inside the product screen.
 *
 * ── WHY THESE EXIST BESIDE instructions/actions.ts ────────────────────────
 *
 * That file's `saveInstructionAction` is a form action: it takes FormData and
 * ends in a `redirect`. Both are right for the full-page editor and wrong here.
 * A product being edited has unsaved work in thirty fields, and a redirect —
 * or the navigation to /instructions that used to be the only way to reach
 * this — throws all of it away to add one answer to one question.
 *
 * So these take plain arguments, save, and return the refreshed library to the
 * caller. Nothing navigates and nothing on the product form is touched.
 *
 * `products.edit` throughout, matching the full editor: the library is shared
 * across every product, so editing it from a corner of one product screen must
 * not be an easier right to hold than editing it from its own page.
 */

export type LibraryResult = { ok: true; groups: InstructionGroup[] } | { ok: false; error: string }

export type GroupResult =
  | { ok: true; group: InstructionGroup; options: InstructionOption[] }
  | { ok: false; error: string }

export type SaveResult =
  | { ok: true; id: number; groups: InstructionGroup[] }
  | { ok: false; error: string }

/** Inactive included: managing the library means seeing what is switched off. */
export async function loadInstructionLibraryAction(): Promise<LibraryResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx
  return { ok: true, groups: await listGroups(ctx.siteId, true) }
}

/**
 * One group with every one of its answers, including the fields the dialog does
 * not show.
 *
 * The dialog edits a name, a price and a default, but `replaceOptions` writes
 * the whole set — so anything it did not load, it would erase. The stock link,
 * the picture, the kitchen and receipt flags and the follow-on questions all
 * come back here and go straight back out on save, untouched.
 */
export async function loadInstructionGroupAction(id: number): Promise<GroupResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx

  const group = await getGroup(ctx.siteId, id)
  if (!group) return { ok: false, error: 'That instruction no longer exists.' }

  return { ok: true, group, options: await listOptions(ctx.siteId, id, true) }
}

export async function saveInstructionGroupAction(
  id: number | null,
  group: GroupInput,
  options: (OptionInput & { id?: number })[],
): Promise<SaveResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const saved = id ? await updateGroup(siteId, id, group) : await createGroup(siteId, group)
  if (!saved.ok) return saved

  const written = await replaceOptions(siteId, saved.id, options)
  if (!written.ok) return written

  // The library's own screen caches; the product screen is force-dynamic and
  // reads the fresh list on its next load either way.
  revalidatePath('/instructions')

  return { ok: true, id: saved.id, groups: await listGroups(siteId, true) }
}

/**
 * Deletes a group. `deleteGroup` refuses while products still ask it or while
 * another answer reveals it, and its refusal is the message shown — it names
 * the count, which is what tells the user what to detach first.
 */
export async function deleteInstructionGroupAction(id: number): Promise<LibraryResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx

  const result = await deleteGroup(ctx.siteId, id)
  if (!result.ok) return result

  revalidatePath('/instructions')

  return { ok: true, groups: await listGroups(ctx.siteId, true) }
}

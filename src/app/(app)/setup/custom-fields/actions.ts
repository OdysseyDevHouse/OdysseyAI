'use server'

import { requireCapability } from '@/lib/auth'
import {
  saveFieldDef,
  deleteFieldDef,
  moveFieldDef,
  type FieldResult,
  type FieldActionResult,
} from '@/lib/site/customFields'
import type { FieldDefInput } from '@/lib/customFieldModel'

/**
 * The real boundary.
 *
 * A server action is a public HTTP endpoint — the page's guard protected the
 * page, not this. So every action re-checks the capability itself, which is the
 * house rule and the reason a hidden menu entry is not a permission.
 */
export async function saveFieldAction(
  input: FieldDefInput & { id: number | null },
): Promise<FieldResult> {
  const { siteId, actor } = await requireCapability('setup.edit')
  return saveFieldDef(siteId, actor, input)
}

export async function deleteFieldAction(id: number): Promise<FieldActionResult> {
  const { siteId, actor } = await requireCapability('setup.edit')
  return deleteFieldDef(siteId, actor, id)
}

export async function moveFieldAction(
  id: number,
  direction: 'up' | 'down',
): Promise<FieldActionResult> {
  const { siteId, actor } = await requireCapability('setup.edit')
  return moveFieldDef(siteId, actor, id, direction)
}

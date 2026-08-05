'use server'

import { requireSiteId } from '@/lib/auth'
import {
  createLocation,
  updateLocation,
  deleteLocation,
  setMainLocation,
  type LocationInput,
} from '@/lib/site/stockLocations'
import { revalidatePath } from 'next/cache'

export type LocationActionResult = { ok: true; message: string } | { ok: false; error: string }

/**
 * Every action revalidates the product pages as well as this screen.
 *
 * A location is a column on every product's stock breakdown, so renaming one
 * or making it main changes what those pages render — leaving them cached
 * would show a location that no longer exists under that name.
 */
function revalidateLocations() {
  revalidatePath('/setup/locations')
  revalidatePath('/products')
}

export async function saveLocationAction(
  id: number | null,
  input: LocationInput,
): Promise<LocationActionResult> {
  const siteId = await requireSiteId()
  const result = id ? await updateLocation(siteId, id, input) : await createLocation(siteId, input)
  if (!result.ok) return { ok: false, error: result.error }

  revalidateLocations()
  return { ok: true, message: id ? 'Location updated.' : 'Location added.' }
}

export async function deleteLocationAction(id: number): Promise<LocationActionResult> {
  const siteId = await requireSiteId()
  const result = await deleteLocation(siteId, id)
  if (!result.ok) return { ok: false, error: result.error }

  revalidateLocations()
  return { ok: true, message: 'Location removed.' }
}

/**
 * Moves "main" to another location.
 *
 * Deliberately does not move stock: naming a different room as the sales
 * source does not carry the goods there. The message says so, because the
 * quantity on the till changes the moment this is done and the user should
 * know why.
 */
export async function setMainLocationAction(id: number): Promise<LocationActionResult> {
  const siteId = await requireSiteId()
  const result = await setMainLocation(siteId, id)
  if (!result.ok) return { ok: false, error: result.error }

  revalidateLocations()
  return {
    ok: true,
    message: 'Main location changed. Sales now come from it — no stock was moved.',
  }
}

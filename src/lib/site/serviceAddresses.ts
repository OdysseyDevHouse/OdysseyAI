import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { logActivity, type Actor } from './activityLog'

/**
 * Where the work happens, which is not where the invoice goes.
 *
 * ── WHY THIS IS NOT CALLED A SITE ──────────────────────────────────────────
 *
 * The PRD calls a customer work location a "site". In this codebase `siteId` is
 * the TENANT, universally: siteQuery(siteId, ...), scripts/site-migrate.mjs,
 * sql/site/, src/lib/site/, cp2_sites. Every one of 137 domain modules takes it
 * as its first argument, and the defining rule of the schema is that there is no
 * `site_id` column because sites are separate databases.
 *
 * A customer location called a site produces `job_sites.site_id`, and then some
 * future migration author adds a site_id column because the word told them to.
 * That is the same reasoning stockLocations.ts uses to keep LOCATION and STORE
 * apart, and that comment is why nobody has re-broken it in 118 migrations.
 * `location` is taken by stock_locations, `branch` by stores. So this is a
 * service address, and the interface may still say Site where a business does.
 *
 * ── WHY customers KEEPS ITS OWN ADDRESS ────────────────────────────────────
 *
 * customers carries one address (012) and every document snapshots it. That is
 * the BILLING address — a managing agent in Sandton, a head office, a PO box.
 * The work is at a block of flats in Parow. A business with one address never
 * opens this screen, and is_default means a job naming no address still has one.
 */

export type ServiceAddress = {
  id: number
  customerId: number
  customerName: string | null
  locationId: number | null
  locationName: string | null
  code: string | null
  name: string
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  postalCode: string | null
  latitude: number | null
  longitude: number | null
  contactId: number | null
  contactName: string | null
  contactPhone: string | null
  accessNotes: string | null
  note: string | null
  isDefault: boolean
  isActive: boolean
  /** Jobs that have named it. Shown before offering to retire one. */
  jobCount: number
}

export type ServiceAddressInput = {
  id: number | null
  customerId: number
  locationId: number | null
  code: string | null
  name: string
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  postalCode: string | null
  latitude: number | null
  longitude: number | null
  contactId: number | null
  accessNotes: string | null
  note: string | null
  isDefault: boolean
  isActive: boolean
}

export type AddressSaveResult = { ok: true; id: number } | { ok: false; error: string }

type Row = RowDataPacket & Record<string, unknown>

const SELECT_ADDRESS = `
  SELECT a.id, a.customer_id, a.location_id, a.code, a.name,
         a.address_line1, a.address_line2, a.city, a.postal_code,
         a.latitude, a.longitude, a.contact_id, a.access_notes, a.note,
         a.is_default, a.is_active,
         c.name  AS customer_name,
         l.name  AS location_name,
         ct.name AS contact_name,
         ct.phone AS contact_phone,
         (SELECT COUNT(*) FROM job_cards j WHERE j.service_address_id = a.id) AS job_count
    FROM service_addresses a
    JOIN customers c          ON c.id  = a.customer_id
    LEFT JOIN stock_locations l ON l.id = a.location_id
    LEFT JOIN customer_contacts ct ON ct.id = a.contact_id`

/**
 * A number column that may be NULL.
 *
 * The pool sets decimalNumbers false, so a DECIMAL arrives as a string and
 * Number('') is 0 — which would put every address without coordinates on the
 * equator off the coast of Africa. Hence the explicit null check.
 */
function optionalNum(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function mapAddress(row: Row): ServiceAddress {
  return {
    id: Number(row.id),
    customerId: Number(row.customer_id),
    customerName: row.customer_name === null ? null : String(row.customer_name),
    locationId: row.location_id === null ? null : Number(row.location_id),
    locationName: row.location_name === null ? null : String(row.location_name),
    code: row.code === null ? null : String(row.code),
    name: String(row.name),
    addressLine1: row.address_line1 === null ? null : String(row.address_line1),
    addressLine2: row.address_line2 === null ? null : String(row.address_line2),
    city: row.city === null ? null : String(row.city),
    postalCode: row.postal_code === null ? null : String(row.postal_code),
    latitude: optionalNum(row.latitude),
    longitude: optionalNum(row.longitude),
    contactId: row.contact_id === null ? null : Number(row.contact_id),
    contactName: row.contact_name === null ? null : String(row.contact_name),
    contactPhone: row.contact_phone === null ? null : String(row.contact_phone),
    accessNotes: row.access_notes === null ? null : String(row.access_notes),
    note: row.note === null ? null : String(row.note),
    isDefault: Number(row.is_default) === 1,
    isActive: Number(row.is_active) === 1,
    jobCount: Number(row.job_count ?? 0),
  }
}

/** Every address for one customer, default first then alphabetical. */
export async function listServiceAddresses(
  siteId: number,
  customerId: number,
  includeInactive = false,
): Promise<ServiceAddress[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_ADDRESS}
      WHERE a.customer_id = ? ${includeInactive ? '' : 'AND a.is_active = 1'}
      ORDER BY a.is_default DESC, a.name`,
    [customerId],
  )
  return rows.map(mapAddress)
}

export async function getServiceAddress(siteId: number, id: number): Promise<ServiceAddress | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_ADDRESS} WHERE a.id = ?`, [id])
  return row ? mapAddress(row) : null
}

/** The address a new job for this customer should start with, if any. */
export async function defaultServiceAddress(
  siteId: number,
  customerId: number,
): Promise<ServiceAddress | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `${SELECT_ADDRESS}
      WHERE a.customer_id = ? AND a.is_active = 1
      ORDER BY a.is_default DESC, a.name LIMIT 1`,
    [customerId],
  )
  return row ? mapAddress(row) : null
}

/** Pure, so the form refuses the same things for the same reasons. */
export function validateServiceAddress(input: ServiceAddressInput): string | null {
  const name = input.name.trim()
  if (!name) return 'An address needs a name — something a technician would recognise.'
  if (name.length > 160) return 'That name is too long — 160 characters is the limit.'
  if (!input.customerId) return 'An address belongs to a customer.'

  /*
   * Coordinates are checked as a PAIR. One without the other cannot be put on a
   * map, and storing half of one is how a pin ends up in the Gulf of Guinea at
   * 0,0 — which is where every mistake of this kind lands.
   */
  const hasLat = input.latitude !== null
  const hasLng = input.longitude !== null
  if (hasLat !== hasLng) return 'Coordinates need both a latitude and a longitude.'
  if (hasLat && (input.latitude! < -90 || input.latitude! > 90)) {
    return 'That latitude is not on Earth — it must be between -90 and 90.'
  }
  if (hasLng && (input.longitude! < -180 || input.longitude! > 180)) {
    return 'That longitude is not on Earth — it must be between -180 and 180.'
  }

  return null
}

export async function saveServiceAddress(
  siteId: number,
  actor: Actor,
  input: ServiceAddressInput,
): Promise<AddressSaveResult> {
  const refusal = validateServiceAddress(input)
  if (refusal) return { ok: false, error: refusal }

  const name = input.name.trim()

  return siteTransaction(siteId, async (tx) => {
    /*
     * Exactly one default per customer, enforced here rather than by a
     * constraint: a partial unique index is not available, and a customer with no
     * default at all is a legitimate state while the first address is captured.
     * Clearing the others first inside the same transaction is what stops two
     * addresses both claiming it.
     */
    if (input.isDefault) {
      await tx.execute(
        `UPDATE service_addresses SET is_default = 0 WHERE customer_id = ? AND id <> ?`,
        [input.customerId, input.id ?? 0],
      )
    }

    if (input.id === null) {
      const [result] = await tx.execute(
        `INSERT INTO service_addresses
           (customer_id, location_id, code, name, address_line1, address_line2, city,
            postal_code, latitude, longitude, contact_id, access_notes, note,
            is_default, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.customerId,
          input.locationId,
          input.code,
          name,
          input.addressLine1,
          input.addressLine2,
          input.city,
          input.postalCode,
          input.latitude,
          input.longitude,
          input.contactId,
          input.accessNotes,
          input.note,
          input.isDefault ? 1 : 0,
          input.isActive ? 1 : 0,
        ],
      )
      const id = Number((result as { insertId: number }).insertId)
      await logActivity(siteId, actor, {
        entity: 'customer',
        entityId: input.customerId,
        action: 'service_address_added',
        detail: name,
      })
      return { ok: true as const, id }
    }

    await tx.execute(
      `UPDATE service_addresses
          SET location_id = ?, code = ?, name = ?, address_line1 = ?, address_line2 = ?,
              city = ?, postal_code = ?, latitude = ?, longitude = ?, contact_id = ?,
              access_notes = ?, note = ?, is_default = ?, is_active = ?
        WHERE id = ?`,
      [
        input.locationId,
        input.code,
        name,
        input.addressLine1,
        input.addressLine2,
        input.city,
        input.postalCode,
        input.latitude,
        input.longitude,
        input.contactId,
        input.accessNotes,
        input.note,
        input.isDefault ? 1 : 0,
        input.isActive ? 1 : 0,
        input.id,
      ],
    )
    await logActivity(siteId, actor, {
      entity: 'customer',
      entityId: input.customerId,
      action: 'service_address_updated',
      detail: name,
    })
    return { ok: true as const, id: input.id }
  })
}

/**
 * Delete an address, or refuse and suggest retiring it.
 *
 * fk_jcard_address is SET NULL, so deleting one would silently strip the
 * location off historical jobs rather than being refused by the database. That
 * is worse than an error: the job would still exist, saying nothing about where
 * the work happened. So the count is checked here and the user is pointed at
 * is_active instead.
 */
export async function deleteServiceAddress(
  siteId: number,
  actor: Actor,
  id: number,
): Promise<AddressSaveResult> {
  const address = await getServiceAddress(siteId, id)
  if (!address) return { ok: false, error: 'That address no longer exists.' }

  if (address.jobCount > 0) {
    return {
      ok: false,
      error: `${address.jobCount} ${address.jobCount === 1 ? 'job names' : 'jobs name'} this address. Switch it off instead, so those jobs keep saying where the work happened.`,
    }
  }

  await siteExecute(siteId, `DELETE FROM service_addresses WHERE id = ?`, [id])
  await logActivity(siteId, actor, {
    entity: 'customer',
    entityId: address.customerId,
    action: 'service_address_deleted',
    detail: address.name,
  })
  return { ok: true, id }
}

/** One line of address, for a job header or a document. */
export function formatAddress(address: ServiceAddress): string {
  return [address.addressLine1, address.addressLine2, address.city, address.postalCode]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(', ')
}

/**
 * A maps link for a technician who needs to get there.
 *
 * Coordinates when we have them, because a pin is unambiguous and an address
 * typed by somebody on the phone often is not. Falls back to the text.
 */
export function mapsHref(address: ServiceAddress): string | null {
  if (address.latitude !== null && address.longitude !== null) {
    return `https://www.google.com/maps/search/?api=1&query=${address.latitude},${address.longitude}`
  }
  const text = formatAddress(address)
  if (!text) return null
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(text)}`
}

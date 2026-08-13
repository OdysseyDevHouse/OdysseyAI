import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { logActivity, type Actor } from './activityLog'

/**
 * A customer's address book: extra billing addresses and every delivery
 * address. The PRIMARY billing address stays on customers itself — too many
 * readers (PDFs, snapshots, the storefront, imports) for a move to be worth
 * anything — so this module answers the questions the master cannot:
 * "which branch", and "deliver here, invoice head office".
 *
 * Structurally serviceAddresses' sibling; see 132 for why they stay apart.
 */

export type AddressKind = 'billing' | 'delivery'

export type CustomerAddress = {
  id: number
  customerId: number
  kind: AddressKind
  label: string
  line1: string | null
  line2: string | null
  city: string | null
  postalCode: string | null
  province: string | null
  country: string
  notes: string | null
  isDefault: boolean
  isActive: boolean
  sortOrder: number
}

export type CustomerAddressInput = {
  kind: AddressKind
  label: string
  line1?: string | null
  line2?: string | null
  city?: string | null
  postalCode?: string | null
  province?: string | null
  country?: string | null
  notes?: string | null
  isDefault?: boolean
}

type Row = RowDataPacket & Record<string, unknown>

function mapAddress(r: Row): CustomerAddress {
  return {
    id: Number(r.id),
    customerId: Number(r.customer_id),
    kind: String(r.kind) as AddressKind,
    label: String(r.label),
    line1: (r.line1 as string | null) ?? null,
    line2: (r.line2 as string | null) ?? null,
    city: (r.city as string | null) ?? null,
    postalCode: (r.postal_code as string | null) ?? null,
    province: (r.province as string | null) ?? null,
    country: String(r.country ?? 'ZA'),
    notes: (r.notes as string | null) ?? null,
    isDefault: Boolean(r.is_default),
    isActive: Boolean(r.is_active),
    sortOrder: Number(r.sort_order ?? 0),
  }
}

export async function listCustomerAddresses(
  siteId: number,
  customerId: number,
  opts: { kind?: AddressKind; includeInactive?: boolean } = {},
): Promise<CustomerAddress[]> {
  const where = ['customer_id = ?']
  const params: unknown[] = [customerId]
  if (opts.kind) {
    where.push('kind = ?')
    params.push(opts.kind)
  }
  if (!opts.includeInactive) where.push('is_active = 1')

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT * FROM customer_addresses
      WHERE ${where.join(' AND ')}
      ORDER BY kind, is_default DESC, sort_order, label`,
    params,
  )
  return rows.map(mapAddress)
}

export async function getCustomerAddress(
  siteId: number,
  id: number,
): Promise<CustomerAddress | null> {
  const row = await siteQueryOne<Row>(siteId, 'SELECT * FROM customer_addresses WHERE id = ? LIMIT 1', [id])
  return row ? mapAddress(row) : null
}

/**
 * The address a document should offer first, or null when the book has none —
 * the caller then falls back to the customer's own billing columns, which is
 * why "no rows" is an ordinary answer rather than an error.
 */
export async function defaultAddressFor(
  siteId: number,
  customerId: number,
  kind: AddressKind,
): Promise<CustomerAddress | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT * FROM customer_addresses
      WHERE customer_id = ? AND kind = ? AND is_active = 1
      ORDER BY is_default DESC, sort_order, id LIMIT 1`,
    [customerId, kind],
  )
  return row ? mapAddress(row) : null
}

export type SaveAddressResult = { ok: true; id: number } | { ok: false; error: string }

export async function saveCustomerAddress(
  siteId: number,
  actor: Actor,
  customerId: number,
  input: CustomerAddressInput,
  id?: number,
): Promise<SaveAddressResult> {
  if (!input.label?.trim()) return { ok: false, error: 'Give the address a name.' }
  if (input.kind !== 'billing' && input.kind !== 'delivery') {
    return { ok: false, error: 'That address kind is not valid.' }
  }
  const country = (input.country ?? 'ZA').trim().toUpperCase().slice(0, 2) || 'ZA'

  const savedId = await siteTransaction(siteId, async (tx) => {
    // One default per kind, cleared inside the same transaction that sets the
    // new one — the service_addresses rule, because MariaDB cannot express it
    // as a partial unique index.
    if (input.isDefault) {
      await tx.execute(
        'UPDATE customer_addresses SET is_default = 0 WHERE customer_id = ? AND kind = ?',
        [customerId, input.kind] as never,
      )
    }

    const values = [
      input.kind,
      input.label.trim().slice(0, 120),
      input.line1?.trim().slice(0, 190) || null,
      input.line2?.trim().slice(0, 190) || null,
      input.city?.trim().slice(0, 120) || null,
      input.postalCode?.trim().slice(0, 20) || null,
      input.province?.trim().slice(0, 80) || null,
      country,
      input.notes?.trim().slice(0, 400) || null,
      input.isDefault ? 1 : 0,
    ]

    if (id) {
      const [res] = await tx.execute(
        `UPDATE customer_addresses
            SET kind = ?, label = ?, line1 = ?, line2 = ?, city = ?, postal_code = ?,
                province = ?, country = ?, notes = ?, is_default = ?
          WHERE id = ? AND customer_id = ?`,
        [...values, id, customerId] as never,
      )
      if ((res as { affectedRows: number }).affectedRows === 0) {
        throw new Error('That address no longer exists.')
      }
      return id
    }

    const [res] = await tx.execute(
      `INSERT INTO customer_addresses
         (customer_id, kind, label, line1, line2, city, postal_code, province, country, notes, is_default)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [customerId, ...values] as never,
    )
    return (res as { insertId: number }).insertId
  })

  await logActivity(siteId, actor, {
    entity: 'customer',
    entityId: customerId,
    action: id ? 'customer_address_updated' : 'customer_address_added',
    detail: `${input.kind === 'billing' ? 'Billing' : 'Delivery'} address "${input.label.trim()}"`,
  }).catch(() => undefined)

  return { ok: true, id: savedId }
}

export async function deleteCustomerAddress(
  siteId: number,
  actor: Actor,
  customerId: number,
  id: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const address = await getCustomerAddress(siteId, id)
  if (!address || address.customerId !== customerId) {
    return { ok: false, error: 'That address no longer exists.' }
  }

  // A hard delete is safe here: documents snapshot text, never a pointer.
  await siteExecute(siteId, 'DELETE FROM customer_addresses WHERE id = ?', [id])
  await logActivity(siteId, actor, {
    entity: 'customer',
    entityId: customerId,
    action: 'customer_address_deleted',
    detail: `${address.kind === 'billing' ? 'Billing' : 'Delivery'} address "${address.label}" removed`,
  }).catch(() => undefined)
  return { ok: true }
}

/** The one line a document snapshot or a delivery note wants. Pure. */
export function formatAddress(a: {
  line1?: string | null
  line2?: string | null
  city?: string | null
  postalCode?: string | null
  province?: string | null
}): string {
  return [a.line1, a.line2, a.city, a.province, a.postalCode]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(', ')
}

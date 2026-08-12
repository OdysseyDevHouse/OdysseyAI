/**
 * What a file can be attached to, and who may see it.
 *
 * ── WHY THERE IS NO NEW TABLE ────────────────────────────────────────────
 *
 * party_documents was built with a loose (entity, entity_id) pair and no
 * foreign key, and its own header says why: "That is what lets a product or a
 * purchase order gain attachments later without a new table." This is that
 * later. A transaction_documents table would be the same six columns, a second
 * upload path, a second download route and a second place for the orphan-file
 * cleanup to be forgotten.
 *
 * ── WHY THE CAPABILITY IS PART OF THE TARGET ─────────────────────────────
 *
 * A document id is a guessable integer. The download route already refuses to
 * look one up by id alone — it requires the caller to name the entity too, so
 * walking the range returns 404 rather than someone else's paperwork.
 *
 * But "may this person read it" differs per entity: a till operator who can see
 * expenses has no business reading a customer's signed credit application, and
 * a supplier's delivery note is not a customer's right. So each target carries
 * its own read and write capability, and the route derives the check from the
 * entity in the URL rather than assuming one blanket permission.
 *
 * This file is PURE — no `server-only`, no database — so a client panel can
 * import a label without dragging mysql2 into the browser bundle.
 */

export const ATTACHMENT_TARGETS = {
  /* The two that already existed. Unchanged, so every current row keeps
     resolving exactly as it did. */
  customer: {
    label: 'Customer',
    read: 'customers.view',
    write: 'customers.edit',
    href: (id: number) => `/customers/${id}`,
  },
  supplier: {
    label: 'Supplier',
    read: 'suppliers.view',
    write: 'suppliers.edit',
    href: (id: number) => `/suppliers/${id}`,
  },

  /* ── Transactions ──────────────────────────────────────────────────────
     The source document that a record was captured FROM, hung on the record
     it created rather than filed under the party. "The supplier PDF that
     GRV-00412 came from" belongs on GRV-00412; filing it under the supplier
     means finding it later involves scrolling two years of their paperwork. */

  /* Each pair below is the SAME capability the record's own screen checks. An
     attachment must never be more visible than the thing it hangs on — nor
     less, or the paperwork becomes unreachable to the person doing the work. */

  /** The supplier's own invoice, against the GRV keyed from it. */
  grv: {
    label: 'Goods received',
    read: 'purchasing.view',
    write: 'purchasing.edit',
    href: (id: number) => `/purchasing/${id}`,
  },
  /** A quote or order confirmation, against the purchase order. */
  purchase_order: {
    label: 'Purchase order',
    read: 'purchasing.view',
    write: 'purchasing.edit',
    href: (id: number) => `/purchasing/${id}`,
  },
  /** The receipt or bill behind an expense — what an auditor asks for. */
  expense: {
    label: 'Expense',
    read: 'cashbook.view',
    write: 'cashbook.edit',
    href: (id: number) => `/expenses/${id}`,
  },
  /** A remittance advice explaining what an unmatched bank line covers. */
  bank_transaction: {
    label: 'Bank line',
    read: 'cashbook.view',
    write: 'cashbook.edit',
    href: () => `/cashbook`,
  },
  /** A signed delivery note or POD, against the invoice a customer disputes. */
  sales_document: {
    label: 'Sales document',
    read: 'sales.view',
    write: 'sales.edit',
    href: (id: number) => `/sales/invoicing/${id}`,
  },
  /** Correspondence behind a manual ledger correction. */
  journal: {
    label: 'Journal',
    read: 'reports.financial',
    write: 'reports.financial',
    href: (id: number) => `/accounting/journals/${id}`,
  },
  /* Photographs of the fault, the signed-off worksheet, the supplier receipt for
     a part bought on the way. A job card accumulates more paperwork than any
     other record in the app, and most of it arrives from a phone on site — which
     is exactly the case the loose (entity, entity_id) design was built for. */
  job_card: {
    label: 'Job card',
    read: 'jobs.view',
    write: 'jobs.edit',
    href: (id: number) => `/jobs/${id}`,
  },
} as const

export type AttachmentTarget = keyof typeof ATTACHMENT_TARGETS

export const ATTACHMENT_TARGET_KEYS = Object.keys(ATTACHMENT_TARGETS) as AttachmentTarget[]

/**
 * Every capability named above, as a union.
 *
 * The server side asserts this is assignable to permissions.ts' `Capability`
 * (see attachments.ts), so a typo like 'expenses.view' — a capability that
 * does not exist — fails the build rather than silently denying everyone at
 * runtime. That check cannot live here: permissions.ts is `server-only` and
 * this file must stay importable from a client panel.
 */
export type AttachmentCapability =
  (typeof ATTACHMENT_TARGETS)[AttachmentTarget]['read' | 'write']

/**
 * Narrows an untrusted string to a target.
 *
 * Every entry point runs this. The value reaches SQL as a bound parameter, but
 * it also selects a CAPABILITY — so an unvalidated one would let a caller name
 * an entity whose read permission they happen to hold and read rows belonging
 * to one they do not.
 */
export function toAttachmentTarget(value: unknown): AttachmentTarget | null {
  // Object.hasOwn, NOT `in`. The `in` operator walks the prototype chain, so
  // 'constructor', 'toString' and '__proto__' would all report as valid
  // targets — and each would then select a capability and reach SQL as an
  // entity name. Own-properties only.
  return typeof value === 'string' && Object.hasOwn(ATTACHMENT_TARGETS, value)
    ? (value as AttachmentTarget)
    : null
}

export function attachmentLabel(target: AttachmentTarget): string {
  return ATTACHMENT_TARGETS[target].label
}

/** The capability needed to READ attachments on this kind of record. */
export function readCapabilityFor(target: AttachmentTarget): AttachmentCapability {
  return ATTACHMENT_TARGETS[target].read
}

/** The capability needed to ADD or REMOVE them. */
export function writeCapabilityFor(target: AttachmentTarget): AttachmentCapability {
  return ATTACHMENT_TARGETS[target].write
}

/**
 * Is this a party record or a transaction?
 *
 * Used only for wording: a party's files are "documents" (things about the
 * account) while a transaction's are "attachments" (the paperwork it came
 * from). Same table, same plumbing — different sentence on screen.
 */
export function isPartyTarget(target: AttachmentTarget): boolean {
  return target === 'customer' || target === 'supplier'
}

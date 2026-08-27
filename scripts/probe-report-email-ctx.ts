/**
 * The facts behind the report dialog's new Print/Email footer, read straight
 * from the same helpers the action calls.
 *
 * The action itself cannot be imported here (requireCapability needs a request),
 * so this exercises the LOGIC it wraps against real documents, and prints what
 * it saw — an empty list would otherwise pass vacuously.
 *
 *   npx tsx scripts/probe-report-email-ctx.ts
 */
import { siteQuery } from '../src/lib/siteDb'
import { getDocument } from '../src/lib/site/salesDocuments'
import { getCustomer } from '../src/lib/site/customers'
import { lastEmailed } from '../src/lib/site/invoiceEmail'

const SITE = Number(process.env.PROBE_SITE ?? 1)
const PRINTABLE = ['quote', 'sales_order', 'invoice', 'credit_sale']

async function main() {
  const rows = await siteQuery<{ id: number }>(
    SITE,
    `SELECT id FROM sales_documents ORDER BY id DESC LIMIT 12`,
    [],
  )
  console.log(`site ${SITE}: ${rows.length} recent documents`)
  if (rows.length === 0) {
    console.log('**No documents at all — nothing was actually verified.**')
    return
  }

  let printableSeen = 0
  let emailableSeen = 0

  for (const { id } of rows) {
    const doc = await getDocument(SITE, id)
    if (!doc) {
      console.log(`  ${id}: getDocument returned null`)
      continue
    }

    const emailable =
      doc.status === 'finalised' &&
      (doc.docType === 'invoice' || doc.docType === 'credit_sale')

    const printable = PRINTABLE.includes(doc.docType)
    if (printable) printableSeen++

    let defaultTo = ''
    let note: string | null = null
    if (emailable) {
      emailableSeen++
      const [cust, last] = await Promise.all([
        doc.customerId ? getCustomer(SITE, doc.customerId) : Promise.resolve(null),
        lastEmailed(SITE, id),
      ])
      defaultTo = cust?.email ?? ''
      note = last ? `${last.detail ?? ''} · ${last.userName}` : null
    }

    console.log(
      `  ${String(doc.documentNumber ?? id).padEnd(20)} ${doc.docType.padEnd(12)} ${doc.status.padEnd(10)}` +
        ` print=${printable ? 'yes' : 'NO '} email=${emailable ? 'yes' : 'no '}` +
        ` to=${defaultTo || '(none)'}${note ? ` last=${note}` : ''}`,
    )
  }

  console.log(`\nprintable: ${printableSeen}/${rows.length}   emailable: ${emailableSeen}/${rows.length}`)
  if (printableSeen !== rows.length) {
    console.log('**FAIL** a document the dialog can show is not printable — Print would 404 in the new tab')
  } else {
    console.log('PASS  every document the dialog can show is printable')
  }
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

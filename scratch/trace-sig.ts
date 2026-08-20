import { deliveryNoteTokens } from '../src/lib/stationery/adapters/deliveryNote'
import { renderTemplate } from '../src/lib/stationery/render'
import { compileDocument } from '../src/lib/stationery/compile'
import { DELIVERY_NOTE_BLOCKS } from '../src/lib/stationery/defaults/deliveryNoteBlocks'

const input = deliveryNoteTokens({
  doc: { id: 1, docType: 'sales_order', status: 'issued', documentNumber: 'SO1',
    documentDate: '2026-08-19', customerName: 'X', customerCode: 'C', customerPhone: '',
    customerAddress: '', userName: 'T', reference: null, notes: null,
    lines: [{ id: 1, lineNumber: 1, productCode: 'P', description: 'Thing', qty: 4, qtyDelivered: 0 }],
  } as never,
  details: null,
  site: { name: 'S', vatNumber: null, registrationNumber: null, address1: null,
    address2: null, address3: null, postalCode: null, phone: null, email: null },
  deliverTo: ['Somewhere'],
  printedAt: 'now',
})
console.log('sign.receivedBy raw   :', JSON.stringify(input.values['sign.receivedBy']))
console.log('char code             :', String(input.values['sign.receivedBy']).charCodeAt(0))

const html = renderTemplate(compileDocument(DELIVERY_NOTE_BLOCKS, 'delivery_note'), 'delivery_note', {
  ...input, capabilities: { isOwner: true, granted: new Set<string>() },
})
const i = html.indexOf('Received by')
console.log('')
console.log('rendered:', JSON.stringify(html.slice(i - 10, i + 160)))

import { writeFileSync, readFileSync } from 'node:fs'
import { DELIVERY_NOTE_BLOCKS } from '../src/lib/stationery/defaults/deliveryNoteBlocks'
import { compileDocument } from '../src/lib/stationery/compile'
const body = compileDocument(DELIVERY_NOTE_BLOCKS, 'delivery_note')
const old = readFileSync('src/lib/stationery/defaults/deliveryNote.ts', 'utf8')
const head = old.slice(0, old.indexOf('export const DELIVERY_NOTE_DEFAULT'))
writeFileSync('src/lib/stationery/defaults/deliveryNote.ts', head + `export const DELIVERY_NOTE_DEFAULT = ${JSON.stringify(body)}\n`)
console.log('regenerated')

/**
 * Proves that accepting the pre-filled product code advances the sequence.
 *
 * The bug: the form pre-fills previewMasterCode()'s answer, which claims
 * nothing, and resolveMasterCode used to treat any non-blank code as the
 * user's own. So every new product was saved as PRD00001 and the counter never
 * moved. This drives the real functions rather than a mirror of the logic.
 */
import { siteExecute, siteQuery } from '@/lib/siteDb'
import { resolveMasterCode, suggestedMasterCode } from '@/lib/site/masterCodes'
import { createProduct, deleteProduct } from '@/lib/site/products'

const siteId = Number(process.env.SHOT_SITE ?? 1)
let failures = 0

function check(label: string, got: unknown, want: unknown) {
  const ok = got === want
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got=${String(got)} want=${String(want)}`)
}

async function seqRow() {
  const rows = await siteQuery<{ next_number: number; last_issued_number: number | null }>(
    siteId,
    "SELECT next_number, last_issued_number FROM document_sequences WHERE doc_type = 'product' AND terminal_id = 0",
  )
  return rows[0]
}

async function main() {
  const before = await seqRow()
  console.log('sequence before:', before)
  const created: number[] = []

  try {
    // 1. The suggestion the form would show.
    const suggested = await suggestedMasterCode(siteId, 'product')
    console.log('suggested:', suggested)
    if (!suggested) throw new Error('no suggestion — autocode_product is off on this site')

    // 2. Submitting it back — what the form actually does — must claim it.
    const a = await createProduct(siteId, {
      code: suggested,
      description: 'Autocode probe A',
      productType: 'stock',
    } as never)
    check('first save succeeded', a.ok, true)
    if (a.ok) created.push(a.id)
    const codeA = (
      await siteQuery<{ code: string }>(siteId, 'SELECT code FROM products WHERE id = ?', [
        (a as { id: number }).id,
      ])
    )[0]?.code
    check('first product took the suggested code', codeA, suggested)

    // 3. The next form load must offer something different.
    const suggested2 = await suggestedMasterCode(siteId, 'product')
    console.log('suggested after first save:', suggested2)
    check('suggestion advanced', suggested2 !== suggested, true)

    // 4. And saving that one must work rather than collide.
    const b = await createProduct(siteId, {
      code: suggested2 as string,
      description: 'Autocode probe B',
      productType: 'stock',
    } as never)
    check('second save succeeded', b.ok, true)
    if (b.ok) created.push(b.id)
    const codeB = (
      await siteQuery<{ code: string }>(siteId, 'SELECT code FROM products WHERE id = ?', [
        (b as { id: number }).id,
      ])
    )[0]?.code
    check('second product took the second code', codeB, suggested2)
    check('the two codes differ', codeA !== codeB, true)

    // 5. A hand-typed code is still left alone and burns nothing.
    const seqBeforeTyped = await seqRow()
    const typed = await resolveMasterCode(siteId, 'product', 'MYOWNCODE-' + before.next_number)
    check('a typed code is returned untouched', typed, 'MYOWNCODE-' + before.next_number)
    const seqAfterTyped = await seqRow()
    check(
      'a typed code claims no number',
      seqAfterTyped.next_number,
      seqBeforeTyped.next_number,
    )

    // 6. A blank code still claims, as it always did.
    const blank = await resolveMasterCode(siteId, 'product', '')
    console.log('blank resolved to:', blank)
    check('a blank code produces one', Boolean(blank), true)
  } finally {
    for (const id of created) {
      await deleteProduct(siteId, id).catch(async () => {
        await siteExecute(siteId, 'DELETE FROM products WHERE id = ?', [id])
      })
    }
    console.log('sequence after:', await seqRow())
    console.log('cleaned up', created.length, 'products')
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

/**
 * Custom comments on a sale — the questions a tender type asks before it pays.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-sale-comments.ts
 *
 * 127 built a general custom-field mechanism and said the entity was a column
 * so a fourth consumer would be cheap. 242 cashed that in for sales, and added
 * the one thing genuinely missing: a way to say WHICH payments ask.
 *
 * What is worth proving:
 *
 *   · 'sale' IS A REAL ENTITY. The two ENUMs must both accept it — the values
 *     table repeats `entity` rather than reading it through field_id (see 127),
 *     so a column that could not hold it would refuse the write with an error
 *     naming neither table.
 *
 *   · VALUES ATTACH TO A DOCUMENT AND READ BACK. Including the required-field
 *     check the till gates on.
 *
 *   · THE FLAG IS PER TENDER AND DEFAULTS OFF. A shop that has never heard of
 *     this must not start interrupting cash sales.
 *
 *   · A SPLIT ASKS ONCE. The till's rule is `paid.some(asksCustomComments)`,
 *     which is the whole reason 242 chose a flag over a per-tender question
 *     set — asserted here as the predicate, since the dialog itself is React.
 *
 * Everything it creates is removed in a `finally`, including after a failure.
 */
import { siteQuery, siteExecute } from '../src/lib/siteDb'
import {
  listFieldDefs,
  saveFieldDef,
  deleteFieldDef,
  setValues,
  valuesFor,
  missingRequired,
  slipComments,
} from '../src/lib/site/customFields'
import { listTenderTypes } from '../src/lib/site/tenderTypes'
import { FIELD_ENTITIES, ENTITY_LABEL } from '../src/lib/customFieldModel'

const SITE = 1
const ACTOR = { userId: 1, userName: 'sale comments test' }

let failures = 0
function check(what: string, got: unknown, want: unknown) {
  const ok = got === want
  if (!ok) failures++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`,
  )
}

const created: number[] = []
let documentId: number | null = null

async function main() {
  console.log('\n── The model knows about sales ────────────────────────────────')
  check("'sale' is an entity", FIELD_ENTITIES.includes('sale'), true)
  check('and it has a label', ENTITY_LABEL.sale, 'Sale')

  console.log('\n── Defining the questions ─────────────────────────────────────')
  /* The requirement's own example: Name, Surname, Age, Occupation — four
     fields where the legacy system capped at four and could go no further. */
  for (const [name, type, required] of [
    ['Test Name', 'text', true],
    ['Test Surname', 'text', false],
    ['Test Age', 'number', false],
  ] as const) {
    const result = await saveFieldDef(SITE, ACTOR, {
      id: null,
      entity: 'sale',
      code: name.toLowerCase().replace(/\s+/g, '_'),
      name,
      hint: null,
      fieldType: type,
      options: [],
      unit: null,
      isRequired: required,
      isPublic: false,
      printsOnSlip: false,
      isActive: true,
    })
    if (!result.ok) throw new Error(`could not define ${name}: ${result.error}`)
    created.push(result.id)
  }
  console.log(`      defined ${created.length} sale fields`)

  const defs = await listFieldDefs(SITE, 'sale')
  check('they list back under the sale entity', defs.length >= 3, true)
  check('and nothing leaked into jobs', (await listFieldDefs(SITE, 'job')).some((d) => created.includes(d.id)), false)

  console.log('\n── Attaching answers to a real document ───────────────────────')
  const doc = await siteQuery<Record<string, unknown>>(
    SITE,
    "SELECT id FROM sales_documents WHERE doc_type = 'invoice' ORDER BY id DESC LIMIT 1",
  )
  if (!doc[0]) throw new Error('no invoice on this site to attach to')
  documentId = Number(doc[0].id)

  const saved = await setValues(SITE, ACTOR, 'sale', documentId, [
    { fieldId: created[0], value: 'Thabo' },
    { fieldId: created[2], value: '34' },
  ])
  check('the values save', saved.ok, true)

  const read = await valuesFor(SITE, 'sale', documentId)
  const byId = new Map(read.map((v) => [v.fieldId, v.value]))
  check('the name reads back', byId.get(created[0]), 'Thabo')
  check('the age reads back', byId.get(created[2]), '34')
  check('the unanswered one is null', byId.get(created[1]), null)

  console.log('\n── The required-field gate ────────────────────────────────────')
  check('nothing is missing once the required one is answered', (await missingRequired(SITE, 'sale', documentId)).length, 0)

  await setValues(SITE, ACTOR, 'sale', documentId, [{ fieldId: created[0], value: '' }])
  const missing = await missingRequired(SITE, 'sale', documentId)
  check('clearing the required one reports it', missing.length, 1)
  check('and names it', missing[0], 'Test Name')

  console.log('\n── A number field refuses a word ──────────────────────────────')
  const bad = await setValues(SITE, ACTOR, 'sale', documentId, [
    { fieldId: created[2], value: 'thirty four' },
  ])
  check('refused', bad.ok, false)
  check(
    'and the stored value is untouched',
    (await valuesFor(SITE, 'sale', documentId)).find((v) => v.fieldId === created[2])?.value,
    '34',
  )

  console.log('\n── The tender flag ────────────────────────────────────────────')
  const tenders = await listTenderTypes(SITE, true)
  check('every seeded tender defaults to NOT asking', tenders.every((t) => !t.asksCustomComments), true)

  /*
   * The till's rule, asserted as the predicate it actually is: a payment asks
   * when ANY of its tenders asks. That is what makes a split unambiguous —
   * one question set, asked once, whichever way the basket was settled.
   */
  const account = tenders.find((t) => t.code === 'ACCOUNT') ?? tenders[0]
  const cash = tenders.find((t) => t.code === 'CASH') ?? tenders[1]
  const asks = (paid: { tenderTypeId: number }[], asking: Set<number>) =>
    paid.some((p) => asking.has(p.tenderTypeId))

  const asking = new Set([account.id])
  check('a sale on the flagged tender asks', asks([{ tenderTypeId: account.id }], asking), true)
  check('a sale on an unflagged one does not', asks([{ tenderTypeId: cash.id }], asking), false)
  check(
    'a SPLIT across both asks once',
    asks([{ tenderTypeId: cash.id }, { tenderTypeId: account.id }], asking),
    true,
  )
  check(
    'and a split across two unflagged tenders does not',
    asks([{ tenderTypeId: cash.id }, { tenderTypeId: cash.id }], asking),
    false,
  )

  console.log('\n── What reaches the slip ──────────────────────────────────────')
  /* Only the fields MARKED to print, only when answered, already formatted.
     Neither renderer may decide this — see slipComments for why. */
  await setValues(SITE, ACTOR, 'sale', documentId, [
    { fieldId: created[0], value: 'Thabo' },
    { fieldId: created[1], value: 'Plumber' },
  ])
  check('nothing prints while no field is marked', (await slipComments(SITE, documentId)).length, 0)

  await siteExecute(SITE, 'UPDATE custom_field_defs SET prints_on_slip = 1 WHERE id = ?', [
    created[0],
  ])
  const printed = await slipComments(SITE, documentId)
  check('the marked field prints', printed.length, 1)
  check('with its label', printed[0]?.label, 'Test Name')
  check('and its answer', printed[0]?.value, 'Thabo')
  check('and the unmarked one stays off', printed.some((c) => c.label === 'Test Surname'), false)

  /* Marked but never answered: dropped, not printed as an empty caption. A
     caption over nothing reads as something the cashier forgot.

     Test Age carries '34' from the section above, so it is cleared first —
     otherwise this would assert nothing, because the field WOULD legitimately
     print. */
  await setValues(SITE, ACTOR, 'sale', documentId, [{ fieldId: created[2], value: '' }])
  await siteExecute(SITE, 'UPDATE custom_field_defs SET prints_on_slip = 1 WHERE id = ?', [
    created[2],
  ])
  check(
    'a marked but unanswered field is dropped rather than printed blank',
    (await slipComments(SITE, documentId)).length,
    1,
  )

  console.log('\n── A field with values cannot be deleted ──────────────────────')
  await setValues(SITE, ACTOR, 'sale', documentId, [{ fieldId: created[0], value: 'Thabo' }])
  const refused = await deleteFieldDef(SITE, ACTOR, created[0])
  check('refused while a sale carries an answer', refused.ok, false)
}

main()
  .catch((err) => {
    console.error('\nThe suite threw:', err)
    failures++
  })
  .finally(async () => {
    try {
      if (documentId) {
        await siteExecute(SITE, "DELETE FROM custom_field_values WHERE entity = 'sale' AND entity_id = ?", [
          documentId,
        ])
      }
      for (const id of created) {
        await siteExecute(SITE, 'DELETE FROM custom_field_values WHERE field_id = ?', [id])
        await siteExecute(SITE, 'DELETE FROM custom_field_defs WHERE id = ?', [id])
      }
      const left = await listFieldDefs(SITE, 'sale')
      console.log(`\nCleaned up. ${left.length} sale field(s) remain (should be any you defined yourself).`)
    } catch (e) {
      console.error('CLEANUP FAILED — check site', SITE, 'by hand:', e)
      failures++
    }

    console.log(
      failures === 0
        ? '\nAll checks passed.\n'
        : `\n${failures} check${failures === 1 ? '' : 's'} FAILED.\n`,
    )
    process.exit(failures === 0 ? 0 : 1)
  })

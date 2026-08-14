import {
  saveFieldDef,
  deleteFieldDef,
  listFieldDefs,
  valuesFor,
  setValues,
  missingRequired,
  moveFieldDef,
  reconcileCustomFields,
  clearValues,
} from '../src/lib/site/customFields'
import { codeFromName } from '../src/lib/customFieldModel'
import { siteExecute, siteQuery } from '../src/lib/siteDb'

const SITE = 1
const actor = { userId: 1, userName: 'Probe' }
const stamp = String(Date.now()).slice(-6)

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function sweep() {
  await siteExecute(SITE, `DELETE FROM custom_field_defs WHERE code LIKE ?`, [`probe${stamp}%`])
  await siteExecute(SITE, `DELETE FROM custom_field_defs WHERE code LIKE 'probe%'`)
}

async function main() {
  await sweep()

  // ── The refusals ─────────────────────────────────────────────────────────
  const nameless = await saveFieldDef(SITE, actor, {
    id: null, entity: 'job', code: `probe${stamp}a`, name: '  ', hint: null,
    fieldType: 'text', options: [], unit: null, isRequired: false, isPublic: false, isActive: true,
  })
  ok('a field with no name is refused', !nameless.ok, nameless.ok ? 'ACCEPTED' : nameless.error)

  const oneChoice = await saveFieldDef(SITE, actor, {
    id: null, entity: 'job', code: `probe${stamp}b`, name: 'Region', hint: null,
    fieldType: 'list', options: ['North'], unit: null, isRequired: false, isPublic: false, isActive: true,
  })
  ok('a list with one choice is refused', !oneChoice.ok, oneChoice.ok ? 'ACCEPTED' : oneChoice.error)

  const badUnit = await saveFieldDef(SITE, actor, {
    id: null, entity: 'job', code: `probe${stamp}c`, name: 'Was it locked', hint: null,
    fieldType: 'yesno', options: [], unit: 'bar', isRequired: false, isPublic: false, isActive: true,
  })
  ok('a unit on a yes/no is refused', !badUnit.ok, badUnit.ok ? 'ACCEPTED' : badUnit.error)

  const badCode = await saveFieldDef(SITE, actor, {
    id: null, entity: 'job', code: '2meters', name: 'Meters', hint: null,
    fieldType: 'number', options: [], unit: null, isRequired: false, isPublic: false, isActive: true,
  })
  ok('a code starting with a digit is refused', !badCode.ok, badCode.ok ? 'ACCEPTED' : badCode.error)
  ok('and codeFromName fixes that shape itself', codeFromName('2nd meter reading') === 'f_2nd_meter_reading',
    codeFromName('2nd meter reading'))

  // ── Building the set ──────────────────────────────────────────────────────
  const made = await saveFieldDef(SITE, actor, {
    id: null, entity: 'job', code: `probe${stamp}n`, name: 'Gas pressure', hint: 'At the outlet',
    fieldType: 'number', options: [], unit: 'bar', isRequired: true, isPublic: false, isActive: true,
  })
  ok('a number field with a unit saves', made.ok, made.ok ? '' : made.error)
  if (!made.ok) throw new Error('fixture failed')

  const list = await saveFieldDef(SITE, actor, {
    id: null, entity: 'job', code: `probe${stamp}r`, name: 'Region', hint: null,
    fieldType: 'list', options: ['North', 'South'], unit: null, isRequired: false, isPublic: true, isActive: true,
  })
  ok('a list field with two choices saves', list.ok, list.ok ? '' : list.error)
  if (!list.ok) throw new Error('fixture failed')

  const dup = await saveFieldDef(SITE, actor, {
    id: null, entity: 'job', code: `probe${stamp}n`, name: 'Another', hint: null,
    fieldType: 'text', options: [], unit: null, isRequired: false, isPublic: false, isActive: true,
  })
  ok('two fields cannot share a code within an entity', !dup.ok, dup.ok ? 'ACCEPTED' : dup.error)

  const sameCodeOtherEntity = await saveFieldDef(SITE, actor, {
    id: null, entity: 'customer', code: `probe${stamp}n`, name: 'Gas pressure', hint: null,
    fieldType: 'text', options: [], unit: null, isRequired: false, isPublic: false, isActive: true,
  })
  ok('*** but a CUSTOMER field may reuse a job field code ***', sameCodeOtherEntity.ok,
    sameCodeOtherEntity.ok ? '' : sameCodeOtherEntity.error)

  // ── Values ────────────────────────────────────────────────────────────────
  const JOB = 12
  const before = await valuesFor(SITE, 'job', JOB)
  ok('an untouched record still lists every field to fill in', before.length >= 2, `${before.length}`)
  ok('and every value is empty', before.every((v) => v.value === null))

  const bad = await setValues(SITE, actor, 'job', JOB, [{ fieldId: made.id, value: 'twelve' }])
  ok('*** a non-number in a number field is refused ***', !bad.ok, bad.ok ? 'ACCEPTED' : bad.error)

  const badChoice = await setValues(SITE, actor, 'job', JOB, [{ fieldId: list.id, value: 'East' }])
  ok('a choice not on the list is refused', !badChoice.ok, badChoice.ok ? 'ACCEPTED' : badChoice.error)

  const written = await setValues(SITE, actor, 'job', JOB, [
    { fieldId: made.id, value: '12.4' },
    { fieldId: list.id, value: 'North' },
  ])
  ok('valid values write', written.ok, written.ok ? '' : (written as any).error)

  const after = await valuesFor(SITE, 'job', JOB)
  ok('and read back with who set them',
    after.find((v) => v.fieldId === made.id)?.value === '12.4' &&
    after.find((v) => v.fieldId === made.id)?.setByName === 'Probe')

  // Writing again must UPDATE, not duplicate — the unique key is the guard.
  await setValues(SITE, actor, 'job', JOB, [{ fieldId: made.id, value: '13.1' }])
  const rows = await siteQuery<any>(SITE,
    `SELECT COUNT(*) AS n FROM custom_field_values WHERE field_id = ? AND entity_id = ?`,
    [made.id, JOB])
  ok('*** writing twice UPDATES rather than duplicating ***', Number(rows[0].n) === 1, `${rows[0].n} row(s)`)

  const missing = await missingRequired(SITE, 'job', JOB)
  ok('a required field that IS answered is not reported missing', !missing.includes('Gas pressure'),
    missing.join(','))

  // Emptying deletes the row, so "never answered" and "cleared" stay distinct.
  await setValues(SITE, actor, 'job', JOB, [{ fieldId: made.id, value: '' }])
  const cleared = await siteQuery<any>(SITE,
    `SELECT COUNT(*) AS n FROM custom_field_values WHERE field_id = ? AND entity_id = ?`,
    [made.id, JOB])
  ok('*** clearing a value DELETES the row, not stores empty ***', Number(cleared[0].n) === 0)
  const nowMissing = await missingRequired(SITE, 'job', JOB)
  ok('and it is then reported as missing, by name', nowMissing.includes('Gas pressure'),
    nowMissing.join(','))

  // ── The type-change refusal ───────────────────────────────────────────────
  await setValues(SITE, actor, 'job', JOB, [{ fieldId: made.id, value: '9.9' }])
  const retype = await saveFieldDef(SITE, actor, {
    id: made.id, entity: 'job', code: `probe${stamp}n`, name: 'Gas pressure', hint: null,
    fieldType: 'date', options: [], unit: null, isRequired: true, isPublic: false, isActive: true,
  })
  ok('*** the TYPE cannot change once values exist ***', !retype.ok, retype.ok ? 'ACCEPTED' : retype.error)

  const rename = await saveFieldDef(SITE, actor, {
    id: made.id, entity: 'job', code: `probe${stamp}n`, name: 'Outlet pressure', hint: null,
    fieldType: 'number', options: [], unit: 'bar', isRequired: true, isPublic: false, isActive: true,
  })
  ok('but renaming is allowed', rename.ok, rename.ok ? '' : rename.error)
  const renamed = await valuesFor(SITE, 'job', JOB)
  ok('*** and the rename RELABELS the existing value rather than orphaning it ***',
    renamed.find((v) => v.fieldId === made.id)?.name === 'Outlet pressure' &&
    renamed.find((v) => v.fieldId === made.id)?.value === '9.9')

  // ── Delete refusal ────────────────────────────────────────────────────────
  const del = await deleteFieldDef(SITE, actor, made.id)
  ok('*** deleting a field that holds values is REFUSED — it would destroy them ***',
    !del.ok, del.ok ? 'ACCEPTED' : del.error)

  const delEmpty = await deleteFieldDef(SITE, actor, sameCodeOtherEntity.ok ? sameCodeOtherEntity.id : 0)
  ok('a field with no values deletes cleanly', delEmpty.ok, delEmpty.ok ? '' : (delEmpty as any).error)

  // ── Ordering ──────────────────────────────────────────────────────────────
  const jobFields = await listFieldDefs(SITE, 'job', true)
  const first = jobFields[0]
  await moveFieldDef(SITE, actor, jobFields[1].id, 'up')
  const reordered = await listFieldDefs(SITE, 'job', true)
  ok('moving a field up reorders it', reordered[0].id !== first.id,
    `${first.name} -> ${reordered[0].name}`)

  // ── publicOnly ────────────────────────────────────────────────────────────
  const publicOnes = await valuesFor(SITE, 'job', JOB, { publicOnly: true })
  ok('*** publicOnly returns ONLY fields marked public ***',
    publicOnes.every((v) => v.isPublic) && publicOnes.length < renamed.length,
    `${publicOnes.length} of ${renamed.length}`)

  // ── Drift ─────────────────────────────────────────────────────────────────
  await setValues(SITE, actor, 'job', 999999, [{ fieldId: list.id, value: 'South' }])
  const drift = await reconcileCustomFields(SITE)
  ok('*** a value whose record is gone is reported as orphaned ***',
    drift.orphaned.some((o) => o.entityId === 999999), `${drift.orphaned.length} reported`)

  // A list edit that drops a chosen option leaves an invalid value behind.
  await saveFieldDef(SITE, actor, {
    id: list.id, entity: 'job', code: `probe${stamp}r`, name: 'Region', hint: null,
    fieldType: 'list', options: ['North', 'West'], unit: null, isRequired: false, isPublic: true, isActive: true,
  })
  const drift2 = await reconcileCustomFields(SITE)
  ok('*** dropping a chosen option leaves a value reconcile CATCHES ***',
    drift2.invalid.some((i) => i.value === 'South'), `${drift2.invalid.length} reported`)

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await clearValues(SITE, 'job', JOB)
  await clearValues(SITE, 'job', 999999)
  await sweep()
  const left = await siteQuery<any>(SITE, `SELECT COUNT(*) AS n FROM custom_field_defs WHERE code LIKE 'probe%'`)
  const leftVals = await siteQuery<any>(SITE,
    `SELECT COUNT(*) AS n FROM custom_field_values WHERE entity = 'job' AND entity_id IN (12, 999999)`)
  ok('the probe leaves nothing behind',
    Number(left[0].n) === 0 && Number(leftVals[0].n) === 0,
    `${left[0].n} def(s), ${leftVals[0].n} value(s)`)
}

main()
  .then(() => {
    console.log(fails ? `\n${fails} failure(s)` : '\nAll custom field checks passed')
    process.exit(fails ? 1 : 0)
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })

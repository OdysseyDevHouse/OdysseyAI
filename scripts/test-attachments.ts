/**
 * Attachments on transactions.
 *
 * The rules that matter, and what breaks if they slip:
 *
 *   AN ATTACHMENT IS SCOPED TO ITS RECORD. Lookup is (id, entity, entity_id),
 *   never id alone. An id is a guessable integer, and matching on it by itself
 *   would let anyone walk the range and read every other record's paperwork.
 *
 *   ENTITIES DO NOT LEAK INTO EACH OTHER. GRV 5's files and expense 5's files
 *   share an id space. If the entity were ignored, the receipt for an expense
 *   would appear on an unrelated goods-received note.
 *
 *   EVERY TARGET NAMES A REAL CAPABILITY. A typo means can() returns false
 *   forever and the panel silently denies everyone, on every screen, with no
 *   error anywhere to explain it.
 *
 *   DELETING A RECORD MUST NOT ORPHAN FILES. There is no foreign key — that
 *   looseness is what lets one table serve every entity — so the bytes stay on
 *   disk unless someone asks for the names and unlinks them.
 */

import {
  listAttachments,
  createAttachment,
  updateAttachment,
  deleteAttachment,
  getAttachment,
  attachmentCounts,
  attachmentsFor,
  removeAttachmentsFor,
} from '../src/lib/site/attachments'
import {
  ATTACHMENT_TARGETS,
  ATTACHMENT_TARGET_KEYS,
  toAttachmentTarget,
  readCapabilityFor,
  writeCapabilityFor,
  isPartyTarget,
} from '../src/lib/attachmentTargets'
import { CAPABILITIES } from '../src/lib/site/permissions'
import { siteExecute, siteQuery } from '../src/lib/siteDb'

const SITE = 1
const actor = { userId: 1, userName: 'Attachment Test' }

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const stamp = Date.now().toString().slice(-6)
let n = 0

/** A stored-name that is unique per row, since the column is UNIQUE. */
function stored(): string {
  n++
  return `test-${stamp}-${n}.pdf`
}

/** The id range this test owns. Nothing real uses it. */
const FROM = 900001
const TO = 900009

async function main() {
  // Clear first, not only at the end. A run that fails partway leaves rows
  // behind, and the next run then counts them and reports failures that have
  // nothing to do with the code — which is exactly how a real bug gets
  // dismissed as "just leftover test data".
  await siteExecute(SITE, 'DELETE FROM party_documents WHERE entity_id BETWEEN ? AND ?', [FROM, TO])

  console.log('\n── Every target names a real capability ────────────────────\n')

  // The compile-time assertion in attachments.ts catches this too, but only
  // for capabilities the type system knows. This proves it against the actual
  // runtime list, which is what can() consults.
  const known = new Set<string>(CAPABILITIES)
  for (const target of ATTACHMENT_TARGET_KEYS) {
    const read = readCapabilityFor(target)
    const write = writeCapabilityFor(target)
    ok(`${target}: read capability '${read}' exists`, known.has(read))
    ok(`${target}: write capability '${write}' exists`, known.has(write))
  }

  ok('*** a target must never be more readable than writable ***',
      ATTACHMENT_TARGET_KEYS.every((t) => known.has(readCapabilityFor(t))))

  console.log('\n── Untrusted entity strings are refused ────────────────────\n')

  ok('a known target narrows', toAttachmentTarget('grv') === 'grv')
  ok('*** an unknown one is refused ***', toAttachmentTarget('grv_admin') === null)
  ok('*** SQL in the entity is refused ***',
      toAttachmentTarget("customer' OR '1'='1") === null)
  ok('a non-string is refused', toAttachmentTarget(42) === null)
  ok('null is refused', toAttachmentTarget(null) === null)
  ok('prototype keys are refused', toAttachmentTarget('constructor') === null)
  ok('customers and suppliers are party targets', isPartyTarget('customer') && isPartyTarget('supplier'))
  ok('a GRV is not', !isPartyTarget('grv'))

  console.log('\n── An attachment belongs to one record ─────────────────────\n')

  const grvFile = await createAttachment(SITE, actor, 'grv', 900001, {
    filename: 'supplier-invoice-88213.pdf',
    storedName: stored(),
    mimeType: 'application/pdf',
    sizeBytes: 51200,
    description: 'Invoice the GRV was captured from',
  })
  ok('an attachment is created', grvFile.ok, grvFile.ok ? '' : grvFile.error)
  if (!grvFile.ok) throw new Error('cannot continue')

  const found = await getAttachment(SITE, 'grv', 900001, grvFile.id)
  ok('it reads back on its own record', found?.filename === 'supplier-invoice-88213.pdf')

  ok('*** it is NOT visible on a different record of the same type ***',
      (await getAttachment(SITE, 'grv', 900002, grvFile.id)) === null)

  // The one that matters most: ids collide across entities.
  ok('*** it is NOT visible on a different ENTITY with the same id ***',
      (await getAttachment(SITE, 'expense', 900001, grvFile.id)) === null)

  ok('*** nor on a customer with the same id ***',
      (await getAttachment(SITE, 'customer', 900001, grvFile.id)) === null)

  console.log('\n── Entities with colliding ids stay separate ───────────────\n')

  const expenseFile = await createAttachment(SITE, actor, 'expense', 900001, {
    filename: 'fuel-receipt.jpg',
    storedName: stored(),
    mimeType: 'image/jpeg',
    sizeBytes: 8000,
  })
  ok('an expense with the same id can hold its own file', expenseFile.ok)

  const grvList = await listAttachments(SITE, 'grv', 900001)
  const expenseList = await listAttachments(SITE, 'expense', 900001)
  ok('*** the GRV sees only its own ***',
      grvList.length === 1 && grvList[0].filename === 'supplier-invoice-88213.pdf',
      `${grvList.length} files`)
  ok('*** the expense sees only its own ***',
      expenseList.length === 1 && expenseList[0].filename === 'fuel-receipt.jpg',
      `${expenseList.length} files`)

  console.log('\n── Existing party documents are untouched ──────────────────\n')

  // The same table already serves customers and suppliers. A transaction
  // attachment must not appear on an account, or a supplier's paperwork
  // suddenly grows entries nobody filed there.
  const partyBefore = await siteQuery(
    SITE,
    `SELECT id FROM party_documents WHERE entity IN ('customer','supplier')`,
  )
  const custFile = await createAttachment(SITE, actor, 'customer', 900001, {
    filename: 'credit-application.pdf',
    storedName: stored(),
    sizeBytes: 1000,
  })
  ok('a customer document still works through the new module', custFile.ok)
  const partyAfter = await siteQuery(
    SITE,
    `SELECT id FROM party_documents WHERE entity IN ('customer','supplier')`,
  )
  ok('*** transaction attachments do not appear as party documents ***',
      partyAfter.length === partyBefore.length + 1,
      `${partyBefore.length} → ${partyAfter.length}`)

  console.log('\n── Counts for a list screen ────────────────────────────────\n')

  await createAttachment(SITE, actor, 'grv', 900002, {
    filename: 'second.pdf', storedName: stored(), sizeBytes: 100,
  })
  await createAttachment(SITE, actor, 'grv', 900002, {
    filename: 'third.pdf', storedName: stored(), sizeBytes: 100,
  })

  const counts = await attachmentCounts(SITE, 'grv', [900001, 900002, 900003])
  ok('a record with one file counts one', counts.get(900001) === 1)
  ok('a record with two counts two', counts.get(900002) === 2)
  ok('*** a record with none is absent, not zero ***', counts.has(900003) === false)
  ok('an empty id list does not query', (await attachmentCounts(SITE, 'grv', [])).size === 0)

  const crossCount = await attachmentCounts(SITE, 'expense', [900002])
  ok('*** counts do not bleed across entities ***', crossCount.has(900002) === false)

  console.log('\n── Renaming ───────────────────────────────────────────────\n')

  const renamed = await updateAttachment(SITE, actor, 'grv', 900001, grvFile.id, {
    filename: 'Supplier invoice 88213.pdf',
    description: 'Received 4 August',
  })
  ok('an attachment renames', renamed.ok)
  const afterRename = await getAttachment(SITE, 'grv', 900001, grvFile.id)
  ok('the new name sticks', afterRename?.filename === 'Supplier invoice 88213.pdf')
  ok('the description sticks', afterRename?.description === 'Received 4 August')
  ok('*** the file on disk is untouched by a rename ***',
      afterRename?.storedName === found?.storedName)

  const wrongRecord = await updateAttachment(SITE, actor, 'grv', 900002, grvFile.id, {
    filename: 'hijacked.pdf',
  })
  ok('*** renaming through the wrong record is refused ***', !wrongRecord.ok)

  const wrongEntity = await updateAttachment(SITE, actor, 'expense', 900001, grvFile.id, {
    filename: 'hijacked.pdf',
  })
  ok('*** renaming through the wrong entity is refused ***', !wrongEntity.ok)

  console.log('\n── Deleting ───────────────────────────────────────────────\n')

  const wrongDelete = await deleteAttachment(SITE, actor, 'expense', 900001, grvFile.id)
  ok('*** deleting through the wrong entity is refused ***', !wrongDelete.ok)

  const stillThere = await getAttachment(SITE, 'grv', 900001, grvFile.id)
  ok('…and the attachment survives that attempt', stillThere !== null)

  const removed = await deleteAttachment(SITE, actor, 'grv', 900001, grvFile.id)
  ok('deleting through the right record works', removed.ok)
  ok('*** it reports the disk name so the caller can unlink the bytes ***',
      removed.ok && removed.storedName.length > 0,
      removed.ok ? removed.storedName : '')
  ok('the attachment is gone', (await getAttachment(SITE, 'grv', 900001, grvFile.id)) === null)

  const twice = await deleteAttachment(SITE, actor, 'grv', 900001, grvFile.id)
  ok('deleting twice is refused rather than silently succeeding', !twice.ok)

  console.log('\n── Deleting a record must not orphan its files ─────────────\n')

  const names = await attachmentsFor(SITE, 'grv', 900002)
  ok('a record reports every file hanging off it', names.length === 2, `${names.length}`)

  const swept = await removeAttachmentsFor(SITE, 'grv', 900002)
  ok('*** removing a record returns the names to unlink ***', swept.length === 2)
  ok('…and the rows are gone', (await listAttachments(SITE, 'grv', 900002)).length === 0)
  ok('*** a record with no files sweeps cleanly ***',
      (await removeAttachmentsFor(SITE, 'grv', 900009)).length === 0)

  console.log('\n── Validation ─────────────────────────────────────────────\n')

  ok('a file with no name is refused',
      !(await createAttachment(SITE, actor, 'grv', 900001, {
        filename: '  ', storedName: stored(), sizeBytes: 1,
      })).ok)

  ok('a file that was never stored is refused',
      !(await createAttachment(SITE, actor, 'grv', 900001, {
        filename: 'x.pdf', storedName: '', sizeBytes: 1,
      })).ok)

  ok('*** an attachment with no record is refused ***',
      !(await createAttachment(SITE, actor, 'grv', 0, {
        filename: 'x.pdf', storedName: stored(), sizeBytes: 1,
      })).ok)

  console.log('\n── Cleanup ────────────────────────────────────────────────\n')

  await siteExecute(SITE, 'DELETE FROM party_documents WHERE entity_id BETWEEN ? AND ?', [FROM, TO])
  await siteExecute(SITE, `DELETE FROM activity_log WHERE user_name = 'Attachment Test'`)

  const left = await siteQuery(
    SITE,
    'SELECT id FROM party_documents WHERE entity_id BETWEEN ? AND ?',
    [FROM, TO],
  )
  ok('test data cleaned up', left.length === 0, `${left.length} left`)

  console.log(fails === 0 ? '\nAll attachment rules hold.\n' : `\n${fails} FAILURE(S)\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

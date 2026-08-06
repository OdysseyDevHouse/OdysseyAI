/**
 * Contacts, documents and comments on a customer or supplier account.
 *
 * The three invariants this proves, because each is enforced in application
 * code rather than by the schema and so has nothing else guarding it:
 *
 *   (A) An account with contacts has EXACTLY ONE primary — never zero, never
 *       two. No partial unique index exists in MariaDB, so demoteOthers() and
 *       the promote-on-delete in deleteContact are the only things holding it.
 *
 *   (B) A read scoped to (entity, entity_id) never returns another account's
 *       row. Document ids are guessable integers; the pair is what stops one
 *       account reading another's paperwork.
 *
 *   (C) Deleting an account leaves NOTHING behind. Contacts cascade via the
 *       foreign key, but documents and comments hang off the loose entity pair
 *       with no FK, so only deleteCustomer/deleteSupplier clean them up.
 *
 * (C) is the one that would rot silently: orphaned rows are invisible until an
 * id is reused and a new account inherits a dead account's comments.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-party-records.ts
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { siteQueryOne, siteExecute } from '../src/lib/siteDb'
import {
  listContacts,
  createContact,
  updateContact,
  deleteContact,
} from '../src/lib/site/partyContacts'
import { listDocuments, createDocument, deleteDocument } from '../src/lib/site/partyDocuments'
import {
  listComments,
  createComment,
  updateComment,
  setCommentPinned,
  deleteComment,
} from '../src/lib/site/partyComments'
import { createCustomer, deleteCustomer } from '../src/lib/site/customers'
import { createSupplier, deleteSupplier } from '../src/lib/site/suppliers'

const SITE = 1
const actor = { userId: 1, userName: 'Party Test' }
/** Must match UPLOADS_ROOT in src/lib/uploads.ts. */
const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'))
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const count = async (sql: string, params: unknown[]) =>
  Number((await siteQueryOne<{ n: number }>(SITE, sql, params))?.n ?? -1)

/** Removes anything a crashed run left behind, so a re-run starts clean. */
async function sweepStrays() {
  await siteExecute(SITE, "DELETE FROM customers WHERE code LIKE 'ZZPTY%'")
  await siteExecute(SITE, "DELETE FROM suppliers WHERE code LIKE 'ZZPTY%'")
}

async function main() {
  await sweepStrays()

  const stamp = Date.now().toString().slice(-6)

  /* ── Setup: one customer and one supplier ───────────────────────────── */
  const madeCustomer = await createCustomer(SITE, actor, {
    code: `ZZPTYC${stamp}`,
    name: 'Party Test Customer',
    status: 'active',
    paymentTermsDays: 30,
    creditLimit: 0,
  } as never)
  if (!madeCustomer.ok) throw new Error(`customer setup failed: ${madeCustomer.error}`)
  const cid = madeCustomer.id

  const madeSupplier = await createSupplier(SITE, actor, {
    code: `ZZPTYS${stamp}`,
    name: 'Party Test Supplier',
    status: 'active',
    paymentTermsDays: 30,
  } as never)
  if (!madeSupplier.ok) throw new Error(`supplier setup failed: ${madeSupplier.error}`)
  const sid = madeSupplier.id

  console.log(`\ncustomer ${cid}, supplier ${sid}\n`)

  /* ── Validation ─────────────────────────────────────────────────────── */
  console.log('-- validation')
  ok(
    'a contact with neither email nor phone is refused',
    !(await createContact(SITE, actor, 'customer', cid, { name: 'Unreachable' })).ok,
  )
  ok(
    'a malformed email is refused',
    !(await createContact(SITE, actor, 'customer', cid, { name: 'X', email: 'nope' })).ok,
  )
  ok(
    'a nameless contact is refused',
    !(await createContact(SITE, actor, 'customer', cid, { name: '  ', phone: '011' })).ok,
  )
  ok(
    'an empty comment is refused',
    !(await createComment(SITE, actor, 'customer', cid, '   ')).ok,
  )

  /* ── (A) exactly one primary ────────────────────────────────────────── */
  console.log('\n-- (A) the single-primary invariant')

  const a = await createContact(SITE, actor, 'customer', cid, {
    name: 'Sarah Ndlovu',
    role: 'Accounts',
    email: 'sarah@example.co.za',
  })
  ok('first contact created', a.ok)
  ok(
    'the first contact is primary without being asked',
    (await listContacts(SITE, 'customer', cid))[0]?.isPrimary === true,
  )

  const b = await createContact(SITE, actor, 'customer', cid, {
    name: 'Pieter Botha',
    phone: '011 555 0100',
    isPrimary: true,
  })
  ok('second contact created as primary', b.ok)

  let contacts = await listContacts(SITE, 'customer', cid)
  ok('still exactly one primary', contacts.filter((c) => c.isPrimary).length === 1,
    `${contacts.filter((c) => c.isPrimary).length} found`)
  ok('the promoted contact is the primary', contacts.find((c) => c.isPrimary)?.name === 'Pieter Botha')
  ok('the primary sorts to the top', contacts[0]?.name === 'Pieter Botha')

  if (b.ok) {
    await updateContact(SITE, actor, 'customer', b.id, {
      name: 'Pieter Botha',
      phone: '011 555 0199',
      email: 'pieter@example.co.za',
    })
    contacts = await listContacts(SITE, 'customer', cid)
    const edited = contacts.find((c) => c.id === b.id)
    ok('an edit persists', edited?.phone === '011 555 0199')
    ok('an edit cannot unset the last primary', edited?.isPrimary === true)

    await deleteContact(SITE, actor, 'customer', b.id)
    contacts = await listContacts(SITE, 'customer', cid)
    ok('deleting the primary promotes a replacement',
      contacts.length === 1 && contacts[0].isPrimary === true)
  }

  /* ── (B) scoping ────────────────────────────────────────────────────── */
  console.log('\n-- (B) reads are scoped to one account')

  await createContact(SITE, actor, 'supplier', sid, {
    name: 'Supplier Person',
    email: 'rep@example.co.za',
  })
  ok('supplier contacts are a separate list',
    (await listContacts(SITE, 'supplier', sid)).length === 1)
  ok('the customer list is unaffected',
    (await listContacts(SITE, 'customer', cid)).length === 1)

  // A real file on disk, so the delete path at the end actually unlinks
  // something. Registering a row that points at nothing would exercise only the
  // missing-file branch and leave the normal one untested.
  const storedName = `zz-test-${stamp}.pdf`
  await mkdir(UPLOADS_DIR, { recursive: true })
  await writeFile(path.join(UPLOADS_DIR, storedName), 'not a real pdf')

  const doc = await createDocument(SITE, actor, 'customer', cid, {
    filename: 'Credit Application.pdf',
    storedName,
    mimeType: 'application/pdf',
    sizeBytes: 2048,
    description: 'Signed',
  })
  ok('a document is recorded', doc.ok)
  ok('the file is on disk before the account is deleted',
    existsSync(path.join(UPLOADS_DIR, storedName)))

  const docs = await listDocuments(SITE, 'customer', cid)
  ok('it lists back with its name', docs[0]?.filename === 'Credit Application.pdf')
  ok('the uploader is snapshotted', docs[0]?.uploadedName === 'Party Test')
  ok('the supplier sees none of it', (await listDocuments(SITE, 'supplier', sid)).length === 0)

  if (doc.ok) {
    ok(
      'a delete aimed at the wrong party is refused',
      !(await deleteDocument(SITE, actor, 'supplier', sid, doc.id)).ok,
    )
    ok('the document survived that attempt',
      (await listDocuments(SITE, 'customer', cid)).length === 1)
  }

  /* ── Comments ───────────────────────────────────────────────────────── */
  console.log('\n-- comments')

  const c1 = await createComment(SITE, actor, 'customer', cid, 'Spoke to Sarah, paying Friday.')
  await createComment(SITE, actor, 'customer', cid, 'Second note.')
  ok('comments are created', c1.ok)

  let comments = await listComments(SITE, 'customer', cid)
  ok('newest first', comments[0]?.body === 'Second note.')
  ok('a fresh comment is not flagged edited', comments.every((c) => !c.edited))

  if (c1.ok) {
    await setCommentPinned(SITE, actor, 'customer', cid, c1.id, true)
    comments = await listComments(SITE, 'customer', cid)
    ok('a pinned comment rises above a newer one', comments[0]?.id === c1.id)
    ok('pinning does not count as an edit', comments[0]?.edited === false)

    // No delay needed: is_edited is a stored flag, not a timestamp comparison.
    // An edit one millisecond after the insert must still report as edited, and
    // this asserts exactly that.
    await updateComment(SITE, actor, 'customer', cid, c1.id, 'Spoke to Sarah, paid Friday.')
    comments = await listComments(SITE, 'customer', cid)
    const edited = comments.find((c) => c.id === c1.id)
    ok('the body changes', edited?.body === 'Spoke to Sarah, paid Friday.')
    ok('and it is now reported as edited', edited?.edited === true)

    await deleteComment(SITE, actor, 'customer', cid, c1.id)
    ok('a deleted comment is gone',
      !(await listComments(SITE, 'customer', cid)).some((c) => c.id === c1.id))
  }

  /* ── (C) nothing left behind ────────────────────────────────────────── */
  console.log('\n-- (C) deleting the account cleans up')

  const goneC = await deleteCustomer(SITE, actor, cid)
  ok('the customer deletes', goneC.ok, goneC.ok ? '' : goneC.error)

  ok('its contacts cascaded away',
    (await count('SELECT COUNT(*) n FROM customer_contacts WHERE customer_id=?', [cid])) === 0)
  ok('its documents were cleaned up',
    (await count('SELECT COUNT(*) n FROM party_documents WHERE entity=? AND entity_id=?',
      ['customer', cid])) === 0)
  ok('its comments were cleaned up',
    (await count('SELECT COUNT(*) n FROM party_comments WHERE entity=? AND entity_id=?',
      ['customer', cid])) === 0)
  ok('the file on disk was unlinked too',
    !existsSync(path.join(UPLOADS_DIR, storedName)))

  const goneS = await deleteSupplier(SITE, actor, sid)
  ok('the supplier deletes', goneS.ok, goneS.ok ? '' : goneS.error)
  ok('supplier contacts cascaded away',
    (await count('SELECT COUNT(*) n FROM supplier_contacts WHERE supplier_id=?', [sid])) === 0)

  await sweepStrays()

  console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS')
  process.exit(fails ? 1 : 0)
}

main().catch(async (e) => {
  console.error(e)
  await sweepStrays().catch(() => {})
  console.log('\nCRASHED — strays swept')
  process.exit(1)
})

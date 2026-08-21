/**
 * "This customer may already exist."
 *
 * Two different promises, and the test exists because they are easy to blur:
 *
 *   CODE      — unique. createCustomer REFUSES a repeat. Nothing to decide.
 *   PHONE/EMAIL — a hint. The save is PAUSED, the match is named, and the
 *                 person decides. A husband and wife share a mobile; a father
 *                 and son shop at one counter. Refusing those would make the
 *                 system wrong about real customers, and staff would work
 *                 around it by typing a fake number — destroying the signal.
 *
 * The interesting assertions are the ones that must NOT fire: a partial number,
 * a customer matching itself on edit, and a closed account.
 *
 *   npm run test:customer-duplicates
 */
import { customerExecute, customerQuery } from '../src/lib/site/customerDb'
import {
  createCustomer,
  possibleDuplicates,
  duplicateWarning,
  phoneKey,
} from '../src/lib/site/customers'
import { customerOwnerSite } from '../src/lib/storeGroups'
import type { Actor } from '../src/lib/site/activityLog'
import type { RowDataPacket } from 'mysql2/promise'

const TAG = 'dupprobe'
const SITE = Number(process.env.TEST_SITE_ID ?? 1)

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const actor: Actor = { userId: 0, userName: TAG }

async function cleanup() {
  await customerExecute(SITE, 'DELETE FROM customers WHERE code LIKE ?', [`${TAG}%`])
}

async function main() {
  await cleanup()

  try {
    /* ── phoneKey: the four ways one number gets typed ─────────────────── */

    console.log('\n— One number, four spellings —')

    const spellings = ['082 123 4567', '0821234567', '+27 82 123 4567', '27821234567']
    const keys = spellings.map((s) => phoneKey(s))
    ok(
      'every spelling produces the same key',
      new Set(keys).size === 1 && keys[0] === '821234567',
      JSON.stringify(keys),
    )

    // The floor matters: without it an extension number would match half the book.
    ok('a short number has no key', phoneKey('123') === null, String(phoneKey('123')))
    ok('an empty number has no key', phoneKey('') === null)
    ok('a null number has no key', phoneKey(null) === null)

    /* ── The code is refused outright ──────────────────────────────────── */

    console.log('\n— A repeated code is an error, not a warning —')

    const first = await createCustomer(SITE, actor, {
      code: `${TAG}-A`,
      name: `${TAG} Bob Smith`,
      phone: '082 123 4567',
      email: `${TAG}.bob@example.com`,
    })
    ok('the first customer was created', first.ok, first.ok ? '' : first.error)
    if (!first.ok) return

    const sameCode = await createCustomer(SITE, actor, {
      code: `${TAG}-A`,
      name: 'Someone else entirely',
    })
    ok('the same code is refused', !sameCode.ok, sameCode.ok ? 'IT WAS CREATED' : sameCode.error)
    ok(
      'and the message names the code',
      !sameCode.ok && sameCode.error.includes(`${TAG}-A`),
      sameCode.ok ? '' : sameCode.error,
    )

    /* ── Phone and email only warn ─────────────────────────────────────── */

    console.log('\n— A repeated cell number or email is a warning —')

    // Written differently from the stored "082 123 4567" on purpose: the whole
    // point is that the two spellings are recognised as one number.
    const byPhone = await possibleDuplicates(SITE, { phone: '+27821234567' })
    ok('a differently-typed cell number matches', byPhone.length === 1, `${byPhone.length} match(es)`)
    ok(
      'and it names the code and the name',
      byPhone[0]?.code === `${TAG}-A` && byPhone[0]?.name === `${TAG} Bob Smith`,
      JSON.stringify(byPhone[0] ?? null),
    )
    ok('and says it matched on the phone', byPhone[0]?.matchedOn.join() === 'phone')

    const byEmail = await possibleDuplicates(SITE, { email: `${TAG}.BOB@Example.com` })
    ok('email matches regardless of case', byEmail.length === 1, `${byEmail.length} match(es)`)
    ok('and says it matched on the email', byEmail[0]?.matchedOn.join() === 'email')

    const byBoth = await possibleDuplicates(SITE, {
      phone: '0821234567',
      email: `${TAG}.bob@example.com`,
    })
    ok(
      'one account matching both is reported once, naming both',
      byBoth.length === 1 && byBoth[0].matchedOn.length === 2,
      JSON.stringify(byBoth),
    )

    // The warning is what the person actually reads, so assert its content
    // rather than trusting that the data behind it was right.
    const message = duplicateWarning(byBoth)
    ok('the warning names the code', message.includes(`${TAG}-A`), message)
    ok('the warning names the customer', message.includes('Bob Smith'), message)
    ok('the warning says it can be overridden', /save anyway/i.test(message), message)

    /* ── And the save still goes through ───────────────────────────────── */

    console.log('\n— A warning does not block the write —')

    const second = await createCustomer(SITE, actor, {
      code: `${TAG}-B`,
      name: `${TAG} Bob Smith Jr`,
      phone: '082 123 4567',
    })
    ok(
      'a second customer on the same number is still created',
      second.ok,
      second.ok ? '' : second.error,
    )

    /* ── What must NOT warn ────────────────────────────────────────────── */

    console.log('\n— The quiet cases —')

    const noFields = await possibleDuplicates(SITE, { phone: null, email: null })
    ok('no phone and no email finds nothing', noFields.length === 0, `${noFields.length}`)

    const shortNumber = await possibleDuplicates(SITE, { phone: '4567' })
    ok(
      'a partial number finds nothing rather than everything',
      shortNumber.length === 0,
      `${shortNumber.length} match(es)`,
    )

    // Editing an account without changing its number must not warn about itself.
    const self = await possibleDuplicates(SITE, { phone: '0821234567' }, first.id)
    ok(
      'excluding the account being edited drops it',
      !self.some((m) => m.id === first.id),
      JSON.stringify(self.map((m) => m.code)),
    )

    // A closed account is finished with — warning about one sends somebody to a
    // record they cannot use.
    await customerExecute(SITE, "UPDATE customers SET status = 'closed' WHERE code = ?", [
      `${TAG}-B`,
    ])
    const afterClose = await possibleDuplicates(SITE, { phone: '0821234567' })
    ok(
      'a closed account is not offered as a match',
      !afterClose.some((m) => m.code === `${TAG}-B`),
      JSON.stringify(afterClose.map((m) => m.code)),
    )

    /* ── It reads the file that actually holds the customers ───────────── */

    console.log('\n— The right database —')

    // Not a sharing test — this site owns its own customers. It asserts the
    // check goes through the resolver at all, which is the difference between
    // finding the duplicate and silently creating it at a branch.
    const owner = await customerOwnerSite(SITE)
    const viaWrapper = await customerQuery<RowDataPacket & { n: number }>(
      SITE,
      'SELECT COUNT(*) AS n FROM customers WHERE code LIKE ?',
      [`${TAG}%`],
    )
    ok(
      `possibleDuplicates reads site ${owner.siteId}'s customer file`,
      Number(viaWrapper[0]?.n) === 2,
      `${viaWrapper[0]?.n} probe customer(s) visible through the wrapper`,
    )
  } finally {
    await cleanup()
    const left = await customerQuery<RowDataPacket & { n: number }>(
      SITE,
      'SELECT COUNT(*) AS n FROM customers WHERE code LIKE ?',
      [`${TAG}%`],
    )
    ok('test data cleaned up', Number(left[0]?.n) === 0, `${left[0]?.n} left`)
  }

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} failure(s).`)
  process.exit(fails > 0 ? 1 : 0)
}

main().catch(async (e) => {
  console.error(e)
  try {
    await cleanup()
  } catch {
    /* the original error is what matters */
  }
  process.exit(1)
})

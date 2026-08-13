/**
 * The pure half of the SMS layer — no database, no network.
 *
 * Phone normalisation is the rule the whole channel stands on: every consumer
 * (dunning, lay-by reminders, the test-send box) runs the same function, so
 * this table IS the definition of "a number we can text".
 */

import { normaliseSaPhone } from '../src/lib/sms/phone'
import { truncateSms, SMS_MAX_LENGTH } from '../src/lib/sms/types'
import { renderTemplate } from '../src/lib/creditModel'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

console.log('\n── South African numbers normalise to E.164 ────────────────\n')

const cases: [string | null | undefined, string | null][] = [
  // The forms a customer file actually holds.
  ['0821234567', '+27821234567'],
  ['082 123 4567', '+27821234567'],
  ['082-123-4567', '+27821234567'],
  ['(082) 123 4567', '+27821234567'],
  ['27821234567', '+27821234567'],
  ['+27821234567', '+27821234567'],
  ['+27 82 123 4567', '+27821234567'],
  // Landline-shaped is still ten digits — the network decides, not us.
  ['0112345678', '+27112345678'],
  // Foreign numbers in full international form pass through as typed.
  ['+441632960961', '+441632960961'],
  // Everything that cannot be a number we text.
  ['12345', null],
  ['082123456', null], // one digit short
  ['08212345678', null], // one digit long
  ['+2782123456', null], // short after the code
  ['not a number', null],
  ['', null],
  [null, null],
  [undefined, null],
]

for (const [input, expected] of cases) {
  const got = normaliseSaPhone(input)
  ok(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, got === expected, `got ${JSON.stringify(got)}`)
}

console.log('\n── Truncation caps at two segments ─────────────────────────\n')

ok('a short body passes untouched', truncateSms('Pay us please') === 'Pay us please')
ok('whitespace is trimmed', truncateSms('  hello  ') === 'hello')

const long = 'x'.repeat(SMS_MAX_LENGTH + 50)
const cut = truncateSms(long)
ok(`a long body is cut to ${SMS_MAX_LENGTH}`, cut.length === SMS_MAX_LENGTH, String(cut.length))
ok('…and says so with an ellipsis', cut.endsWith('…'))

const exact = 'y'.repeat(SMS_MAX_LENGTH)
ok('a body exactly at the cap is not touched', truncateSms(exact) === exact)

console.log('\n── Templates fill the same tokens as email ─────────────────\n')

const body = renderTemplate('Hi {customer}, {overdue} overdue at {company}.', {
  customer: 'Harbour Cafe',
  overdue: 'R1,234.00',
  company: 'Test Shop',
})
ok('tokens are replaced', body === 'Hi Harbour Cafe, R1,234.00 overdue at Test Shop.', body)
ok('no braces survive', !body.includes('{') && !body.includes('}'))

console.log(fails === 0 ? '\nAll SMS model rules hold.\n' : `\n${fails} FAILURE(S)\n`)
process.exit(fails === 0 ? 0 : 1)

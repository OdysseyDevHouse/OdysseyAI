// Do the loyalty reports return REAL ROWS, including a walk-in member?
// The template suite passed at 0 rows, which proves the SQL parses and nothing
// more — a join that drops every walk-in returns 0 rows just as cleanly.
import { enrolMember, getLoyaltySettings, saveLoyaltySettings } from '../src/lib/site/loyalty'
import { runBuilderSpec } from '../src/lib/reportBuilder/run'
import { TEMPLATES } from '../src/lib/reportBuilder/templates'
import { siteExecute } from '../src/lib/siteDb'

const SITE = 1
const ACTOR = { userId: 1, userName: 'Report probe' }
const stamp = String(Date.now()).slice(-8)

async function main() {
  const s = await getLoyaltySettings(SITE)
  await saveLoyaltySettings(SITE, ACTOR, { ...s, enabled: true })

  const cust = await siteExecute(
    SITE,
    `INSERT INTO customers (code, name, status, account_type) VALUES (?,?,'active','cash')`,
    [`RP${stamp}`, `Report Customer ${stamp}`],
  )
  const withAccount = await enrolMember(SITE, ACTOR, {
    name: `Report Account ${stamp}`, customerId: cust.insertId,
  })
  const walkIn = await enrolMember(SITE, ACTOR, { name: `Report WalkIn ${stamp}` })
  if (!withAccount.ok || !walkIn.ok) throw new Error('enrolment failed')

  let fails = 0
  const ok = (l: string, c: boolean, d = '') => {
    if (!c) fails++
    console.log(`${c ? 'PASS' : '**FAIL**'}  ${l}${d ? '  -- ' + d : ''}`)
  }

  const members = TEMPLATES.find((t) => t.id === 'loyalty-members')!
  const res = await runBuilderSpec(SITE, { ...members.spec, name: members.name } as never, () => true, { limit: 200 })
  const rows = (res as { rows: Record<string, unknown>[] }).rows
  const names = rows.map((r) => String(r.memberName ?? ''))

  ok('the members report returns rows', rows.length >= 2, `${rows.length}`)
  ok('*** it includes the ACCOUNT holder ***', names.includes(`Report Account ${stamp}`))
  ok('*** it includes the WALK-IN member ***', names.includes(`Report WalkIn ${stamp}`),
     'an INNER JOIN to customers would drop exactly this row')

  await siteExecute(SITE, 'DELETE FROM loyalty_members WHERE id IN (?,?)',
                    [withAccount.memberId, walkIn.memberId])
  await siteExecute(SITE, 'DELETE FROM customers WHERE id = ?', [cust.insertId])
  console.log(fails === 0 ? '\nBoth kinds of member reach the report.\n' : `\n${fails} FAILED\n`)
  process.exit(fails === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })

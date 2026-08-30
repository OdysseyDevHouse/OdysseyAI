/*
 * What the Getting started checklist would say, for a real site.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/probe-getting-started.ts [siteId]
 *
 * The point is to prove the page reads DATA rather than guessing: every tick
 * below comes from a count against the site's own tables, so running this
 * against a busy site and an empty one should produce two different lists
 * without a line of the page changing.
 *
 * Read-only. It writes nothing and creates nothing.
 */
import { getSite } from '../src/lib/sites'
import { readProgress, completion, landingFor } from '../src/lib/site/gettingStarted'
import { STEPS } from '../src/app/(app)/getting-started/catalogue'

async function main() {
  const siteId = Number(process.argv[2] ?? 1)

  const site = await getSite(siteId)
  if (!site) {
    console.error(`No site ${siteId}`)
    process.exit(1)
  }

  console.log(`\n  ${site.displayName}  (site ${site.id}, ${site.code})`)
  console.log(`  ${'-'.repeat(64)}`)

  const progress = await readProgress(site)

  const essential = STEPS.filter((s) => s.essential)
  const optional = STEPS.filter((s) => !s.essential)

  const line = (s: (typeof STEPS)[number]) => {
    const state = progress[s.key]
    const mark = state.done ? '[x]' : '[ ]'
    const count = state.count > 0 ? `${state.count >= 20 ? '20+' : state.count}` : '-'
    console.log(`  ${mark}  ${s.title.padEnd(34)} ${count.padStart(4)}   ${s.href}`)
  }

  console.log('\n  ESSENTIAL - needed before the shop can trade')
  essential.forEach(line)

  console.log('\n  WORTH DOING NEXT')
  optional.forEach(line)

  const done = completion(essential.map((s) => progress[s.key]))
  console.log(`\n  Ready to trade: ${done.done} of ${done.total}  (${done.pct}%)`)

  /* The other half of the feature: where a sign-in for this site would land. A
     site that has never sold lands on the checklist; one that has gets the
     dashboard it wants every morning after. */
  console.log(`  A sign-in here would land on: ${await landingFor(site.id)}\n`)

  process.exit(0)
}

main()

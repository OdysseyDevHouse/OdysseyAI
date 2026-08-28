import { payableSummary } from '../src/lib/site/payableSummary'
import { resolvePayLink, splitPayCode } from '../src/lib/site/payLinks'
import { getCustomer } from '../src/lib/site/customers'
async function main() {
  const split = splitPayCode('1h-bGRsZn3uMgAj')!
  const link = await resolvePayLink(split.siteId, split.slug)
  const sum = link ? await payableSummary(53, link) : null
  console.log('pay page now shows :', sum ? `${sum.title} — outstanding ${sum.outstanding}` : 'link gone')
  const c = await getCustomer(53, 1)
  console.log('customer balance   :', c?.balance)
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })

import { siteQuery } from '../src/lib/siteDb'
async function main() {
  const s = await siteQuery<any>(1, `SHOW COLUMNS FROM customers WHERE Field = 'status'`)
  console.log('status type:', s[0].Type, ' default:', s[0].Default)
}
main().then(() => process.exit(0))

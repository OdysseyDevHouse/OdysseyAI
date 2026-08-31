import { siteQuery } from '../src/lib/siteDb'
async function main() {
  const SITE = Number(process.env.SITE || 33)
  const cols = await siteQuery<any>(SITE, `SHOW COLUMNS FROM departments`)
  console.log('departments:', cols.map((c: any) => c.Field).join(', '))
  const p = await siteQuery<any>(SITE, `SHOW COLUMNS FROM products`)
  console.log('\nproducts (filters):', p.map((c: any) => c.Field).filter((f: string) => /arch|visib|active|status|parent|department/.test(f)).join(', '))
}
main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1) })

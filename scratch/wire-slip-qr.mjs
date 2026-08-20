import fs from 'fs'
const must = (c, w) => { if (!c) throw new Error('no match: ' + w) }

/* ── the printed slip ───────────────────────────────────────────────────── */
{
  const p = 'src/app/(print)/sales/[id]/slip/page.tsx'
  let s = fs.readFileSync(p, 'utf8')
  must(s.includes('      copyNumber: doc.printCount,\n      footerText,'), 'slip opts')
  s = s.replace(
    '      copyNumber: doc.printCount,\n      footerText,',
    '      copyNumber: doc.printCount,\n      footerText,\n      qrLinks: await qrContextFor(site.id),',
  )
  const first = s.match(/^import[^\n]*\n/m)
  s = s.replace(first[0], first[0] + "import { qrContextFor } from '@/lib/site/qrLinks'\n")
  fs.writeFileSync(p, s)
  console.log('slip print route')
}

/* ── the sample the designer previews against ───────────────────────────── */
{
  const p = 'src/lib/stationery/preview.ts'
  let s = fs.readFileSync(p, 'utf8')
  must(s.includes('export function sampleReceipt(siteName: string, vatNumber: string | null): ReceiptData {'), 'sample sig')
  s = s.replace(
    'export function sampleReceipt(siteName: string, vatNumber: string | null): ReceiptData {',
    `export function sampleReceipt(
  siteName: string,
  vatNumber: string | null,
  /**
   * Where a QR on the sample slip may point.
   *
   * Passed in rather than defaulted, so the designer's preview resolves a QR by
   * exactly the rules the till will — a preview that showed a square the printer
   * would omit is a preview that lies at the moment someone trusts it.
   */
  qrLinks?: ReceiptData['qrLinks'],
): ReceiptData {`,
  )
  must(s.includes("    footerText: '',"), 'sample body')
  s = s.replace("    footerText: '',", "    footerText: '',\n    ...(qrLinks ? { qrLinks } : {}),")
  fs.writeFileSync(p, s)
  console.log('preview sample')
}

/* ── the two designer callers ───────────────────────────────────────────── */
{
  const p = 'src/app/(app)/setup/stationery/actions.ts'
  let s = fs.readFileSync(p, 'utf8')
  const from = 'sampleReceipt(site.displayName, site.vatNumber)'
  const to = 'sampleReceipt(site.displayName, site.vatNumber, await qrContextFor(ctx.siteId))'
  must(s.includes(from), 'sample callers')
  s = s.split(from).join(to)
  fs.writeFileSync(p, s)
  console.log('designer callers')
}

import { siteQuery } from '../src/lib/siteDb'
async function main() {
  for (const s of [1, 2]) {
    const cols = await siteQuery<any>(s, `SHOW COLUMNS FROM job_card_items WHERE Field IN ('attachment_id','evidence_required')`)
    const tcols = await siteQuery<any>(s, `SHOW COLUMNS FROM job_headline_items WHERE Field = 'evidence_required'`)
    const fk = await siteQuery<any>(s,
      `SELECT CONSTRAINT_NAME, DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'fk_jci_attachment'`)
    const set = await siteQuery<any>(s,
      `SELECT setting_key, setting_value FROM settings WHERE setting_key LIKE 'job_signature%' ORDER BY setting_key`)
    console.log(`site ${s}: item cols [${cols.map((c:any)=>c.Field+':'+c.Type).join(' | ')}]`)
    console.log(`         template col [${tcols.map((c:any)=>c.Field+':'+c.Type).join('')}]`)
    console.log(`         fk ${fk[0]?.CONSTRAINT_NAME ?? 'MISSING'} -> ${fk[0]?.DELETE_RULE ?? '?'}`)
    console.log(`         settings ${set.length}: ${set.map((r:any)=>r.setting_key).join(', ')}`)
    const bad = await siteQuery<any>(s,
      `SELECT COUNT(*) n FROM job_card_items
        WHERE evidence_required = 1 AND response_type NOT IN ('photo','signature')`)
    const reopened = await siteQuery<any>(s,
      `SELECT COUNT(*) n FROM job_card_items WHERE completed_at IS NOT NULL AND evidence_required = 1`)
    console.log(`         non-evidence rows wrongly flagged: ${bad[0].n} | already-completed rows reopened: ${reopened[0].n}`)
  }
}
main().then(() => process.exit(0))

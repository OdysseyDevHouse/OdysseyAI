import { siteQuery, siteExecute } from '../src/lib/siteDb'

async function main() {
  await siteExecute(1, `DELETE FROM custom_field_defs WHERE code = 'gas_pressure'`)
  const defs = await siteQuery<any>(1, `SELECT id, code FROM custom_field_defs`)
  const vals = await siteQuery<any>(1, `SELECT COUNT(*) AS n FROM custom_field_values`)
  const acts = await siteQuery<any>(
    1,
    `SELECT COUNT(*) AS n FROM activity_log WHERE entity = 'custom_field'`,
  )
  console.log('defs left:', JSON.stringify(defs))
  console.log('values left:', vals[0].n, ' activity rows:', acts[0].n)
  // The activity rows are a real audit trail of a real action, but this was a
  // probe, so they go too.
  await siteExecute(1, `DELETE FROM activity_log WHERE entity = 'custom_field'`)
  console.log('probe activity removed')
}

main().then(() => process.exit(0))

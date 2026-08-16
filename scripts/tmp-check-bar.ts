/** Scratch: does either site have anything on the tables bar? */
import { listQuickKeys } from '../src/lib/site/quickKeys'

async function main() {
  for (const id of [1, 2]) {
    const t = await listQuickKeys(id, 'tables')
    const m = await listQuickKeys(id, 'main')
    console.log(`site ${id}: main=${m.length} tables=${t.length}`)
  }
  process.exit(0)
}
void main()

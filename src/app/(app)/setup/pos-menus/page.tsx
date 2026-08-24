import { requireCapability } from '@/lib/auth'
import { listPosMenus } from '@/lib/site/posMenus'
import { listDepartments } from '@/lib/site/departments'
import { listTerminals } from '@/lib/site/terminals'
import { PageBody, PageHeader } from '@/components/ui'
import { PosMenusClient } from './PosMenusClient'

export const dynamic = 'force-dynamic'

/**
 * Rotating menus — what the till shows, by the hour.
 *
 * ── WHY THIS IS ITS OWN SCREEN AND NOT PART OF THE MENU DESIGNER ───────────
 *
 * The designer answers "what ORDER do the tiles come in"; this answers "which
 * tiles are there at all, right now". They read the same catalogue and mean
 * different things, and one screen holding a drag canvas and a set of trading
 * hours would answer neither question well.
 *
 * ── WHY NOT PART OF SPECIALS ───────────────────────────────────────────────
 *
 * Specials time-box PRICE; this time-boxes VISIBILITY. A dinner steak that
 * costs more after five is a special with a daily band, and it composes with
 * a menu rather than being the same thing — see 231's docblock.
 */
export default async function PosMenusPage() {
  // A hidden nav entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('setup.edit')

  const [menus, departments, terminals] = await Promise.all([
    listPosMenus(siteId),
    listDepartments(siteId),
    /* Active tills only: this is the list somebody PICKS from, and a
       decommissioned register is not one to pin a menu to. Menus already
       pinned to it keep their row until the till is deleted. */
    listTerminals(siteId, false),
  ])

  return (
    <>
      <PageHeader
        title="Rotating menus"
        subtitle="Breakfast, lunch and dinner — the till switches by the clock"
      />
      <PageBody>
        <PosMenusClient
          initialMenus={menus}
          departments={departments.map((d) => ({
            id: d.id,
            name: d.name,
            parentId: d.parentId,
          }))}
          terminals={terminals.map((t) => ({ id: t.id, code: t.code, name: t.name }))}
        />
      </PageBody>
    </>
  )
}

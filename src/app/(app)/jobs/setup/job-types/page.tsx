import { requireModuleCapability } from '@/lib/auth'
import { listJobBoards } from '@/lib/site/jobBoards'
import { listHeadlines } from '@/lib/site/jobHeadlines'
import { PageHeader, PageBody } from '@/components/ui'
import HeadlinesPanel from './HeadlinesPanel'

export const dynamic = 'force-dynamic'

/**
 * The kinds of work this business takes on.
 *
 * Called "job types" rather than "headlines" — the schema's word — because a
 * headline is what the row is; a kind of work is what somebody is choosing.
 *
 * Reads the boards because a type can send its jobs to one by default. Tolerant
 * on the headline read: a site without migration 114 still gets the screen and an
 * empty list rather than a 500.
 */
export default async function JobTypesPage() {
  const { siteId } = await requireModuleCapability('job_cards', 'jobs.setup')

  const [headlines, boards] = await Promise.all([
    listHeadlines(siteId, true).catch(() => []),
    listJobBoards(siteId, true).catch(() => []),
  ])

  return (
    <>
      <PageHeader
        title="Job types"
        subtitle="The kinds of jobs you take on, and what each one needs."
      />
      <PageBody>
        <HeadlinesPanel
          headlines={headlines}
          boards={boards.filter((b) => b.isActive).map((b) => ({ id: b.id, name: b.name }))}
        />
      </PageBody>
    </>
  )
}

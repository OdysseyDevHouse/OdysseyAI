import { requireModuleCapability } from '@/lib/auth'
import { PageHeader, PageBody, TextLink } from '@/components/ui'
import NotBuiltYet from '../NotBuiltYet'

export const dynamic = 'force-dynamic'

/**
 * The layouts job paperwork prints from.
 *
 * Not built. The stationery designer is the engine this will run on — it already
 * has catalogue-bounded templates, a block system and three print paths — but its
 * document catalogue holds five types and none of them is a job: no job card, no
 * service report, no certificate. Adding those is a catalogue and a block set,
 * not a new designer, which is why this points there rather than promising a
 * screen of its own.
 */
export default async function JobDocumentTemplatesPage() {
  await requireModuleCapability('job_cards', 'jobs.setup')

  return (
    <>
      <PageHeader
        title="Document templates"
        subtitle="The layouts your quotes, reports and certificates print from."
      />
      <PageBody>
        <NotBuiltYet
          what="Job paperwork — a job card, a service report, a completion certificate — has no template of its own yet, so it prints from the built-in layout."
          today={
            <>
              Quotes and invoices raised from a job already print from{' '}
              <TextLink href="/setup/stationery">Stationery</TextLink>, which is where job
              layouts will live once they exist.
            </>
          }
        />
      </PageBody>
    </>
  )
}

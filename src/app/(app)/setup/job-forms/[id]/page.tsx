import { notFound } from 'next/navigation'
import { requireModuleCapability } from '@/lib/auth'
import { getForm, getVersion } from '@/lib/site/jobForms'
import { PageHeader, PageBody, Callout } from '@/components/ui'
import BuilderClient from './BuilderClient'

export const dynamic = 'force-dynamic'

/**
 * Building one form.
 *
 * ── THE SCREEN ALWAYS EDITS A DRAFT ────────────────────────────────────────
 *
 * A published version is frozen — responses point at it, and §24 is explicit
 * that template edits must not alter historical submissions. So this page opens
 * the draft when there is one, and otherwise shows what is live READ-ONLY with
 * a button to start the next draft.
 *
 * That is the honest shape rather than an editor that silently forks on first
 * keystroke: somebody who opens a live form to check what it asks should not
 * create v4 by looking at it.
 */
export default async function BuildFormPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { siteId } = await requireModuleCapability('job_cards', 'jobs.setup')
  const { id } = await params

  const formId = Number(id)
  if (!Number.isFinite(formId) || formId <= 0) notFound()

  const form = await getForm(siteId, formId)
  if (!form) notFound()

  const editing = form.draftVersionId !== null
  const versionId = form.draftVersionId ?? form.liveVersionId
  const version = versionId === null ? null : await getVersion(siteId, versionId)

  return (
    <>
      <PageHeader
        title={form.name}
        subtitle={
          editing
            ? 'A draft. Nothing is asked of anybody until it is published.'
            : form.liveVersionId !== null
              ? `Version ${form.liveVersion}, live. Start a draft to change it.`
              : 'Nothing published yet.'
        }
        backHref="/setup/job-forms"
        backLabel="Forms"
      />
      <PageBody>
        {form.responseCount > 0 && editing && (
          <Callout tone="brand" title="This form has already been filled in">
            {form.responseCount} {form.responseCount === 1 ? 'response has' : 'responses have'} been
            recorded against earlier versions. Publishing this draft changes what future jobs are
            asked; it does not touch what has already been answered.
          </Callout>
        )}

        <BuilderClient
          formId={form.id}
          formName={form.name}
          versionId={versionId}
          version={version?.version ?? 0}
          isDraft={editing}
          fields={version?.fields ?? []}
        />
      </PageBody>
    </>
  )
}

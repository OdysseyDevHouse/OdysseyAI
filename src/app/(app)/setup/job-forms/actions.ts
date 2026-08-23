'use server'

import { revalidatePath } from 'next/cache'
import { actorForModule } from '@/lib/auth'
import {
  createForm,
  saveDraft,
  publishVersion,
  startDraft,
  setFormActive,
  setHeadlineForms,
  type FieldInput,
  type FormResult,
  type FormActionResult,
} from '@/lib/site/jobForms'

/**
 * Building forms.
 *
 * Every action is gated on `jobs.setup` — the same capability that guards
 * statuses, boards and headlines, because a form is a piece of the workflow
 * rather than work. Somebody who fills forms in needs `jobs.edit`; somebody who
 * decides what the form ASKS is configuring the business.
 */

function refresh(formId?: number) {
  revalidatePath('/setup/job-forms')
  if (formId) revalidatePath(`/setup/job-forms/${formId}`)
  // A published change alters what every open job is asked for.
  revalidatePath('/jobs')
}

export async function createFormAction(input: {
  name: string
  description: string | null
  isPublic: boolean
}): Promise<FormResult> {
  const ctx = await actorForModule('job_cards', 'jobs.setup')
  if ('ok' in ctx) return ctx

  const result = await createForm(ctx.siteId, ctx.actor, input)
  if (result.ok) refresh(result.id)
  return result
}

export async function saveDraftAction(
  formId: number,
  versionId: number,
  fields: FieldInput[],
): Promise<FormActionResult> {
  const ctx = await actorForModule('job_cards', 'jobs.setup')
  if ('ok' in ctx) return ctx

  const result = await saveDraft(ctx.siteId, ctx.actor, versionId, fields)
  if (result.ok) refresh(formId)
  return result
}

export async function publishAction(
  formId: number,
  versionId: number,
): Promise<FormActionResult> {
  const ctx = await actorForModule('job_cards', 'jobs.setup')
  if ('ok' in ctx) return ctx

  const result = await publishVersion(ctx.siteId, ctx.actor, versionId)
  if (result.ok) refresh(formId)
  return result
}

export async function startDraftAction(formId: number): Promise<FormResult> {
  const ctx = await actorForModule('job_cards', 'jobs.setup')
  if ('ok' in ctx) return ctx

  const result = await startDraft(ctx.siteId, ctx.actor, formId)
  if (result.ok) refresh(formId)
  return result
}

export async function setActiveAction(
  formId: number,
  isActive: boolean,
): Promise<FormActionResult> {
  const ctx = await actorForModule('job_cards', 'jobs.setup')
  if ('ok' in ctx) return ctx

  const result = await setFormActive(ctx.siteId, ctx.actor, formId, isActive)
  if (result.ok) refresh(formId)
  return result
}

export async function setHeadlineFormsAction(
  headlineId: number,
  forms: { formId: number; isRequired: boolean }[],
): Promise<FormActionResult> {
  const ctx = await actorForModule('job_cards', 'jobs.setup')
  if ('ok' in ctx) return ctx

  const result = await setHeadlineForms(ctx.siteId, headlineId, forms)
  if (result.ok) {
    revalidatePath('/setup/job-workflow')
    revalidatePath('/jobs')
  }
  return result
}

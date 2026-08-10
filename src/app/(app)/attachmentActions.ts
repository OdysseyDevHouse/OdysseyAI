'use server'

import { revalidatePath } from 'next/cache'
import { actorForOrThrow } from '@/lib/auth'
import { storeUpload, deleteStoredFile } from '@/lib/uploads'
import {
  createAttachment,
  updateAttachment,
  deleteAttachment,
} from '@/lib/site/attachments'
import {
  ATTACHMENT_TARGETS,
  toAttachmentTarget,
  writeCapabilityFor,
  type AttachmentTarget,
} from '@/lib/attachmentTargets'

/**
 * Attaching files to any record.
 *
 * One set of actions for every entity, because the work is identical and the
 * only thing that varies — which capability is required — is data on the
 * target rather than a branch in the code.
 *
 * ── THE CAPABILITY IS DERIVED FROM THE TARGET ────────────────────────────
 *
 * Not hardcoded. The existing party actions check `customers.edit` even when
 * the record is a supplier, which is a latent bug: someone with supplier rights
 * but no customer rights cannot attach a file to a supplier. Deriving it means
 * that class of mistake cannot recur as targets are added.
 *
 * The entity is narrowed against the known list BEFORE it selects a
 * capability. An unvalidated one would let a caller name a target whose
 * permission they happen to hold and write against one they do not.
 */

export type AttachmentState = {
  ok: boolean
  error: string | null
  message: string | null
}

/* The idle state lives with the component that uses it, not here. A
   'use server' module may export nothing but async functions — every export
   becomes a callable server action — so a plain object breaks the whole file at
   runtime with "can only export async functions, found object", taking every
   other action on the page down with it. The type above is fine: it is erased
   before any of this reaches the runtime. */

/** Narrows the target pair from a form, or refuses. */
function readTarget(form: FormData): { entity: AttachmentTarget; entityId: number } | null {
  const entity = toAttachmentTarget(form.get('entity'))
  if (entity === null) return null

  const entityId = Number(form.get('entityId'))
  if (!Number.isFinite(entityId) || entityId <= 0) return null

  return { entity, entityId }
}

function text(form: FormData, key: string): string | null {
  const value = form.get(key)
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Where to revalidate after a change.
 *
 * The record's own screen, plus any list it appears on. Kept with the target
 * definition rather than guessed here, so a new entity brings its own path.
 */
function revalidateTarget(entity: AttachmentTarget, entityId: number): void {
  revalidatePath(ATTACHMENT_TARGETS[entity].href(entityId))
}

/**
 * Stores the file, then records it.
 *
 * In that order, and the failure path matters: the bytes land on disk before
 * the row exists, so a failed insert must unlink them or the file is orphaned
 * with nothing pointing at it.
 */
export async function uploadAttachmentAction(
  _prev: AttachmentState,
  form: FormData,
): Promise<AttachmentState> {
  const target = readTarget(form)
  if (!target) return { ok: false, error: 'That record could not be identified.', message: null }

  const { siteId, actor } = await actorForOrThrow(writeCapabilityFor(target.entity))

  const file = form.get('file')
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'Choose a file to attach.', message: null }
  }

  const stored = await storeUpload(file)
  if (!stored.ok) return { ok: false, error: stored.error, message: null }

  try {
    const result = await createAttachment(siteId, actor, target.entity, target.entityId, {
      filename: stored.file.filename,
      storedName: stored.file.storedName,
      mimeType: stored.file.mimeType,
      sizeBytes: stored.file.sizeBytes,
      description: text(form, 'description'),
    })

    if (!result.ok) {
      await deleteStoredFile(stored.file.storedName)
      return { ok: false, error: result.error, message: null }
    }
  } catch (error) {
    // A thrown insert leaves the same orphan as a returned failure.
    await deleteStoredFile(stored.file.storedName)
    throw error
  }

  revalidateTarget(target.entity, target.entityId)
  return { ok: true, error: null, message: `Attached ${stored.file.filename}.` }
}

export async function renameAttachmentAction(
  _prev: AttachmentState,
  form: FormData,
): Promise<AttachmentState> {
  const target = readTarget(form)
  if (!target) return { ok: false, error: 'That record could not be identified.', message: null }

  const { siteId, actor } = await actorForOrThrow(writeCapabilityFor(target.entity))

  const attachmentId = Number(form.get('attachmentId'))
  if (!Number.isFinite(attachmentId) || attachmentId <= 0) {
    return { ok: false, error: 'That attachment could not be identified.', message: null }
  }

  const result = await updateAttachment(
    siteId,
    actor,
    target.entity,
    target.entityId,
    attachmentId,
    {
      filename: text(form, 'filename') ?? undefined,
      description: form.has('description') ? text(form, 'description') : undefined,
    },
  )
  if (!result.ok) return { ok: false, error: result.error, message: null }

  revalidateTarget(target.entity, target.entityId)
  return { ok: true, error: null, message: 'Attachment updated.' }
}

/**
 * Removes the row, then the bytes.
 *
 * In that order. The reverse leaves a row pointing at nothing, which reads on
 * screen as a working attachment that 404s when clicked — worse than an
 * orphaned file nobody can see.
 */
export async function deleteAttachmentAction(
  _prev: AttachmentState,
  form: FormData,
): Promise<AttachmentState> {
  const target = readTarget(form)
  if (!target) return { ok: false, error: 'That record could not be identified.', message: null }

  const { siteId, actor } = await actorForOrThrow(writeCapabilityFor(target.entity))

  const attachmentId = Number(form.get('attachmentId'))
  if (!Number.isFinite(attachmentId) || attachmentId <= 0) {
    return { ok: false, error: 'That attachment could not be identified.', message: null }
  }

  const result = await deleteAttachment(
    siteId,
    actor,
    target.entity,
    target.entityId,
    attachmentId,
  )
  if (!result.ok) return { ok: false, error: result.error, message: null }

  await deleteStoredFile(result.storedName)

  revalidateTarget(target.entity, target.entityId)
  return { ok: true, error: null, message: 'Attachment removed.' }
}

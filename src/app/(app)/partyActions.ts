'use server'

import { revalidatePath } from 'next/cache'
import { requireActor, actorFor, actorForOrThrow } from '@/lib/auth'
import {
  createContact,
  updateContact,
  deleteContact,
  type ContactInput,
  type PartyKind,
} from '@/lib/site/partyContacts'
import {
  createDocument,
  deleteDocument,
  updateDocument,
} from '@/lib/site/partyDocuments'
import {
  createComment,
  updateComment,
  deleteComment,
  setCommentPinned,
} from '@/lib/site/partyComments'
import { storeUpload, deleteStoredFile } from '@/lib/uploads'

/**
 * Contacts, documents and comments — for customers and suppliers alike.
 *
 * One file rather than a copy in each folder. These three features are
 * identical on both screens, and the party is already a parameter all the way
 * down through lib/site. Splitting them would mean fixing every bug twice.
 *
 * Every action returns its result instead of redirecting: these all fire from
 * panels embedded in a page that must stay where it is. A redirect would throw
 * the user back to the top of the account and lose the tab they were on.
 */

// Note: a 'use server' module may only export async functions, so the idle
// state every useActionState() starts from lives in the panel components
// rather than here.
export type PartyActionState = { ok: boolean; error: string | null; message: string | null }

/**
 * Both account screens, so either is correct after a write.
 *
 * The list page too: a contact change alters what the "Contact" column shows.
 */
function revalidateParty(party: PartyKind, partyId: number): void {
  const base = party === 'customer' ? '/customers' : '/suppliers'
  revalidatePath(base)
  revalidatePath(`${base}/${partyId}`)
}

/**
 * Reads and checks the party from a form.
 *
 * PartyKind reaches SQL as a table name in partyContacts, so it is validated
 * against the two literals here rather than cast. Everything past this point
 * can treat it as trusted.
 */
function readParty(form: FormData): { party: PartyKind; partyId: number } | null {
  const raw = String(form.get('party') ?? '')
  if (raw !== 'customer' && raw !== 'supplier') return null

  const partyId = Number(form.get('partyId'))
  if (!Number.isFinite(partyId) || partyId <= 0) return null

  return { party: raw, partyId }
}

function text(form: FormData, key: string): string | null {
  return String(form.get(key) ?? '').trim() || null
}

/* ── Contacts ─────────────────────────────────────────────────────────────── */

export async function saveContactAction(
  _prev: PartyActionState,
  form: FormData,
): Promise<PartyActionState> {
  const ctx = await actorForOrThrow('customers.edit')
  const { siteId, actor } = ctx
  const target = readParty(form)
  if (!target) return { ok: false, error: 'That account could not be identified.', message: null }

  const input: ContactInput = {
    name: String(form.get('name') ?? ''),
    role: text(form, 'role'),
    email: text(form, 'email'),
    phone: text(form, 'phone'),
    notes: text(form, 'notes'),
    isPrimary: form.get('isPrimary') === 'on' || form.get('isPrimary') === '1',
  }

  const idRaw = String(form.get('contactId') ?? '').trim()
  const result = idRaw
    ? await updateContact(siteId, actor, target.party, Number(idRaw), input)
    : await createContact(siteId, actor, target.party, target.partyId, input)

  if (!result.ok) return { ok: false, error: result.error, message: null }

  revalidateParty(target.party, target.partyId)
  return {
    ok: true,
    error: null,
    message: idRaw ? `Updated ${input.name.trim()}.` : `Added ${input.name.trim()}.`,
  }
}

export async function deleteContactAction(
  _prev: PartyActionState,
  form: FormData,
): Promise<PartyActionState> {
  const ctx = await actorForOrThrow('customers.edit')
  const { siteId, actor } = ctx
  const target = readParty(form)
  if (!target) return { ok: false, error: 'That account could not be identified.', message: null }

  const contactId = Number(form.get('contactId'))
  if (!Number.isFinite(contactId) || contactId <= 0) {
    return { ok: false, error: 'That contact could not be identified.', message: null }
  }

  const result = await deleteContact(siteId, actor, target.party, contactId)
  if (!result.ok) return { ok: false, error: result.error, message: null }

  revalidateParty(target.party, target.partyId)
  return { ok: true, error: null, message: 'Contact removed.' }
}

/* ── Documents ────────────────────────────────────────────────────────────── */

/**
 * Stores the file, then records it.
 *
 * In that order, and the failure path matters: the bytes land on disk before
 * the row exists, so a failed insert must unlink them or the file is orphaned
 * with nothing pointing at it.
 */
export async function uploadDocumentAction(
  _prev: PartyActionState,
  form: FormData,
): Promise<PartyActionState> {
  const ctx = await actorForOrThrow('customers.edit')
  const { siteId, actor } = ctx
  const target = readParty(form)
  if (!target) return { ok: false, error: 'That account could not be identified.', message: null }

  const file = form.get('file')
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'Choose a file to upload.', message: null }
  }

  const stored = await storeUpload(file)
  if (!stored.ok) return { ok: false, error: stored.error, message: null }

  try {
    const result = await createDocument(siteId, actor, target.party, target.partyId, {
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

  revalidateParty(target.party, target.partyId)
  return { ok: true, error: null, message: `${stored.file.filename} attached.` }
}

export async function renameDocumentAction(
  _prev: PartyActionState,
  form: FormData,
): Promise<PartyActionState> {
  const ctx = await actorForOrThrow('customers.edit')
  const { siteId, actor } = ctx
  const target = readParty(form)
  if (!target) return { ok: false, error: 'That account could not be identified.', message: null }

  const documentId = Number(form.get('documentId'))
  if (!Number.isFinite(documentId) || documentId <= 0) {
    return { ok: false, error: 'That document could not be identified.', message: null }
  }

  const result = await updateDocument(
    siteId,
    actor,
    target.party,
    target.partyId,
    documentId,
    { filename: String(form.get('filename') ?? ''), description: text(form, 'description') },
  )
  if (!result.ok) return { ok: false, error: result.error, message: null }

  revalidateParty(target.party, target.partyId)
  return { ok: true, error: null, message: 'Document updated.' }
}

export async function deleteDocumentAction(
  _prev: PartyActionState,
  form: FormData,
): Promise<PartyActionState> {
  const ctx = await actorForOrThrow('customers.edit')
  const { siteId, actor } = ctx
  const target = readParty(form)
  if (!target) return { ok: false, error: 'That account could not be identified.', message: null }

  const documentId = Number(form.get('documentId'))
  if (!Number.isFinite(documentId) || documentId <= 0) {
    return { ok: false, error: 'That document could not be identified.', message: null }
  }

  const result = await deleteDocument(siteId, actor, target.party, target.partyId, documentId)
  if (!result.ok) return { ok: false, error: result.error, message: null }

  // Row first, file second — see deleteDocument for why that order.
  await deleteStoredFile(result.storedName)

  revalidateParty(target.party, target.partyId)
  return { ok: true, error: null, message: 'Document removed.' }
}

/* ── Comments ─────────────────────────────────────────────────────────────── */

export async function saveCommentAction(
  _prev: PartyActionState,
  form: FormData,
): Promise<PartyActionState> {
  const ctx = await actorForOrThrow('customers.edit')
  const { siteId, actor } = ctx
  const target = readParty(form)
  if (!target) return { ok: false, error: 'That account could not be identified.', message: null }

  const body = String(form.get('body') ?? '')
  const idRaw = String(form.get('commentId') ?? '').trim()

  const result = idRaw
    ? await updateComment(siteId, actor, target.party, target.partyId, Number(idRaw), body)
    : await createComment(
        siteId,
        actor,
        target.party,
        target.partyId,
        body,
        form.get('isPinned') === 'on' || form.get('isPinned') === '1',
      )

  if (!result.ok) return { ok: false, error: result.error, message: null }

  revalidateParty(target.party, target.partyId)
  return { ok: true, error: null, message: idRaw ? 'Comment updated.' : 'Comment added.' }
}

export async function pinCommentAction(
  _prev: PartyActionState,
  form: FormData,
): Promise<PartyActionState> {
  const ctx = await actorForOrThrow('customers.edit')
  const { siteId, actor } = ctx
  const target = readParty(form)
  if (!target) return { ok: false, error: 'That account could not be identified.', message: null }

  const commentId = Number(form.get('commentId'))
  if (!Number.isFinite(commentId) || commentId <= 0) {
    return { ok: false, error: 'That comment could not be identified.', message: null }
  }

  const pinned = form.get('pinned') === '1'
  const result = await setCommentPinned(
    siteId,
    actor,
    target.party,
    target.partyId,
    commentId,
    pinned,
  )
  if (!result.ok) return { ok: false, error: result.error, message: null }

  revalidateParty(target.party, target.partyId)
  return { ok: true, error: null, message: pinned ? 'Comment pinned.' : 'Comment unpinned.' }
}

export async function deleteCommentAction(
  _prev: PartyActionState,
  form: FormData,
): Promise<PartyActionState> {
  const ctx = await actorForOrThrow('customers.edit')
  const { siteId, actor } = ctx
  const target = readParty(form)
  if (!target) return { ok: false, error: 'That account could not be identified.', message: null }

  const commentId = Number(form.get('commentId'))
  if (!Number.isFinite(commentId) || commentId <= 0) {
    return { ok: false, error: 'That comment could not be identified.', message: null }
  }

  const result = await deleteComment(siteId, actor, target.party, target.partyId, commentId)
  if (!result.ok) return { ok: false, error: result.error, message: null }

  revalidateParty(target.party, target.partyId)
  return { ok: true, error: null, message: 'Comment removed.' }
}

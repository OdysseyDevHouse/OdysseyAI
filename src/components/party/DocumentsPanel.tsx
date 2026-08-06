'use client'

import { useActionState, useEffect, useRef, useState } from 'react'
import {
  Button,
  buttonClass,
  ConfirmModal,
  EmptyState,
  Field,
  FileInput,
  Input,
  Modal,
  useToast,
  Icons,
} from '@/components/ui'
import type { PartyDocument } from '@/lib/site/partyDocuments'
import type { PartyKind } from '@/lib/site/partyContacts'
import {
  uploadDocumentAction,
  renameDocumentAction,
  deleteDocumentAction,
  type PartyActionState,
} from '@/app/(app)/partyActions'

/**
 * Files attached to an account — the signed credit application, a BEE
 * certificate, proof of payment.
 *
 * Upload goes through a server action, which is why next.config.mjs raises
 * serverActions.bodySizeLimit; download goes through /api/documents/[id],
 * because a server action cannot hand the browser a file.
 */

const IDLE: PartyActionState = { ok: false, error: null, message: null }

/** Icon by extension. A grid of identical page glyphs is a grid nobody scans. */
function iconFor(filename: string) {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic'].includes(ext)) {
    return <Icons.FileImage size={16} />
  }
  if (['.xls', '.xlsx', '.csv', '.ods'].includes(ext)) return <Icons.FileSpreadsheet size={16} />
  if (ext === '.zip') return <Icons.FileArchive size={16} />
  if (ext === '.pdf') return <Icons.FileText size={16} />
  return <Icons.FileIcon size={16} />
}

/**
 * Bytes as something a person reads.
 *
 * Decimal units, matching what Windows and every browser download panel show —
 * being technically right about 1024 here would just make the number disagree
 * with the one next to it in Explorer.
 */
function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`
  const units = ['kB', 'MB', 'GB']
  let value = bytes / 1000
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

function formatDate(value: Date | string): string {
  const d = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' })
}

export default function DocumentsPanel({
  party,
  partyId,
  documents,
}: {
  party: PartyKind
  partyId: number
  documents: PartyDocument[]
}) {
  const toast = useToast()
  const [uploadState, uploadAction, uploading] = useActionState(uploadDocumentAction, IDLE)
  const [renameState, renameAction, renaming] = useActionState(renameDocumentAction, IDLE)
  const [deleteState, deleteAction, deleting] = useActionState(deleteDocumentAction, IDLE)

  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<PartyDocument | null>(null)
  const [removing, setRemoving] = useState<PartyDocument | null>(null)

  // Reset so the same file can be picked again after a failed upload — a file
  // input keeps its selection, and re-choosing an identical path fires no
  // change event.
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (uploadState.message) {
      toast.success(uploadState.message)
      setAdding(false)
      if (fileRef.current) fileRef.current.value = ''
    } else if (uploadState.error) {
      toast.error(uploadState.error)
    }
  }, [uploadState, toast])

  useEffect(() => {
    if (renameState.message) {
      toast.success(renameState.message)
      setEditing(null)
    } else if (renameState.error) {
      toast.error(renameState.error)
    }
  }, [renameState, toast])

  useEffect(() => {
    if (deleteState.message) {
      toast.success(deleteState.message)
      setRemoving(null)
    } else if (deleteState.error) {
      toast.error(deleteState.error)
    }
  }, [deleteState, toast])

  /** The party pair every download needs — see the route for why. */
  const hrefFor = (doc: PartyDocument) =>
    `/api/documents/${doc.id}?party=${party}&partyId=${partyId}`

  return (
    <>
      <div className="flex flex-col gap-4 p-5">
        {documents.length === 0 ? (
          <EmptyState
            icon={<Icons.Paperclip size={28} strokeWidth={1.75} />}
            title="No documents yet"
            hint="Attach the signed credit application, a BEE certificate, or anything else worth keeping with this account."
            action={
              <Button type="button" onClick={() => setAdding(true)}>
                <Icons.Upload size={15} />
                Upload document
              </Button>
            }
          />
        ) : (
          <>
            <ul className="flex flex-col divide-y divide-border rounded-card border border-border">
              {documents.map((doc) => (
                <li key={doc.id} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="shrink-0 text-faint">{iconFor(doc.filename)}</span>

                  <div className="min-w-0 flex-1">
                    {/* The filename is the download link: it is what the user
                        is looking for, so it is also what they click. */}
                    <a
                      href={hrefFor(doc)}
                      className="block truncate text-sm font-medium text-ink hover:text-brand hover:underline"
                    >
                      {doc.filename}
                    </a>
                    <p className="mt-0.5 truncate text-xs text-muted">
                      {doc.description ? `${doc.description} · ` : ''}
                      <span className="numeric">{formatSize(doc.sizeBytes)}</span> ·{' '}
                      {formatDate(doc.createdAt)}
                      {doc.uploadedName ? ` · ${doc.uploadedName}` : ''}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    {/* A plain <a>, not ButtonLink: that renders a Next <Link>,
                        which would try to client-side navigate to a binary
                        response. This must be a real browser download.
                        data-kit-ok — the kit's link button is the wrong tool
                        here rather than a missing variant. */}
                    <a
                      data-kit-ok
                      href={hrefFor(doc)}
                      aria-label={`Download ${doc.filename}`}
                      className={buttonClass({ variant: 'ghost', size: 'sm', iconOnly: true })}
                    >
                      <Icons.Download size={15} />
                    </a>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label={`Rename ${doc.filename}`}
                      onClick={() => setEditing(doc)}
                    >
                      <Icons.Pencil size={15} />
                    </Button>
                    <Button
                      type="button"
                      variant="danger-ghost"
                      size="sm"
                      iconOnly
                      aria-label={`Remove ${doc.filename}`}
                      onClick={() => setRemoving(doc)}
                    >
                      <Icons.Trash size={15} />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>

            <div>
              <Button type="button" variant="secondary" onClick={() => setAdding(true)}>
                <Icons.Upload size={15} />
                Upload document
              </Button>
            </div>
          </>
        )}
      </div>

      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="Upload a document"
        description="PDF, image, Office, text, email or ZIP. Up to 10MB."
        closeOnBackdrop={false}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" form="document-upload-form" disabled={uploading}>
              <Icons.Upload size={15} />
              {uploading ? 'Uploading…' : 'Upload'}
            </Button>
          </>
        }
      >
        <form id="document-upload-form" action={uploadAction} className="flex flex-col gap-4">
          <input type="hidden" name="party" value={party} />
          <input type="hidden" name="partyId" value={partyId} />

          <Field label="File">
            <FileInput ref={fileRef} name="file" required />
          </Field>

          <Field label="Description" hint="Optional. What this is, since a filename often is not.">
            <Input name="description" maxLength={400} placeholder="e.g. Signed credit application" />
          </Field>

          {uploadState.error && (
            <p role="alert" className="text-sm text-danger">
              {uploadState.error}
            </p>
          )}
        </form>
      </Modal>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title="Rename document"
        description="Changes what it is called here and when downloaded. The file itself is untouched."
        closeOnBackdrop={false}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button type="submit" form="document-rename-form" disabled={renaming}>
              <Icons.Save size={15} />
              {renaming ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        {editing && (
          <form id="document-rename-form" action={renameAction} className="flex flex-col gap-4">
            <input type="hidden" name="party" value={party} />
            <input type="hidden" name="partyId" value={partyId} />
            <input type="hidden" name="documentId" value={editing.id} />

            <Field label="Name">
              <Input name="filename" defaultValue={editing.filename} required maxLength={255} autoFocus />
            </Field>
            <Field label="Description">
              <Input name="description" defaultValue={editing.description ?? ''} maxLength={400} />
            </Field>

            {renameState.error && (
              <p role="alert" className="text-sm text-danger">
                {renameState.error}
              </p>
            )}
          </form>
        )}
      </Modal>

      <ConfirmModal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          const form = new FormData()
          form.set('party', party)
          form.set('partyId', String(partyId))
          form.set('documentId', String(removing?.id ?? 0))
          deleteAction(form)
        }}
        title="Delete this document?"
        message={
          <>
            <strong className="text-ink">{removing?.filename}</strong> will be permanently deleted
            from the server. This cannot be undone.
          </>
        }
        confirmLabel="Delete document"
        busy={deleting}
      />
    </>
  )
}

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
import {
  uploadAttachmentAction,
  renameAttachmentAction,
  deleteAttachmentAction,
  type AttachmentState,
} from '@/app/(app)/attachmentActions'
import type { AttachmentTarget } from '@/lib/attachmentTargets'

/**
 * The paperwork a record came from.
 *
 * The supplier's PDF against the GRV keyed from it, the receipt against an
 * expense, the remittance advice against a bank line. Filed on the record
 * rather than under the party, because "the invoice GRV-00412 came from" is
 * found by opening GRV-00412 — not by scrolling two years of that supplier's
 * documents.
 *
 * Upload goes through a server action, which is why next.config.mjs raises
 * serverActions.bodySizeLimit; download goes through /api/attachments/[id],
 * because a server action cannot hand the browser a file.
 */

/* Declared here rather than imported from the actions module: that file is
   'use server', where every export has to be an async function. Same reason the
   party panels each hold their own. */
const IDLE: AttachmentState = { ok: false, error: null, message: null }

/** What the panel is showing, so a record's own screen can say it plainly. */
export type AttachmentView = {
  id: number
  filename: string
  description: string | null
  sizeBytes: number
  uploadedName: string
  /** Serialised before crossing the boundary — a Date does not survive it. */
  createdAt: string
}

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

function formatDate(value: string): string {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' })
}

export function AttachmentsPanel({
  entity,
  entityId,
  attachments,
  canEdit = true,
  hint,
}: {
  entity: AttachmentTarget
  entityId: number
  attachments: AttachmentView[]
  /** False renders read-only: files can be downloaded but not added or removed. */
  canEdit?: boolean
  /** What is worth attaching here, for the empty state. */
  hint?: string
}) {
  const toast = useToast()
  const [uploadState, uploadAction, uploading] = useActionState(uploadAttachmentAction, IDLE)
  const [renameState, renameAction, renaming] = useActionState(renameAttachmentAction, IDLE)
  const [deleteState, deleteAction, deleting] = useActionState(deleteAttachmentAction, IDLE)

  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<AttachmentView | null>(null)
  const [removing, setRemoving] = useState<AttachmentView | null>(null)

  // Reset so the same file can be picked again after a failed upload — a file
  // input keeps its selection, and re-choosing an identical path fires no
  // change event.
  const fileRef = useRef<HTMLInputElement>(null)

  useAnnounce(uploadState, toast, () => {
    setAdding(false)
    if (fileRef.current) fileRef.current.value = ''
  })
  useAnnounce(renameState, toast, () => setEditing(null))
  useAnnounce(deleteState, toast, () => setRemoving(null))

  /** The pair every download needs — see the route for why it is not id alone. */
  const hrefFor = (a: AttachmentView) =>
    `/api/attachments/${a.id}?entity=${entity}&entityId=${entityId}`

  const formId = `attachment-${entity}-${entityId}`

  return (
    <>
      <div className="flex flex-col gap-4">
        {attachments.length === 0 ? (
          <EmptyState
            icon={<Icons.Paperclip size={28} strokeWidth={1.75} />}
            title="Nothing attached"
            hint={
              hint ??
              'Attach the document this record was captured from, so the evidence sits with the entry rather than in someone’s inbox.'
            }
            action={
              canEdit ? (
                <Button type="button" onClick={() => setAdding(true)}>
                  <Icons.Upload size={15} />
                  Attach a file
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <ul className="flex flex-col divide-y divide-border rounded-card border border-border">
              {attachments.map((a) => (
                <li key={a.id} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="shrink-0 text-faint">{iconFor(a.filename)}</span>

                  <div className="min-w-0 flex-1">
                    {/* The filename is the download link: it is what the user
                        is looking for, so it is also what they click. */}
                    <a
                      href={hrefFor(a)}
                      className="block truncate text-sm font-medium text-ink hover:text-brand hover:underline"
                    >
                      {a.filename}
                    </a>
                    <p className="mt-0.5 truncate text-xs text-muted">
                      {a.description ? `${a.description} · ` : ''}
                      <span className="numeric">{formatSize(a.sizeBytes)}</span> ·{' '}
                      {formatDate(a.createdAt)}
                      {a.uploadedName ? ` · ${a.uploadedName}` : ''}
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
                      href={hrefFor(a)}
                      aria-label={`Download ${a.filename}`}
                      className={buttonClass({ variant: 'ghost', size: 'sm', iconOnly: true })}
                    >
                      <Icons.Download size={15} />
                    </a>
                    {canEdit && (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          iconOnly
                          aria-label={`Rename ${a.filename}`}
                          onClick={() => setEditing(a)}
                        >
                          <Icons.Pencil size={15} />
                        </Button>
                        <Button
                          type="button"
                          variant="danger-ghost"
                          size="sm"
                          iconOnly
                          aria-label={`Remove ${a.filename}`}
                          onClick={() => setRemoving(a)}
                        >
                          <Icons.Trash size={15} />
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>

            {canEdit && (
              <div>
                <Button type="button" variant="secondary" onClick={() => setAdding(true)}>
                  <Icons.Upload size={15} />
                  Attach a file
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="Attach a file"
        description="PDF, image, Office, text, email or ZIP. Up to 10MB."
        closeOnBackdrop={false}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" form={`${formId}-upload`} disabled={uploading}>
              <Icons.Upload size={15} />
              {uploading ? 'Uploading…' : 'Attach'}
            </Button>
          </>
        }
      >
        <form id={`${formId}-upload`} action={uploadAction} className="flex flex-col gap-4">
          <input type="hidden" name="entity" value={entity} />
          <input type="hidden" name="entityId" value={entityId} />

          <Field label="File">
            <FileInput ref={fileRef} name="file" required />
          </Field>

          <Field
            label="Description"
            hint="Optional. What this is, since a filename often is not."
          >
            <Input name="description" maxLength={400} placeholder="e.g. Supplier invoice 88213" />
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
        title="Rename attachment"
        description="Changes what it is called here and when downloaded. The file itself is untouched."
        closeOnBackdrop={false}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button type="submit" form={`${formId}-rename`} disabled={renaming}>
              <Icons.Save size={15} />
              {renaming ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        {editing && (
          <form id={`${formId}-rename`} action={renameAction} className="flex flex-col gap-4">
            <input type="hidden" name="entity" value={entity} />
            <input type="hidden" name="entityId" value={entityId} />
            <input type="hidden" name="attachmentId" value={editing.id} />

            <Field label="Name">
              <Input
                name="filename"
                defaultValue={editing.filename}
                required
                maxLength={255}
                autoFocus
              />
            </Field>
            <Field label="Description">
              <Input
                name="description"
                defaultValue={editing.description ?? ''}
                maxLength={400}
              />
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
          if (!removing) return
          const form = new FormData()
          form.set('entity', entity)
          form.set('entityId', String(entityId))
          form.set('attachmentId', String(removing.id))
          deleteAction(form)
        }}
        title="Remove this attachment?"
        message={
          <>
            <strong className="text-ink">{removing?.filename}</strong> will be deleted from the
            server. This cannot be undone — if it is the only copy of a supplier&rsquo;s invoice,
            it is gone.
          </>
        }
        confirmLabel="Remove"
        busy={deleting}
      />
    </>
  )
}

/**
 * Toast on an action's result, once per result.
 *
 * The three action states are handled identically, so the effect is written
 * once rather than copied three times with a different setter in each — which
 * is how one of them ends up not clearing its modal.
 */
function useAnnounce(
  state: AttachmentState,
  toast: ReturnType<typeof useToast>,
  onSuccess: () => void,
): void {
  useEffect(() => {
    if (state.message) {
      toast.success(state.message)
      onSuccess()
    } else if (state.error) {
      toast.error(state.error)
    }
    // onSuccess is redefined each render; depending on it would fire the toast
    // on every render rather than on every result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, toast])
}

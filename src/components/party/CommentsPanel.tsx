'use client'

import { useActionState, useEffect, useRef, useState } from 'react'
import {
  Badge,
  Button,
  Checkbox,
  ConfirmModal,
  EmptyState,
  Field,
  Modal,
  Textarea,
  useToast,
  Icons,
} from '@/components/ui'
import type { PartyComment } from '@/lib/site/partyComments'
import type { PartyKind } from '@/lib/site/partyContacts'
import {
  saveCommentAction,
  pinCommentAction,
  deleteCommentAction,
  type PartyActionState,
} from '@/app/(app)/partyActions'

/**
 * What people said about this account.
 *
 * Not the Activity tab, which records what the system observed someone DO, and
 * not the notes field, which describes the account as it stands today. This is
 * a dated, attributed remark: "spoke to Sarah, paying Friday". See the header
 * of partyComments.ts for why all three exist.
 *
 * The composer sits at the top rather than the bottom. This is a log read
 * newest-first, not a chat read oldest-first, so the box and the most recent
 * entry belong next to each other.
 */

const IDLE: PartyActionState = { ok: false, error: null, message: null }

/**
 * A timestamp a person reads at a glance.
 *
 * Relative for the last week, because "2 hours ago" is what matters on a note
 * about a call. Absolute after that, because "43 days ago" is not.
 */
function formatWhen(value: Date | string): string {
  const d = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(d.getTime())) return ''

  const seconds = Math.round((Date.now() - d.getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} d ago`

  return d.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' })
}

/** Initials for the author chip, so a thread is scannable by who wrote what. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export default function CommentsPanel({
  party,
  partyId,
  comments,
}: {
  party: PartyKind
  partyId: number
  comments: PartyComment[]
}) {
  const toast = useToast()
  const [saveState, saveAction, saving] = useActionState(saveCommentAction, IDLE)
  const [pinState, pinAction] = useActionState(pinCommentAction, IDLE)
  const [deleteState, deleteAction, deleting] = useActionState(deleteCommentAction, IDLE)

  const [editing, setEditing] = useState<PartyComment | null>(null)
  const [removing, setRemoving] = useState<PartyComment | null>(null)

  // Cleared by hand after a successful post: the composer is uncontrolled, so
  // React will not reset it, and leaving the text sitting there reads as though
  // the save failed.
  const composerRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    if (saveState.message) {
      toast.success(saveState.message)
      setEditing(null)
      composerRef.current?.reset()
    } else if (saveState.error) {
      toast.error(saveState.error)
    }
  }, [saveState, toast])

  useEffect(() => {
    if (pinState.error) toast.error(pinState.error)
  }, [pinState, toast])

  useEffect(() => {
    if (deleteState.message) {
      toast.success(deleteState.message)
      setRemoving(null)
    } else if (deleteState.error) {
      toast.error(deleteState.error)
    }
  }, [deleteState, toast])

  return (
    <>
      <div className="flex flex-col gap-5 p-5">
        {/* Composer */}
        <form ref={composerRef} action={saveAction} className="flex flex-col gap-3">
          <input type="hidden" name="party" value={party} />
          <input type="hidden" name="partyId" value={partyId} />

          <Textarea
            name="body"
            rows={3}
            required
            maxLength={4000}
            placeholder="Add a comment — what was said, what was agreed, what to chase."
            aria-label="New comment"
          />

          <div className="flex items-center justify-between gap-4">
            <Checkbox name="isPinned" label="Pin to the top" />
            <Button type="submit" disabled={saving}>
              <Icons.MessageSquare size={15} />
              {saving ? 'Saving…' : 'Add comment'}
            </Button>
          </div>

          {saveState.error && !editing && (
            <p role="alert" className="text-sm text-danger">
              {saveState.error}
            </p>
          )}
        </form>

        {comments.length === 0 ? (
          <EmptyState
            icon={<Icons.MessageSquare size={28} strokeWidth={1.75} />}
            title="No comments yet"
            hint="Record what was said on a call, what was agreed, or anything the next person to open this account should know."
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {comments.map((comment) => (
              <li
                key={comment.id}
                className={`rounded-card border px-4 py-3 ${
                  // A pinned note is the exception in the list, so it gets the
                  // colour. Everything else stays quiet — see odyssey-craft.
                  comment.isPinned ? 'border-brand/40 bg-brand-soft' : 'border-border bg-surface'
                }`}
              >
                <div className="flex items-start gap-3">
                  {/* Initials chip. A circular avatar is not a kit component
                      and should not become one for a single use.
                      data-kit-ok */}
                  <span
                    data-kit-ok
                    className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-pill bg-surface-2 text-[11px] font-semibold text-ink-2"
                    aria-hidden="true"
                  >
                    {initials(comment.authorName)}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-ink">
                        {comment.authorName || 'Unknown user'}
                      </span>
                      <span className="text-xs text-muted">{formatWhen(comment.createdAt)}</span>
                      {comment.edited && <span className="text-xs text-faint">(edited)</span>}
                      {comment.isPinned && (
                        <Badge tone="brand">
                          <Icons.Pin size={11} />
                          Pinned
                        </Badge>
                      )}
                    </div>

                    {/* whitespace-pre-wrap so the line breaks someone typed
                        survive. The body is plain text and is escaped by React,
                        so there is no markup to sanitise. */}
                    <p className="mt-1 text-sm whitespace-pre-wrap text-ink-2">{comment.body}</p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label={comment.isPinned ? 'Unpin comment' : 'Pin comment'}
                      onClick={() => {
                        const form = new FormData()
                        form.set('party', party)
                        form.set('partyId', String(partyId))
                        form.set('commentId', String(comment.id))
                        form.set('pinned', comment.isPinned ? '0' : '1')
                        pinAction(form)
                      }}
                    >
                      {comment.isPinned ? <Icons.PinOff size={15} /> : <Icons.Pin size={15} />}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label="Edit comment"
                      onClick={() => setEditing(comment)}
                    >
                      <Icons.Pencil size={15} />
                    </Button>
                    <Button
                      type="button"
                      variant="danger-ghost"
                      size="sm"
                      iconOnly
                      aria-label="Delete comment"
                      onClick={() => setRemoving(comment)}
                    >
                      <Icons.Trash size={15} />
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title="Edit comment"
        closeOnBackdrop={false}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button type="submit" form="comment-edit-form" disabled={saving}>
              <Icons.Save size={15} />
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        {editing && (
          <form id="comment-edit-form" action={saveAction} className="flex flex-col gap-4">
            <input type="hidden" name="party" value={party} />
            <input type="hidden" name="partyId" value={partyId} />
            <input type="hidden" name="commentId" value={editing.id} />

            <Field label="Comment">
              <Textarea name="body" defaultValue={editing.body} rows={5} required maxLength={4000} autoFocus />
            </Field>

            {saveState.error && (
              <p role="alert" className="text-sm text-danger">
                {saveState.error}
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
          form.set('commentId', String(removing?.id ?? 0))
          deleteAction(form)
        }}
        title="Delete this comment?"
        message="The comment will be removed from this account. This cannot be undone."
        confirmLabel="Delete comment"
        busy={deleting}
      />
    </>
  )
}

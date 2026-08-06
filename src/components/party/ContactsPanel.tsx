'use client'

import { useActionState, useEffect, useState } from 'react'
import {
  Badge,
  Button,
  ConfirmModal,
  EmptyState,
  Field,
  Input,
  Modal,
  Checkbox,
  Textarea,
  useToast,
  Icons,
} from '@/components/ui'
import type { PartyContact, PartyKind } from '@/lib/site/partyContacts'
import {
  saveContactAction,
  deleteContactAction,
  type PartyActionState,
} from '@/app/(app)/partyActions'

/**
 * The people at an account.
 *
 * Saves independently of the account form, the same way SerialsPanel does and
 * for the same reason: a contact is a record in its own right, and losing three
 * captured contacts because an unrelated field on the account failed validation
 * would be indefensible. That independence is why this panel owns its own
 * <form> elements and is rendered outside the account form.
 *
 * The account's own email and phone are deliberately still on that form. This
 * list is people; that field is where the business is reached. See the header
 * of 028_party_contacts_documents_comments.sql.
 */

const IDLE: PartyActionState = { ok: false, error: null, message: null }

/** A blank row for the "add" dialog. */
const BLANK = { id: 0, name: '', role: '', email: '', phone: '', notes: '', isPrimary: false }

type Draft = typeof BLANK

function toDraft(contact: PartyContact): Draft {
  return {
    id: contact.id,
    name: contact.name,
    role: contact.role ?? '',
    email: contact.email ?? '',
    phone: contact.phone ?? '',
    notes: contact.notes ?? '',
    isPrimary: contact.isPrimary,
  }
}

export default function ContactsPanel({
  party,
  partyId,
  contacts,
}: {
  party: PartyKind
  partyId: number
  contacts: PartyContact[]
}) {
  const toast = useToast()
  const [saveState, saveAction, saving] = useActionState(saveContactAction, IDLE)
  const [deleteState, deleteAction, deleting] = useActionState(deleteContactAction, IDLE)

  /** Null when the dialog is shut; a draft when adding or editing. */
  const [editing, setEditing] = useState<Draft | null>(null)
  const [removing, setRemoving] = useState<PartyContact | null>(null)

  // Toast on the way out, and close whichever dialog was open. Driven off the
  // action state rather than fired at the call site so a failure keeps the
  // dialog up with the message still on screen.
  useEffect(() => {
    if (saveState.message) {
      toast.success(saveState.message)
      setEditing(null)
    } else if (saveState.error) {
      toast.error(saveState.error)
    }
    // The state object identity changes on every submission, which is exactly
    // when this should re-run.
  }, [saveState, toast])

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
      <div className="flex flex-col gap-4 p-5">
        {contacts.length === 0 ? (
          <EmptyState
            title="No contacts yet"
            hint="Add the people you deal with at this account — the buyer, the accounts clerk, whoever answers after hours. The account's own email and phone stay on the Details tab."
            action={
              <Button type="button" onClick={() => setEditing({ ...BLANK })}>
                <Icons.UserPlus size={15} />
                Add contact
              </Button>
            }
          />
        ) : (
          <>
            <ul className="flex flex-col divide-y divide-border rounded-card border border-border">
              {contacts.map((contact) => (
                <li key={contact.id} className="flex items-start gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-ink">{contact.name}</span>
                      {contact.isPrimary && (
                        <Badge tone="brand">
                          <Icons.Star size={11} />
                          Primary
                        </Badge>
                      )}
                      {contact.role && <span className="text-xs text-muted">{contact.role}</span>}
                    </div>

                    {/* Both are links: on a back-office screen the next thing
                        after finding a contact is almost always contacting
                        them, and a tel: on a desktop softphone saves a retype
                        of a number that is easy to get one digit wrong. */}
                    <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
                      {contact.email && (
                        <a
                          href={`mailto:${contact.email}`}
                          className="flex items-center gap-1.5 text-xs text-muted hover:text-brand hover:underline"
                        >
                          <Icons.Mail size={13} />
                          {contact.email}
                        </a>
                      )}
                      {contact.phone && (
                        <a
                          href={`tel:${contact.phone.replace(/[^+\d]/g, '')}`}
                          className="flex items-center gap-1.5 text-xs text-muted hover:text-brand hover:underline"
                        >
                          <Icons.Phone size={13} />
                          {contact.phone}
                        </a>
                      )}
                    </div>

                    {contact.notes && <p className="mt-1.5 text-xs text-muted">{contact.notes}</p>}
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label={`Edit ${contact.name}`}
                      onClick={() => setEditing(toDraft(contact))}
                    >
                      <Icons.Pencil size={15} />
                    </Button>
                    <Button
                      type="button"
                      variant="danger-ghost"
                      size="sm"
                      iconOnly
                      aria-label={`Remove ${contact.name}`}
                      onClick={() => setRemoving(contact)}
                    >
                      <Icons.Trash size={15} />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>

            <div>
              <Button type="button" variant="secondary" onClick={() => setEditing({ ...BLANK })}>
                <Icons.UserPlus size={15} />
                Add contact
              </Button>
            </div>
          </>
        )}
      </div>

      {/* Add / edit. One dialog for both — the only difference is whether a
          contactId goes along with it. */}
      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.id ? 'Edit contact' : 'Add contact'}
        description="A contact needs at least an email address or a phone number."
        /* Half-typed work: a stray click on the backdrop must not discard it. */
        closeOnBackdrop={false}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button type="submit" form="contact-form" disabled={saving}>
              <Icons.Save size={15} />
              {saving ? 'Saving…' : 'Save contact'}
            </Button>
          </>
        }
      >
        {editing && (
          <form id="contact-form" action={saveAction} className="flex flex-col gap-4">
            <input type="hidden" name="party" value={party} />
            <input type="hidden" name="partyId" value={partyId} />
            {editing.id > 0 && <input type="hidden" name="contactId" value={editing.id} />}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name">
                <Input name="name" defaultValue={editing.name} required maxLength={120} autoFocus />
              </Field>
              <Field label="Role" hint="Buyer, accounts, after hours…">
                <Input name="role" defaultValue={editing.role} maxLength={60} />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Email">
                <Input name="email" type="email" defaultValue={editing.email} maxLength={190} />
              </Field>
              <Field label="Phone">
                <Input name="phone" defaultValue={editing.phone} maxLength={40} />
              </Field>
            </div>

            <Field label="Notes" hint="Anything worth knowing before calling them.">
              <Textarea name="notes" defaultValue={editing.notes} rows={2} maxLength={400} />
            </Field>

            {/* Field carries the hint; Checkbox itself only takes a label. */}
            <Field
              label=""
              hint="The primary contact is the one to ask for by default. Only one per account — setting this moves it."
            >
              <Checkbox
                name="isPrimary"
                defaultChecked={editing.isPrimary}
                label="Primary contact"
              />
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
          form.set('contactId', String(removing?.id ?? 0))
          deleteAction(form)
        }}
        title="Remove this contact?"
        message={
          <>
            <strong className="text-ink">{removing?.name}</strong> will be removed from this
            account. Nothing else about the account changes.
          </>
        }
        confirmLabel="Remove contact"
        busy={deleting}
      />
    </>
  )
}

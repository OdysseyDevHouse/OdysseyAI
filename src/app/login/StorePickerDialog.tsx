'use client'

import { useEffect, useRef } from 'react'
import { useFormStatus } from 'react-dom'
import { ChevronRight, ShoppingBag, Store } from '@/components/ui/icons'
import type { SignInChoice } from '@/lib/auth'
import { selectSiteAction } from '../select-site/actions'
import styles from '../login.module.css'

/**
 * "Choose a store", shown over the login screen when the credentials were
 * accepted but the account opens more than one store.
 *
 * Not the kit's <Modal>: this sits on top of the login card, which is a
 * deliberate pixel-for-pixel port of Odyssey's own login and does not use the
 * token palette (see the note at the top of login.module.css). A kit dialog
 * would put OdysseyAI's blue and radii directly against Odyssey's. The native
 * <dialog> still does the real work — focus trap, Escape, and making the page
 * underneath inert.
 *
 * The full-page /select-site remains, for anyone who reaches it directly or is
 * sent there by a guard after their session has already been established.
 */

/** Disables every control while a choice is being submitted. */
function useSubmitting() {
  return useFormStatus().pending
}

function StoreRow({ site }: { site: SignInChoice }) {
  // Only this row's own form — useFormStatus reads the form it sits inside, so
  // clicking one store greys out that row and leaves the others alone.
  const pending = useSubmitting()
  return (
    /* Not <Button>: a two-line store row with a trailing chevron is a list
       item, not a labelled action. Styled by login.module.css so it matches
       the login card it sits on rather than the token palette. */
    <button data-kit-ok type="submit" className={styles.pickerRow} disabled={pending}>
      <span className={styles.pickerRowMain}>
        <span className={styles.pickerRowIcon}>
          <Store size={17} strokeWidth={1.8} aria-hidden="true" />
        </span>
        <span className="min-w-0">
          <span className={styles.pickerName}>{site.name}</span>
          <span className={styles.pickerCode}>{site.code}</span>
        </span>
      </span>
      <ChevronRight size={17} className={styles.pickerChevron} aria-hidden="true" />
    </button>
  )
}

function CancelButton() {
  return (
    /* Styled from login.module.css for the same reason as the rows above.
       No pending state: this posts a plain form, so the browser navigates
       away rather than React re-rendering it. */
    <button data-kit-ok type="submit" className={styles.pickerCancel}>
      Cancel
    </button>
  )
}

export default function StorePickerDialog({
  choices,
  next,
}: {
  choices: SignInChoice[]
  next: string
}) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    // showModal() throws if the dialog is already open.
    if (choices.length > 0 && !dialog.open) dialog.showModal()
  }, [choices.length])

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    // Escape would close the dialog natively and leave a signed-in session with
    // no store open, on a screen that still shows the login form. Cancelling is
    // a real action here, so let the Cancel button be the only way out.
    function onCancel(event: Event) {
      event.preventDefault()
    }
    dialog.addEventListener('cancel', onCancel)
    return () => dialog.removeEventListener('cancel', onCancel)
  }, [])

  if (choices.length === 0) return null

  return (
    <dialog ref={ref} className={styles.picker} aria-labelledby="store-picker-title">
      <div className={styles.pickerInner}>
        <div className={styles.pickerHead}>
          <span className={styles.pickerIcon}>
            <ShoppingBag size={22} strokeWidth={1.8} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 id="store-picker-title" className={styles.pickerTitle}>
              Choose a store
            </h2>
            <p className={styles.pickerSubtitle}>
              Your account has access to more than one store. Select which one to open.
            </p>
          </div>
        </div>

        <div className={styles.pickerList}>
          {choices.map((site) => (
            /* A form per row so the choice posts the same server action the
               full-page picker uses — one place decides whether this user may
               open this store. */
            <form key={site.id} action={selectSiteAction}>
              <input type="hidden" name="siteId" value={site.id} />
              {next && <input type="hidden" name="next" value={next} />}
              <StoreRow site={site} />
            </form>
          ))}
        </div>

        {/*
          Cancel SIGNS OUT rather than just closing the dialog. By the time the
          picker is shown the credentials have been accepted and a session
          cookie exists — it simply has no store open. Leaving that cookie in
          place would strand the account in a state where every screen bounces
          back to the picker, so backing out has to mean returning to the login
          form as a signed-out visitor.

          A plain POST to the existing signout route, not a server action: the
          route already exists for the full-page picker's "Sign out", and it
          responds with a 303 to '/', which reloads the login screen with the
          cookie gone.
        */}
        <form action="/api/auth/signout" method="post">
          <CancelButton />
        </form>
      </div>
    </dialog>
  )
}

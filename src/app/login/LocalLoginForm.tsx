'use client'

import { useActionState, useEffect, useRef, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { ArrowRight, Eye, EyeOff, Lock, User } from '@/components/ui/icons'
import styles from '../login.module.css'
import { localLoginAction, type LocalLoginState } from './localActions'
import { DEV_SIGN_IN, fillSignInForDebug } from '@/lib/devSignIn'

/**
 * Signing in on a shop's own machine: a name and a PIN.
 *
 * Same lockup and the same CSS module as the cloud form deliberately — a person
 * who has used Odyssey elsewhere should recognise this screen instantly, and
 * the only visible difference should be what the two fields ask for. See the
 * note at the top of login.module.css: the exception to the UI kit stops with
 * these screens.
 *
 * There is no "forgot" link. Nobody upstream can reset a PIN on this machine —
 * another back-office user does it on Setup → Users, which is a person in the
 * next room rather than an email.
 */

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button className={styles.button} type="submit" disabled={pending}>
      {pending ? 'Signing in…' : 'Sign in'}
      <ArrowRight className={styles.buttonIcon} size={19} strokeWidth={2} aria-hidden="true" />
    </button>
  )
}

export default function LocalLoginForm() {
  const [state, formAction] = useActionState<LocalLoginState, FormData>(localLoginAction, {
    error: null,
  })
  const [peek, setPeek] = useState(false)

  /*
   * A debug run of the desktop shell arrives with both fields already filled —
   * see lib/devSignIn.ts for what gates it, and why a browser never sees this.
   *
   * WRITTEN INTO THE DOM rather than turned into `defaultValue`, because these
   * inputs are uncontrolled and the server action reads the FORM, not React
   * state. An effect is the earliest this can happen either way: the answer
   * lives on `window`, so it does not exist while the page is being rendered on
   * the server.
   *
   * ON MOUNT ONLY, and only into an EMPTY field. React invokes an effect twice
   * in development, and this component also remounts when the action state
   * changes — so a version that assigned unconditionally could put the stored
   * PIN back over one somebody had just corrected after a failed sign-in, which
   * is worse than filling nothing in at all. The ref settles the first, the
   * emptiness check the second.
   *
   * It does not submit. Filling the form saves the typing; pressing the button
   * is how a person checks the form itself still works.
   */
  const nameRef = useRef<HTMLInputElement>(null)
  const pinRef = useRef<HTMLInputElement>(null)
  const filled = useRef(false)

  useEffect(() => {
    if (filled.current || !fillSignInForDebug()) return
    filled.current = true
    if (nameRef.current && !nameRef.current.value) nameRef.current.value = DEV_SIGN_IN.name
    if (pinRef.current && !pinRef.current.value) pinRef.current.value = DEV_SIGN_IN.pin
  }, [])

  return (
    <form action={formAction} className={styles.form}>
      <label className={styles.label}>
        Name
        <span className={styles.inputWrap}>
          <span className={styles.inputIcon}>
            <User size={18} strokeWidth={2} aria-hidden="true" />
          </span>
          <input
            ref={nameRef}
            className={`${styles.input} ${styles.inputWithIcon}`}
            type="text"
            name="name"
            autoComplete="username"
            autoCapitalize="words"
            required
            autoFocus
            placeholder="Your name"
          />
        </span>
      </label>

      <label className={styles.label}>
        PIN
        <span className={styles.passwordField}>
          <span className={styles.inputIcon}>
            <Lock size={18} strokeWidth={2} aria-hidden="true" />
          </span>
          <input
            ref={pinRef}
            className={`${styles.input} ${styles.inputWithIcon} ${styles.inputPeekable}`}
            type={peek ? 'text' : 'password'}
            name="pin"
            /* Digits, and a keypad on a touchscreen till-shaped machine.
               `one-time-code` rather than `current-password` so a browser does
               not offer to remember it — a PIN on a shared shop machine is the
               one credential that must not be filled in for whoever sits down
               next. */
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d*"
            required
            placeholder="••••"
          />
          <button
            type="button"
            className={styles.peek}
            onClick={() => setPeek((v) => !v)}
            aria-label={peek ? 'Hide PIN' : 'Show PIN'}
          >
            {peek ? (
              <EyeOff size={18} strokeWidth={2} aria-hidden="true" />
            ) : (
              <Eye size={18} strokeWidth={2} aria-hidden="true" />
            )}
          </button>
        </span>
      </label>

      {state.error && (
        <div className={styles.error} role="alert">
          {state.error}
        </div>
      )}

      <SubmitButton />
    </form>
  )
}

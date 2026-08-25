'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { ArrowRight, Eye, EyeOff, Lock, User } from '@/components/ui/icons'
import styles from '../login.module.css'
import { localLoginAction, type LocalLoginState } from './localActions'

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

  return (
    <form action={formAction} className={styles.form}>
      <label className={styles.label}>
        Name
        <span className={styles.inputWrap}>
          <span className={styles.inputIcon}>
            <User size={18} strokeWidth={2} aria-hidden="true" />
          </span>
          <input
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

'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { ArrowRight, Eye, EyeOff, Lock, Mail } from '@/components/ui/icons'
import styles from '../login.module.css'
import { loginAction, type LoginState } from './actions'

/**
 * The sign-in form.
 *
 * Styled from `login.module.css` rather than the UI kit: this screen is a
 * pixel-for-pixel port of the Odyssey POS login, which carries its own brand
 * blue and radii. See the note at the top of that file — the exception stops
 * here and must not spread to other screens.
 */

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button className={styles.button} type="submit" disabled={pending}>
      {pending ? 'Signing in…' : 'Sign in'}
      {!pending && (
        <ArrowRight className={styles.buttonIcon} size={19} strokeWidth={2} aria-hidden="true" />
      )}
    </button>
  )
}

export default function LoginForm({ next }: { next: string }) {
  const [state, formAction] = useActionState<LoginState, FormData>(loginAction, { error: null })
  const [showPassword, setShowPassword] = useState(false)

  return (
    <form action={formAction}>
      <input type="hidden" name="next" value={next} />

      <label className={styles.label}>
        Email
        <span className={styles.inputWrap}>
          <span className={styles.inputIcon}>
            <Mail size={18} strokeWidth={1.8} />
          </span>
          <input
            className={`${styles.input} ${styles.inputWithIcon}`}
            name="email"
            type="email"
            autoComplete="username"
            placeholder="you@company.com"
            required
            autoFocus
          />
        </span>
      </label>

      <label className={styles.label}>
        Password
        {/* The eye sits in the field's right padding — hence .inputPeekable on
            the input, so a long password never runs under the button. */}
        <span className={styles.passwordField}>
          <span className={styles.inputIcon}>
            <Lock size={18} strokeWidth={1.8} />
          </span>
          <input
            className={`${styles.input} ${styles.inputWithIcon} ${styles.inputPeekable}`}
            name="password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            placeholder="••••••••"
            required
          />
          <button
            type="button"
            className={styles.peek}
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            aria-pressed={showPassword}
            title={showPassword ? 'Hide password' : 'Show password'}
          >
            {showPassword ? (
              <EyeOff size={18} strokeWidth={1.8} />
            ) : (
              <Eye size={18} strokeWidth={1.8} />
            )}
          </button>
        </span>
      </label>

      <div className={styles.formRow}>
        <a href="/forgot-password" className={styles.forgotLink}>
          Forgot password?
        </a>
      </div>

      {state.error && (
        <div className={styles.error} role="alert">
          {state.error}
        </div>
      )}

      <SubmitButton />
    </form>
  )
}

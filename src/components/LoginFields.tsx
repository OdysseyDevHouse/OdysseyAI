import { Field, Input } from '@/components/ui'

/**
 * The email + password inputs. Presentational only — no action, no state — so
 * both the static screen and the wired form use the exact same markup.
 */
export default function LoginFields({ autoFocus = false }: { autoFocus?: boolean }) {
  return (
    <>
      <Field label="Email">
        <Input
          name="email"
          type="email"
          autoComplete="username"
          required
          autoFocus={autoFocus}
          placeholder="you@example.com"
        />
      </Field>

      <Field label="Password">
        <Input name="password" type="password" autoComplete="current-password" required />
      </Field>
    </>
  )
}

/**
 * The email + password inputs. Presentational only — no action, no state — so
 * both the static screen and the wired form use the exact same markup.
 */
export default function LoginFields({ autoFocus = false }: { autoFocus?: boolean }) {
  return (
    <>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted">Email</span>
        <input
          name="email"
          type="email"
          autoComplete="username"
          required
          autoFocus={autoFocus}
          placeholder="you@example.com"
          className="rounded-md border border-border bg-surface px-3 py-2.5 text-ink"
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted">Password</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="rounded-md border border-border bg-surface px-3 py-2.5 text-ink"
        />
      </label>
    </>
  )
}

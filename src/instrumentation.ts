/**
 * Why the server died, written down before it dies.
 *
 * ── THE FAILURE THIS EXISTS FOR ─────────────────────────────────────────────
 *
 * A tester saved a report on the live site: the toast said it saved, and about
 * a second later the browser showed an ASP.NET "Server Error in '/' Application"
 * page. That page cannot come from this app — it is IIS's, and `deploy/web.config`
 * sets `httpErrors existingResponse="PassThrough"` precisely so that a real
 * response from Next reaches the browser untouched. IIS only writes its own page
 * when there is NO response to pass through, which means the Node process either
 * died or dropped the connection mid-render.
 *
 * Nothing logged why. PM2 restarts the app (`autorestart`, `restart_delay: 2000`)
 * and the restart itself looks like the whole story in `pm2 list`; the stack that
 * caused it was never written anywhere, because an `uncaughtException` with no
 * handler prints to stderr only if the process gets that far, and an
 * `unhandledRejection` in Node 15+ terminates the process by default.
 *
 * So this file's job is narrow: make the NEXT occurrence name itself.
 *
 * ── THE TWO HOOKS, AND WHY BOTH ─────────────────────────────────────────────
 *
 * They catch different halves and neither covers the other:
 *
 *   · `onRequestError` is Next's own hook. It fires for an error Next CAUGHT —
 *     a Server Component that threw, a Server Action that rejected — and it
 *     knows the route and the request, which a bare stack does not. The app
 *     already has error boundaries for these, so they render a tidy screen
 *     rather than an IIS page; logging them is how a report that "sometimes
 *     fails" stops being anecdotal.
 *
 *   · `process.on('uncaughtException' | 'unhandledRejection')` catches the case
 *     Next never sees — the one that produces the IIS page. `(app)/error.tsx`
 *     describes exactly such a path in its own notes: an error thrown outside
 *     any boundary becomes an uncaughtException that leaves the stream
 *     unfinished. There is no boundary above that, so without this the only
 *     evidence is a bumped restart counter.
 *
 * ── WHY IT ONLY LOGS, AND DOES NOT SWALLOW ──────────────────────────────────
 *
 * The handlers deliberately re-raise nothing and suppress nothing: they write
 * the stack and let Node do what it was going to do. Keeping a process alive
 * after an uncaughtException leaves it in an unknown state — half-written
 * responses, a transaction nobody will commit — and a till or a counter is the
 * worst place to run a server that is pretending to be fine. PM2 restarting a
 * dead process is the correct outcome; the only thing missing was the reason.
 *
 * Written to stderr because PM2 routes stderr to `app/logs/error.log`
 * (`error_file` in deploy/ecosystem.config.js), which is the file the server
 * README already tells an operator to read.
 */

/** ISO timestamp, so a line can be matched against an IIS log entry. */
function stamp(): string {
  return new Date().toISOString()
}

/**
 * One error, flattened for a log file.
 *
 * `cause` and `AggregateError.errors` are walked because the interesting one is
 * often underneath: `lib/siteDb.ts` notes that the MySQL driver wraps a refused
 * socket in an AggregateError, and React wraps a render throw in another. A log
 * line naming only the outer error sends the reader to the wrong place.
 */
function describe(err: unknown, depth = 0): string {
  const pad = '  '.repeat(depth + 1)
  if (!(err instanceof Error)) return `${pad}${String(err)}`

  const lines = [`${pad}${err.name}: ${err.message}`]
  if (err.stack) {
    lines.push(
      ...err.stack
        .split('\n')
        .slice(1)
        .map((l) => `${pad}${l.trim()}`),
    )
  }
  // A digest is how a production error on the client is matched to this one.
  const digest = (err as { digest?: unknown }).digest
  if (digest !== undefined) lines.push(`${pad}digest: ${String(digest)}`)

  if (depth < 3) {
    const nested = err instanceof AggregateError ? err.errors : []
    for (const inner of nested) lines.push(`${pad}caused by (aggregate):`, describe(inner, depth + 1))
    if (err.cause !== undefined && err.cause !== null) {
      lines.push(`${pad}caused by:`, describe(err.cause, depth + 1))
    }
  }
  return lines.join('\n')
}

/**
 * Runs once per server instance, before the first request is served.
 *
 * Guarded on the Node runtime: `process.on` does not exist on the edge runtime,
 * and Next loads this file in both (see "Specifying the runtime" in
 * next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md).
 */
export function register(): void {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  process.on('uncaughtException', (err, origin) => {
    process.stderr.write(
      `\n[${stamp()}] UNCAUGHT EXCEPTION (${origin}) — the process is going down.\n` +
        `${describe(err)}\n`,
    )
  })

  process.on('unhandledRejection', (reason) => {
    process.stderr.write(
      `\n[${stamp()}] UNHANDLED REJECTION — the process is going down.\n` +
        `${describe(reason)}\n`,
    )
  })

  // A restart is the thing an operator sees in `pm2 list`; this is how they can
  // tell one restart from the next in the log.
  process.stderr.write(`[${stamp()}] odyssey-ai server started (pid ${process.pid}).\n`)
}

/**
 * An error Next caught while serving a request.
 *
 * Typed structurally rather than with `Instrumentation.onRequestError` so this
 * file carries no import: it is loaded before the app's module graph and a type
 * import here is one more thing that can fail at the worst moment.
 */
export function onRequestError(
  error: unknown,
  request: { path: string; method: string },
  context: { routePath: string; routeType: string; renderSource?: string },
): void {
  process.stderr.write(
    `\n[${stamp()}] REQUEST ERROR — ${request.method} ${request.path}\n` +
      `  route: ${context.routePath} (${context.routeType}${
        context.renderSource ? `, ${context.renderSource}` : ''
      })\n` +
      `${describe(error)}\n`,
  )
}

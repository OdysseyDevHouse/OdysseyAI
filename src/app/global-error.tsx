'use client'

import { useEffect, useState } from 'react'

/**
 * The screen a server error lands on, with the error on it.
 *
 * ── WHY NEXT'S OWN SCREEN IS NOT ENOUGH HERE ────────────────────────────────
 *
 * In production Next replaces a server error's message with "A server error
 * occurred" and a digest, before the browser ever sees it. That is correct for
 * a public web app: the reader might be anybody, and a stack trace tells them
 * about your database.
 *
 * A desktop install inverts the assumption. The only person who can read this
 * screen is the one standing at the machine — the shop's own owner, or a
 * technician mid-install — and withholding the cause from them buys nothing.
 * It cost three rebuild-and-reinstall cycles in one afternoon to learn things
 * the app already knew and would not say.
 *
 * So on the desktop build the real error is fetched back over the Electron
 * bridge and shown. In a browser there is no bridge, nothing is fetched, and
 * the screen falls back to the digest — which is all the web build should ever
 * show.
 *
 * ── WHY global-error AND NOT error ──────────────────────────────────────────
 *
 * This is the one that replaces the screen Next renders when a page fails
 * outright, which is the failure being diagnosed. It replaces the whole
 * document, so it has to render <html> and <body> itself — and it cannot use
 * the UI kit, because a broken root layout is exactly the case where the kit's
 * own styles may not have loaded.
 */

type Bridge = {
  diagnostics?: {
    recentErrors(): Promise<string[]>
    logPath(): Promise<string | null>
    openLog(): Promise<string | null>
  }
}

function bridge(): Bridge['diagnostics'] | null {
  if (typeof window === 'undefined') return null
  return (window as unknown as { odyssey?: Bridge }).odyssey?.diagnostics ?? null
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const [lines, setLines] = useState<string[] | null>(null)
  const [logFile, setLogFile] = useState<string | null>(null)

  useEffect(() => {
    const d = bridge()
    if (!d) return
    /* Best-effort on both. A diagnostic screen that throws while reporting a
       throw is worse than one that shows less than it hoped to. */
    d.recentErrors()
      .then((r) => setLines(r.slice(-8)))
      .catch(() => {})
    d.logPath()
      .then(setLogFile)
      .catch(() => {})
  }, [])

  const detail = lines?.length ? lines.join('\n') : null

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          background: '#f6f7f9',
          color: '#16191d',
          font: '15px/1.6 "Segoe UI", system-ui, sans-serif',
        }}
      >
        <div style={{ maxWidth: 760, width: '100%' }}>
          <h1 style={{ margin: '0 0 6px', fontSize: 22, fontWeight: 600 }}>
            This page couldn&rsquo;t load
          </h1>
          <p style={{ margin: '0 0 20px', color: '#667085' }}>
            Something failed on the server inside this app.
          </p>

          {detail ? (
            <>
              <div
                style={{
                  fontSize: 11,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  color: '#98a2b3',
                  marginBottom: 8,
                }}
              >
                What actually went wrong
              </div>
              <pre
                style={{
                  margin: '0 0 20px',
                  padding: 16,
                  background: '#ffffff',
                  border: '1px solid #e4e7ec',
                  borderRadius: 10,
                  maxHeight: 320,
                  overflow: 'auto',
                  fontSize: 12.5,
                  lineHeight: 1.55,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontFamily: '"Cascadia Mono", Consolas, monospace',
                }}
              >
                {detail}
              </pre>
            </>
          ) : (
            <p style={{ margin: '0 0 20px', color: '#667085' }}>
              {/* A browser, or a failure so early that nothing was captured.
                  The digest is what Next gives everybody; it is at least enough
                  to find the matching line in a server log. */}
              No details were captured. Quote the reference below when reporting this.
            </p>
          )}

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              onClick={() => reset()}
              style={{
                height: 36,
                padding: '0 16px',
                borderRadius: 8,
                border: '1px solid #2f6fed',
                background: '#2f6fed',
                color: '#fff',
                font: 'inherit',
                cursor: 'pointer',
              }}
            >
              Try again
            </button>
            {detail && (
              <button
                onClick={() => navigator.clipboard?.writeText(detail).catch(() => {})}
                style={{
                  height: 36,
                  padding: '0 16px',
                  borderRadius: 8,
                  border: '1px solid #d0d5dd',
                  background: '#fff',
                  color: '#16191d',
                  font: 'inherit',
                  cursor: 'pointer',
                }}
              >
                Copy details
              </button>
            )}
            {logFile && (
              <button
                onClick={() => bridge()?.openLog().catch(() => {})}
                style={{
                  height: 36,
                  padding: '0 16px',
                  borderRadius: 8,
                  border: '1px solid #d0d5dd',
                  background: '#fff',
                  color: '#16191d',
                  font: 'inherit',
                  cursor: 'pointer',
                }}
              >
                Show log file
              </button>
            )}
          </div>

          <p style={{ margin: '20px 0 0', fontSize: 12, color: '#98a2b3' }}>
            Reference {error.digest ?? 'none'}
            {logFile ? ` · ${logFile}` : ''}
          </p>
        </div>
      </body>
    </html>
  )
}

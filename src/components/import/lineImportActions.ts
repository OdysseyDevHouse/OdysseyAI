'use server'

import { actorForAny } from '@/lib/auth'
import { readDocumentLines, type LineReadResult } from '@/lib/import/documentLines'

/**
 * Reading a file of document lines for whichever screen asked.
 *
 * One action for orders, GRVs and stock takes, because all three want the same
 * thing: turn a file into resolved lines and tell me what did not resolve.
 * Nothing is written — the screen puts the lines in its grid and the user posts
 * them the normal way.
 *
 * Guarded on either purchasing or stock capability rather than a new one of its
 * own: this reads the product catalogue and returns nothing that the screen
 * calling it could not already see.
 */
export async function readLinesAction(input: {
  filename: string
  /** CSV text, for a text file. */
  text?: string
  /** Base64 bytes, for a workbook — XLSX cannot survive being read as text. */
  base64?: string
}): Promise<LineReadResult> {
  const ctx = await actorForAny('purchasing.edit', 'stock.adjust')
  if ('ok' in ctx) return { ok: false, error: ctx.error }

  const buffer = input.base64
    ? Uint8Array.from(atob(input.base64), (c) => c.charCodeAt(0)).buffer
    : undefined

  return readDocumentLines(ctx.siteId, {
    name: input.filename,
    text: input.text,
    buffer,
  })
}

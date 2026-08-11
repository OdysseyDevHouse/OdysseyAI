'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { specFor } from '@/lib/import/registry'
import { fieldsFor, type ExistingMode } from '@/lib/import/spec'
import { planImport } from '@/lib/import/plan'
import { detectDateFormat } from '@/lib/import/text'
import { applyBatch, type BatchRequest, type BatchResponse } from '@/lib/import/apply'
import type { Capability } from '@/lib/site/permissions'

/**
 * The wizard's server calls.
 *
 * ── WHAT CROSSES, AND WHAT DOES NOT ──────────────────────────────────────
 *
 * The FILE stays in the browser. It is read there, and only the columns being
 * planned or the chunk being written ever cross — 20,000 rows of parsed drafts
 * would be several megabytes against a 10MB action body limit, and a limit you
 * are under by luck is a limit you are over next month.
 *
 * PARSING stays on the server. A field's `parse` is a function, and functions
 * do not cross the server→client boundary, so the browser could not run them
 * even if it wanted to. Planning is therefore a round trip per file rather than
 * per row — one call for the whole review, not twenty thousand.
 */

export type FieldDescriptor = {
  key: string
  label: string
  aliases: string[]
  required: boolean
  hint?: string
  example?: string
  lookup?: string
}

export type PrepareResult =
  | { ok: true; fields: FieldDescriptor[] }
  | { ok: false; error: string }

/**
 * The columns this import knows about.
 *
 * Called once when the screen opens, because the price and location columns are
 * built from this site's own data — a spec cannot know them until the lookups
 * load. Only plain data crosses; the `parse` functions stay here.
 */
export async function prepareImportAction(entity: string): Promise<PrepareResult> {
  const spec = specFor(entity)
  if (!spec) return { ok: false, error: 'There is no import of that kind.' }

  const ctx = await actorFor(spec.capability as Capability)
  if ('ok' in ctx) return ctx

  const lookups = await spec.loadLookups(ctx.siteId)

  return {
    ok: true,
    fields: fieldsFor(spec, lookups).map((field) => ({
      key: field.key,
      label: field.label,
      aliases: [...field.aliases],
      required: field.required ?? false,
      hint: field.hint,
      example: field.example,
      lookup: field.lookup,
    })),
  }
}

export type PlanRequest = {
  entity: string
  headers: string[]
  rows: string[][]
  mapping: Record<string, number | null>
  mode: ExistingMode
  headerLine: number
}

export type WirePlan = {
  ready: { line: number; code: string; draft: Record<string, unknown>; existingId: number | null }[]
  skipped: { line: number; code: string }[]
  problems: { line: number; code: string; column?: string; value?: string; reason: string }[]
  unresolved: { kind: string; column: string; values: { value: string; rows: number }[] }[]
  counts: { total: number; create: number; update: number; skip: number; problem: number }
  dateFormat: string | null
}

export type PlanResult = { ok: true; plan: WirePlan } | { ok: false; error: string }

/**
 * Checks the whole file, writing nothing.
 *
 * The result is what the review screen shows and what the apply step then sends
 * back in chunks. Every row lands in ready, skipped or problems — none are
 * dropped, because "18,000 of 20,000 imported" is a number nobody can act on.
 */
export async function planImportAction(request: PlanRequest): Promise<PlanResult> {
  const spec = specFor(request.entity)
  if (!spec) return { ok: false, error: 'There is no import of that kind.' }

  const ctx = await actorFor(spec.capability as Capability)
  if ('ok' in ctx) return ctx

  const lookups = await spec.loadLookups(ctx.siteId)
  const fields = fieldsFor(spec, lookups)

  // The date format is decided from the file, once, and shown on the review
  // screen — a wrong guess has to be visible before it becomes 20,000 wrong
  // dates. See detectDateFormat on why it cannot be decided per row.
  lookups.dateFormat = sniffDates(fields, request.mapping, request.rows)

  const plan = planImport(
    spec, fields, lookups, request.mapping, request.rows,
    request.headers, request.mode, request.headerLine,
  )

  return {
    ok: true,
    plan: {
      ready: plan.ready,
      skipped: plan.skipped.map(({ line, code }) => ({ line, code })),
      problems: plan.problems,
      unresolved: plan.unresolved,
      counts: plan.counts,
      dateFormat: lookups.dateFormat,
    },
  }
}

/** Samples every mapped date column so one format governs the whole file. */
function sniffDates(
  fields: readonly { key: string; parse: unknown }[],
  mapping: Record<string, number | null>,
  rows: readonly string[][],
): string | null {
  const columns = fields
    .filter((f) => /date|anchor/i.test(f.key))
    .map((f) => mapping[f.key])
    .filter((c): c is number => c != null)

  if (columns.length === 0) return null
  return detectDateFormat(rows.flatMap((row) => columns.map((c) => row[c] ?? '')))
}

/**
 * Writes one chunk.
 *
 * Every row is re-validated and every reference re-resolved HERE, from the raw
 * draft, rather than being trusted from the browser. That is what stands in for
 * opening balances' re-plan-before-committing: the browser has held these rows
 * across a review step, and an account can be closed or a code taken in the
 * meantime.
 */
export async function applyBatchAction(request: BatchRequest): Promise<BatchResponse> {
  const spec = specFor(request.entity)
  if (!spec) return { ok: false, offset: request.offset, error: 'There is no import of that kind.' }

  const ctx = await actorFor(spec.capability as Capability)
  if ('ok' in ctx) return { ok: false, offset: request.offset, error: ctx.error }

  try {
    // Reloaded per batch, not carried from the browser, so a code created by an
    // earlier batch — or by somebody else entirely — is seen now.
    const lookups = await spec.loadLookups(ctx.siteId)
    lookups.dateFormat = request.dateFormat

    const outcomes = await applyBatch(spec, {
      siteId: ctx.siteId,
      actor: ctx.actor,
      lookups,
      mapped: new Set(request.mapped),
    }, request)

    revalidatePath(`/${spec.entity}`)
    return { ok: true, offset: request.offset, outcomes }
  } catch (error) {
    // Only infrastructure lands here — a row that fails comes back as a failed
    // outcome. The client halts on this rather than skipping ahead, because a
    // run that "finished" with a 200-row hole is worse than one that stopped.
    return {
      ok: false,
      offset: request.offset,
      error: error instanceof Error ? error.message : 'The import could not reach the database.',
    }
  }
}

export type { ExistingMode }

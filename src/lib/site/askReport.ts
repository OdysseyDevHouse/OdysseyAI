import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import type { Capability } from './permissions'
import { fieldsFor, getSource, sourcesFor, type CatalogSource } from '../reportBuilder/catalog'
import {
  inferPeriodKey,
  validateSpec,
  PERIOD_KEYS,
  type CustomReportSpec,
  type PeriodKey,
} from '../reportBuilder/spec'

/**
 * "Describe a report and have it built."
 *
 * The model turns a plain-English question into a CustomReportSpec — the exact
 * same object the builder produces — which is then validated against the
 * catalog and run by the ordinary engine.
 *
 * ── WHY IT EMITS A SPEC AND NOT SQL ──────────────────────────────────────────
 *
 * The catalog boundary is the whole security model of this feature (see the
 * header of reportBuilder/catalog.ts), and it holds here unchanged: the model
 * picks field KEYS from a list it is given, and the server composes every byte
 * of SQL from developer-authored expressions. A spec naming a field that does
 * not exist loses that field; it cannot reach the database. There is no prompt
 * that makes the model emit a table name, because the output schema has no
 * place to put one.
 *
 * Emitting a builder spec (rather than a narrower closed shape) also means an
 * AI-generated report is a first-class report: it opens in the builder, can be
 * edited by hand, saved, favourited, exported and scheduled, with no separate
 * code path. The AI is a way to START a report, not a different kind of report.
 *
 * ── WHAT THE MODEL IS SHOWN ──────────────────────────────────────────────────
 *
 * Only the sources and fields the CALLER may read. A user without cost access
 * is never shown the margin fields, so the model cannot propose a report that
 * would be stripped back on the way out and confuse everyone.
 */

const MODEL = 'claude-opus-5'

/** The AI call is metered by the provider — keep the shape small. */
const MAX_FIELDS_SHOWN = 60

export class AskNotConfiguredError extends Error {}

let cachedClient: Anthropic | null = null

function client(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new AskNotConfiguredError(
      'Report generation is not set up. An administrator needs to add an Anthropic API key.',
    )
  }
  cachedClient ??= new Anthropic()
  return cachedClient
}

export function isAskConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY
}

/* ── the schema the model must emit ────────────────────────────────────────── */

/**
 * A deliberately flat mirror of CustomReportSpec.
 *
 * Nested unions confuse structured output more than they help, and every field
 * is re-validated by validateSpec anyway — so the schema optimises for the
 * model getting it right first time rather than for expressing the type
 * exactly.
 */
function specSchema(source: CatalogSource, fieldKeys: string[]) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', description: 'A short title for the report.' },
      source: { type: 'string', enum: [source.key] },
      periodKey: { type: 'string', enum: PERIOD_KEYS },
      groupFields: {
        type: 'array',
        items: { type: 'string', enum: fieldKeys },
        description: 'Fields to group by. Empty for a list of individual records.',
      },
      columns: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            field: { type: 'string', enum: [...fieldKeys, '__rows'] },
            agg: {
              type: ['string', 'null'],
              enum: ['sum', 'avg', 'min', 'max', 'count', null],
            },
          },
          required: ['field', 'agg'],
        },
      },
      filters: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            field: { type: 'string', enum: fieldKeys },
            op: {
              type: 'string',
              enum: [
                'eq',
                'ne',
                'contains',
                'notContains',
                'startsWith',
                'endsWith',
                'in',
                'gt',
                'gte',
                'lt',
                'lte',
                'between',
                'isEmpty',
                'notEmpty',
              ],
            },
            value: { type: 'string' },
            value2: { type: ['string', 'null'] },
          },
          required: ['field', 'op', 'value', 'value2'],
        },
      },
      sortField: { type: ['string', 'null'], description: 'Field key to sort by.' },
      sortAgg: {
        type: ['string', 'null'],
        enum: ['sum', 'avg', 'min', 'max', 'count', null],
        description: 'If sorting a summarised column, which aggregate it uses.',
      },
      sortDir: { type: 'string', enum: ['asc', 'desc'] },
      limit: { type: 'number' },
      chartType: { type: 'string', enum: ['bar', 'line', 'pie'] },
    },
    required: [
      'name',
      'source',
      'periodKey',
      'groupFields',
      'columns',
      'filters',
      'sortField',
      'sortAgg',
      'sortDir',
      'limit',
      'chartType',
    ],
  } as const
}

/**
 * The structured output, from wherever the SDK put it.
 *
 * `output_config.format` CONSTRAINS what the model may emit, but only
 * `messages.parse()` pre-parses it into `parsed_output`. This module calls
 * `messages.create()`, which leaves the JSON in an ordinary text block — so
 * reading `parsed_output` alone found nothing and every question answered
 * "could not turn that into a report" no matter how good the response was.
 *
 * Reading both means an SDK upgrade that starts populating `parsed_output`
 * cannot break this, and neither can one that stops.
 */
function readJson<T>(response: { content: unknown[] }): T | null {
  const withParsed = response as { parsed_output?: T }
  if (withParsed.parsed_output) return withParsed.parsed_output

  for (const block of response.content) {
    const text = block as { type?: string; text?: string }
    if (text.type !== 'text' || !text.text) continue
    try {
      return JSON.parse(text.text) as T
    } catch {
      // Not the payload — a thinking summary or preamble. Keep looking.
    }
  }
  return null
}

/** Picking the dataset is its own decision, made before the fields are shown. */
function sourceSchema(sources: CatalogSource[]) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      source: { type: 'string', enum: sources.map((s) => s.key) },
      reasoning: { type: 'string', description: 'One sentence on why this dataset answers it.' },
    },
    required: ['source', 'reasoning'],
  } as const
}

const SOURCE_SYSTEM = `You choose which dataset answers a retail business question. You are given a list of datasets with descriptions. Pick exactly one — the one that most directly contains the information the question asks for.

Guidance:
- Questions about WHAT SOLD (products, quantities, margin) use the sales lines dataset, not the documents one.
- Questions counting INVOICES, BASKETS or AVERAGE SALE use the sales documents dataset.
- Questions about MONEY RECEIVED or payment methods use the payments dataset.
- Questions about STOCK ON HAND, valuation or reorder use the products dataset.
- Questions about WHO OWES US use the customers or customer ledger dataset.`

function buildSpecSystem(source: CatalogSource, today: string): string {
  return `You turn a retail manager's plain-English question into a structured report definition over the "${source.label}" dataset (${source.description}).

Today's date is ${today}.

RULES:

periodKey — the period the report covers. If the question names one ("last month", "this week"), use the matching key. If it names none, use "thisMonth".${
    source.shape === 'snapshot'
      ? ' This dataset is a snapshot of right now, so the period does not filter it — still return a value.'
      : ''
  }

groupFields — what each row of the report represents. "Sales by department" groups by department; "top products" groups by the product code and description. Leave EMPTY only when the user wants a list of individual records rather than a summary.

columns — the figures to show. When groupFields is non-empty every column needs an "agg":
  · sum for money and quantities (the usual choice)
  · avg for percentages and for "average X" questions
  · count for counting values
  · Use the special field "__rows" with agg "count" to count records — this is how you answer "how many invoices/sales/baskets".
When groupFields is EMPTY, set agg to null on every column.

filters — restrict which records are included. Prefer the smallest set that answers the question. Note that fields marked with an options list only accept those exact values.

sortField/sortAgg/sortDir — how to rank. For "top" or "best", sort desc on the main money or quantity column; for "worst" or "slowest", asc. sortAgg must match the agg you gave that column, or be null when the report is not summarised.

limit — how many rows. "Top 10" is 10. Default to 100 for summaries and 500 for record lists.

chartType — bar for comparisons between categories, line for anything over time (day/week/month), pie for shares of a whole.

Choose the fewest columns that answer the question well. Do not add columns the user did not ask about.`
}

/* ── the model's raw output, before validation ─────────────────────────────── */

type RawSpec = {
  name: string
  source: string
  periodKey: PeriodKey
  groupFields: string[]
  columns: { field: string; agg: string | null }[]
  filters: { field: string; op: string; value: string; value2: string | null }[]
  sortField: string | null
  sortAgg: string | null
  sortDir: 'asc' | 'desc'
  limit: number
  chartType: 'bar' | 'line' | 'pie'
}

export type AskResult = {
  spec: CustomReportSpec
  /** One line on why this dataset — shown under the generated report. */
  reasoning: string
}

/**
 * Turn a question into a runnable spec.
 *
 * Two calls rather than one: choosing the dataset and choosing its fields are
 * genuinely different decisions, and sending every field of every source in one
 * prompt is both large and worse — the model picks fields from a source it has
 * not committed to. Splitting also means the second call's schema can CONSTRAIN
 * the field keys to that one source, which is what makes an invalid field
 * nearly impossible rather than merely validated away afterwards.
 */
export async function askForReport(
  question: string,
  can: (c: Capability) => boolean,
  today: string,
): Promise<AskResult> {
  const trimmed = question.trim().slice(0, 500)
  if (!trimmed) throw new Error('Ask a question first.')

  const available = sourcesFor(can)
  if (available.length === 0) {
    throw new Error('You do not have access to any data to report on.')
  }

  const anthropic = client()

  // ── 1. which dataset ──────────────────────────────────────────────────────
  const sourceList = available
    .map((s) => `- ${s.key}: ${s.label} — ${s.description}`)
    .join('\n')

  const sourcePick = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2000,
    thinking: { type: 'adaptive' },
    system: SOURCE_SYSTEM,
    output_config: { format: { type: 'json_schema', schema: sourceSchema(available) } },
    messages: [
      {
        role: 'user',
        content: `Datasets available:\n${sourceList}\n\nQuestion: ${trimmed}`,
      },
    ],
  })

  if (sourcePick.stop_reason === 'refusal') {
    throw new Error('That question could not be processed. Try rephrasing it.')
  }

  const picked = readJson<{ source: string; reasoning: string }>(sourcePick)
  const source = picked ? available.find((s) => s.key === picked.source) : undefined
  if (!source) throw new Error('Could not work out which data answers that. Try rephrasing it.')

  // ── 2. the spec over that dataset ─────────────────────────────────────────
  const fields = fieldsFor(source, can).slice(0, MAX_FIELDS_SHOWN)
  const fieldKeys = fields.map((f) => f.key)
  const fieldList = fields
    .map((f) => {
      const bits = [`- ${f.key}: ${f.label}`]
      if (f.numeric) bits.push('(number)')
      if (f.type === 'currency') bits.push('(money)')
      if (f.type === 'percent') bits.push('(percentage)')
      if (f.options?.length) bits.push(`— one of: ${f.options.map((o) => o.value).join(', ')}`)
      else if (f.hint) bits.push(`— ${f.hint}`)
      return bits.join(' ')
    })
    .join('\n')

  const specPick = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    system: buildSpecSystem(source, today),
    output_config: {
      format: { type: 'json_schema', schema: specSchema(source, fieldKeys) },
    },
    messages: [
      { role: 'user', content: `Fields available:\n${fieldList}\n\nQuestion: ${trimmed}` },
    ],
  })

  if (specPick.stop_reason === 'refusal') {
    throw new Error('That question could not be processed. Try rephrasing it.')
  }

  const raw = readJson<RawSpec>(specPick)
  if (!raw) throw new Error('Could not turn that into a report. Try rephrasing it.')

  const spec = toSpec(raw, source.key, today)

  // The model's output is never trusted: the same validation the builder uses
  // runs here, and anything unrecognised is dropped rather than executed.
  const checked = validateSpec(spec)
  if (!checked.ok) throw new Error(checked.error)

  return { spec: checked.spec, reasoning: picked?.reasoning ?? '' }
}

/** Fold the flat model output into a real spec. */
function toSpec(raw: RawSpec, sourceKey: string, today: string): CustomReportSpec {
  const summarised = raw.groupFields.length > 0

  const columns = raw.columns.map((c) => ({
    field: c.field,
    ...(summarised && c.agg ? { agg: c.agg as CustomReportSpec['columns'][number]['agg'] } : {}),
  }))

  const filters = raw.filters.map((f) => ({
    field: f.field,
    op: f.op as CustomReportSpec['filters'][number]['op'],
    value: f.value,
    ...(f.value2 ? { value2: f.value2 } : {}),
  }))

  // The sort names an OUTPUT column, which for a summarised report carries the
  // aggregate suffix. Getting this wrong silently un-sorts the report, so it is
  // assembled here rather than asked of the model as a composite string.
  const sortKey = raw.sortField
    ? summarised && raw.sortAgg
      ? `${raw.sortField}_${raw.sortAgg}`
      : raw.sortField
    : null

  return {
    version: 1,
    name: raw.name,
    source: sourceKey,
    // A period key rather than the dates it resolves to — this is what stops a
    // saved "last month" report still reporting on last month next year.
    period: { key: normalisePeriod(raw.periodKey, today) },
    columns,
    filters,
    groupFields: raw.groupFields,
    totalFilters: [],
    ...(sortKey ? { sort: { key: sortKey, dir: raw.sortDir } } : {}),
    chartType: raw.chartType,
    limit: Math.max(1, Math.min(20000, Math.round(raw.limit) || 100)),
  }
}

/**
 * Keep a named period named.
 *
 * The model is given today's date and may resolve a period itself. If it
 * returns a key we recognise, use it as-is; the inferPeriodKey round-trip is
 * belt-and-braces for the case where a future schema lets it emit dates.
 */
function normalisePeriod(key: PeriodKey, today: string): PeriodKey {
  if (PERIOD_KEYS.includes(key) && key !== 'custom') return key
  return inferPeriodKey(today, today) ?? 'thisMonth'
}

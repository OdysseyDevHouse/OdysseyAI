'use client'

import { useEffect, useState } from 'react'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  EmptyState,
  Field,
  Icons,
  Input,
  Select,
  Textarea,
} from '@/components/ui'
import {
  DOC_BLOCK_CATALOG,
  type DetailRow,
  type DocBlock,
  type DocBlockAlign,
  type DocBlockSpan,
} from '@/lib/stationery/blocks'
import ColumnEditor from './ColumnEditor'

/**
 * The selected block's settings.
 *
 * A panel, not a dialog — laying out a document means touching six blocks in a
 * row, and a modal dismissed between each turns a two-minute job into five. It
 * stays put and follows the selection, the way KeyInspector does for the till's
 * quick keys.
 *
 * ── WHAT A BLOCK OFFERS DEPENDS ON WHAT IT IS ─────────────────────────────
 *
 * A rule has nothing to configure; a line table has the whole column editor. So
 * the body is a switch, and the shared controls — where it sits, how it aligns
 * — come first because they apply to nearly everything.
 */

export type TokenChoice = { key: string; label: string; section: string | null }

export default function BlockInspector({
  block,
  tokens,
  onChange,
}: {
  block: DocBlock | null
  /** Every field this caller may use. Already permission-filtered. */
  tokens: TokenChoice[]
  onChange: (patch: Partial<DocBlock>) => void
}) {
  if (!block) {
    return (
      <Card>
        <CardBody>
          <EmptyState
            icon={<Icons.FileText aria-hidden className="h-6 w-6" />}
            title="Nothing selected"
            hint="Click a block on the page to change what it shows."
          />
        </CardBody>
      </Card>
    )
  }

  const def = DOC_BLOCK_CATALOG[block.kind]
  const docTokens = tokens.filter((t) => t.section === null)
  const lineTokens = tokens.filter((t) => t.section === 'lines')

  return (
    <Card>
      <CardHeader title={def.label} description={def.hint} />
      <CardBody className="flex flex-col gap-4">
        {/* Where it sits. Not offered for a rule or a spacer, which span by
            nature and would only ever be half a hairline. */}
        {block.kind !== 'rule' && block.kind !== 'spacer' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Across the page"
              hint="Two half-width blocks in a row sit side by side."
            >
              <Select
                value={block.span ?? 'full'}
                onChange={(e) => onChange({ span: e.target.value as DocBlockSpan })}
              >
                <option value="full">Full width</option>
                <option value="left">Left half</option>
                <option value="right">Right half</option>
              </Select>
            </Field>
            <Field label="Text">
              <Select
                value={block.align ?? 'left'}
                onChange={(e) => onChange({ align: e.target.value as DocBlockAlign })}
              >
                <option value="left">Left</option>
                <option value="center">Centred</option>
                <option value="right">Right</option>
              </Select>
            </Field>
          </div>
        )}

        {/* A heading above the block, where one makes sense. */}
        {(block.kind === 'partyBlock' ||
          block.kind === 'detailList' ||
          block.kind === 'docTitle' ||
          block.kind === 'notes' ||
          block.kind === 'banking' ||
          block.kind === 'vatSummary') && (
          <Field
            label="Heading"
            hint="Printed above the block. Leave it empty for none."
          >
            <Input
              value={block.title ?? ''}
              placeholder={block.kind === 'docTitle' ? 'PURCHASE ORDER' : 'BILL TO'}
              onChange={(e) => onChange({ title: e.target.value })}
            />
          </Field>
        )}

        {/* Which fields, in what order. A tick list rather than a picker,
            because seeing what is NOT on the document matters as much. */}
        {def.picksTokens && block.kind !== 'detailList' && (
          <TokenTicks
            chosen={block.tokens ?? []}
            available={docTokens}
            onChange={(next) => onChange({ tokens: next })}
          />
        )}

        {block.kind === 'detailList' && (
          <DetailRows
            rows={block.rows ?? []}
            available={docTokens}
            onChange={(next) => onChange({ rows: next })}
          />
        )}

        {block.kind === 'lineTable' && (
          <Field
            label="Columns"
            hint="Drag to reorder. The heading is your wording; the field underneath decides the value."
          >
            <ColumnEditor
              columns={block.columns ?? []}
              available={lineTokens}
              onChange={(next) => onChange({ columns: next })}
            />
          </Field>
        )}

        {block.kind === 'text' && (
          <Field
            label="Your words"
            hint="A field in braces is filled in — try {doc.number}."
          >
            <Textarea
              rows={4}
              value={block.text ?? ''}
              onChange={(e) => onChange({ text: e.target.value })}
            />
          </Field>
        )}

        {block.kind === 'html' && (
          <Field
            label="Custom HTML"
            hint="Cleaned on save, like any template. Scripts and off-site images are removed."
          >
            <Textarea
              rows={6}
              className="font-mono text-xs"
              value={block.text ?? ''}
              onChange={(e) => onChange({ text: e.target.value })}
            />
          </Field>
        )}

        {(block.kind === 'rule' || block.kind === 'spacer') && (
          <p className="text-sm text-muted">Nothing to set — this block is just the gap.</p>
        )}
      </CardBody>
    </Card>
  )
}

/**
 * Which fields a block shows, and in what order.
 *
 * Ticking adds to the END rather than restoring a catalog order, because the
 * order on the page is the designer's: a letterhead that reads name, phone,
 * email is a decision, and re-sorting it on every tick would undo it.
 */
function TokenTicks({
  chosen,
  available,
  onChange,
}: {
  chosen: string[]
  available: TokenChoice[]
  onChange: (next: string[]) => void
}) {
  const move = (i: number, by: number) => {
    const j = i + by
    if (j < 0 || j >= chosen.length) return
    const next = [...chosen]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }

  return (
    <Field label="Fields" hint="Ticked fields print, in this order.">
      <div className="flex flex-col gap-3">
        {chosen.length > 0 && (
          <ul className="flex flex-col gap-1">
            {chosen.map((key, i) => {
              const def = available.find((a) => a.key === key)
              return (
                <li
                  key={key}
                  className="flex items-center justify-between gap-2 rounded-control border border-border px-2.5 py-1.5"
                >
                  <span className="min-w-0 truncate text-sm text-ink-2">
                    {def?.label ?? key}
                  </span>
                  <span className="flex shrink-0 items-center gap-0.5">
                    <Button
                      size="sm"
                      variant="ghost"
                      iconOnly
                      aria-label="Move up"
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                    >
                      <Icons.ChevronUp aria-hidden className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      iconOnly
                      aria-label="Move down"
                      disabled={i === chosen.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      <Icons.ChevronDown aria-hidden className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="danger-ghost"
                      iconOnly
                      aria-label={`Remove ${def?.label ?? key}`}
                      onClick={() => onChange(chosen.filter((k) => k !== key))}
                    >
                      <Icons.Trash aria-hidden className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                </li>
              )
            })}
          </ul>
        )}

        <Select
          aria-label="Add a field"
          value=""
          onChange={(e) => {
            if (!e.target.value) return
            onChange([...chosen, e.target.value])
            e.target.value = ''
          }}
        >
          <option value="">Add a field…</option>
          {available
            .filter((a) => !chosen.includes(a.key))
            .map((a) => (
              <option key={a.key} value={a.key}>
                {a.label}
              </option>
            ))}
        </Select>
      </div>
    </Field>
  )
}

/**
 * Labelled rows — "Required by", "Reference".
 *
 * The label is stored beside the field rather than taken from the catalog,
 * whose wording is written for a picker ("Payment terms (with unit)") and reads
 * wrong on a printed page. Storing it also means renaming a row can never
 * change which field it shows.
 */
function DetailRows({
  rows,
  available,
  onChange,
}: {
  rows: DetailRow[]
  available: TokenChoice[]
  onChange: (next: DetailRow[]) => void
}) {
  return (
    <Field label="Rows" hint="A label and a field. Rows whose field is empty hide themselves.">
      <div className="flex flex-col gap-3">
        <ul className="flex flex-col gap-1.5">
          {rows.map((r, i) => (
            <li key={`${r.token}-${i}`} className="flex items-center gap-2">
              <Input
                aria-label="Row label"
                className="min-w-0 flex-1"
                value={r.label}
                placeholder="Label"
                onChange={(e) =>
                  onChange(rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))
                }
              />
              <span className="shrink-0 text-xs text-faint">
                {available.find((a) => a.key === r.token)?.label ?? r.token}
              </span>
              <Button
                size="sm"
                variant="danger-ghost"
                iconOnly
                aria-label={`Remove the ${r.label || r.token} row`}
                onClick={() => onChange(rows.filter((_, j) => j !== i))}
              >
                <Icons.Trash aria-hidden className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>

        <Select
          aria-label="Add a row"
          value=""
          onChange={(e) => {
            const key = e.target.value
            if (!key) return
            const def = available.find((a) => a.key === key)
            onChange([...rows, { token: key, label: def?.label ?? key }])
            e.target.value = ''
          }}
        >
          <option value="">Add a row…</option>
          {available.map((a) => (
            <option key={a.key} value={a.key}>
              {a.label}
            </option>
          ))}
        </Select>
      </div>
    </Field>
  )
}

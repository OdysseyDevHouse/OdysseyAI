'use client'

import { Badge, Button, Icons, Input, Select } from '@/components/ui'
import {
  SLIP_BLOCK_INFO,
  SLIP_BLOCK_KINDS,
  MAX_SLIP_BLOCKS,
  type SlipBlock,
  type SlipBlockKind,
  type SlipSpec,
} from '@/lib/stationery/slip'

/**
 * The till slip's designer.
 *
 * ── A LIST, NOT A CANVAS ──────────────────────────────────────────────────
 *
 * A slip is 80mm of paper printed one line at a time by a head with no CSS, so
 * the only real choices are which blocks appear, in what order, and with what
 * emphasis. A drag-and-drop canvas would offer freedoms the printer cannot
 * honour — position, columns, fonts — and every one of them would be a
 * disappointment at the counter. Up and down is the whole geometry.
 *
 * ── REQUIRED BLOCKS CANNOT BE REMOVED ─────────────────────────────────────
 *
 * The sale, the totals, the VAT analysis and the number are what make the paper
 * a tax invoice. They can be reordered and restyled; their Remove button is
 * absent rather than disabled, because a control that exists but refuses is a
 * worse explanation than one that was never offered. The server enforces the
 * same rule regardless — this is the courtesy, not the boundary.
 */
export default function SlipBlockEditor({
  spec,
  onChange,
}: {
  spec: SlipSpec
  onChange: (next: SlipSpec) => void
}) {
  const blocks = spec.blocks

  const set = (next: SlipBlock[]) => onChange({ version: 1, blocks: next })

  const update = (i: number, patch: Partial<SlipBlock>) =>
    set(blocks.map((b, j) => (j === i ? { ...b, ...patch } : b)))

  const move = (i: number, by: number) => {
    const j = i + by
    if (j < 0 || j >= blocks.length) return
    const next = [...blocks]
    ;[next[i], next[j]] = [next[j], next[i]]
    set(next)
  }

  const remove = (i: number) => set(blocks.filter((_, j) => j !== i))

  const add = (kind: SlipBlockKind) => {
    if (blocks.length >= MAX_SLIP_BLOCKS) return
    set([...blocks, { kind }])
  }

  /* Only the repeatable blocks are offered — everything else is already on the
     slip or would be a duplicate the validator refuses. */
  const used = new Set(blocks.map((b) => b.kind))
  const addable = SLIP_BLOCK_KINDS.filter(
    (k) => k === 'text' || k === 'rule' || k === 'feed' || !used.has(k),
  )

  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-1.5">
        {blocks.map((b, i) => {
          const info = SLIP_BLOCK_INFO[b.kind]
          return (
            <li key={i} className="rounded-control border border-border px-3 py-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-ink">{info.label}</span>
                    {info.required && <Badge tone="brand">Required</Badge>}
                  </div>
                  <p className="mt-0.5 text-xs text-muted">{info.hint}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    aria-label="Move up"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    <Icons.ChevronUp aria-hidden className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    aria-label="Move down"
                    disabled={i === blocks.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <Icons.ChevronDown aria-hidden className="h-4 w-4" />
                  </Button>
                  {!info.required && (
                    <Button
                      size="sm"
                      variant="danger-ghost"
                      iconOnly
                      aria-label="Remove"
                      onClick={() => remove(i)}
                    >
                      <Icons.Trash aria-hidden className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>

              {/* A rule and a blank line have nothing to style. */}
              {b.kind !== 'rule' && b.kind !== 'feed' && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Select
                    aria-label="Alignment"
                    className="w-32"
                    value={b.align ?? 'left'}
                    onChange={(e) => update(i, { align: e.target.value as SlipBlock['align'] })}
                  >
                    <option value="left">Left</option>
                    <option value="center">Centred</option>
                    <option value="right">Right</option>
                  </Select>
                  <Select
                    aria-label="Size"
                    className="w-32"
                    value={String(b.size ?? 1)}
                    onChange={(e) =>
                      update(i, { size: Number(e.target.value) as SlipBlock['size'] })
                    }
                  >
                    <option value="1">Normal</option>
                    <option value="2">Large</option>
                    <option value="3">Largest</option>
                  </Select>
                  <Button
                    size="sm"
                    variant={b.bold ? 'secondary' : 'ghost'}
                    onClick={() => update(i, { bold: !b.bold })}
                  >
                    Bold
                  </Button>
                </div>
              )}

              {b.kind === 'text' && (
                <Input
                  className="mt-2"
                  placeholder="Leave empty to print the slip footer from Setup → Printing"
                  value={b.text ?? ''}
                  onChange={(e) => update(i, { text: e.target.value })}
                />
              )}
            </li>
          )
        })}
      </ol>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Add a block"
          className="w-56"
          value=""
          onChange={(e) => {
            if (e.target.value) add(e.target.value as SlipBlockKind)
            e.target.value = ''
          }}
        >
          <option value="">Add a block…</option>
          {addable.map((k) => (
            <option key={k} value={k}>
              {SLIP_BLOCK_INFO[k].label}
            </option>
          ))}
        </Select>
        <span className="text-xs text-muted">
          {blocks.length} of {MAX_SLIP_BLOCKS} blocks
        </span>
      </div>
    </div>
  )
}

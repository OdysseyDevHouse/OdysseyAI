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
  NumberInput,
  Select,
  Textarea,
} from '@/components/ui'
import {
  BAND_INFO,
  BAND_KEYS,
  DEFAULT_IMAGE_H,
  DEFAULT_BARCODE_PT,
  DEFAULT_QR_PT,
  DEFAULT_LOGO_HEIGHT,
  DOC_BLOCK_CATALOG,
  MAX_IMAGE_H,
  MAX_BARCODE_PT,
  MAX_QR_PT,
  MAX_LOGO_HEIGHT,
  MIN_IMAGE_H,
  MIN_BARCODE_PT,
  MIN_QR_PT,
  MIN_LOGO_HEIGHT,
  type BandKey,
  type DetailRow,
  type DocBlock,
  type DocBlockAlign,
} from '@/lib/stationery/blocks'
import { MIN_BLOCK_W, clampBlock } from '@/lib/stationery/geometry'
import { CONDITIONS, conditionDef, type ConditionRule } from '@/lib/stationery/conditions'
import { QR_TARGET_INFO, cleanCustomUrl, type QrTarget } from '@/lib/stationery/qrTarget'
import { BARCODE_SOURCE_INFO, type BarcodeSource } from '@/lib/stationery/barcodeSource'
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
  onRemove,
  pictures,
}: {
  block: DocBlock | null
  /** Every field this caller may use. Already permission-filtered. */
  tokens: TokenChoice[]
  onChange: (patch: Partial<DocBlock>) => void
  onRemove: () => void
  /** The shop's pictures, for an image block to choose from. */
  pictures: { id: number; label: string }[]
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
        <Position block={block} onChange={onChange} />

        {/* Where the block SITS is above; this is how its own text lines up
            inside whatever width it has. */}
        {block.kind !== 'rule' && block.kind !== 'spacer' && (
          <Field label="Text">
            <Select
              className="w-40"
              value={block.align ?? 'left'}
              onChange={(e) => onChange({ align: e.target.value as DocBlockAlign })}
            >
              <option value="left">Left</option>
              <option value="center">Centred</option>
              <option value="right">Right</option>
            </Select>
          </Field>
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

        {block.kind === 'barcode' && (
          <>
            <Field
              label="What it carries"
              hint={
                BARCODE_SOURCE_INFO.find((x) => x.source === (block.barcodeSource ?? 'docNumber'))
                  ?.hint
              }
            >
              <Select
                value={block.barcodeSource ?? 'docNumber'}
                onChange={(e) => onChange({ barcodeSource: e.target.value as BarcodeSource })}
              >
                {BARCODE_SOURCE_INFO.map((x) => (
                  <option key={x.source} value={x.source}>
                    {x.label}
                  </option>
                ))}
              </Select>
            </Field>

            {block.barcodeSource === 'custom' && (
              <Field
                label="The code"
                hint="Letters, digits and punctuation. Anything a barcode cannot carry is dropped."
              >
                <Input
                  value={block.barcodeText ?? ''}
                  placeholder="PROMO2026"
                  onChange={(e) => onChange({ barcodeText: e.target.value })}
                />
              </Field>
            )}

            <Field label="How tall the bars are" hint="Points. Short bars scan badly at an angle.">
              <div className="flex items-center gap-2">
                <NumberInput
                  aria-label="Barcode height"
                  className="w-24"
                  value={block.barcodeHeight ?? DEFAULT_BARCODE_PT}
                  min={MIN_BARCODE_PT}
                  max={MAX_BARCODE_PT}
                  step={5}
                  onChange={(e) => {
                    const n = Number(e.target.value)
                    if (!Number.isFinite(n)) return
                    onChange({
                      barcodeHeight: Math.min(
                        Math.max(Math.round(n), MIN_BARCODE_PT),
                        MAX_BARCODE_PT,
                      ),
                    })
                  }}
                />
                <span className="text-xs text-muted">pt</span>
              </div>
            </Field>
          </>
        )}

        {block.kind === 'qr' && (
          <>
            <Field label="What it opens" hint={QR_TARGET_INFO.find((t) => t.target === (block.qrTarget ?? 'store'))?.hint}>
              <Select
                value={block.qrTarget ?? 'store'}
                onChange={(e) => onChange({ qrTarget: e.target.value as QrTarget })}
              >
                {QR_TARGET_INFO.map((t) => (
                  <option key={t.target} value={t.target}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </Field>

            {block.qrTarget === 'custom' && <QrUrlField block={block} onChange={onChange} />}

            <Field label="Words underneath" hint='Optional — "Scan to rate us".'>
              <Input
                value={block.qrCaption ?? ''}
                placeholder="Scan to visit our shop"
                onChange={(e) => onChange({ qrCaption: e.target.value })}
              />
            </Field>

            <Field label="How big" hint="Points. Below about 50 a phone struggles at arm's length.">
              <div className="flex items-center gap-2">
                <NumberInput
                  aria-label="QR size"
                  className="w-24"
                  value={block.qrSize ?? DEFAULT_QR_PT}
                  min={MIN_QR_PT}
                  max={MAX_QR_PT}
                  step={10}
                  onChange={(e) => {
                    const n = Number(e.target.value)
                    if (!Number.isFinite(n)) return
                    onChange({ qrSize: Math.min(Math.max(Math.round(n), MIN_QR_PT), MAX_QR_PT) })
                  }}
                />
                <span className="text-xs text-muted">pt</span>
              </div>
            </Field>
          </>
        )}

        {block.kind === 'image' && (
          <>
            <Field
              label="Which picture"
              hint={
                pictures.length === 0
                  ? 'You have not uploaded any pictures yet — there is an uploader below the designer.'
                  : 'Your own pictures. Upload more below the designer.'
              }
            >
              <Select
                value={block.imageId ? String(block.imageId) : ''}
                onChange={(e) => {
                  const n = Number(e.target.value)
                  onChange({ imageId: Number.isInteger(n) && n > 0 ? n : undefined })
                }}
              >
                {/* A block with no picture chosen yet prints nothing, so the
                    empty option is a real state rather than a placeholder. */}
                <option value="">— none —</option>
                {pictures.map((p) => (
                  <option key={p.id} value={String(p.id)}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="How tall to print it"
              hint="Points. The width follows, so the picture keeps its shape."
            >
              <div className="flex items-center gap-2">
                <NumberInput
                  aria-label="Picture height"
                  className="w-24"
                  value={block.imageHeight ?? DEFAULT_IMAGE_H}
                  min={MIN_IMAGE_H}
                  max={MAX_IMAGE_H}
                  step={10}
                  onChange={(e) => {
                    const n = Number(e.target.value)
                    if (!Number.isFinite(n)) return
                    onChange({
                      imageHeight: Math.min(Math.max(Math.round(n), MIN_IMAGE_H), MAX_IMAGE_H),
                    })
                  }}
                />
                <span className="text-xs text-muted">pt</span>
              </div>
            </Field>
          </>
        )}

        {block.kind === 'logo' && (
          <Field
            label="How tall to print it"
            hint="Points. The width follows, so the logo keeps its shape."
          >
            <div className="flex items-center gap-2">
              <NumberInput
                aria-label="Logo height"
                className="w-24"
                value={block.logoHeight ?? DEFAULT_LOGO_HEIGHT}
                min={MIN_LOGO_HEIGHT}
                max={MAX_LOGO_HEIGHT}
                step={4}
                onChange={(e) => {
                  const n = Number(e.target.value)
                  if (!Number.isFinite(n)) return
                  onChange({
                    logoHeight: Math.min(Math.max(Math.round(n), MIN_LOGO_HEIGHT), MAX_LOGO_HEIGHT),
                  })
                }}
              />
              <span className="text-xs text-muted">pt</span>
            </div>
          </Field>
        )}

        {(block.kind === 'rule' || block.kind === 'spacer') && (
          <p className="text-sm text-muted">Nothing to set — this block is just the gap.</p>
        )}

        {/*
          ── WHEN THIS BLOCK PRINTS ──────────────────────────────────────

          Last, and below everything about how the block LOOKS, because it is a
          question about the block as a whole rather than one more setting on
          its appearance. A shop reads down to it after deciding what the block
          says.

          Not offered on a required block: "show the TAX INVOICE heading only
          sometimes" is a document that is sometimes unlawful, and the answer to
          that is no rather than a warning.
        */}
        {!def.required && (
          <Field
            label="Show this"
            hint={conditionDef(block.showWhen)?.hint ?? 'On every document.'}
          >
            <Select
              className="w-56"
              value={block.showWhen ?? 'always'}
              onChange={(e) => {
                const rule = e.target.value
                // 'always' is stored as nothing — one representation of
                // unconditional, so a design cannot carry two.
                onChange({ showWhen: rule === 'always' ? undefined : (rule as ConditionRule) })
              }}
            >
              {CONDITIONS.map((c) => (
                <option key={c.rule} value={c.rule}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {/* Removing is here rather than on the block itself: a delete button
            floating over the page is one mis-click away from taking a
            letterhead out, and a required block has to be able to say no. */}
        {def.required ? (
          <p className="text-xs text-muted">
            Every document needs this block, so it cannot be removed.
          </p>
        ) : (
          <div>
            <Button variant="danger" size="sm" onClick={onRemove}>
              Remove this block
            </Button>
          </div>
        )}
      </CardBody>
    </Card>
  )
}

/**
 * Where the block sits, as numbers.
 *
 * Dragging is the way this is meant to be done. These are here for the cases
 * dragging is bad at: typing 0 to go exactly flush, matching a number read off
 * another block, and getting a block back that has been dragged somewhere
 * confusing. Every design tool carries both for the same reason.
 *
 * The band is a SELECT rather than a drag between bands, because moving between
 * bands is a change of meaning — "this prints after the items" — and not a
 * change of position. A block dragged across an invisible boundary would be
 * making that decision by accident.
 */
/**
 * The typed address for a custom QR target.
 *
 * ── WHY IT KEEPS ITS OWN COPY ─────────────────────────────────────────────
 *
 * The spec round-trips through parseSpec on every change — that is what keeps a
 * design honest — and parseSpec DROPS a qrUrl that is not a valid https
 * address. So writing each keystroke straight to the block meant the field
 * erased itself as you typed: "h", "ht", "htt" are all invalid, and none of
 * them survived the trip back.
 *
 * The draft therefore lives here and is pushed up on every change; the block
 * takes whatever it can use. The error then has something to describe, which it
 * did not before — the invalid value never existed long enough to be shown.
 */
function QrUrlField({
  block,
  onChange,
}: {
  block: DocBlock
  onChange: (patch: Partial<DocBlock>) => void
}) {
  const [draft, setDraft] = useState(block.qrUrl ?? '')

  /* Follow the block when the SELECTION changes — a different QR block has a
     different address — without fighting what is being typed into this one. */
  useEffect(() => {
    setDraft(block.qrUrl ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [block.id])

  const clean = cleanCustomUrl(draft)

  return (
    <Field
      label="The web address"
      hint="Must start with https. Check it before you print a thousand of them."
      error={draft.trim() && !clean ? 'That is not an https address.' : undefined}
    >
      <Input
        value={draft}
        placeholder="https://g.page/r/your-review-link"
        onChange={(e) => {
          const next = e.target.value
          setDraft(next)
          /*
           * Judged on what was just TYPED, not on `clean` — which describes the
           * previous draft and is one keystroke stale. Testing that meant the
           * first valid address never committed, because the value before it
           * was still invalid.
           *
           * Only a usable address reaches the design; a half-typed one leaves
           * the block's previous value alone rather than clearing it.
           */
          const cleanNext = cleanCustomUrl(next)
          if (cleanNext || next.trim() === '') onChange({ qrUrl: cleanNext ?? '' })
        }}
        onBlur={() => onChange({ qrUrl: clean ?? '' })}
      />
    </Field>
  )
}

function Position({
  block,
  onChange,
}: {
  block: DocBlock
  onChange: (patch: Partial<DocBlock>) => void
}) {
  const def = DOC_BLOCK_CATALOG[block.kind]

  return (
    <div className="flex flex-col gap-3">
      <Field
        label="Part of the page"
        hint={
          def.band
            ? 'The items table always prints here.'
            : BAND_INFO[block.band].hint
        }
      >
        <Select
          className="w-full"
          value={block.band}
          disabled={!!def.band}
          onChange={(e) => onChange({ band: e.target.value as BandKey })}
        >
          {BAND_KEYS.map((b) => (
            <option key={b} value={b}>
              {BAND_INFO[b].label}
            </option>
          ))}
        </Select>
      </Field>

      <div className="flex flex-wrap items-end gap-2">
        <Field label="Across" hint="% from the left">
          <NumberInput
            aria-label="Position across the page"
            className="w-20"
            value={block.x}
            min={0}
            max={100}
            step={0.5}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (Number.isFinite(n)) onChange(clampBlock({ x: n, y: block.y, w: block.w }))
            }}
          />
        </Field>
        <Field label="Down" hint="% down the band">
          <NumberInput
            aria-label="Position down the band"
            className="w-20"
            value={block.y}
            min={0}
            step={0.5}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (Number.isFinite(n)) onChange(clampBlock({ x: block.x, y: n, w: block.w }))
            }}
          />
        </Field>
        <Field label="Width" hint="% of the page">
          <NumberInput
            aria-label="Width"
            className="w-20"
            value={block.w}
            min={MIN_BLOCK_W}
            max={100}
            step={0.5}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (Number.isFinite(n)) onChange(clampBlock({ x: block.x, y: block.y, w: n }))
            }}
          />
        </Field>
      </div>
    </div>
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

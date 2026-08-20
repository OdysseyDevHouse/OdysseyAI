'use client'

import { Badge, Button, Card, CardBody, CardHeader, EmptyState, Field, Icons, Input, Select } from '@/components/ui'
import { SLIP_CONDITIONS, conditionDef, type ConditionRule } from '@/lib/stationery/conditions'
import { QR_TARGET_INFO, cleanCustomUrl, type QrTarget } from '@/lib/stationery/qrTarget'
import { BARCODE_SOURCE_INFO, type BarcodeSource } from '@/lib/stationery/barcodeSource'
import { SLIP_BLOCK_INFO, type SlipBlock } from '@/lib/stationery/slip'

/**
 * The selected slip block's settings.
 *
 * ── THE POINT OF THE WHOLE REWORK ─────────────────────────────────────────
 *
 * Changing the business name to centred used to mean finding "Business name" in
 * a list of seventeen settings and reading across to the right controls. Now the
 * name on the SLIP is the control: click it, and this panel shows the three
 * things a thermal head can actually do to it.
 *
 * ── THREE SETTINGS, BECAUSE THAT IS THE WHOLE VOCABULARY ──────────────────
 *
 * Align, size, weight. Not a reduced version of the A4 inspector — the complete
 * one for this device. A slip has no width to set, no position, no font: the
 * encoder's entire repertoire is align / bold / size / text / feed / cut, and
 * offering anything else would be offering a disappointment at the counter.
 *
 * A rule and a blank line have none of the three, and say so rather than showing
 * controls that do nothing.
 */
export default function SlipInspector({
  block,
  index,
  count,
  onChange,
  onRemove,
  onMove,
}: {
  block: SlipBlock | null
  index: number
  count: number
  onChange: (patch: Partial<SlipBlock>) => void
  onRemove: () => void
  onMove: (to: number) => void
}) {
  if (!block) {
    return (
      <Card>
        <CardBody>
          <EmptyState
            icon={<Icons.FileText aria-hidden className="h-6 w-6" />}
            title="Nothing selected"
            hint="Click a line on the slip to change how it prints."
          />
        </CardBody>
      </Card>
    )
  }

  const info = SLIP_BLOCK_INFO[block.kind]
  /*
   * A QR and a barcode are not stylable either, and for a more interesting
   * reason than a rule is: the PRINTER draws them. Align, size and bold are
   * commands about text, and the head positions a symbol as a unit at its own
   * module size — so offering the three would be offering settings the paper
   * ignores.
   */
  const stylable = block.kind !== 'rule' && block.kind !== 'feed' && block.kind !== 'qr' && block.kind !== 'barcode'

  return (
    <Card>
      <CardHeader
        title={info.label}
        description={info.hint}
        action={info.required ? <Badge tone="brand">Required</Badge> : undefined}
      />
      <CardBody className="flex flex-col gap-4">
        {stylable ? (
          <>
            <Field label="Across the slip">
              <Select
                className="w-full"
                value={block.align ?? 'left'}
                onChange={(e) => onChange({ align: e.target.value as SlipBlock['align'] })}
              >
                <option value="left">Left</option>
                <option value="center">Centred</option>
                <option value="right">Right</option>
              </Select>
            </Field>

            <Field label="How big" hint="The head prints in whole multiples, so there are three.">
              <Select
                className="w-full"
                value={String(block.size ?? 1)}
                onChange={(e) =>
                  onChange({ size: Number(e.target.value) as SlipBlock['size'] })
                }
              >
                <option value="1">Normal</option>
                <option value="2">Large</option>
                <option value="3">Largest</option>
              </Select>
            </Field>

            <Field label="Weight">
              <Button
                variant={block.bold ? 'secondary' : 'ghost'}
                onClick={() => onChange({ bold: !block.bold })}
              >
                {block.bold ? 'Bold' : 'Normal'}
              </Button>
            </Field>
          </>
        ) : block.kind === 'qr' || block.kind === 'barcode' ? (
          /* Not "nothing to set" — both have plenty, just below. What they
             have none of is TEXT styling, because the printer draws them. */
          <p className="text-sm text-muted">
            The printer draws this one, centred, at its own size.
          </p>
        ) : (
          <p className="text-sm text-muted">
            Nothing to set — this block is just the space or the line.
          </p>
        )}

        {block.kind === 'barcode' && (
          <>
            <Field label="What it carries" hint="The slip number, or a code you type.">
              <Select
                className="w-full"
                value={block.barcodeSource ?? 'docNumber'}
                onChange={(e) => onChange({ barcodeSource: e.target.value as BarcodeSource })}
              >
                {/* Only the two a SLIP can answer. A receipt has no reference of
                    its own and no customer account, so offering those would be
                    two settings that never fire. */}
                {BARCODE_SOURCE_INFO.filter(
                  (x) => x.source === 'docNumber' || x.source === 'custom',
                ).map((x) => (
                  <option key={x.source} value={x.source}>
                    {x.label}
                  </option>
                ))}
              </Select>
            </Field>

            {block.barcodeSource === 'custom' && (
              <Field label="The code" hint="Anything a barcode cannot carry is dropped.">
                <Input
                  value={block.barcodeText ?? ''}
                  placeholder="PROMO2026"
                  onChange={(e) => onChange({ barcodeText: e.target.value })}
                />
              </Field>
            )}
          </>
        )}

        {block.kind === 'qr' && (
          <>
            <Field
              label="What it opens"
              hint={QR_TARGET_INFO.find((t) => t.target === (block.qrTarget ?? 'store'))?.hint}
            >
              <Select
                className="w-full"
                value={block.qrTarget ?? 'store'}
                onChange={(e) => onChange({ qrTarget: e.target.value as QrTarget })}
              >
                {/* "This document" is offered on a page and NOT here: a till slip
                    has no public page of its own, so it would resolve to nothing
                    and print no square. A setting that never fires reads as
                    broken. */}
                {QR_TARGET_INFO.filter((t) => t.target !== 'doc').map((t) => (
                  <option key={t.target} value={t.target}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </Field>

            {block.qrTarget === 'custom' && (
              <Field
                label="The web address"
                hint="Must start with https."
                error={
                  block.qrUrl && !cleanCustomUrl(block.qrUrl)
                    ? 'That is not an https address.'
                    : undefined
                }
              >
                <Input
                  value={block.qrUrl ?? ''}
                  placeholder="https://g.page/r/your-review-link"
                  onChange={(e) => onChange({ qrUrl: e.target.value })}
                />
              </Field>
            )}

            <Field label="Words underneath" hint='Optional — "Scan to rate us".'>
              <Input
                value={block.qrCaption ?? ''}
                placeholder="Scan to rate us"
                onChange={(e) => onChange({ qrCaption: e.target.value })}
              />
            </Field>
          </>
        )}

        {block.kind === 'text' && (
          <Field
            label="Your words"
            hint="Leave it empty to print the slip footer from Setup → Printing."
          >
            <Input
              value={block.text ?? ''}
              placeholder="Returns within 7 days with this slip"
              onChange={(e) => onChange({ text: e.target.value })}
            />
          </Field>
        )}

        {/*
          Up and down, for the same reason the A4 designer keeps them: dragging
          is the discoverable gesture and a button is the reliable one, and on a
          list of seventeen a shop nudging one block into place should not have
          to aim.
        */}
        <Field label="Order">
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={index === 0}
              onClick={() => onMove(index - 1)}
            >
              <Icons.ChevronUp aria-hidden className="h-4 w-4" />
              Up
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={index === count - 1}
              onClick={() => onMove(index + 1)}
            >
              <Icons.ChevronDown aria-hidden className="h-4 w-4" />
              Down
            </Button>
            <span className="text-xs text-muted">
              {index + 1} of {count}
            </span>
          </div>
        </Field>

        {/*
          ── WHEN THIS LINE PRINTS ───────────────────────────────────────

          A SHORTER list than a document gets, because a slip is handed over at
          the moment of payment: nothing is owed, nothing is overdue, and a
          walk-in has no account. Offering those four anyway would be four
          settings that quietly never fire, which reads as broken rather than
          as not applicable. See SLIP_CONDITIONS.
        */}
        {!info.required && (
          <Field
            label="Show this"
            hint={conditionDef(block.showWhen)?.hint ?? 'On every slip.'}
          >
            <Select
              className="w-56"
              value={block.showWhen ?? 'always'}
              onChange={(e) => {
                const rule = e.target.value
                onChange({ showWhen: rule === 'always' ? undefined : (rule as ConditionRule) })
              }}
            >
              {SLIP_CONDITIONS.map((c) => (
                <option key={c.rule} value={c.rule}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {/*
          Required blocks have no Remove button rather than a disabled one: the
          sale, the totals, the VAT analysis and the number are what make the
          paper a tax invoice, and a control that exists but refuses explains
          itself worse than one that was never offered.
        */}
        {info.required ? (
          <p className="text-xs text-muted">
            This is part of what makes the slip a tax invoice, so it cannot be removed.
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

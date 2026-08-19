'use client'

import { Badge, Button, Card, CardBody, CardHeader, EmptyState, Field, Icons, Input, Select } from '@/components/ui'
import { SLIP_CONDITIONS, conditionDef, type ConditionRule } from '@/lib/stationery/conditions'
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
  const stylable = block.kind !== 'rule' && block.kind !== 'feed'

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
        ) : (
          <p className="text-sm text-muted">
            Nothing to set — this block is just the space or the line.
          </p>
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

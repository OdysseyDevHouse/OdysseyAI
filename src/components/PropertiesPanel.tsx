'use client'

import { useState } from 'react'
import {
  Icons,
  NumberInput,
  Select,
  SettingGroup,
  SettingRow,
  Switch,
} from '@/components/ui'
import {
  PACK_DESCRIPTIONS,
  PRICE_CALCS,
  VARIABLE_TYPES,
  WEIGHT_DESCRIPTIONS,
  type PriceCalcId,
  type VariableTypeId,
} from '@/lib/productProperties'

/**
 * How a product behaves at the till, on the scale and in the stockroom.
 *
 * Every switch is backed by a hidden input carrying "1"/"0": an unchecked
 * checkbox submits nothing at all, which the action would read as "field
 * absent" rather than "switched off". The numeric and select controls are
 * uncontrolled and submit their own values.
 */

export type ProductProperties = {
  visibleInPos: boolean
  changeDescription: boolean
  askPriceAtSale: boolean
  allowFractions: boolean
  chargePctSubtotal: boolean
  nonGpProduct: boolean
  maxDiscountPct: number
  variableType: VariableTypeId
  priceCalc: PriceCalcId

  packWeight: number
  weightDescription: string
  packSize: number
  packDescription: string
  lengthMm: number
  widthMm: number
  heightMm: number
  prepTimeMinutes: number

  scaleItem: boolean
  labelScaleItem: boolean
  fixedPriceScale: boolean
  expiresInDays: number
}

/** A switch plus the hidden input that makes its "off" state submittable. */
function SettingSwitch({
  name,
  checked,
  onChange,
}: {
  name: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <>
      <input type="hidden" name={name} value={checked ? '1' : '0'} />
      <Switch checked={checked} onChange={onChange} />
    </>
  )
}

export default function PropertiesPanel({ value }: { value: ProductProperties }) {
  const [props, setProps] = useState<ProductProperties>(value)
  const set = <K extends keyof ProductProperties>(key: K, next: ProductProperties[K]) =>
    setProps((prev) => ({ ...prev, [key]: next }))

  return (
    <div className="flex flex-col gap-4">
      <SettingGroup title="Properties" description="Configure how this product behaves in sales and pricing.">
        <SettingRow
          icon={<Icons.Eye size={16} />}
          label="Visible in point of sale"
          description="Show this product on the point of sale. Switch off to hide it from cashiers while keeping it on file."
        >
          <SettingSwitch
            name="visibleInPos"
            checked={props.visibleInPos}
            onChange={(v) => set('visibleInPos', v)}
          />
        </SettingRow>

        <SettingRow
          icon={<Icons.FileText size={16} />}
          label="Change item description"
          description="Prompt the cashier to enter a custom description each time this product is sold."
        >
          <SettingSwitch
            name="changeDescription"
            checked={props.changeDescription}
            onChange={(v) => set('changeDescription', v)}
          />
        </SettingRow>

        <SettingRow
          icon={<Icons.Tag size={16} />}
          label="Ask price during sale (SQ)"
          description="Prompt the cashier to enter the selling price each time this product is sold."
        >
          <SettingSwitch
            name="askPriceAtSale"
            checked={props.askPriceAtSale}
            onChange={(v) => set('askPriceAtSale', v)}
          />
        </SettingRow>

        <SettingRow
          icon={<Icons.Calculator size={16} />}
          label="Allow decimal fractions"
          description="Allow this product to be sold in fractional quantities, such as 1.45."
        >
          <SettingSwitch
            name="allowFractions"
            checked={props.allowFractions}
            onChange={(v) => set('allowFractions', v)}
          />
        </SettingRow>

        <SettingRow
          icon={<Icons.Percent size={16} />}
          label="Charge % of subtotal"
          description="Treat the selling price as a percentage and add that share of the sale's subtotal as a charge."
        >
          <SettingSwitch
            name="chargePctSubtotal"
            checked={props.chargePctSubtotal}
            onChange={(v) => set('chargePctSubtotal', v)}
          />
        </SettingRow>

        <SettingRow
          icon={<Icons.Ban size={16} />}
          label="Non-GP product"
          description="Exclude this product from gross-profit calculations in reports."
        >
          <SettingSwitch
            name="nonGpProduct"
            checked={props.nonGpProduct}
            onChange={(v) => set('nonGpProduct', v)}
          />
        </SettingRow>

        <SettingRow
          icon={<Icons.Percent size={16} />}
          label="Maximum discount %"
          description="The highest discount a cashier may apply to this product, as a percentage."
          htmlFor="maxDiscountPct"
        >
          <NumberInput
            id="maxDiscountPct"
            name="maxDiscountPct"
            precision={2}
            defaultValue={props.maxDiscountPct}
            className="w-32 text-right"
          />
          <span className="text-sm text-muted">%</span>
        </SettingRow>

        <SettingRow
          icon={<Icons.Barcode size={16} />}
          label="Variable type"
          description="Whether variable barcodes for this product encode a price or a weight."
          htmlFor="variableType"
        >
          <Select
            id="variableType"
            name="variableType"
            defaultValue={props.variableType}
            className="w-52"
          >
            {VARIABLE_TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </SettingRow>

        <SettingRow
          icon={<Icons.Calculator size={16} />}
          label="Price calculation"
          description="When the cost price changes, choose whether the selling price or the markup stays fixed."
          htmlFor="priceCalc"
        >
          <Select id="priceCalc" name="priceCalc" defaultValue={props.priceCalc} className="w-52">
            {PRICE_CALCS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </SettingRow>
      </SettingGroup>

      {/* ── Weight and size ──────────────────────────────────────────────── */}
      {/* A grid rather than SettingRows: these are paired value + unit fields,
          and each pair reads as one setting rather than two. */}
      <SettingGroup title="Weight and size">
        <div className="grid gap-5 px-6 py-5 sm:grid-cols-2">
          <div>
            <label htmlFor="packWeight" className="block text-sm font-medium text-ink">
              Pack weight
            </label>
            <NumberInput
              id="packWeight"
              name="packWeight"
              precision={4}
              defaultValue={props.packWeight}
              className="mt-1.5 text-right"
            />
            <p className="mt-1 text-xs text-muted">Add the weight of your product.</p>
          </div>

          <div>
            <label htmlFor="weightDescription" className="block text-sm font-medium text-ink">
              Weight description
            </label>
            <Select
              id="weightDescription"
              name="weightDescription"
              defaultValue={props.weightDescription}
              className="mt-1.5"
            >
              {WEIGHT_DESCRIPTIONS.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <label htmlFor="packSize" className="block text-sm font-medium text-ink">
              Pack size
            </label>
            <NumberInput
              id="packSize"
              name="packSize"
              precision={2}
              defaultValue={props.packSize}
              className="mt-1.5 text-right"
            />
            <p className="mt-1 text-xs text-muted">
              Add the size of the product. Example a 6 pack beer will be 6 and a case beer would be
              24.
            </p>
          </div>

          <div>
            <label htmlFor="packDescription" className="block text-sm font-medium text-ink">
              Pack description
            </label>
            <Select
              id="packDescription"
              name="packDescription"
              defaultValue={props.packDescription}
              className="mt-1.5"
            >
              {PACK_DESCRIPTIONS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </div>

          {/* Spans the grid and splits into three: length, width and height are
              one setting, so they share a heading and a single hint rather than
              repeating "in millimetres" three times. */}
          <div className="sm:col-span-2">
            <span className="block text-sm font-medium text-ink">Dimensions</span>
            <div className="mt-1.5 grid gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="lengthMm" className="mb-1 block text-xs text-muted">
                  Length (mm)
                </label>
                <NumberInput
                  id="lengthMm"
                  name="lengthMm"
                  precision={2}
                  defaultValue={props.lengthMm}
                  className="text-right"
                />
              </div>
              <div>
                <label htmlFor="widthMm" className="mb-1 block text-xs text-muted">
                  Width (mm)
                </label>
                <NumberInput
                  id="widthMm"
                  name="widthMm"
                  precision={2}
                  defaultValue={props.widthMm}
                  className="text-right"
                />
              </div>
              <div>
                <label htmlFor="heightMm" className="mb-1 block text-xs text-muted">
                  Height (mm)
                </label>
                <NumberInput
                  id="heightMm"
                  name="heightMm"
                  precision={2}
                  defaultValue={props.heightMm}
                  className="text-right"
                />
              </div>
            </div>
            <p className="mt-1 text-xs text-muted">
              The physical size of the product, in millimetres. Leave at zero if not recorded.
            </p>
          </div>

          <div>
            <label htmlFor="prepTimeMinutes" className="block text-sm font-medium text-ink">
              Preparation time
            </label>
            <div className="mt-1.5 flex items-center gap-2">
              <NumberInput
                id="prepTimeMinutes"
                name="prepTimeMinutes"
                precision={0}
                defaultValue={props.prepTimeMinutes}
                className="text-right"
              />
              <span className="shrink-0 text-sm text-muted">minutes</span>
            </div>
            <p className="mt-1 text-xs text-muted">
              How long this product takes to prepare, for kitchen and online-order timing.
            </p>
          </div>
        </div>
      </SettingGroup>

      {/* ── Scale properties ─────────────────────────────────────────────── */}
      <SettingGroup title="Scale properties">
        <SettingRow
          icon={<Icons.Scale size={16} />}
          label="Scale Item"
          description="Prompt the cashier to weigh this product before it can be sold, such as fresh meat or produce."
        >
          <SettingSwitch
            name="scaleItem"
            checked={props.scaleItem}
            onChange={(v) => set('scaleItem', v)}
          />
        </SettingRow>

        <SettingRow
          icon={<Icons.Tag size={16} />}
          label="Label scale item"
          description="Include this product when exporting data to a scale for label printing."
        >
          <SettingSwitch
            name="labelScaleItem"
            checked={props.labelScaleItem}
            onChange={(v) => set('labelScaleItem', v)}
          />
        </SettingRow>

        <SettingRow
          icon={<Icons.Tag size={16} />}
          label="Fixed price on scale"
          description="Always export a fixed selling price for this product to the scale, rather than a calculated one."
        >
          <SettingSwitch
            name="fixedPriceScale"
            checked={props.fixedPriceScale}
            onChange={(v) => set('fixedPriceScale', v)}
          />
        </SettingRow>

        <SettingRow
          icon={<Icons.Clock size={16} />}
          label="Item expires in days"
          description="Number of days after which this product expires, used for scale date labels."
          htmlFor="expiresInDays"
        >
          <NumberInput
            id="expiresInDays"
            name="expiresInDays"
            precision={0}
            defaultValue={props.expiresInDays}
            className="w-32 text-right"
          />
        </SettingRow>
      </SettingGroup>
    </div>
  )
}

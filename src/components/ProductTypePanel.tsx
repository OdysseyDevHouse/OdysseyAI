'use client'

import { useState } from 'react'
import { Badge, Button, SelectableCard } from '@/components/ui'
import { Globe } from '@/components/ui/icons'
import { PRODUCT_TYPES, type ProductTypeId } from '@/lib/productTypes'

/**
 * Which kind of product this is.
 *
 * Exactly one type applies, so these are radios despite reading as a grid of
 * checkboxes — a product cannot both deduct and add stock on sale. The setup
 * links are disabled until their type is chosen, because a recipe or serial
 * list is meaningless on a product that isn't of that type.
 */
export default function ProductTypePanel({
  defaultValue,
  onChange,
  onSetupClick,
}: {
  defaultValue: ProductTypeId
  /**
   * Told to the form so the Recipe, Refer and Serials tabs can appear with the
   * type they belong to. Kept as a callback rather than lifting the state out
   * entirely: the radio group still owns its own selection.
   */
  onChange?: (next: ProductTypeId) => void
  /** Jumps to the tab that configures the selected type. */
  onSetupClick?: (type: ProductTypeId) => void
}) {
  const [selected, setSelected] = useState<ProductTypeId>(defaultValue)

  function choose(next: ProductTypeId) {
    setSelected(next)
    onChange?.(next)
  }

  return (
    <div className="grid gap-3 p-6 sm:grid-cols-2 lg:grid-cols-3">
      {PRODUCT_TYPES.map((type) => {
        const isSelected = selected === type.id

        return (
          <SelectableCard
            key={type.id}
            name="productType"
            value={type.id}
            title={type.name}
            description={type.description}
            checked={isSelected}
            onChange={(v) => choose(v as ProductTypeId)}
            badge={
              type.onlineOnly && (
                <Badge tone="brand">
                  <Globe size={11} />
                  Online only
                </Badge>
              )
            }
            footer={
              type.setupLabel && (
                // Only live once this IS the product's type: a recipe's
                // ingredient list is meaningless on a product that isn't one,
                // and its tab is not on the bar to jump to.
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!isSelected || !onSetupClick}
                  onClick={() => onSetupClick?.(type.id)}
                  className="w-full"
                >
                  {type.setupLabel}
                </Button>
              )
            }
          />
        )
      })}
    </div>
  )
}

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
}: {
  defaultValue: ProductTypeId
}) {
  const [selected, setSelected] = useState<ProductTypeId>(defaultValue)

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
            onChange={(v) => setSelected(v as ProductTypeId)}
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
                // Disabled: nothing to configure until this is the product's
                // type, and the screens themselves aren't built yet.
                <Button variant="ghost" size="sm" disabled className="w-full">
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

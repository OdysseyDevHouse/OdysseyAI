'use client'

import { useTransition } from 'react'
import {
  Badge,
  Callout,
  Icons,
  SettingGroup,
  SettingRow,
  Switch,
  TextLink,
  useToast,
} from '@/components/ui'
import type { KitchenPrinter } from '@/lib/site/kitchenPrinters'
import { setAutoPrintKitchenAction } from './kitchenActions'

/**
 * Kitchen printing — what is left that is genuinely about food.
 *
 * This card used to own the printer list and the per-till mapping. Neither was
 * a kitchen question: every document has a printer, and every machine reaches
 * it somehow. Both now live in the cards above, which is what "kitchen printing
 * folds into the new system" means concretely.
 *
 * What remains is the pair a restaurant actually asks about — whether saving a
 * tab fires the food, and which stations have nothing routed to them yet.
 */
export default function KitchenPrintersPanel({
  printers,
  autoPrint,
}: {
  printers: KitchenPrinter[]
  autoPrint: boolean
}) {
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  function toggleAuto(next: boolean) {
    startTransition(async () => {
      const result = await setAutoPrintKitchenAction(next)
      if (result.ok) toast.success(result.message)
      else toast.error(result.error)
    })
  }

  const active = printers.filter((p) => p.isActive)

  return (
    <SettingGroup
      title="Kitchen tickets"
      description="Which station cooks what is set on the product; this is everything else."
    >
      <SettingRow
        icon={<Icons.Flame size={16} />}
        label="Send to the kitchen automatically"
        description="When a tab is saved or finalised, anything new on it goes to its station. Off means a waiter presses Send to kitchen."
        htmlFor="auto-print-kitchen"
      >
        <Switch
          id="auto-print-kitchen"
          checked={autoPrint}
          disabled={pending}
          onChange={toggleAuto}
        />
      </SettingRow>

      {active.map((printer) => (
        <SettingRow
          key={printer.id}
          icon={<Icons.Printer size={16} />}
          label={printer.name}
          description={
            printer.productCount === 0
              ? 'Nothing is routed here yet — open a product’s Kitchen tab to send it.'
              : `${printer.productCount} product${printer.productCount === 1 ? '' : 's'} print here.`
          }
        >
          {printer.productCount === 0 ? (
            <Badge tone="warning">No products routed</Badge>
          ) : (
            <Badge tone="neutral">{printer.productCount}</Badge>
          )}
        </SettingRow>
      ))}

      <div className="px-4 pb-3 pt-1">
        <Callout tone="brand" title="A product with no printer never reaches a kitchen">
          That is the ordinary case rather than a gap — a bag of ice on a restaurant till has
          nothing to tell a chef. Mark a station as “Kitchen tickets” under Printers above and
          it appears on every product’s <TextLink href="/products">Kitchen tab</TextLink>.
        </Callout>
      </div>
    </SettingGroup>
  )
}

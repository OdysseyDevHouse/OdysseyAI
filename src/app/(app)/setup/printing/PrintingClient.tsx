'use client'

import { useEffect, useState, useTransition } from 'react'
import {
  Badge,
  Button,
  Callout,
  Field,
  Icons,
  Select,
  SettingGroup,
  SettingRow,
  Textarea,
  useToast,
} from '@/components/ui'
import { deviceId as thisDeviceId } from '@/lib/deviceId'
import { shellCanPrint } from '@/lib/print/shell'
import type { Device } from '@/lib/site/devices'
import type { Printer } from '@/lib/site/printers'
import type { DocumentAssignment } from '@/lib/site/documentPrinters'
import type { KitchenPrinter } from '@/lib/site/kitchenPrinters'
import { savePrintingSettingsAction } from './actions'
import { copyPrintingSetupAction } from './deviceActions'
import PrintersPanel from './PrintersPanel'
import DocumentAssignmentTable from './DocumentAssignmentTable'
import KitchenPrintersPanel from './KitchenPrintersPanel'

/**
 * Printer setup.
 *
 * ── THE DEVICE PICKER IS THE WHOLE FEATURE ────────────────────────────────
 *
 * Everything below the first card is scoped to one machine, and the machine is
 * chosen here rather than being "whichever one you are sitting at". That single
 * control is what makes it possible to set up the till in the next room from
 * the office — and it only works because every per-machine write is now a
 * server action keyed on a UUID rather than a write to this browser's own
 * localStorage, which is where all of this used to live.
 *
 * The amber callout this screen used to carry said the opposite: "saved on THIS
 * machine only". Same job, opposite polarity — it now warns when you are NOT
 * configuring the machine in front of you, because that is the way round that
 * can now surprise somebody.
 */
export default function PrintingClient({
  footerText: initialFooter,
  printers,
  devices,
  assignments,
  kitchenPrinters,
  autoPrintKitchen,
  modules,
}: {
  footerText: string
  printers: Printer[]
  devices: Device[]
  assignments: Record<string, DocumentAssignment[]>
  kitchenPrinters: KitchenPrinter[]
  autoPrintKitchen: boolean
  modules: string[]
}) {
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  const [footer, setFooter] = useState(initialFooter)
  const [savedFooter, setSavedFooter] = useState(initialFooter)

  /* Resolved after mount. `deviceId()` reads localStorage (or the desktop
     shell), neither of which exists during SSR — reading it during render would
     mismatch the server's HTML. `undefined` means "not looked yet" and is
     deliberately distinct from `null`, which means "looked, and this browser
     will not tell us". */
  const [here, setHere] = useState<string | null | undefined>(undefined)
  const [selected, setSelected] = useState<string | null>(null)
  const [canEngine, setCanEngine] = useState(false)

  useEffect(() => {
    const id = thisDeviceId()
    setHere(id)
    setCanEngine(shellCanPrint())
    /* Default to the machine we are on, when the shop knows it — a manager who
       opened this page almost always means "set up this one". Falling back to
       the first machine rather than to nothing keeps the screen useful on a
       browser that will not tell us who it is. */
    setSelected((current) => current ?? (id && devices.some((d) => d.deviceId === id) ? id : (devices[0]?.deviceId ?? null)))
  }, [devices])

  const device = devices.find((d) => d.deviceId === selected) ?? null
  const isThisMachine = here != null && device?.deviceId === here
  const deviceLabel = device
    ? device.terminal
      ? `${device.terminal.code} — ${device.terminal.name}`
      : device.label || 'this machine'
    : 'this machine'

  function saveFooter() {
    startTransition(async () => {
      const result = await savePrintingSettingsAction({ footerText: footer })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setSavedFooter(footer)
      toast.success(result.message)
    })
  }

  function copyFrom(fromId: string) {
    if (!device) return
    startTransition(async () => {
      const result = await copyPrintingSetupAction(fromId, device.deviceId)
      if (result.ok) toast.success(result.message)
      else toast.error(result.error)
    })
  }

  /** Grouped so a shop with six machines can find the one it means. */
  const tills = devices.filter((d) => d.terminal !== null)
  const others = devices.filter((d) => d.terminal === null)

  return (
    <div className="flex flex-col gap-4">
      {devices.length === 0 ? (
        <Callout tone="warning" title="No machines have checked in yet">
          A machine appears here the first time somebody signs in on it, or the first time a
          till loads its products. Open this page on the machine you want to set up.
        </Callout>
      ) : (
        <>
          <SettingGroup title="The machine">
            <SettingRow
              icon={<Icons.Terminal size={16} />}
              label="Setting up"
              description="Which machine the document list below applies to. The printers themselves are the shop’s, wherever you set them up from."
              htmlFor="device-picker"
            >
              <div className="flex items-center gap-2">
                {isThisMachine && <Badge tone="brand">This machine</Badge>}
                <Select
                  id="device-picker"
                  className="w-72"
                  value={selected ?? ''}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  {tills.length > 0 && (
                    <optgroup label="Tills">
                      {tills.map((d) => (
                        <option key={d.deviceId} value={d.deviceId}>
                          {d.terminal!.code} — {d.terminal!.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {others.length > 0 && (
                    <optgroup label="Other machines">
                      {others.map((d) => (
                        <option key={d.deviceId} value={d.deviceId}>
                          {d.label || d.deviceId.slice(0, 8)}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </Select>
              </div>
            </SettingRow>

            {devices.length > 1 && device && (
              <SettingRow
                icon={<Icons.Copy size={16} />}
                label="Copy setup from another machine"
                description="Replaces this machine's printers and documents with that one's. The fast way to set up a second till."
                htmlFor="copy-from"
              >
                <Select
                  id="copy-from"
                  className="w-64"
                  value=""
                  disabled={pending}
                  onChange={(e) => e.target.value && copyFrom(e.target.value)}
                >
                  <option value="">Copy from…</option>
                  {devices
                    .filter((d) => d.deviceId !== device.deviceId)
                    .map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.terminal ? `${d.terminal.code} — ${d.terminal.name}` : d.label || d.deviceId.slice(0, 8)}
                      </option>
                    ))}
                </Select>
              </SettingRow>
            )}
          </SettingGroup>

          {device && !isThisMachine && here !== undefined && (
            <Callout tone="warning" title={`You are setting up ${deviceLabel}`}>
              The document list below is {deviceLabel}’s, not this machine’s. Adding a printer
              plugged into {deviceLabel} also needs its Windows printer name typed by hand —
              only the machine itself can list what is plugged into it.
            </Callout>
          )}

          <PrintersPanel
            printers={printers}
            deviceId={device?.deviceId ?? null}
            deviceLabel={deviceLabel}
            isThisMachine={isThisMachine}
          />

          {isThisMachine && !canEngine && (
            <Callout tone="warning" title="This machine cannot talk to a printer directly">
              Documents here go through the browser’s print dialog, and the printer list above
              cannot be read from Windows. Install the desktop app on this machine to pick
              printers from a list, open a cash drawer, or save a PDF without being asked
              where.
            </Callout>
          )}

          {device && (
            <DocumentAssignmentTable
              deviceId={device.deviceId}
              deviceLabel={deviceLabel}
              assignments={assignments[device.deviceId] ?? []}
              printers={printers.filter((p) => p.isActive)}
              modules={modules}
            />
          )}
        </>
      )}

      <KitchenPrintersPanel printers={kitchenPrinters} autoPrint={autoPrintKitchen} />

      <SettingGroup
        title="The slip"
        description="What every till on this site prints at the bottom of a receipt."
      >
        <div className="px-4 py-3">
          <Field
            label="Footer line"
            hint={`${footer.length}/500 — the returns policy, a thank-you, a promo. Empty prints nothing.`}
          >
            <Textarea
              rows={2}
              value={footer}
              onChange={(e) => setFooter(e.target.value)}
              placeholder="Exchanges within 30 days with this slip. Thank you!"
            />
          </Field>
          <div className="mt-3 flex items-center justify-end gap-3">
            {footer === savedFooter && <span className="text-xs text-muted">No changes to save.</span>}
            <Button
              variant="secondary"
              disabled={pending || footer === savedFooter}
              onClick={saveFooter}
            >
              <Icons.Save size={15} />
              {pending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </SettingGroup>
    </div>
  )
}

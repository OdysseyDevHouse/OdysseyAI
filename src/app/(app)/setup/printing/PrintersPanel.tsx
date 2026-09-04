'use client'

import { useState, useTransition } from 'react'
import {
  Badge,
  Button,
  EmptyState,
  Icons,
  Input,
  SettingGroup,
  SettingRow,
  useToast,
} from '@/components/ui'
import { PAPER_LABELS } from '@/lib/printing/documents'
import type { Printer, PrinterInput } from '@/lib/site/printers'
import { renderTestSlip } from '@/lib/escpos/slips'
import { shellCanPrint, shellSendRaw, shellTargetFor } from '@/lib/print/shell'
import { createPrinterAction, setPrinterActiveAction, updatePrinterAction } from './printerActions'
import PrinterModal from './PrinterModal'

/**
 * The shop's printers. Each row says where it is.
 *
 * One list, one modal, one connection question — asked when the printer is
 * created and never again. The per-machine "how do I reach this" card that used
 * to sit below this one is gone; sql/site/247 says why.
 */

/** Where a printer is, in a sentence. The row's whole job. */
function where(printer: Printer): string {
  if (printer.unconfigured) {
    return printer.connection === 'queue'
      ? 'No printer picked yet — open it and choose one'
      : 'No network address yet — open it and add one'
  }
  if (printer.connection === 'network') {
    return `On the network at ${printer.target}${printer.port ? `:${printer.port}` : ''}`
  }
  return printer.deviceLabel
    ? `${printer.deviceLabel} · ${printer.target}`
    : `${printer.target} — on a machine this shop no longer knows`
}

export default function PrintersPanel({
  printers,
  deviceId,
  deviceLabel,
  isThisMachine,
}: {
  printers: Printer[]
  deviceId: string | null
  deviceLabel: string
  isThisMachine: boolean
}) {
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  const active = printers.filter((p) => p.isActive)
  const off = printers.filter((p) => !p.isActive)

  const [newName, setNewName] = useState('')
  const [modal, setModal] = useState<{ id: number; input: PrinterInput } | null>(null)
  const [modalOpen, setModalOpen] = useState(false)

  function open(printer?: Printer) {
    setModal(
      printer
        ? {
            id: printer.id,
            input: {
              name: printer.name,
              purpose: printer.purpose,
              paper: printer.paper,
              slipColumns: printer.slipColumns,
              connection: printer.connection,
              deviceId: printer.deviceId,
              target: printer.target,
              shareName: printer.shareName,
              port: printer.port,
              drawerKick: printer.drawerKick,
            },
          }
        : null,
    )
    setModalOpen(true)
  }

  function save(id: number | null, input: PrinterInput) {
    const named = { ...input, name: input.name.trim() || newName.trim() }
    startTransition(async () => {
      const result = id === null ? await createPrinterAction(named) : await updatePrinterAction(id, named)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
      setModalOpen(false)
      setNewName('')
    })
  }

  function toggle(printer: Printer) {
    startTransition(async () => {
      const result = await setPrinterActiveAction(printer.id, !printer.isActive)
      if (result.ok) toast.success(result.message)
      else toast.error(result.error)
    })
  }

  async function testPage(printer: Printer) {
    const target = shellTargetFor(printer)
    if (!target) {
      toast.error('That printer has no address yet.')
      return
    }
    const result = await shellSendRaw(
      target,
      renderTestSlip({ siteName: printer.name, columns: printer.slipColumns ?? 48 }),
    )
    /* "Sent", never "printed". Nothing in any transport reports that paper
       moved, and a person told "printed" stops looking at the printer. */
    if (result.ok) toast.success('Test page sent — check the printer.')
    else toast.error(result.error)
  }

  /** Whether THIS machine could run a test page against that printer. */
  const canTest = (printer: Printer) =>
    shellCanPrint() &&
    !printer.unconfigured &&
    (printer.connection === 'network' || printer.deviceId === deviceId)

  return (
    <>
      <SettingGroup
        title="Printers"
        description="Every printer this shop has. Add each one once — a USB printer plugged into a till, or a network printer the whole shop shares."
      >
        {active.length === 0 ? (
          <div className="px-4 py-6">
            <EmptyState
              icon={<Icons.Printer size={22} />}
              title="No printers set up yet"
              hint="Add the printer at the counter, and the office laser if you have one. Until then every document uses the browser's print dialog."
              action={
                <Button variant="primary" onClick={() => open()}>
                  <Icons.Plus size={15} />
                  Add a printer
                </Button>
              }
            />
          </div>
        ) : (
          active.map((printer) => (
            <SettingRow
              key={printer.id}
              icon={
                printer.connection === 'network' ? (
                  <Icons.Wifi size={16} />
                ) : (
                  <Icons.Printer size={16} />
                )
              }
              label={printer.name}
              description={where(printer)}
            >
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Badge tone="neutral">{PAPER_LABELS[printer.paper]}</Badge>
                {printer.purpose === 'kitchen' && <Badge tone="neutral">Kitchen</Badge>}
                {printer.drawerKick && <Badge tone="neutral">Cash drawer</Badge>}
                {/* The trap worth surfacing: a printer nothing points at prints
                    nothing, and a half-finished one prints nothing either. */}
                {printer.unconfigured ? (
                  <Badge tone="warning">Needs finishing</Badge>
                ) : printer.documentCount === 0 ? (
                  <Badge tone="warning">No documents yet</Badge>
                ) : (
                  <Badge tone="neutral">
                    {printer.documentCount} document{printer.documentCount === 1 ? '' : 's'}
                  </Badge>
                )}
                {canTest(printer) && (
                  <Button variant="ghost" size="sm" onClick={() => void testPage(printer)}>
                    Test page
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label={`Edit ${printer.name}`}
                  onClick={() => open(printer)}
                >
                  <Icons.Pencil size={15} />
                </Button>
                <Button variant="ghost" size="sm" disabled={pending} onClick={() => toggle(printer)}>
                  Switch off
                </Button>
              </div>
            </SettingRow>
          ))
        )}

        {active.length > 0 && (
          <div className="flex items-center justify-end gap-2 px-4 py-3">
            <Input
              className="w-56"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Front counter"
              aria-label="New printer name"
            />
            <Button variant="secondary" onClick={() => open()}>
              <Icons.Plus size={15} />
              Add printer
            </Button>
          </div>
        )}
      </SettingGroup>

      {off.length > 0 && (
        <SettingGroup
          title="Switched off"
          description="Their routing and every machine's assignments are kept, so switching one back on restores it."
        >
          {off.map((printer) => (
            <SettingRow
              key={printer.id}
              icon={<Icons.Printer size={16} />}
              label={printer.name}
              description={`${PAPER_LABELS[printer.paper]} · ${where(printer)}`}
            >
              <Button variant="secondary" size="sm" disabled={pending} onClick={() => toggle(printer)}>
                Switch on
              </Button>
            </SettingRow>
          ))}
        </SettingGroup>
      )}

      <PrinterModal
        open={modalOpen}
        editing={modal}
        deviceId={deviceId}
        deviceLabel={deviceLabel}
        isThisMachine={isThisMachine}
        pending={pending}
        onSave={save}
        onClose={() => setModalOpen(false)}
      />
    </>
  )
}

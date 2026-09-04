'use client'

import { useEffect, useState } from 'react'
import {
  Badge,
  Button,
  Callout,
  Field,
  Icons,
  Input,
  Modal,
  NumberInput,
  Select,
  Switch,
  TextLink,
} from '@/components/ui'
import { PAPER_LABELS, type PrinterPaper } from '@/lib/printing/documents'
import type { PrinterConnection } from '@/lib/printing/resolve'
import type { PrinterInput } from '@/lib/site/printers'
import { shellPrinters, type ShellPrinter } from '@/lib/print/shell'

/**
 * Adding or editing a printer — the ONE place its connection is chosen.
 *
 * ── THE QUEUE IS PICKED, NOT TYPED ────────────────────────────────────────
 *
 * The dropdown is this machine's real print queues, read from Windows itself
 * (`Get-Printer`, via the shell). It shows the port beside each name, so
 * "EPSON TM-T70 Receipt · USB" and "Kitchen · 192.168.1.50" are distinguishable
 * at a glance, and a paused or offline queue says so before anybody wonders why
 * nothing came out.
 *
 * Typing a queue name was the old design and it was a trap: the string has to
 * match Windows exactly, and nothing on screen could confirm it until a print
 * failed.
 *
 * ── AND WHY A DIRECT ADDRESS IS STILL OFFERED ─────────────────────────────
 *
 * A queue exists only on the machine it is installed on. For a kitchen printer
 * that every till prints to, requiring a Windows queue would mean installing a
 * driver on every till. Raw TCP needs none — so a network address stays as the
 * second option, and it is the right one for a shared thermal printer.
 *
 * When a picked queue turns out to BE a network printer, the address is offered
 * as a one-click switch, because that is almost always what a shop wants.
 */

const BLANK: PrinterInput = {
  name: '',
  purpose: 'general',
  paper: 'slip80',
  slipColumns: null,
  connection: 'queue',
  deviceId: null,
  target: '',
  shareName: '',
  port: null,
  drawerKick: false,
}

/** What a queue is, in a few words, for the dropdown and the row beneath it. */
function describeQueue(q: ShellPrinter): string {
  const where =
    q.kind === 'network' && q.address
      ? q.address
      : q.kind === 'usb'
        ? 'USB'
        : q.kind === 'shared'
          ? 'Shared'
          : q.port || 'unknown port'
  return q.statusText ? `${where} · ${q.statusText}` : where
}

export default function PrinterModal({
  open,
  editing,
  deviceId,
  deviceLabel,
  isThisMachine,
  pending,
  onSave,
  onClose,
}: {
  open: boolean
  /** The printer being edited, or null for a new one. */
  editing: { id: number; input: PrinterInput } | null
  /** The machine currently selected on the screen behind this. */
  deviceId: string | null
  deviceLabel: string
  isThisMachine: boolean
  pending: boolean
  onSave: (id: number | null, input: PrinterInput) => void
  onClose: () => void
}) {
  const [input, setInput] = useState<PrinterInput>(BLANK)
  const [queues, setQueues] = useState<ShellPrinter[] | null>(null)

  useEffect(() => {
    if (!open) return
    setInput(editing ? editing.input : { ...BLANK, deviceId })
    /* Only this machine's queues can be known, and only by the shell. Null means
       "cannot ask" and is deliberately different from an empty list, which would
       mean "no printers installed". */
    void shellPrinters().then(setQueues)
  }, [open, editing, deviceId])

  const set = (patch: Partial<PrinterInput>) => setInput((i) => ({ ...i, ...patch }))
  const picked = queues?.find((q) => q.name === input.target) ?? null

  /* A queue printer belongs to the machine whose queue it is. Setting it up for
     a DIFFERENT machine is allowed — the manager just cannot pick from a list,
     because this machine has no way to know what is plugged in over there. */
  const canPick = isThisMachine && input.connection === 'queue'

  function pickQueue(name: string) {
    const q = queues?.find((p) => p.name === name)
    set({
      target: name,
      deviceId,
      /* Carried across so the raw fallback has it without anybody typing it —
         read from Windows, so it is right or it is absent. */
      shareName: q?.shared ? q.shareName : '',
      /* A first guess at the paper, from the driver's own name. Thermal drivers
         say so; anything else is far more likely to be A4 than an 80mm roll, and
         guessing wrong here costs one dropdown change rather than a wasted till
         roll. */
      paper:
        input.name || editing
          ? input.paper
          : /receipt|thermal|tm-|tsp|pos-?8|80mm/i.test(`${q?.driver ?? ''} ${q?.name ?? ''}`)
            ? 'slip80'
            : 'a4',
      /* Suggest the printer's own name the first time, so a shop that just wants
         "EPSON TM-T70 Receipt" does not have to type it. */
      name: input.name.trim() ? input.name : (q?.displayName ?? ''),
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? 'Edit printer' : 'Add a printer'}
      description="What it is called, how it is connected, and what paper is in it."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={pending} onClick={() => onSave(editing?.id ?? null, input)}>
            <Icons.Save size={15} />
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="How is it connected?">
          <Select
            value={input.connection}
            onChange={(e) => {
              const connection = e.target.value as PrinterConnection
              /* The other half is cleared rather than kept. A stale address no
                 reader consults is still a fact the screen would show, and
                 somebody would one day trust it. */
              set(
                connection === 'queue'
                  ? { connection, target: '', port: null, deviceId }
                  : { connection, target: '', shareName: '', deviceId: null },
              )
            }}
          >
            <option value="queue">A printer installed on this machine (USB or network)</option>
            <option value="network">Straight to a network address (no driver needed)</option>
          </Select>
        </Field>

        {input.connection === 'queue' && (
          <>
            <Field
              label={isThisMachine ? 'Which printer' : `Which printer on ${deviceLabel}`}
              hint={
                canPick
                  ? 'Read from Windows. Anything installed here appears, USB or network.'
                  : 'Must match the Windows printer name on that machine exactly.'
              }
            >
              {canPick && queues ? (
                <Select value={input.target} onChange={(e) => pickQueue(e.target.value)}>
                  <option value="">Pick a printer…</option>
                  {queues
                    .filter((q) => !q.isVirtual)
                    .map((q) => (
                      <option key={q.name} value={q.name}>
                        {q.displayName} — {describeQueue(q)}
                      </option>
                    ))}
                  {/* Listed, and marked, rather than hidden. A shop looking for
                      "Microsoft Print to PDF" should find out WHY it is not an
                      option instead of concluding the list is broken — and the
                      Save as PDF destination below is what they actually want. */}
                  {queues.some((q) => q.isVirtual) && (
                    <optgroup label="Not printers">
                      {queues
                        .filter((q) => q.isVirtual)
                        .map((q) => (
                          <option key={q.name} value={q.name} disabled>
                            {q.displayName} — asks where to save a file
                          </option>
                        ))}
                    </optgroup>
                  )}
                </Select>
              ) : (
                <Input
                  value={input.target}
                  onChange={(e) => set({ target: e.target.value, deviceId })}
                  placeholder="EPSON TM-T70 Receipt"
                />
              )}
            </Field>

            {!isThisMachine && (
              <Callout tone="warning" title={`You are adding a printer for ${deviceLabel}`}>
                This machine cannot list what is plugged in over there, so the name has to be
                typed exactly as Windows shows it. Opening this page on {deviceLabel} turns it
                into a dropdown.
              </Callout>
            )}

            {picked?.statusText && (
              <Callout tone="warning" title={`Windows says this printer is ${picked.statusText.toLowerCase()}`}>
                Worth checking before you rely on it — a paused or offline queue accepts jobs
                and prints none of them. A thermal printer often reports this between jobs, so
                it is not always a problem.
              </Callout>
            )}

            {/* The one-click switch. A network printer reached through its driver
                works, but only from this machine; reached directly it works from
                every till with no driver installed anywhere. */}
            {picked?.address && (
              <Callout tone="brand" title="This one is on the network">
                Windows reaches it at {picked.address}.{' '}
                <TextLink
                  href="#"
                  onClick={(e) => {
                    e.preventDefault()
                    set({ connection: 'network', target: picked.address!, deviceId: null, shareName: '' })
                  }}
                >
                  Use that address directly
                </TextLink>{' '}
                and every machine can print to it without installing a driver.
              </Callout>
            )}
          </>
        )}

        {input.connection === 'network' && (
          <div className="grid grid-cols-[1fr_8rem] gap-4">
            <Field label="Address" hint="The printer's IP or hostname on the shop's network.">
              <Input
                value={input.target}
                onChange={(e) => set({ target: e.target.value })}
                placeholder="192.168.1.50"
              />
            </Field>
            <Field label="Port" hint="9100 unless told otherwise.">
              <NumberInput
                value={input.port ?? ''}
                onChange={(e) => set({ port: e.target.value === '' ? null : Number(e.target.value) })}
                placeholder="9100"
              />
            </Field>
          </div>
        )}

        <Field label="Name" hint="What staff call it. It prints at the top of a kitchen ticket.">
          <Input
            value={input.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="Front counter"
          />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Paper" hint="What is loaded in it — not what any one document needs.">
            <Select
              value={input.paper}
              onChange={(e) => set({ paper: e.target.value as PrinterPaper, slipColumns: null })}
            >
              {(Object.keys(PAPER_LABELS) as PrinterPaper[]).map((paper) => (
                <option key={paper} value={paper}>
                  {PAPER_LABELS[paper]}
                </option>
              ))}
            </Select>
          </Field>

          {(input.paper === 'slip80' || input.paper === 'slip58') && (
            <Field
              label="Characters across"
              hint="Leave blank for the usual. 80mm heads come in 48 and 42; the test page shows which lines up."
            >
              <NumberInput
                value={input.slipColumns ?? ''}
                onChange={(e) =>
                  set({ slipColumns: e.target.value === '' ? null : Number(e.target.value) })
                }
                placeholder={input.paper === 'slip80' ? '48' : '32'}
              />
            </Field>
          )}
        </div>

        {/* Not a "used for" dropdown any more. It only ever did one thing —
            decide whether a product's Kitchen tab offers this printer — so it
            says that, as a switch. */}
        <div className="flex items-center justify-between rounded-card border border-border px-4 py-3">
          <div>
            <div className="text-sm text-ink">Offer it on products’ Kitchen tab</div>
            <div className="text-xs text-muted">
              For a station that cooks food. Keeps the office laser out of that picker.
            </div>
          </div>
          <Switch
            aria-label="Offer on products' Kitchen tab"
            checked={input.purpose === 'kitchen'}
            onChange={(next) => set({ purpose: next ? 'kitchen' : 'general' })}
          />
        </div>

        {(input.paper === 'slip80' || input.paper === 'slip58') && (
          <div className="flex items-center justify-between rounded-card border border-border px-4 py-3">
            <div>
              <div className="text-sm text-ink">The cash drawer is plugged into it</div>
              <div className="text-xs text-muted">
                Opens when a sale is paid with a tender whose “Opens cash drawer” flag is on.
                {input.connection === 'queue' && (
                  <>
                    {' '}
                    <Badge tone="neutral">Needs raw printing</Badge>
                  </>
                )}
              </div>
            </div>
            <Switch
              aria-label="The cash drawer is plugged into this printer"
              checked={input.drawerKick}
              onChange={(next) => set({ drawerKick: next })}
            />
          </div>
        )}
      </div>
    </Modal>
  )
}

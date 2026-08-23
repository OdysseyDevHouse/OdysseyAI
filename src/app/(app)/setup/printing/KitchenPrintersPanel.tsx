'use client'

import { useState, useTransition } from 'react'
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  Icons,
  Input,
  Select,
  SettingGroup,
  SettingRow,
  Switch,
  useToast,
} from '@/components/ui'
import type { KitchenPrinter, TerminalPrinterMap } from '@/lib/site/kitchenPrinters'
import {
  createKitchenPrinterAction,
  renameKitchenPrinterAction,
  setKitchenPrinterActiveAction,
  setTerminalPrinterAction,
  setAutoPrintKitchenAction,
} from './kitchenActions'

/**
 * Kitchen printers, in the two halves a shop actually thinks in.
 *
 * WHAT the printers are is a site fact and comes first — a shop names its bar
 * and its grill once. WHERE each one is, is a per-till fact, and the second
 * card is scoped to one till at a time with the till named in its own heading,
 * because "the Bar" meaning two different machines on two counters is the
 * normal case rather than a mistake.
 *
 * The unmapped state is shown LOUDLY, in warning, on both halves. A printer
 * this till cannot reach is exactly the state where food silently stops coming
 * out, and a screen that only listed what already worked could never reveal it.
 */
export default function KitchenPrintersPanel({
  printers,
  terminals,
  terminalMaps,
  autoPrint: initialAutoPrint,
  /** Spool names this browser's bridge reported. Null until Test connection. */
  knownBridgePrinters,
}: {
  printers: KitchenPrinter[]
  terminals: { id: number; code: string; name: string }[]
  terminalMaps: Record<number, TerminalPrinterMap[]>
  autoPrint: boolean
  knownBridgePrinters: string[] | null
}) {
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  const [newName, setNewName] = useState('')
  const [autoPrint, setAutoPrint] = useState(initialAutoPrint)
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null)
  /* Which till the mapping card is showing. Defaults to the first, so the card
     has something to say on first paint rather than an empty picker. */
  const [terminalId, setTerminalId] = useState<number | null>(terminals[0]?.id ?? null)
  /* Edits held locally so a manager can type a spool name without a round trip
     per keystroke; each row saves on its own button. */
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  const active = printers.filter((p) => p.isActive)
  const maps = terminalId === null ? [] : (terminalMaps[terminalId] ?? [])

  function add() {
    const name = newName.trim()
    if (!name) return
    startTransition(async () => {
      const result = await createKitchenPrinterAction(name)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setNewName('')
      toast.success(result.message)
    })
  }

  function saveName() {
    if (!editing) return
    const target = editing
    startTransition(async () => {
      const result = await renameKitchenPrinterAction(target.id, target.name)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setEditing(null)
      toast.success(result.message)
    })
  }

  function toggleActive(printer: KitchenPrinter) {
    startTransition(async () => {
      const result = await setKitchenPrinterActiveAction(printer.id, !printer.isActive)
      if (!result.ok) toast.error(result.error)
      else toast.success(result.message)
    })
  }

  function saveMapping(printerId: number, value: string) {
    if (terminalId === null) return
    const till = terminalId
    startTransition(async () => {
      const result = await setTerminalPrinterAction(till, printerId, value)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setDrafts((d) => {
        const next = { ...d }
        delete next[`${till}:${printerId}`]
        return next
      })
      toast.success(result.message)
    })
  }

  function toggleAutoPrint(next: boolean) {
    setAutoPrint(next)
    startTransition(async () => {
      const result = await setAutoPrintKitchenAction(next)
      if (!result.ok) {
        // Put the switch back — the setting did not change.
        setAutoPrint(!next)
        toast.error(result.error)
        return
      }
      toast.success(result.message)
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <SettingGroup
        title="Kitchen printers"
        description="The stations this shop sends food to. Products are pointed at these on the product's Kitchen tab."
      >
        {active.length === 0 ? (
          <div className="px-4 py-6">
            <EmptyState
              icon={<Icons.Printer size={20} />}
              title="No kitchen printers yet"
              hint="Add one for each station that gets a docket — a Bar and a Kitchen is the usual pair. Nothing prints to a kitchen until a product is pointed at one."
            />
          </div>
        ) : (
          active.map((printer) => (
            <SettingRow
              key={printer.id}
              icon={<Icons.Printer size={16} />}
              label={printer.name}
              description={
                printer.productCount === 0
                  ? 'No products print here yet.'
                  : `${printer.productCount} product${printer.productCount === 1 ? '' : 's'} print here.`
              }
            >
              <div className="flex items-center gap-2">
                {/* The trap this screen exists to reveal: a printer no till can
                    reach takes food nowhere, however many products point at it. */}
                {printer.terminalCount === 0 ? (
                  <Badge tone="warning">No till reaches it</Badge>
                ) : (
                  <Badge tone="neutral">
                    {printer.terminalCount} till{printer.terminalCount === 1 ? '' : 's'}
                  </Badge>
                )}
                {editing?.id === printer.id ? (
                  <>
                    <Input
                      className="w-40"
                      value={editing.name}
                      autoFocus
                      onChange={(e) => setEditing({ id: printer.id, name: e.target.value })}
                    />
                    <Button variant="primary" size="sm" disabled={pending} onClick={saveName}>
                      Save
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label={`Rename ${printer.name}`}
                      onClick={() => setEditing({ id: printer.id, name: printer.name })}
                    >
                      <Icons.Pencil size={15} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() => toggleActive(printer)}
                    >
                      Switch off
                    </Button>
                  </>
                )}
              </div>
            </SettingRow>
          ))
        )}

        <div className="flex items-center gap-2 px-4 py-3">
          <Input
            className="w-56"
            value={newName}
            placeholder="Bar"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add()
            }}
          />
          <Button variant="secondary" disabled={pending || !newName.trim()} onClick={add}>
            <Icons.Plus size={15} />
            Add printer
          </Button>
        </div>
      </SettingGroup>

      {printers.some((p) => !p.isActive) && (
        <SettingGroup
          title="Switched off"
          description="Kept rather than deleted, so the dockets they printed stay accounted for. Switching one back on restores every product already pointed at it."
        >
          {printers
            .filter((p) => !p.isActive)
            .map((printer) => (
              <SettingRow key={printer.id} icon={<Icons.Printer size={16} />} label={printer.name}>
                <Button variant="ghost" size="sm" disabled={pending} onClick={() => toggleActive(printer)}>
                  Switch on
                </Button>
              </SettingRow>
            ))}
        </SettingGroup>
      )}

      <SettingGroup
        title="Where this till sends them"
        description="Each till spools to its own printers, so the mapping is set per till. A station left blank is one this till cannot reach — its dockets are skipped rather than failing the rest."
      >
        <SettingRow
          icon={<Icons.Terminal size={16} />}
          label="Till"
          description="Set each till that takes food orders. A till with nothing mapped prints no kitchen dockets at all."
          htmlFor="mapping-terminal"
        >
          <Select
            id="mapping-terminal"
            className="w-56"
            value={terminalId === null ? '' : String(terminalId)}
            onChange={(e) => setTerminalId(e.target.value ? Number(e.target.value) : null)}
          >
            {terminals.map((t) => (
              <option key={t.id} value={t.id}>
                {t.code} — {t.name}
              </option>
            ))}
          </Select>
        </SettingRow>

        {terminals.length === 0 ? (
          <div className="px-4 py-6">
            <EmptyState
              icon={<Icons.Terminal size={20} />}
              title="No tills registered"
              hint="Register a till in Setup → Tills before mapping its printers."
            />
          </div>
        ) : active.length === 0 ? (
          <div className="px-4 py-6">
            <EmptyState
              icon={<Icons.Printer size={20} />}
              title="Nothing to map yet"
              hint="Add a kitchen printer above, then come back to say where this till sends it."
            />
          </div>
        ) : (
          maps.map((row) => {
            const key = `${terminalId}:${row.printerId}`
            const draft = drafts[key] ?? row.bridgePrinter
            const dirty = draft !== row.bridgePrinter
            return (
              <SettingRow
                key={row.printerId}
                icon={<Icons.Link2 size={16} />}
                label={row.printerName}
                description="The print bridge's own name for the queue — press Test connection above to see what this machine reports."
              >
                <div className="flex items-center gap-2">
                  {!row.bridgePrinter && !dirty && <Badge tone="warning">Not mapped</Badge>}
                  {knownBridgePrinters?.includes(draft) && draft ? (
                    <Badge tone="success">Found</Badge>
                  ) : null}
                  {/* No example placeholder. A greyed "EPSON-TM20-BAR" in an
                      EMPTY box reads as a value that is already set — which is
                      the one thing this row must never imply, since an unmapped
                      station is exactly where dockets vanish. */}
                  <Input
                    className="w-48"
                    value={draft}
                    placeholder="Printer name"
                    onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                  />
                  <Button
                    variant={dirty ? 'primary' : 'ghost'}
                    size="sm"
                    disabled={pending || !dirty}
                    onClick={() => saveMapping(row.printerId, draft)}
                  >
                    Save
                  </Button>
                </div>
              </SettingRow>
            )
          })
        )}
      </SettingGroup>

      <SettingGroup
        title="Sending to the kitchen"
        description="When a tab is saved, closed or paid, the items the kitchen has not seen yet are sent to their printers."
      >
        <SettingRow
          icon={<Icons.Zap size={16} />}
          label="Send automatically when a tab is saved"
          description="Only ever sends what is new since the last docket — adding two drinks to a table sends two, not the whole tab. Switch off to fire every course by hand with the Send to kitchen key."
          htmlFor="auto-print-kitchen"
        >
          <Switch id="auto-print-kitchen" checked={autoPrint} onChange={toggleAutoPrint} />
        </SettingRow>
      </SettingGroup>

      {active.length > 0 && (
        <Callout tone="brand" title="A product with no printer never goes to a kitchen">
          That is the ordinary case, not a gap — a bag of ice has nothing to tell a chef.
          Point a product at a station on its Kitchen tab, and give it a group there
          (“Starters”, “Mains”) if the docket should be sorted into courses.
        </Callout>
      )}
    </div>
  )
}

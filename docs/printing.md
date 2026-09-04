# Printing

Replaces `docs/print-bridge.md`. The sidecar it described — a Node process a
shop installed by hand, which the installer never shipped and which spoke TCP
9100 and nothing else — is gone. Its transports moved into the desktop shell.

## The model, in two sentences

1. **A printer knows where it is.** One shop-wide list (`printers`), and each
   row says how it is reached — a print queue on one named machine, or a
   network address. Chosen once, when the printer is created.
2. **Each machine says what comes out where** (`device_document_printers`), one
   row per printable document.

Reachability is two rules, and there is no table to consult:

- a **network** printer is reachable from every machine on the LAN
- a **queue** printer only from the machine its queue is installed on

Assignments are keyed on the **machine's UUID**, not on a till. A back-office PC
prints invoices and statements, has no `terminals` row, and is exactly the
machine that needs to disagree with the counter about where A4 goes.

Schema: `sql/site/246_device_printing.sql`, then
`sql/site/247_printer_owns_its_location.sql` — which collapsed an earlier
two-level design that asked every printer's connection question twice. 247 has
the argument for why the second question was not worth its keep.

## Setting a shop up

Everything is in **Setup → Printing**, and the machine being configured is a
picker at the top — so a manager sets up every till from one desk.

1. **Printers.** Add each physical printer once. *How is it connected?* has two
   answers:
   - **A printer installed on this machine** — a dropdown of the machine's real
     Windows queues, read with `Get-Printer`. Shows the port beside each name
     (`EPSON TM-T70 Receipt — USB`, `Kitchen — 192.168.1.50`) and flags a paused
     or offline queue before anybody wonders why nothing came out. Nobody types
     a printer name.
   - **Straight to a network address** — an IP and a port. Needs no driver
     installed anywhere and is reachable from every machine at once, which is
     the right answer for a kitchen printer a whole restaurant shares.
   
   Then the paper, and two switches: *offer it on products' Kitchen tab*, and
   *the cash drawer is plugged into it*.
2. **What prints where.** One card, tabbed by group, showing every printable
   document. Click a row and pick a destination: a printer, *Save as PDF*, the
   browser's print dialog, or *Never print this here*. The tab carries a count
   of what is still unanswered.

When a picked queue turns out to be a network printer, the modal offers its
address as a one-click switch — because reaching it directly means every other
till can print to it without installing a driver.

A document with **no row** uses the browser's print dialog, which is what every
document did before this existed. Nothing changes until somebody fills a row in.

## What each destination can do

| | Network address | OS queue | PDF | Browser dialog |
|---|---|---|---|---|
| Silent (no dialog) | yes | yes | yes | no |
| Raw ESC/POS (cut, drawer) | yes | yes | — | no |
| A4 documents | driver only | yes | yes | yes |
| Reachable from every machine | yes | its own only | yes | yes |
| Needs a driver installed | no | yes | — | yes |
| Works offline | yes | yes | bytes only | yes |
| Needs the desktop app | yes | yes | yes | no |

**A browser and an Android till get the print dialog only.** They have no
engine, so the setup screen says so rather than offering controls that do
nothing. Android's WebView also does not honour `@page { size: 80mm auto }` the
way desktop Chrome does — a known limitation, not a bug.

## The engine

`electron/` — four files, split on whether they need Electron:

- **`printTargets.js`** — validation. No dependencies at all, so
  `npm run test:print-ipc` runs the real rules. Carries the security reasoning.
- **`printQueues.js`** — what is installed on this machine. Uses `Get-Printer`,
  not Electron's `getPrintersAsync`, which on Windows answers the NAME and
  nothing else (verified: no status, no port, no `isDefault`, whatever the docs
  suggest). `Get-Printer` gives the port, the driver, the share name and a real
  status bitmask — which is what makes a useful dropdown possible at all.
  `getPrintersAsync` is kept as the fallback for a machine where PowerShell is
  blocked by policy.
- **`printTransports.js`** — the byte-movers: TCP, the raw spooler, `lp`. Node
  only, so `npm run test:print-tcp` and `test:print-queue` exercise them with
  no display and no hardware.
- **`printing.js`** — the OS printer list, the hidden window rendered documents
  are laid out in, PDFs, and the five `printing:*` IPC handlers.

Exposed to the app as `window.odyssey.printing` with five named verbs and no
generic escape hatch, for the reason `electron/preload.js` states about itself.

### "Sent" never means "printed"

Nothing in any transport can tell you paper moved. Port 9100 has no
acknowledgement; `webContents.print` reports that the job reached the spooler;
`WritePrinter` the same. Every message the app shows says *sent to the printer*.
A cashier told "printed" stops looking at the printer, which is exactly when the
paper has run out.

### The raw-print helper

`build/rawprint/odyssey-rawprint.exe` — about 6KB of `winspool` calls that hand
RAW bytes to a Windows queue, which is what makes the paper cut and the cash
drawer work on a USB printer. Node cannot do this itself, and every alternative
is worse (the argument is in `RawPrint.cs`).

It is **not** a native node module: nothing to rebuild when Electron moves.

- Rebuild after changing the C#: `npm run build:rawprint`, then **commit the
  exe** — `npm run dist` never regenerates it.
- Shipped via `extraResources`, so it lands *outside* `app.asar`. A path inside
  an asar cannot be spawned; moving it into `files:` would break raw USB
  printing with no build error.
- `scripts/verify-packaged-build.mjs` fails the build if it is missing.

**Fallback**, when policy blocks spawning it: share the printer in Windows and
put the share name in the printer's row. Only used when a share name is set on
purpose — never guessed, because the share name and the printer name differ.

## A cash drawer cannot survive a driver-printed job

`ESC p 0 25 250` is raw ESC/POS. A GDI driver renders it as characters or drops
it, so a machine whose slip printer is reached *only* through a driver has no
drawer kick from Odyssey. Either give the same printer a raw target as well
(usually free — the drawer is on the printer's RJ11 and the head normally also
exposes a raw port), or use the driver's own "open drawer before printing" box.

## When nothing comes out

In order, because this is the order it is usually one of:

1. **Is the queue paused, offline or out of paper?** The Add/Edit Printer modal
   says so beside the queue, and the engine logs it on every job — the single
   most common cause. Note a thermal printer often reports "Offline" between
   jobs and prints perfectly, so it is a hint rather than a verdict, which is
   why the engine logs it instead of refusing.
2. **Is it a real printer?** *Microsoft Print to PDF*, *XPS Document Writer*,
   *OneNote* and *Fax* look like printers and are not — printing to one
   silently opens a Save-As dialog on a window nobody can see. The engine
   refuses them and the picker marks them.
3. **Is the document assigned at all?** An amber *Not set* badge means the
   browser dialog, not a printer.
4. **Can this machine reach it?** A red *Not on this machine* badge means the
   document points at a queue printer plugged into a different machine — the row
   says which one, in words.
5. **A "USB" printer installed over a TCP port pointing nowhere** accepts every
   job and prints none of them, forever, with no error. *Test page* prints
   visible paper rather than reporting a boolean, which is how you tell.
6. **The log.** Every job writes one line — transport, target, size, duration,
   outcome — to the file `window.odyssey.diagnostics.logPath()` names. Never
   the job's bytes: a slip carries a customer's name and what they bought.

## Tests

| | What it covers | Needs |
|---|---|---|
| `npm run test:print-catalogue` | the document catalogue, `planFor` | nothing |
| `npm run test:print-ipc` | validation rules, and the bridge's shape | nothing |
| `npm run test:print-tcp` | the network transport, on a loopback listener | nothing |
| `npm run test:print-queue` | the spooler transport, against a stub exe | csc.exe |
| `npm run test:device-printing` | the schema and the assignment layer | a site DB |
| `npm run test:kitchen-printing` | kitchen routing after the fold-in | a site DB |
| `npm run test:escpos` | the bytes themselves | nothing |

### What still needs hardware

Two machines on one site — a desktop till and a back-office PC:

- Change a network printer's address once, and confirm **both** follow without
  either machine being touched. That is the property the shop-wide address
  exists for.
- Assign the till slip to a real USB thermal printer and confirm the **cut** and
  the **drawer kick**. Both are raw ESC/POS, so both prove the helper.
- Assign a statement to *Save as PDF* and confirm it opens in a viewer.
- Pull the network cable and finalise a sale. The slip must still print — the
  bytes are a pure function over what is already in the till's memory, and the
  engine opens the socket locally.

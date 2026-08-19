# Stationery designer — what customers can put on a document

## Context

The designers work: A4 documents are laid out by dragging blocks on the page,
slips by dragging lines up and down, and both compile to what actually prints.
What a customer can *put* on a document is still the shipped set of blocks —
letterhead, tables, totals, notes. This plan adds the things shops keep asking
for, in the order they are worth building.

Five items, from the review. **Column control is deliberately excluded** — it
has been attempted before and did not work cleanly; it is worth revisiting on
its own rather than riding along with this.

## What the research found

Five facts shape every item below. They were checked in the code, not assumed.

**1. The ESC/POS encoder is text-only.** `src/lib/escpos/encoder.ts` has
`text`, `bold`, `align`, `size`, `feed`, `cut`, `drawerKick` and nothing else.
There is **no QR command (`GS ( k`) and no raster command (`GS v 0`)** anywhere
in the repo, no QR library in `package.json`, and no reference to one. Whatever
prints QR codes to Epson today does not go through this code path.

> **This needs confirming before step 1 is built.** If QR printing happens
> elsewhere — a different product, the printer's own driver, a firmware
> feature — then the encoder work below is new, not a port. It is one question
> with a large effect on the estimate.

**2. The slip has a byte-for-byte parity guarantee.**
`src/lib/escpos/slipSpec.ts` states that for the shipped design it emits the
same bytes the old hard-coded renderer did, and `scripts/test-slip-design.ts`
asserts exactly that. Adding a block kind must not change the bytes of a design
that does not use it — the parity suite is the check, and it has already caught
one head-state regression.

**3. The print bridge is transport-only.** `printRaw()` POSTs
`{ printer, dataBase64 }` to a local HTTP bridge. It has no opinion about
content, so anything we can encode as bytes, we can print. No bridge change is
needed for any item here.

**4. `markup` format already exists, with a strict rule.**
`TokenFormat` includes `'markup'` — server-composed HTML emitted unescaped —
and the catalog says plainly that a token may only carry it when its value is
built in TypeScript from something already proved safe. Today exactly one token
qualifies: `site.logo`. **A QR image and an uploaded picture are the same shape
of thing** and extend a precedent rather than inventing one.

**5. The image path is already built.** `storeImageUpload()` and `sniffImage()`
verify a picture by magic bytes and store it under a UUID; `readStoredFile()`
reads it back; pdfkit already draws images (`doc.image` in
`src/lib/stationery/pdf.ts`). Uploaded pictures reuse all of it.

## The constraint that governs all five

**Three unrelated engines**, and a block only earns a tile in the palette if
each can honour it or it degrades visibly and predictably:

| Channel | Engine | QR | Picture | Conditions |
|---|---|---|---|---|
| A4 paper | HTML + `@page` | `<img>` data URI | `<img>` | CSS/compile |
| Emailed PDF | pdfkit, hand-drawn | `doc.image` | `doc.image` | compile |
| Till slip | raw ESC/POS bytes | `GS ( k` **(to build)** | **no** | compile |

The honest boundary: **pictures are A4/PDF only.** Raster on a thermal head is
possible (`GS v 0`) but slow, coarse at 203dpi and paper-hungry; a CCTV
installer wants equipment photos on a quote, not on a till slip.

---

## 1. QR code block

The strongest item, and the only one that lands on both designers.

### The model

A QR is a block with a **payload**, which makes it the same shape as every
other block. One kind, three renderers.

```ts
{ kind: 'qr',
  qr: { target: 'doc' | 'store' | 'review' | 'custom',
        url?: string,          // 'custom' only
        caption?: string,      // "Scan to rate us"
        size?: 1 | 2 | 3 },
  ... }
```

### Targets are catalog-owned, not a free URL box

This is the part worth getting right. A free-text URL gives a static QR — the
same square on every document. The valuable version **varies per document**,
and only the catalog can safely produce those links:

- **`doc`** — this document. The customer scans their own invoice and lands on
  its tracking/portal page. `createOrderTrackToken()` and
  `createPublicStoreToken()` already mint exactly these.
- **`store`** — the shop's online store, from `lib/site/onlineStore.ts`.
- **`review`** — a shop-configured review link, stored once in settings so it
  is typed once rather than per design.
- **`custom`** — free `https:` URL, for everything else.

`resolveQrUrl()` in the catalog is the single place a target becomes a URL, and
the only place any of these are allowed to be composed.

### Two rules

**`https:` only**, matching the sanitiser's existing refusal of outbound
non-https references. A printed QR is a new outbound surface — it points a
customer somewhere without them reading it first.

**Show the resolved URL under the block in the designer.** A typo on 10,000
slips is discovered by a customer, not by us. Seeing the real link — including
the sample document's real token — is what stops that.

### Rendering

- **A4/HTML** — a QR PNG as a `data:` URI, composed server-side, carried as a
  `markup` token. Precedent: `site.logo`. The CSP forbids remote images, so
  data URIs are the only option, which is also the safe one.
- **PDF** — `doc.image` with the same PNG buffer.
- **Slip** — `GS ( k`. The encoder gains one method:

```ts
/** GS ( k — the QR command set every Epson-compatible head implements. */
qr(data: string, opts?: { size?: number; ec?: 'L'|'M'|'Q'|'H' }): this
```

Four sub-commands: model (`165 49`), module size (`167`), error correction
(`169`), store data (`180`), print (`181`). Store-data length is little-endian
`pL pH` — the one place this is easy to get wrong.

**Where APP_URL is unset**, `appUrl()` returns null rather than inventing a
host. A QR to nowhere is worse than no QR: the block prints its caption and no
square, and the designer says why.

### Library

No QR encoder is installed. `qrcode` (MIT, ~50KB, no native deps) generates
both the PNG for A4/PDF and — importantly — is not needed for the slip at all,
since `GS ( k` has the printer do its own encoding. That asymmetry is worth
keeping: the thermal path stays pure bytes.

### Verification

- `GS ( k` byte sequence asserted against the Epson spec, including a
  >256-byte payload to prove the `pL pH` split.
- Parity suite still green: a design without a QR block emits identical bytes.
- A real scan from a real Epson before it ships. A QR that renders is not a QR
  that scans — module size and quiet zone decide that, and only paper proves it.

---

## 2. Picture block (A4 and PDF only)

### The model

```ts
{ kind: 'image', image: { file: string, height?: number, align?: ... }, ... }
```

`file` is the UUID filename from `storeImageUpload()`, never a path and never a
URL — the same discipline `document_logo_file` uses, whose comment notes that a
filename an attacker cannot control carries no authority to be anything else.

### Reuses what exists

`storeImageUpload()` verifies by magic bytes, `sniffImage()` identifies the
format, `readStoredFile()` reads it back, pdfkit draws it. The one new piece is
a **small library of a shop's pictures** — upload once, use on several
documents — rather than an upload per block.

### The slip boundary, stated out loud

The block does not appear in the slip palette at all. Not greyed out with a
tooltip: absent, because a line that cannot print is not a line. The A4 palette
gains it; the slip's does not.

### Size discipline

`document_logo_file` already notes that an emailed PDF carries the file itself,
so a large logo is skipped rather than attached to every invoice. The same
ceiling applies here, and the designer says it before the upload rather than
after: **500KB**, with the picture skipped in email above it.

---

## 3. Conditional blocks — "show this only when…"

The most-used feature of the five, and the one most likely to grow badly if
built wrong.

### What it is NOT

`{#if}` was deliberately excluded from the template language, and that call
stands — a template language is a second thing to support forever. This is
**not** that. It is a property on a block, evaluated in TypeScript, chosen from
a fixed list in the catalog.

```ts
{ kind: 'text', showWhen?: { rule: 'docOverdue' | 'customerOnAccount' | ... }, ... }
```

### A fixed, catalog-owned list

Each rule is a named predicate over data the adapter already has. Starting set:

| Rule | True when | Why a shop wants it |
|---|---|---|
| `always` | (default) | today's behaviour |
| `docOverdue` | due date is past | a firmer footer on an overdue statement |
| `customerOnAccount` | account customer | payment terms only where they apply |
| `hasBalance` | amount due > 0 | "please pay" only when something is owed |
| `isPaid` | amount due = 0 | "PAID — thank you" |
| `hasDiscount` | any discount | "you saved R…" |
| `isVendor` | site is VAT-registered | already governs `site.vatLine` |

Growing the list is a catalog entry plus a predicate, and rules the spec no
longer recognises are **dropped on read** — the saved_reports doctrine, so a
design survives a rule being retired instead of failing to open.

### Why this is safe where `{#if}` was not

No expressions, no operators, no nesting, no user-authored logic — a closed set
of named questions the product already knows how to answer. It cannot become a
language because there is nothing to compose.

### It works in all three engines

The condition is evaluated at **compile** time, before any engine sees the
block: a block whose rule is false is simply not emitted. HTML, pdfkit and
ESC/POS need no changes at all. This is why it is cheap.

### In the designer

The inspector gains one select — "Show this: Always / When overdue / …" — and
the canvas marks conditional blocks so a shop can see at a glance which parts
of the page are situational. On the preview, blocks whose rule is false against
the sample document show ghosted rather than vanishing, or the design would
appear to have lost pieces.

---

## 5. Duplicate a design / copy to another document

Cheap, and it saves real work.

### Two operations

**Duplicate** — a copy of a design as a new inactive row, for "try something
without breaking what prints".

**Copy to another document type** — invoice design → quote design. The valuable
one, and the one with a catch worth handling properly.

### The catch: blocks that do not exist on the target

An invoice has `vatSummary` and `banking`; a delivery note must never show
prices. Copying cannot be a blind row clone.

So a copy **validates against the target's catalog and drops what it does not
recognise** — exactly what `mapReport()` does on read — and then **tells the
shop what it dropped**:

> Copied to Quote. Two blocks were left behind: *Banking details* and *VAT
> summary* — a quote has no place for them.

Silence here would be the bug. A shop that copies an invoice to a delivery note
and is not told the prices were dropped will assume they are there.

### Required blocks work the other way

If the target requires a block the source has not got — a tax invoice must say
TAX INVOICE — the copy **adds it from the target's shipped default** and says
so. A design that cannot legally print is not a design.

### Multi-store

`linkedStores()` already scopes cross-store work. Copying a design to another
store in the group is the same operation with a site id, and worth including
since a group setting up ten stores is exactly who feels this.

---

## 6. Barcode block (slip-first, A4 too)

Nearly free once the QR encoder work is done, and directly revenue-adjacent.

```ts
{ kind: 'barcode', barcode: { symbology: 'code128' | 'ean13', value: ..., caption?: ... } }
```

`GS k` for the slip, the same PNG/`doc.image` path for A4 and PDF. The payload
is catalog-owned like the QR's: a loyalty card number, a voucher code, the
document number. Shops use these for "show this at the till" promotions.

Built **after** the QR, deliberately: the two share the encoder work, the
payload-resolution shape and the designer inspector, and doing QR first proves
all three on the item that matters more.

---

## Build order

1. **Conditional blocks (3).** No engine changes, immediate value, and it makes
   every existing block more useful. Lowest risk of the five.
2. **Duplicate / copy (5).** Small, self-contained, no rendering work.
3. **Picture block (2).** A4/PDF only; reuses the whole upload path.
4. **QR block (1).** The encoder work, gated on the question above.
5. **Barcode block (6).** Rides the QR's rails.

1 and 2 are worth shipping on their own before any encoder work begins.

## Deliberately out of scope

- **Column control on the line table.** Attempted before, did not work cleanly,
  and it deserves its own attempt rather than riding along with this.
- **Raster images on thermal slips.** Possible, ugly, slow. See above.
- **Free-form HTML on slips.** A thermal head has no CSS; the block model is
  not a limitation to work around there.

## Verification

- Unit suites beside the existing ones (`test:stationery`,
  `test:stationery-blocks`, `test:slip-design` are the models):
  a false `showWhen` emits nothing in **all three** engines; a copy to a
  narrower document drops the right blocks and reports them; a QR resolves
  `https:` only and refuses everything else.
- **Parity suite must stay green** for every slip change — it is the guarantee
  that a shop changing nothing keeps the slip it had.
- A real scan off a real Epson for the QR and the barcode, before ship.
- Browser verification via CDP on :4100 from PowerShell, per the house rules.
- `npm run pre-publish` before calling any of it done.

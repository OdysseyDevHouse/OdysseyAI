import zlib from 'node:zlib'
import qrcode from 'qrcode-generator'

/**
 * QR codes for printed documents.
 *
 * ── ONE MATRIX, THREE ENGINES ─────────────────────────────────────────────
 *
 * The library gives a MODULE MATRIX — `isDark(row, col)` over an n×n grid —
 * rather than a picture, and that is exactly what makes it the right one here.
 * Each engine wants something different from the same squares:
 *
 *   A4 HTML   a PNG data URI, because the sanitiser strips <svg> outright and
 *             the CSP forbids a remote src, so a raster is the only route.
 *   PDF       filled rectangles drawn straight onto the page — pdfkit has no
 *             .svg(), and drawing the modules needs no image at all.
 *   Slip      NOTHING from this module. `GS ( k` has the thermal head encode
 *             its own, so the library never runs for a till slip and that path
 *             stays pure bytes.
 *
 * ── WHY THE PNG IS HAND-ROLLED ────────────────────────────────────────────
 *
 * A QR is two colours, so an 8-bit greyscale PNG is a header, one deflated
 * block and a CRC — and zlib is built into Node. Adding an image encoder to get
 * that would be a dependency for about forty lines of well-specified format. A
 * real 32-character URL comes out at 465 bytes.
 *
 * ── AND WHY THERE IS NO CACHE ─────────────────────────────────────────────
 *
 * Encoding a QR is sub-millisecond and a document has at most a couple. A cache
 * would be a correctness question — when does a per-document payload expire —
 * traded for a saving nobody can measure.
 */

/** Error correction. M is the usual compromise and what a printed code wants. */
export type QrEcc = 'L' | 'M' | 'Q' | 'H'

/** The modules, as rows of booleans. Dark is true. */
export type QrMatrix = { size: number; dark: (row: number, col: number) => boolean }

/**
 * The QR for a payload.
 *
 * Type 0 lets the library pick the smallest version the data fits, so a long
 * tracking URL simply produces a denser code rather than an error.
 */
export function qrMatrix(text: string, ecc: QrEcc = 'M'): QrMatrix {
  const q = qrcode(0, ecc)
  q.addData(text)
  q.make()
  const size = q.getModuleCount()
  return { size, dark: (row, col) => q.isDark(row, col) }
}

/* ── PNG ─────────────────────────────────────────────────────────────────── */

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = c ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([len, typed, crc])
}

/**
 * The QR as PNG bytes.
 *
 * `quiet` is the mandatory blank margin — four modules, per the QR spec. A code
 * printed hard against other ink is a code a scanner will not find, and it is
 * the single most common reason a rendered QR fails to scan.
 */
export function qrPng(text: string, opts: { scale?: number; ecc?: QrEcc } = {}): Buffer {
  const scale = Math.min(Math.max(Math.round(opts.scale ?? 4), 1), 16)
  const quiet = 4
  const m = qrMatrix(text, opts.ecc)

  const size = (m.size + quiet * 2) * scale
  /* One filter byte per row, then one byte per pixel. 0xff is white. */
  const raw = Buffer.alloc((size + 1) * size, 0xff)
  for (let y = 0; y < size; y++) raw[y * (size + 1)] = 0

  for (let my = 0; my < m.size; my++) {
    for (let mx = 0; mx < m.size; mx++) {
      if (!m.dark(my, mx)) continue
      for (let dy = 0; dy < scale; dy++) {
        const y = (my + quiet) * scale + dy
        const rowStart = y * (size + 1) + 1
        raw.fill(0x00, rowStart + (mx + quiet) * scale, rowStart + (mx + quiet + 1) * scale)
      }
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // greyscale

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** The QR as a data URI, for an <img> on an A4 page. */
export function qrDataUri(text: string, opts?: { scale?: number; ecc?: QrEcc }): string {
  return `data:image/png;base64,${qrPng(text, opts).toString('base64')}`
}

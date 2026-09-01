// Builds build/icon.ico — the icon Windows puts on the .exe, the installer, the
// Start-menu tile, the desktop shortcut and the taskbar button.
//
// ── WHY A SCRIPT, AND WHY THE OUTPUT IS COMMITTED ──────────────────────────
//
// The source of truth is public/logo-icon.png, which is also what the app
// itself renders — one artwork, so the icon on the taskbar and the mark on the
// sign-in screen can never drift apart. But electron-builder needs a .ico, and
// a .ico is not something a designer hands over: it is seven bitmaps in one
// container, and Windows picks between them by context (16px in a file list,
// 32px on the taskbar, 256px in the Start menu's large-icon view). Handing
// electron-builder the .png and letting it convert produces a single upscaled
// bitmap that looks like porridge at 16px.
//
// So the .ico is generated here and COMMITTED. A build must not depend on sharp
// being installed or on this script having been run — `npm run dist` on a clean
// checkout has to produce a correctly branded installer. Re-run this only when
// the artwork changes:
//
//     node scripts/make-icons.mjs
//
// ── WHY THE SMALL SIZES ARE BMP AND THE LARGE ONES PNG ─────────────────────
//
// An .ico entry may hold either. Windows has read PNG entries since Vista, but
// only for the large sizes in practice — plenty of shell surfaces, and every
// icon editor older than about 2010, still expect a raw DIB below 128px and
// show nothing at all when they find a PNG there. A blank 16px icon in Explorer
// is not a failure anybody notices until a customer mentions it.
//
// PNG above that is not optional the other way round: a 256×256 BMP entry is
// 256KB on its own and the container would be over 350KB, which is the reason
// the PNG entry type was added in the first place.
import { Buffer } from 'node:buffer'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'public', 'logo-icon.png')
const target = path.join(root, 'build', 'icon.ico')

// Below 128 the shell wants a DIB; at and above it, a PNG. See the header.
const SIZES = [16, 24, 32, 48, 64, 128, 256]
const PNG_FROM = 128

/**
 * The artwork is wider than it is tall and an icon canvas is square, so it is
 * letterboxed rather than stretched — `fit: 'contain'` on a transparent ground.
 * Squashing a logo to fill the square is the one thing that would make it look
 * wrong at every size at once.
 */
function square(size) {
  return sharp(source)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
}

/**
 * A BMP entry inside an .ico is a BITMAPINFOHEADER with NO file header, a
 * bottom-up BGRA bitmap, and then a 1bpp AND mask — which is legacy and unused
 * at 32bpp, where the alpha channel does the masking, but is still required to
 * be present and rows still pad to 4 bytes.
 *
 * The height in the header is DOUBLE the real height. That is not a mistake in
 * this code: the field describes the XOR bitmap and the AND mask stacked, and
 * writing the true height there is the classic way to end up with an icon that
 * renders as its own bottom half.
 */
async function dibEntry(size) {
  const { data } = await square(size).raw().toBuffer({ resolveWithObject: true })

  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0) // biSize
  header.writeInt32LE(size, 4) // biWidth
  header.writeInt32LE(size * 2, 8) // biHeight — XOR + AND, see above
  header.writeUInt16LE(1, 12) // biPlanes
  header.writeUInt16LE(32, 14) // biBitCount
  header.writeUInt32LE(0, 16) // biCompression = BI_RGB

  const xor = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    // Bottom-up: the last row of the image is the first row of the bitmap.
    const src = (size - 1 - y) * size * 4
    for (let x = 0; x < size; x++) {
      const s = src + x * 4
      const d = (y * size + x) * 4
      xor[d] = data[s + 2] // B
      xor[d + 1] = data[s + 1] // G
      xor[d + 2] = data[s] // R
      xor[d + 3] = data[s + 3] // A
    }
  }

  // All-zero mask: "every pixel is the icon's". Alpha decides what shows.
  const maskStride = Math.ceil(size / 32) * 4
  const mask = Buffer.alloc(maskStride * size)

  header.writeUInt32LE(xor.length + mask.length, 20) // biSizeImage
  return Buffer.concat([header, xor, mask])
}

const images = await Promise.all(
  SIZES.map((size) => (size >= PNG_FROM ? square(size).toBuffer() : dibEntry(size))),
)

const dir = Buffer.alloc(6)
dir.writeUInt16LE(0, 0) // reserved
dir.writeUInt16LE(1, 2) // type: 1 = icon
dir.writeUInt16LE(SIZES.length, 4)

const entries = Buffer.alloc(16 * SIZES.length)
// Every entry's offset is past the whole directory, so the directory has to be
// sized before any of it can be filled in.
let offset = dir.length + entries.length
SIZES.forEach((size, i) => {
  const at = i * 16
  // 256 does not fit in a byte and is written as 0. The format says so; it is
  // the reason 256 is the largest size an .ico can hold.
  entries.writeUInt8(size >= 256 ? 0 : size, at)
  entries.writeUInt8(size >= 256 ? 0 : size, at + 1)
  entries.writeUInt8(0, at + 2) // palette size — none, this is truecolour
  entries.writeUInt8(0, at + 3) // reserved
  entries.writeUInt16LE(1, at + 4) // planes
  entries.writeUInt16LE(32, at + 6) // bits per pixel
  entries.writeUInt32LE(images[i].length, at + 8)
  entries.writeUInt32LE(offset, at + 12)
  offset += images[i].length
})

writeFileSync(target, Buffer.concat([dir, entries, ...images]))
console.log(
  `Wrote ${path.relative(root, target)} — ${SIZES.join(', ')}px, ${(offset / 1024).toFixed(1)}KB`,
)

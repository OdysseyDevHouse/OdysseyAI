// Downloads the demo catalogue's photography into uploads/.
//
// Every file is verified with the same magic-number check the app applies on
// upload AND again on serve (src/lib/uploads.ts sniffImage) — a file that is
// not a real JPEG would serve a 404 and the tile would fall back to a
// lettermark, so it is better to fail here, loudly.
//
//   node scripts/tmp-fetch-photos.mjs
//
// Writes a manifest mapping photo id -> stored name so the seeder can insert
// matching product_images rows. Re-running skips photos already fetched.
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PRODUCTS, STOREFRONT_IMAGES } from './catalogue.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const uploadsDir = path.join(root, 'uploads')
const manifestPath = path.join(root, '.demo-seed', 'photo-manifest.json')

// Same check as src/lib/uploads.ts sniffImage, for jpeg/png/webp.
function sniff(b) {
  if (b.length < 12) return null
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp'
  return null
}

// Large enough to look sharp on a product page without bloating uploads/.
function urlFor(photoId, w) {
  return `https://images.unsplash.com/${photoId}?w=${w}&h=${Math.round(w * 0.75)}&fit=crop&q=80&fm=jpg`
}

async function fetchOne(photoId, width) {
  const res = await fetch(urlFor(photoId, width), { headers: { accept: 'image/jpeg' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  const format = sniff(bytes)
  if (format !== 'jpeg') throw new Error(`not a JPEG (sniffed: ${format ?? 'unknown'})`)
  if (bytes.byteLength < 5000) throw new Error(`suspiciously small: ${bytes.byteLength} bytes`)
  return bytes
}

const manifest = existsSync(manifestPath)
  ? JSON.parse(await readFile(manifestPath, 'utf8'))
  : {}

await mkdir(uploadsDir, { recursive: true })

// Keyed by PRODUCT CODE, not by photo id: product_images.stored_name is
// UNIQUE, so two products cannot point at one file even when they show the
// same picture. Each gets its own copy on disk.
const wanted = [
  ...PRODUCTS.map((p) => ({ photo: p[6], width: 900, key: `${p[0]}@900` })),
  ...STOREFRONT_IMAGES.map((s) => ({ photo: s.photo, width: 1600, key: `${s.photo}@1600` })),
]

let fetched = 0
let skipped = 0
const failed = []

for (const { photo, width, key } of wanted) {
  if (manifest[key] && existsSync(path.join(uploadsDir, manifest[key].storedName))) {
    skipped++
    continue
  }
  let lastErr
  let ok = false
  for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
    try {
      const bytes = await fetchOne(photo, width)
      const storedName = `${randomUUID()}.jpg`
      await writeFile(path.join(uploadsDir, storedName), bytes)
      manifest[key] = { storedName, sizeBytes: bytes.byteLength, mimeType: 'image/jpeg' }
      fetched++
      ok = true
      process.stdout.write('.')
    } catch (e) {
      lastErr = e
      await new Promise((r) => setTimeout(r, 400 * attempt))
    }
  }
  if (!ok) {
    failed.push(`${photo}: ${lastErr?.message ?? 'unknown'}`)
    process.stdout.write('x')
  }
}

await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
console.log(`\nfetched ${fetched}, already had ${skipped}, failed ${failed.length}`)
if (failed.length) {
  console.log('FAILED:')
  for (const f of failed) console.log('  ' + f)
}

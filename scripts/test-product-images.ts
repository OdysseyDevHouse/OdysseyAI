/**
 * Product images, against a live site database.
 *
 * These render INLINE on a public page, which makes them the highest-risk
 * uploads in the app: a file that is not really an image, served from our own
 * origin, is a stored XSS on a shop that takes payments.
 *
 * So the checks below are mostly about what must NOT get in —
 *
 *   an SVG (an XML document that can carry <script>);
 *   an HTML page with a .png name (the classic extension-check bypass);
 *   anything whose bytes are not one of four formats we can serve.
 *
 * Plus the invariant that keeps the UI honest: exactly one primary image.
 *
 *   npm run test:product-images
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import {
  MAX_IMAGES_PER_PRODUCT,
  addImage,
  deleteImage,
  getImage,
  listImages,
  primaryImages,
  reorderImages,
  setAltText,
  setPrimaryImage,
} from '../src/lib/site/productImages'
import { sniffImage, storeImageUpload, readStoredFile, deleteStoredFile } from '../src/lib/uploads'

const SITE = 1
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/* ── Fixtures: the smallest real files of each kind ────────────────────────── */

/** A 1×1 transparent PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)
/** A minimal JPEG (SOI + APP0 + EOI). */
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2Q==', 'base64')
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
/** RIFF....WEBP */
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x1a, 0, 0, 0]),
  Buffer.from('WEBPVP8 ', 'ascii'),
  Buffer.alloc(14),
])

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
const HTML = Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>')

function asFile(bytes: Buffer, name: string, type = 'image/png'): File {
  return new File([new Uint8Array(bytes)], name, { type })
}

async function cleanup(productId: number) {
  const rows = await siteQuery<{ stored_name: string }>(
    SITE,
    `SELECT stored_name FROM product_images WHERE product_id = ?`,
    [productId],
  )
  for (const r of rows) await deleteStoredFile(String(r.stored_name))
  await siteExecute(SITE, `DELETE FROM product_images WHERE product_id = ?`, [productId])
  await siteExecute(SITE, `UPDATE products SET image_path = NULL WHERE id = ?`, [productId])
}

async function main() {
  const product = await siteQueryOne<{ id: number }>(
    SITE,
    `SELECT id FROM products WHERE is_archived = 0 ORDER BY id LIMIT 1`,
  )
  if (!product) throw new Error('Need a product to attach images to.')
  const productId = Number(product.id)

  const imagePathBefore = await siteQueryOne<{ image_path: string | null }>(
    SITE,
    `SELECT image_path FROM products WHERE id = ?`,
    [productId],
  )
  await cleanup(productId)

  console.log('\n— Recognising real images by their bytes —')
  ok('a PNG is recognised', sniffImage(PNG) === 'png')
  ok('a JPEG is recognised', sniffImage(JPEG) === 'jpeg')
  ok('a GIF is recognised', sniffImage(GIF) === 'gif')
  ok('a WebP is recognised', sniffImage(WEBP) === 'webp')

  console.log('\n— What must never get in —')
  // The whole reason this module exists. An SVG served inline from our own
  // origin executes its script with access to the page.
  ok('an SVG is NOT an image we will serve', sniffImage(SVG) === null)
  ok('an HTML document is not either', sniffImage(HTML) === null)
  ok('empty bytes are not', sniffImage(Buffer.alloc(0)) === null)
  ok('a few random bytes are not', sniffImage(Buffer.from('not an image at all')) === null)

  // The classic bypass: name it .png and hope only the extension is checked.
  const disguised = await storeImageUpload(asFile(HTML, 'photo.png', 'image/png'))
  ok('HTML renamed .png is REFUSED', !disguised.ok, disguised.ok ? 'it was accepted!' : disguised.error)

  const svgAsPng = await storeImageUpload(asFile(SVG, 'logo.png', 'image/png'))
  ok('an SVG renamed .png is REFUSED', !svgAsPng.ok)

  // Rejected by extension before the bytes are even read, so the message names
  // what to convert to.
  const svgNamed = await storeImageUpload(asFile(SVG, 'logo.svg', 'image/svg+xml'))
  ok('an honestly-named SVG is refused', !svgNamed.ok)

  ok('an empty file is refused', !(await storeImageUpload(asFile(Buffer.alloc(0), 'x.png'))).ok)
  ok(
    'a PDF is refused',
    !(await storeImageUpload(asFile(Buffer.from('%PDF-1.4'), 'doc.pdf', 'application/pdf'))).ok,
  )

  console.log('\n— The stored file matches its real format —')
  // A JPEG called .png must be stored and served AS a JPEG, not carry the lie
  // forward into a Content-Type header.
  const mislabelled = await storeImageUpload(asFile(JPEG, 'actually-a-jpeg.png'))
  ok('a JPEG named .png is accepted', mislabelled.ok, mislabelled.ok ? '' : mislabelled.error)
  if (mislabelled.ok) {
    ok('but stored as a JPEG', mislabelled.file.format === 'jpeg')
    ok('with the JPEG mime type', mislabelled.file.mimeType === 'image/jpeg')
    ok('and a .jpg on disk', mislabelled.file.storedName.endsWith('.jpg'))
    // The generated name is a UUID, so nothing the caller sent reaches a path.
    ok(
      'the stored name has nothing of the original in it',
      !mislabelled.file.storedName.includes('actually'),
      mislabelled.file.storedName,
    )
    await deleteStoredFile(mislabelled.file.storedName)
  }

  console.log('\n— A path cannot escape the uploads directory —')
  ok('a traversal name reads nothing', (await readStoredFile('../../.env')) === null)
  ok('an absolute path reads nothing', (await readStoredFile('/etc/passwd')) === null)
  ok('a nested name reads nothing', (await readStoredFile('sub/dir/file.png')) === null)

  console.log('\n— Attaching images to a product —')
  const first = await addImage(SITE, productId, asFile(PNG, 'front.png'), 'The front')
  ok('the first image attaches', first.ok, first.ok ? '' : first.error)
  // Nobody wants to upload one photo and then be told to nominate it.
  ok('and becomes the main one automatically', first.ok && first.image.isPrimary)
  ok('its alt text is kept', first.ok && first.image.altText === 'The front')

  const second = await addImage(SITE, productId, asFile(JPEG, 'back.jpg'))
  ok('a second attaches', second.ok)
  ok('but does NOT steal primary', second.ok && !second.image.isPrimary)

  const listed = await listImages(SITE, productId)
  ok('both are listed', listed.length === 2)
  ok('exactly one is primary', listed.filter((i) => i.isPrimary).length === 1)

  // products.image_path is what the till button and older screens read.
  const synced = await siteQueryOne<{ image_path: string | null }>(
    SITE,
    `SELECT image_path FROM products WHERE id = ?`,
    [productId],
  )
  ok(
    'products.image_path follows the main image',
    first.ok && synced?.image_path === first.image.storedName,
  )

  console.log('\n— Exactly one primary, always —')
  if (second.ok) {
    await setPrimaryImage(SITE, productId, second.image.id)
    const after = await listImages(SITE, productId)
    ok('nominating one promotes it', after.find((i) => i.id === second.image.id)?.isPrimary === true)
    ok('and demotes the other', after.filter((i) => i.isPrimary).length === 1)
    const resynced = await siteQueryOne<{ image_path: string | null }>(
      SITE,
      `SELECT image_path FROM products WHERE id = ?`,
      [productId],
    )
    ok('image_path follows the change', resynced?.image_path === second.image.storedName)
  }

  console.log('\n— Ordering —')
  if (first.ok && second.ok) {
    await reorderImages(SITE, productId, [second.image.id, first.image.id])
    const ordered = await listImages(SITE, productId)
    ok('the order is respected', ordered[0].id === second.image.id)
    // An id belonging to another product must not be moved by this call.
    await reorderImages(SITE, productId, [99_999_999])
    ok('a foreign id is ignored', (await listImages(SITE, productId)).length === 2)
  }

  console.log('\n— Every storefront query carries the picture —')
  // The bug this caught: the image subquery was added to two of the three
  // product queries, so a product showed its photo on its own page and a bare
  // tile in the listing. Each path is checked separately because they are
  // three separate SELECTs that must agree.
  {
    const { storefrontContext, publishedProduct, publishedProducts, newestProducts } = await import(
      '../src/lib/site/storefront'
    )
    const context = await storefrontContext(SITE)
    if (!context) {
      console.log('SKIP  the shop is closed, so the storefront queries cannot run')
    } else {
      const single = await publishedProduct(context, productId)
      if (single) {
        ok('the product page carries an image id', single.imageId !== null)
        const listed = (await publishedProducts(context, { limit: 120 })).find(
          (p) => p.id === productId,
        )
        // Only meaningful when this product is actually in the listing.
        if (listed) ok('the listing carries it too', listed.imageId !== null)
        const newest = (await newestProducts(context, 24)).find((p) => p.id === productId)
        if (newest) ok('and so does "newest"', newest.imageId !== null)
        ok('alt text falls back to the description, never empty', single.imageAlt !== '')
      } else {
        console.log('SKIP  this product is not published, so the storefront cannot see it')
      }
    }
  }

  console.log('\n— One picture per product, in bulk —')
  const map = await primaryImages(SITE, [productId])
  ok('the batched lookup finds it', map.has(productId))
  ok('and returns the primary', map.get(productId)?.isPrimary === true)
  ok('an empty list asks nothing', (await primaryImages(SITE, [])).size === 0)

  console.log('\n— Only this product’s images are reachable —')
  if (first.ok) {
    ok('by the right product it resolves', (await getImage(SITE, productId, first.image.id)) !== null)
    // The guard the serving routes rely on: an image id alone is guessable.
    ok(
      'by the WRONG product it does not',
      (await getImage(SITE, productId + 99_999, first.image.id)) === null,
    )
  }

  console.log('\n— Deleting —')
  if (second.ok && first.ok) {
    const storedName = second.image.storedName
    await deleteImage(SITE, productId, second.image.id)
    const left = await listImages(SITE, productId)
    ok('the row is gone', left.length === 1)
    ok('the file is gone too', (await readStoredFile(storedName)) === null)
    // A product with images but no primary would render a blank tile.
    ok('deleting the primary promotes the next', left[0].isPrimary === true)
    ok('deleting a missing image is refused', !(await deleteImage(SITE, productId, second.image.id)).ok)
  }

  console.log('\n— Limits —')
  const current = await listImages(SITE, productId)
  for (let i = current.length; i < MAX_IMAGES_PER_PRODUCT; i++) {
    await addImage(SITE, productId, asFile(PNG, `fill-${i}.png`))
  }
  ok('the product fills to its cap', (await listImages(SITE, productId)).length === MAX_IMAGES_PER_PRODUCT)
  const overflow = await addImage(SITE, productId, asFile(PNG, 'one-too-many.png'))
  ok('one more is refused', !overflow.ok, overflow.ok ? '' : overflow.error)

  ok('alt text can be changed', (await setAltText(SITE, productId, current[0].id, 'Updated')).ok)
  ok(
    'alt text on a foreign image is refused',
    !(await setAltText(SITE, productId, 99_999_999, 'x')).ok,
  )

  console.log('\n— Cleanup —')
  await cleanup(productId)
  await siteExecute(SITE, `UPDATE products SET image_path = ? WHERE id = ?`, [
    imagePathBefore?.image_path ?? null,
    productId,
  ])
  ok('every test image removed', (await listImages(SITE, productId)).length === 0)

  console.log(`\n${fails === 0 ? 'All product image checks passed.' : `${fails} FAILED.`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  process.exit(1)
})

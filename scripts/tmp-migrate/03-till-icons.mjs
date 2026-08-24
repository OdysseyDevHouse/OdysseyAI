// Gives every imported product its till-button icon.
//
//   node --env-file=.env scripts/tmp-migrate/03-till-icons.mjs <siteId>
//
// The import wrote each picture to product_images and mirrored the primary into
// products.image_path, which is what the photographs panel does. That covers
// the product page and the storefront, but NOT the till button: the button
// reads products.image_icon, a separate column owned by the till-icon picker
// (src/lib/site/productImages.ts, "The till icon"). A product with a photograph
// and no icon renders as a coloured tile with its initials on it.
//
// The two columns are genuinely different pictures — a photograph is
// merchandising, the icon is a glyph on a key — but this catalogue has only one
// picture per product, so the same file is the best answer for both. It is
// pointed at rather than copied: both columns hold a stored NAME, and the file
// on disk is the same file.
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createDecipheriv, scryptSync } from 'node:crypto'
import mysql from 'mysql2/promise'

const siteId = Number(process.argv[2])
if (!Number.isFinite(siteId) || siteId <= 0) {
  console.error('Usage: node --env-file=.env scripts/tmp-migrate/03-till-icons.mjs <siteId>')
  process.exit(1)
}

const DB = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
}

const ENC_PREFIX = 'enc:v1:'
function decryptSecret(stored) {
  if (!stored) return ''
  if (!stored.startsWith(ENC_PREFIX)) return stored
  const [iv, tag, ct] = stored
    .slice(ENC_PREFIX.length)
    .split(':')
    .map((s) => Buffer.from(s, 'base64'))
  const key = scryptSync(process.env.ENCRYPTION_KEY, 'odyssey-secret-v1', 32)
  const d = createDecipheriv('aes-256-gcm', key, iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
}

const control = await mysql.createConnection({ ...DB, database: process.env.DB_NAME })
const [[reg]] = await control.query(
  `SELECT server_host, server_port, database_name, db_username, db_password_enc
     FROM cp2_site_databases
    WHERE site_id = ? AND status = 'active' AND purpose = 'master' LIMIT 1`,
  [siteId],
)
await control.end()
if (!reg) {
  console.error(`Site ${siteId} has no active master database.`)
  process.exit(1)
}

const site = await mysql.createConnection({
  host: process.env.SITE_DB_HOST_OVERRIDE || reg.server_host,
  port: reg.server_port,
  user: reg.db_username,
  password: decryptSecret(reg.db_password_enc),
  database: reg.database_name,
})

// Only where the product has no icon yet, so re-running this cannot overwrite
// an icon somebody has since chosen deliberately.
const [res] = await site.query(
  `UPDATE products SET image_icon = image_path
    WHERE image_path IS NOT NULL AND image_path <> '' AND image_icon IS NULL`,
)
console.log(`Till icons set: ${res.affectedRows}`)

const [[left]] = await site.query(
  "SELECT COUNT(*) n FROM products WHERE image_icon IS NULL OR image_icon = ''",
)
console.log(`Products still without a till icon: ${left.n}`)

await site.end()

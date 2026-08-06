/**
 * Product image facts shared by the server and the browser.
 *
 * No `server-only` marker and no database or filesystem import, because the
 * image manager runs in the browser and needs the same limits and labels the
 * server enforces. Importing the server module for a constant would drag
 * mysql2 and node:fs into the client bundle — which is exactly what happened
 * before this file existed.
 *
 * The enforcement still lives on the server. These are the numbers the UI
 * quotes; lib/uploads.ts and lib/site/productImages.ts are what actually
 * refuse a bad upload.
 */

/** How many photographs one product may carry. */
export const MAX_IMAGES_PER_PRODUCT = 8

/** Largest image accepted, in bytes. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/** Named in the file picker and in the error a rejected upload produces. */
export const IMAGE_EXTENSIONS_LABEL = 'PNG, JPG, GIF or WebP'

/** The `accept` attribute for a file input, so the picker filters sensibly. */
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp'

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp'

/**
 * The one MIME type we will ever serve for each verified format.
 *
 * Here rather than beside the sniffing code because the value is a fact about
 * the format, and both halves of the app describe it.
 */
export const IMAGE_MIME: Record<ImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** One product photograph, as every screen receives it. */
export type ProductImage = {
  id: number
  productId: number
  storedName: string
  filename: string
  mimeType: string
  sizeBytes: number
  altText: string
  sortOrder: number
  isPrimary: boolean
}

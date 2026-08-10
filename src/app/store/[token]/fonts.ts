import { Inter, Lora, Poppins, Source_Serif_4 } from 'next/font/google'
import type { FontKey } from '@/lib/storefrontModel'

/**
 * The shop's typeface, self-hosted.
 *
 * ── WHY EVERY FONT IS DECLARED AT MODULE SCOPE ───────────────────────────
 *
 * `next/font/google` is not a runtime function — it is a build-time
 * transform. It downloads the files during the build and emits them as static
 * assets on this origin, which is what removes the third-party request that
 * would otherwise make a shopper's browser tell Google which shop they are
 * looking at. That only works if the call is a top-level literal: calling it
 * inside a component, or with a variable family name, is a build error rather
 * than a slow path.
 *
 * So all four are declared here and the shop picks between the CLASS NAMES.
 * The cost is four font files in the build; the benefit is that a shop's
 * choice is a lookup rather than a network call, and a value in the database
 * can never become a request to somewhere unexpected.
 *
 * ── display: 'swap' ON ALL OF THEM ───────────────────────────────────────
 *
 * Text paints immediately in the fallback and is replaced when the face
 * arrives. The alternative — invisible text while a font loads — is a blank
 * shop on a slow connection, which is the case that matters most here.
 */

const inter = Inter({ subsets: ['latin'], display: 'swap' })
const lora = Lora({ subsets: ['latin'], display: 'swap' })
// Poppins has no variable build, so the weights the shop actually uses are
// named: body, medium for labels, and semibold for headings.
const poppins = Poppins({ subsets: ['latin'], weight: ['400', '500', '600'], display: 'swap' })
const sourceSerif = Source_Serif_4({ subsets: ['latin'], display: 'swap' })

/**
 * The class that applies a shop's chosen font, or '' for the device's own.
 *
 * '' rather than a class that re-declares the system stack: globals.css
 * already sets that on `body`, and an empty string lets it through untouched.
 */
export function fontClass(key: FontKey): string {
  switch (key) {
    case 'inter':
      return inter.className
    case 'lora':
      return lora.className
    case 'poppins':
      return poppins.className
    case 'source-serif':
      return sourceSerif.className
    default:
      return ''
  }
}

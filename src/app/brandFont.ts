import { Archivo } from 'next/font/google'

/**
 * The wordmark typeface — the font the Odyssey logo is drawn in.
 *
 * The logo PNG carries "ODYSSEY" set in a heavy grotesque, and every screen
 * that puts a heading NEXT TO that logo was setting it in the UI stack (Segoe
 * UI on Windows). Two typefaces a few pixels apart, one of them a humanist UI
 * face and the other a geometric-ish grotesque, reads as a mistake even to
 * someone who could not name what is wrong — the brand and the app look like
 * they came from different products.
 *
 * Archivo is the match. It was chosen by overlaying candidates directly on the
 * logo artwork rather than by eye: its O is the same slightly-narrowed oval
 * (Montserrat's and Poppins' are true circles), its S has the same flat,
 * horizontally-cut terminals, and its Y and D land on the logo's own strokes.
 *
 * ── WHY THIS IS NOT THE BODY FONT ────────────────────────────────────────
 *
 * Only the wordmark and the screen titles that sit beside it use this. The
 * body stays on the system stack set in globals.css: a till and a back office
 * are read all day, the system face is the one the OS hints best at small
 * sizes, and swapping every label in the app for a downloaded font would cost
 * a flash of unstyled text on the one screen — the till — that must be usable
 * the instant it opens.
 *
 * `next/font/google` is a BUILD-TIME transform: the files are downloaded during
 * the build and served from this origin, so no screen makes a request to
 * Google. That is also why this is a top-level literal — see the same note in
 * `src/app/store/[token]/fonts.ts`, which does this for storefront themes.
 *
 * Weights are named because only these are used: 700 for the tracked subline,
 * 800 for the wordmark itself. `display: 'swap'` paints the fallback first
 * rather than leaving a till's header blank while the face arrives.
 */
export const brandFont = Archivo({
  subsets: ['latin'],
  weight: ['700', '800'],
  display: 'swap',
  variable: '--font-brand',
})

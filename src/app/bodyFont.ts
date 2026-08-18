import { Inter } from 'next/font/google'

/**
 * The UI typeface — everything that is not the wordmark.
 *
 * ── WHY A DOWNLOADED FACE RATHER THAN THE SYSTEM STACK ────────────────────
 *
 * The app used to set body text in whatever the OS offered: Segoe UI on
 * Windows, SF Pro on macOS, Roboto on Android. That is the cheapest possible
 * choice and it costs nothing to load, but it means the product looks like a
 * different piece of software on every machine it runs on — and a back office
 * on Windows sitting beside a till on Android could not be shown in the same
 * screenshot without the difference being obvious.
 *
 * Inter is the face for this job: drawn for user interfaces at small sizes,
 * with a tall x-height that keeps 14px labels legible, and unambiguous figures
 * — a slashed nothing-like zero and a 1 with a foot — which matters on screens
 * that are mostly money.
 *
 * ── THE FALLBACK STACK IS THE OLD BEHAVIOUR ───────────────────────────────
 *
 * Listed after Inter, so a machine that has not finished downloading it — or
 * cannot — renders exactly what the app used to. Segoe UI, SF Pro and Roboto
 * are all close enough in metrics that the swap is a shift in texture rather
 * than a reflow.
 *
 * ── WHY THIS DOES NOT FLASH ───────────────────────────────────────────────
 *
 * `next/font/google` is a BUILD-TIME transform: the files are downloaded during
 * the build and served from this origin, so no screen makes a request to Google
 * and the face is already same-origin cached by the time a till opens.
 * `display: 'swap'` then paints the fallback immediately rather than leaving
 * text blank — the concern that kept the till on the system stack, now handled
 * by serving the font locally rather than by refusing to use one.
 *
 * Weights are named because only these are used: 400 and 500 for body text,
 * 600 and 700 for headings, and 800 for the three till displays that shout a
 * figure across a counter (NumPad, PinPad). 800 is loaded rather than left to
 * the browser: asked for a weight it does not have, it SYNTHESISES one by
 * smearing the 700 outlines, which at the 26-30px those displays use looks
 * like a rendering fault rather than a bolder face.
 */
export const bodyFont = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  display: 'swap',
  variable: '--font-body',
})

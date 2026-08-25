'use client'

/**
 * The "it went through" animation, at the top of the sale-complete dialog.
 *
 * A disc pops in, a tick draws itself, and eighteen particles burst outward and
 * fade. It runs ONCE per open rather than looping: this dialog is on screen for
 * about three seconds while money changes hands, and a tick that keeps
 * re-drawing itself reads as "still working" — the opposite of what it is here
 * to say. (The Modal remounts its body on every open, so "once" is once per
 * sale without any state of our own.)
 *
 * Colour comes from `currentColor`, so the caller's `text-success` is the only
 * place the colour is named — there is no hex in this file. The white tick is
 * the one exception it cannot avoid: it is the KNOCKOUT out of the disc, and a
 * knockout is the surface behind it, `--color-surface`, not a success tone.
 *
 * Local to the till, not the kit: this is decoration for ONE dialog. If a
 * second screen ever wants it, that is the moment it moves to `components/ui/`
 * and onto the Style Guide — not before.
 */
export function SuccessBurst({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      /* Cropped tight to the disc, and sized 1:1 WITH THE RENDERED BOX — 112
         units square for the caller's 112px square.

         The 1:1 matters more than it looks. The particle keyframes translate in
         CSS `px` under `transform-box: view-box`, and those px are NOT scaled
         by the viewBox ratio the way the geometry is. At a 160-unit box drawn
         at 112px (0.7) a particle told to travel 40 units moved 215px on
         screen — three times its drawn distance — and flew off the top of the
         modal body. Matching the two makes one unit one pixel everywhere, so
         the numbers in PARTICLES are the distances actually travelled.

         Keep them equal. Changing one without the other silently re-scales the
         burst without touching the drawing.

         The particles are drawn well outside this box on purpose and are NOT
         clipped: an SVG does not clip to its viewBox unless asked, so the
         caller adds `overflow-visible` and the burst spends the dialog's own
         padding instead of reserving layout of its own. */
      viewBox="144 72 112 112"
      className={`pointer-events-none text-success ${className ?? ''}`}
      fill="currentColor"
    >
      {/* Scoped by the `sb-` prefix rather than a CSS module: the keyframes are
          part of the drawing, and splitting them into another file means the
          particle timings and the particle geometry can drift apart. */}
      <style>{`
        .sb-halo{fill:currentColor;transform-origin:200px 128px;transform-box:view-box;
          animation:sb-halo-k 1.6s cubic-bezier(.2,.7,.3,1) both}
        @keyframes sb-halo-k{
          0%{opacity:0;transform:scale(.55)}
          10%{opacity:.30;transform:scale(.8)}
          60%,100%{opacity:0;transform:scale(1.62)}
        }
        .sb-disc{fill:currentColor;transform-origin:200px 128px;transform-box:view-box;
          animation:sb-disc-k 1.6s cubic-bezier(.34,1.56,.5,1) both}
        @keyframes sb-disc-k{
          0%{opacity:0;transform:scale(0)}
          6%{opacity:1;transform:scale(.35)}
          40%,100%{opacity:1;transform:scale(1)}
        }
        .sb-tick{fill:none;stroke:var(--color-surface);stroke-width:8;stroke-linecap:round;
          stroke-linejoin:round;stroke-dasharray:54;
          animation:sb-tick-k 1.6s cubic-bezier(.2,.8,.3,1) both}
        @keyframes sb-tick-k{
          0%,20%{stroke-dashoffset:54;opacity:0}
          22%{stroke-dashoffset:54;opacity:1}
          58%,100%{stroke-dashoffset:0;opacity:1}
        }
        .sb-p{fill:currentColor;transform-origin:200px 128px;transform-box:view-box;
          animation-duration:1.6s;animation-timing-function:cubic-bezier(.16,.7,.3,1);
          animation-fill-mode:both}
        @media (prefers-reduced-motion:reduce){
          .sb-halo,.sb-disc,.sb-tick,.sb-p{animation:none}
          .sb-halo,.sb-p{opacity:0}
          .sb-disc{opacity:1}
          .sb-tick{stroke-dashoffset:0;opacity:1}
        }
        ${PARTICLES.map(
          (p, i) => `
        .sb-p${i}{animation-name:sb-p${i}-k}
        @keyframes sb-p${i}-k{
          0%,${p.delay}%{opacity:0;transform:translate(0,0) scale(.2) rotate(0deg)}
          ${p.delay + 2}%{opacity:1;transform:translate(0,0) scale(.5) rotate(0deg)}
          ${p.delay + 20}%{opacity:1;transform:translate(${p.midX}px,${p.midY}px) scale(1.15) rotate(${p.spin}deg)}
          ${p.delay + 62}%,100%{opacity:0;transform:translate(${p.endX}px,${p.endY}px) scale(.55) rotate(${p.spin * 2}deg)}
        }`,
        ).join('')}
      `}</style>

      <circle className="sb-halo" cx="200" cy="128" r="36" />

      {/* Particles are painted BEFORE the disc so the ones thrown upward pass
          behind it on the way out — they read as coming from under the tick
          rather than landing on top of it. */}
      {PARTICLES.map((p, i) =>
        p.star ? (
          <path
            key={i}
            className={`sb-p sb-p${i}`}
            /* `p.r` is a radius, so a star drawn to the same number reads at
               the same size as a circle beside it.

               Centred by the PATH DATA, not by a transform attribute.
               `transform="translate(200 128)"` is the obvious way to place it
               and it is a trap: the keyframes animate the CSS `transform`
               property, which OVERRIDES the presentation attribute outright —
               so the moment a star animates it loses its placement and snaps
               to the SVG origin, hundreds of pixels above the viewBox. That is
               what clipped three particles at the top of the modal body, and
               it hit only the stars because the circles place themselves with
               `cx`/`cy`, which no transform can overwrite. */
            d={starPath(p.r, 200, 128)}
          />
        ) : (
          <circle key={i} className={`sb-p sb-p${i}`} cx="200" cy="128" r={p.r} />
        ),
      )}

      <circle className="sb-disc" cx="200" cy="128" r="36" />
      <path className="sb-tick" d="M181,129 L194,142 L219,115" />
    </svg>
  )
}

/**
 * A four-pointed glint — the same waist-pinched star the change card uses, so
 * the two pieces of decoration on this dialog are recognisably one family.
 */
function starPath(size: number, cx: number, cy: number) {
  const w = size * 0.18
  return (
    `M${cx},${cy - size} Q${cx + w},${cy - w} ${cx + size},${cy} ` +
    `Q${cx + w},${cy + w} ${cx},${cy + size} Q${cx - w},${cy + w} ${cx - size},${cy} ` +
    `Q${cx - w},${cy - w} ${cx},${cy - size} Z`
  )
}

/**
 * The burst, written out rather than generated.
 *
 * Random angles would mean a different burst on every render and no way to look
 * at a bad one twice; these are one good scatter, frozen. `delay` is a
 * percentage of the run — the spread is what stops it reading as a single ring
 * leaving at once. Distances are relative to the centre at (200,128), and
 * because the viewBox is 1:1 with the rendered box (see above) they are PIXELS
 * — a `endX: 58.5` particle finishes 58px from the centre of a 72px disc.
 *
 * The whole table is the supplied artwork's scatter scaled by 36/52, the ratio
 * between its disc and this one, so the burst keeps its proportions to the tick
 * it comes out of. Scale the disc and these have to move with it.
 */
const PARTICLES = [
  { delay: 21, midX: 32.2, midY: -1.8, endX: 58.5, endY: -3.3, r: 3.28, spin: 22, star: false },
  { delay: 21, midX: 29.2, midY: 9.3, endX: 53.2, endY: 16.8, r: 3.27, spin: 2, star: true },
  { delay: 25, midX: 26.4, midY: 16.7, endX: 48, endY: 30.3, r: 2.72, spin: -56, star: false },
  { delay: 24, midX: 23.1, midY: 33, endX: 41.9, endY: 59.9, r: 4.02, spin: -5, star: false },
  { delay: 22, midX: 0.8, midY: 30.5, endX: 1.4, endY: 55.4, r: 4.25, spin: -53, star: true },
  { delay: 22, midX: -1.9, midY: 34.8, endX: -3.5, endY: 63.3, r: 3.7, spin: 31, star: false },
  { delay: 21, midX: -19.3, midY: 30.3, endX: -35.1, endY: 55.1, r: 3.03, spin: -69, star: false },
  { delay: 23, midX: -28.9, midY: 29.2, endX: -52.5, endY: 53.1, r: 3.05, spin: 31, star: true },
  { delay: 24, midX: -32.5, midY: 12.3, endX: -59, endY: 22.4, r: 3.64, spin: -34, star: false },
  { delay: 24, midX: -38.5, midY: -0.9, endX: -70, endY: -1.7, r: 3.84, spin: -25, star: false },
  { delay: 25, midX: -27.8, midY: -15.2, endX: -50.5, endY: -27.6, r: 3.02, spin: -51, star: true },
  { delay: 25, midX: -23.3, midY: -19.5, endX: -42.4, endY: -35.3, r: 3.33, spin: 29, star: false },
  { delay: 23, midX: -13.8, midY: -32.1, endX: -25.1, endY: -58.4, r: 3.39, spin: 30, star: false },
  { delay: 23, midX: -8.2, midY: -43, endX: -14.9, endY: -78.2, r: 4.49, spin: 46, star: true },
  { delay: 26, midX: 1.5, midY: -41.4, endX: 2.8, endY: -75.3, r: 3.27, spin: 76, star: false },
  { delay: 21, midX: 15.9, midY: -32.5, endX: 28.9, endY: -59.1, r: 3.33, spin: 8, star: false },
  { delay: 25, midX: 22, midY: -22.8, endX: 40, endY: -41.4, r: 2.02, spin: -55, star: true },
  { delay: 22, midX: 33, midY: -15, endX: 60, endY: -27.3, r: 3.84, spin: 5, star: false },
]

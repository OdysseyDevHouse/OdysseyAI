import { code128Bars } from './code128'

/**
 * A CODE128 barcode, as inline SVG rects.
 *
 * `currentColor` so print CSS forces black; height in the caller's units via
 * the viewBox — the SVG scales to its container. A code that cannot encode
 * renders the human-readable text alone rather than a broken picture.
 */
export function Code128({ value, heightMm = 10 }: { value: string; heightMm?: number }) {
  const encoded = code128Bars(value)
  if (!encoded) {
    return <span className="numeric text-[10px] text-ink">{value}</span>
  }

  return (
    <svg
      viewBox={`0 0 ${encoded.totalModules} 100`}
      preserveAspectRatio="none"
      style={{ width: '100%', height: `${heightMm}mm` }}
      role="img"
      aria-label={value}
    >
      {encoded.bars.map((bar, i) => (
        <rect key={i} x={bar.x} y={0} width={bar.width} height={100} fill="currentColor" />
      ))}
    </svg>
  )
}

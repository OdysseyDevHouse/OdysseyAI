import './print.css'

/**
 * The PRINT route group: pages meant for paper.
 *
 * Bare on purpose — no sidebar, no top bar, no chrome of any kind, because
 * whatever this layout renders is what comes out of the printer. The root
 * layout supplies html/body; this group only adds the 80mm print rules and
 * deliberately mounts none of (app)'s chrome.
 */
export default function PrintLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-surface">{children}</div>
}

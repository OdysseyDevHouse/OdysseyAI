'use client'

import { useEffect, useRef, useState } from 'react'
import { Bold, Italic, Underline, List, ListOrdered, Link2, Eraser } from 'lucide-react'

/**
 * Small contenteditable editor for the extra description.
 *
 * Its value is mirrored into a hidden input so the surrounding <form> submits it
 * like any other field — no controlled-component fight with the browser's own
 * editing, which is what makes contenteditable painful in React.
 *
 * Whatever this produces is re-sanitised on the server (lib/html.ts). Nothing
 * here is a security control; it is only there to keep the markup tidy.
 */

type Command = {
  label: string
  icon: typeof Bold
  run: (exec: (cmd: string, value?: string) => void) => void
}

const COMMANDS: Command[] = [
  { label: 'Bold', icon: Bold, run: (x) => x('bold') },
  { label: 'Italic', icon: Italic, run: (x) => x('italic') },
  { label: 'Underline', icon: Underline, run: (x) => x('underline') },
  { label: 'Bulleted list', icon: List, run: (x) => x('insertUnorderedList') },
  { label: 'Numbered list', icon: ListOrdered, run: (x) => x('insertOrderedList') },
]

export default function RichText({
  name,
  defaultValue,
  placeholder,
}: {
  name: string
  defaultValue?: string | null
  placeholder?: string
}) {
  const editorRef = useRef<HTMLDivElement>(null)
  const [value, setValue] = useState(defaultValue ?? '')
  const [empty, setEmpty] = useState(!defaultValue)

  // Set the initial HTML once. Writing it on every render would move the caret
  // to the start on each keystroke.
  useEffect(() => {
    if (editorRef.current && defaultValue) {
      editorRef.current.innerHTML = defaultValue
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sync = () => {
    const html = editorRef.current?.innerHTML ?? ''
    // Browsers leave "<br>" or an empty paragraph behind when you delete
    // everything; treat that as empty so the placeholder comes back.
    const stripped = html.replace(/<br\s*\/?>|<p>\s*<\/p>|&nbsp;|\s/gi, '')
    setEmpty(stripped === '')
    setValue(html)
  }

  const exec = (cmd: string, arg?: string) => {
    editorRef.current?.focus()
    // execCommand is deprecated but is still the only thing every browser
    // implements for this, and it keeps undo history intact.
    document.execCommand(cmd, false, arg)
    sync()
  }

  const addLink = () => {
    const url = window.prompt('Link address')
    if (!url) return
    exec('createLink', url)
  }

  const clearFormatting = () => exec('removeFormat')

  return (
    <div className="rounded-md border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-border p-1">
        {COMMANDS.map(({ label, icon: Icon, run }) => (
          <button
            key={label}
            type="button"
            title={label}
            aria-label={label}
            // onMouseDown, not onClick: clicking a button would otherwise blur
            // the editor and drop the selection before the command runs.
            onMouseDown={(e) => {
              e.preventDefault()
              run(exec)
            }}
            className="rounded p-1.5 text-muted transition hover:bg-surface-2 hover:text-ink"
          >
            <Icon size={15} />
          </button>
        ))}
        <button
          type="button"
          title="Add link"
          aria-label="Add link"
          onMouseDown={(e) => {
            e.preventDefault()
            addLink()
          }}
          className="rounded p-1.5 text-muted transition hover:bg-surface-2 hover:text-ink"
        >
          <Link2 size={15} />
        </button>
        <button
          type="button"
          title="Clear formatting"
          aria-label="Clear formatting"
          onMouseDown={(e) => {
            e.preventDefault()
            clearFormatting()
          }}
          className="rounded p-1.5 text-muted transition hover:bg-surface-2 hover:text-ink"
        >
          <Eraser size={15} />
        </button>
      </div>

      <div className="relative">
        {empty && placeholder && (
          <span className="pointer-events-none absolute left-3 top-2.5 text-sm text-muted">
            {placeholder}
          </span>
        )}
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label="Extra description"
          onInput={sync}
          onBlur={sync}
          // Paste as plain text: pasting from Word otherwise drags in a wall of
          // markup the sanitiser would strip anyway.
          onPaste={(e) => {
            e.preventDefault()
            const text = e.clipboardData.getData('text/plain')
            document.execCommand('insertText', false, text)
            sync()
          }}
          className="min-h-28 px-3 py-2.5 text-sm text-ink outline-none [&_a]:text-brand [&_a]:underline [&_li]:ml-4 [&_ol]:list-decimal [&_ul]:list-disc"
        />
      </div>

      <input type="hidden" name={name} value={value} />
    </div>
  )
}

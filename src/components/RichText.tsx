'use client'

import { useEffect, useRef, useState } from 'react'
import {
  Bold,
  Italic,
  Underline,
  List,
  ListOrdered,
  Link2,
  Eraser,
  Code,
} from '@/components/ui/icons'
import { Button, Callout, CodeArea } from '@/components/ui'
import { ALLOWED_TAG_LIST, hasContentDroppingTags, unsupportedTagsIn } from '@/lib/htmlTags'

/**
 * Small contenteditable editor for the extra description.
 *
 * Its value is mirrored into a hidden input so the surrounding <form> submits it
 * like any other field — no controlled-component fight with the browser's own
 * editing, which is what makes contenteditable painful in React.
 *
 * Whatever this produces is re-sanitised on the server (lib/html.ts). Nothing
 * here is a security control; it is only there to keep the markup tidy.
 *
 * ── THE HTML VIEW ────────────────────────────────────────────────────────
 *
 * The toolbar's last button swaps the editor for a textarea holding the raw
 * markup, so a description can be pasted or hand-edited rather than composed.
 *
 * It reports which tags the server will strip, but does NOT strip them itself.
 * Client-side cleaning would be theatre — anyone can post straight to the
 * action — and silently rewriting what someone typed is worse than telling
 * them what will happen to it. The sanitiser remains the only authority; this
 * just means the user is not surprised by it after saving.
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

  // Which view the toolbar is showing. The VALUE is shared between the two —
  // only the way of editing it changes.
  const [showSource, setShowSource] = useState(false)

  const stripped = showSource ? unsupportedTagsIn(value) : []

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

  const toggleSource = () => setShowSource((wasSource) => !wasSource)

  /**
   * Push the edited markup back into the contenteditable when the formatted
   * view returns.
   *
   * ── WHY THIS IS AN EFFECT AND NOT PART OF THE TOGGLE ─────────────────────
   *
   * The source view REPLACES the contenteditable rather than hiding it, so
   * while it is open editorRef.current is null and the div React mounts on the
   * way back is brand new and empty. Writing during the toggle therefore wrote
   * to nothing, and the formatted view came back blank even though the hidden
   * input still held the right markup — the text was not lost, but it looked
   * like it had been.
   *
   * Running after the swap means the ref points at the new div. The mount
   * effect above cannot do this job: it deliberately runs once, so that typing
   * does not reset the caret on every render.
   */
  useEffect(() => {
    if (showSource || !editorRef.current) return
    if (editorRef.current.innerHTML === value) return
    editorRef.current.innerHTML = value
    const text = value.replace(/<br\s*\/?>|<p>\s*<\/p>|&nbsp;|\s/gi, '')
    setEmpty(text === '')
    // `value` is deliberately not a dependency: this must run when the VIEW
    // changes, not on every keystroke — the editor is the source of the value
    // while it is open, and writing back into it would fight the caret.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSource])

  return (
    <div className="rounded-md border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-border p-1">
        {COMMANDS.map(({ label, icon: Icon, run }) => (
          <Button
            key={label}
            variant="bare"
            size="sm"
            iconOnly
            title={label}
            aria-label={label}
            // Nothing to format in the source view — the commands act on the
            // contenteditable, which is not on screen.
            disabled={showSource}
            // onMouseDown, not onClick: clicking a button would otherwise blur
            // the editor and drop the selection before the command runs.
            onMouseDown={(e) => {
              e.preventDefault()
              run(exec)
            }}
          >
            <Icon size={15} />
          </Button>
        ))}
        <Button
          variant="bare"
          size="sm"
          iconOnly
          title="Add link"
          aria-label="Add link"
          disabled={showSource}
          onMouseDown={(e) => {
            e.preventDefault()
            addLink()
          }}
        >
          <Link2 size={15} />
        </Button>
        <Button
          variant="bare"
          size="sm"
          iconOnly
          title="Clear formatting"
          aria-label="Clear formatting"
          disabled={showSource}
          onMouseDown={(e) => {
            e.preventDefault()
            clearFormatting()
          }}
        >
          <Eraser size={15} />
        </Button>

        {/* Last and set apart: this switches the whole editor rather than
            acting on the text, so it does not belong in the run of commands. */}
        <span aria-hidden className="mx-1 h-5 w-px bg-border" />
        <Button
          variant="bare"
          size="sm"
          iconOnly
          title={showSource ? 'Back to formatted view' : 'Edit HTML'}
          aria-label={showSource ? 'Back to formatted view' : 'Edit HTML'}
          aria-pressed={showSource}
          className={showSource ? 'bg-surface-2 text-ink' : undefined}
          onMouseDown={(e) => {
            e.preventDefault()
            toggleSource()
          }}
        >
          <Code size={15} />
        </Button>
      </div>

      {showSource ? (
        <div className="flex flex-col gap-2 p-2">
          <CodeArea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label="Extra description, HTML"
            placeholder="<p>Paste or write HTML here…</p>"
          />

          {stripped.length > 0 ? (
            <Callout tone="warning" title="Some of this will not be kept">
              <p>
                {/* Named individually: "some tags" sends the user hunting. */}
                <span className="font-medium">{stripped.join(', ')}</span>{' '}
                {stripped.length === 1 ? 'is' : 'are'} removed when you save
                {hasContentDroppingTags(value) ? ', along with anything inside them' : ''}.
              </p>
              <p className="mt-1">Kept: {ALLOWED_TAG_LIST}.</p>
            </Callout>
          ) : (
            <p className="text-xs text-muted">
              Kept when you save: {ALLOWED_TAG_LIST}. Anything else is removed, and only
              <code className="mx-1 rounded bg-surface-2 px-1 py-0.5 font-mono">href</code>
              survives on a link.
            </p>
          )}
        </div>
      ) : (
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
      )}

      <input type="hidden" name={name} value={value} />
    </div>
  )
}

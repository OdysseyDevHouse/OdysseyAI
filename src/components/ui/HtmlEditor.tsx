'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from './Button'
import { Menu, MenuItem } from './Menu'
import * as Icons from './icons'

/**
 * Writing an email, without a rich-text library.
 *
 * ── WHY contentEditable AND NOT AN EDITOR PACKAGE ────────────────────────
 *
 * The person using this is a shopkeeper writing three paragraphs, not an
 * author. A full editor is several hundred kilobytes for bold, italic and a
 * link — and it brings its own document model, which then has to be
 * translated to and from the HTML that actually gets emailed. This edits the
 * HTML directly, so what is typed is what is sent.
 *
 * ── THE SOURCE VIEW IS THE ESCAPE HATCH ──────────────────────────────────
 *
 * Anyone who wants to paste markup from a designer can. The WYSIWYG side is
 * for everyone else, and the toggle means neither audience is stuck.
 */

export type InsertToken = { token: string; label: string }

export function HtmlEditor({
  value,
  onChange,
  tokens = [],
  placeholder,
  minHeight = 240,
}: {
  value: string
  onChange: (html: string) => void
  /** Offered under "Insert…" and dropped in as literal {{token}} text. */
  tokens?: InsertToken[]
  placeholder?: string
  minHeight?: number
}) {
  const [source, setSource] = useState(false)
  const editable = useRef<HTMLDivElement>(null)
  /** Where the caret was, so an Insert lands where the writer was looking. */
  const lastRange = useRef<Range | null>(null)

  /*
   * Write `value` into the DOM only when it actually differs.
   *
   * The editor is UNCONTROLLED while typing, deliberately. Assigning innerHTML
   * on every keystroke destroys and rebuilds the nodes the caret lives in, so
   * the cursor jumps to the start on every character.
   */
  useEffect(() => {
    const el = editable.current
    if (!el || source) return
    if (el.innerHTML !== value) el.innerHTML = value
  }, [value, source])

  // Track the caret, because opening the Insert menu moves focus out of the
  // editable and the browser forgets where it was.
  useEffect(() => {
    const onSelectionChange = () => {
      const el = editable.current
      if (!el) return
      const selection = window.getSelection()
      if (!selection || selection.rangeCount === 0) return
      const range = selection.getRangeAt(0)
      if (el.contains(range.commonAncestorContainer)) lastRange.current = range.cloneRange()
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [])

  function exec(command: string, argument?: string) {
    editable.current?.focus()
    if (lastRange.current) restoreCaret()
    document.execCommand(command, false, argument)
    emit()
  }

  function restoreCaret() {
    const selection = window.getSelection()
    if (!selection || !lastRange.current) return
    selection.removeAllRanges()
    selection.addRange(lastRange.current)
  }

  function emit() {
    const el = editable.current
    if (el) onChange(el.innerHTML)
  }

  function insertToken(token: string) {
    const el = editable.current
    if (!el) return
    el.focus()
    if (lastRange.current) restoreCaret()
    // insertText, not insertHTML: the braces must survive as literal
    // characters for the renderer to find, not be parsed as markup.
    document.execCommand('insertText', false, `{{${token}}}`)
    emit()
  }

  function addLink() {
    const url = window.prompt('Link address', 'https://')
    if (!url) return
    if (!/^(https?:|mailto:)/i.test(url.trim())) {
      window.alert('Links must start with http://, https:// or mailto:')
      return
    }
    exec('createLink', url.trim())
  }

  return (
    <div className="rounded-card border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
        {!source && (
          <>
            <ToolButton label="Bold" onClick={() => exec('bold')}>
              <span className="font-bold">B</span>
            </ToolButton>
            <ToolButton label="Italic" onClick={() => exec('italic')}>
              <span className="italic">I</span>
            </ToolButton>
            <ToolButton label="Underline" onClick={() => exec('underline')}>
              <span className="underline">U</span>
            </ToolButton>
            <Divider />
            <ToolButton label="Heading" onClick={() => exec('formatBlock', 'h2')}>
              H
            </ToolButton>
            <ToolButton label="Paragraph" onClick={() => exec('formatBlock', 'p')}>
              ¶
            </ToolButton>
            <ToolButton label="Bulleted list" onClick={() => exec('insertUnorderedList')}>
              •
            </ToolButton>
            <Divider />
            <ToolButton label="Add a link" onClick={addLink}>
              <Icons.ExternalLink size={14} />
            </ToolButton>
            <ToolButton label="Clear formatting" onClick={() => exec('removeFormat')}>
              <Icons.Close size={14} />
            </ToolButton>
          </>
        )}

        {tokens.length > 0 && (
          <Menu label="Insert…" align="left">
            {tokens.map((t) => (
              <MenuItem key={t.token} onClick={() => insertToken(t.token)}>
                {t.label}
              </MenuItem>
            ))}
          </Menu>
        )}

        <span className="ml-auto">
          <Button variant="ghost" size="sm" onClick={() => setSource((s) => !s)}>
            {source ? 'Editor' : 'HTML'}
          </Button>
        </span>
      </div>

      {source ? (
        /* Bound straight to `value`, so what is shown is exactly what will be
           stored and sent — no round trip through the DOM to disagree with. */
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          className="w-full resize-y bg-surface px-3 py-2 font-mono text-xs text-ink outline-none"
          style={{ minHeight }}
        />
      ) : (
        <div
          ref={editable}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label="Message"
          data-placeholder={placeholder}
          onInput={emit}
          onBlur={emit}
          className="prose-editor w-full px-3 py-2 text-sm text-ink outline-none empty:before:text-faint empty:before:content-[attr(data-placeholder)]"
          style={{ minHeight }}
        />
      )}
    </div>
  )
}

function ToolButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    /* Not a kit Button: a formatting control must not steal focus, so it
       preventDefaults on mousedown — the selection it is about to act on
       lives in another element and would be lost the moment focus moved. */
    <button
      data-kit-ok
      type="button"
      title={label}
      aria-label={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="flex h-7 min-w-7 items-center justify-center rounded-control px-1.5 text-sm text-ink-2 transition hover:bg-surface-2"
    >
      {children}
    </button>
  )
}

function Divider() {
  return <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />
}

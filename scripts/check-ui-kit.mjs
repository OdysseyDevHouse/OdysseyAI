#!/usr/bin/env node
// Guards the design-system rules in AGENTS.md.
//
//   node scripts/check-ui-kit.mjs <file> [...files]
//
// Reads a file and reports the ways it bypasses the shared UI kit. Exits 2 with
// findings on stderr so a PostToolUse hook feeds them straight back to the
// agent that just wrote the file, while it still has the context to fix it.
//
// Deliberately narrow: every rule here is one that has actually been broken in
// this repo. A checker that cries wolf gets ignored, which is worse than none.
import { readFileSync } from 'node:fs'

/** Stock Tailwind palette names — a raw colour by any other name. */
const PALETTE =
  '(?:slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)'

const RULES = [
  {
    id: 'raw-colour',
    test: new RegExp(`\\b(?:bg|text|border|ring|fill|stroke|from|via|to)-${PALETTE}-\\d{2,3}\\b`),
    message:
      'Stock Tailwind palette colour. Use a token: bg-brand, text-muted, border-border, bg-success-soft…',
  },
  {
    id: 'hex-colour',
    test: /#[0-9a-fA-F]{3,8}\b(?![^(]*\))/,
    message: 'Raw hex colour. Colours are tokens in src/app/globals.css — never inline.',
  },
  {
    id: 'rgb-colour',
    test: /\b(?:rgba?|hsla?)\s*\(/,
    message: 'Raw rgb()/hsl() colour. Use a token from src/app/globals.css.',
  },
  {
    id: 'lucide-direct',
    test: /from\s+['"]lucide-react['"]/,
    message: "Icons come from '@/components/ui/icons', never straight from lucide-react.",
  },
  {
    id: 'hand-rolled-button',
    test: /<button(?![^>]*\bdata-kit-ok\b)[\s\S]{0,400}?className=["'][^"']*\b(?:rounded|border|bg-)/,
    message:
      'Hand-rolled button. Use <Button variant=…> from @/components/ui, or add a variant there.',
  },
  {
    id: 'hand-rolled-control',
    test: /<(?:input|select|textarea)(?![^>]*\btype=["'](?:checkbox|radio|hidden)["'])[\s\S]{0,400}?className=["'][^"']*\b(?:rounded|border-|bg-surface)/,
    message:
      'Hand-rolled form control. Use Input/NumberInput/CurrencyInput/Select/Textarea from @/components/ui.',
  },
  {
    id: 'ad-hoc-table-header',
    test: /<th\s[^>]*className=\{?["'`][^"'`]*\b(?:px-|py-|text-xs|font-)/,
    message:
      'Ad-hoc <th> styling. Use TABLE_TH / TABLE_TD / TABLE_HEAD_ROW from @/components/ui, or <DataTable>.',
  },
]

/** Only these are UI files; a .ts lib module has no business being checked. */
const UI_FILE = /\.(?:tsx|jsx)$/

/** The kit itself defines the primitives, so it is exempt by definition. */
const EXEMPT = /[\\/]components[\\/]ui[\\/]|[\\/]app[\\/]globals\.css$/

function stripComments(source) {
  // Rules match on code, not prose: a comment saying "never write bg-blue-600"
  // must not itself trip the check.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function checkFile(path) {
  if (!UI_FILE.test(path) || EXEMPT.test(path)) return []

  let source
  try {
    source = readFileSync(path, 'utf8')
  } catch {
    return [] // Deleted or unreadable — not this script's problem.
  }

  const code = stripComments(source)
  const findings = []

  for (const rule of RULES) {
    // Report the first offending line per rule; listing all of them buries
    // the signal when a file breaks one rule twenty times.
    const lines = code.split('\n')
    const index = lines.findIndex((line) => rule.test.test(line))
    if (index === -1 && !rule.test.test(code)) continue

    findings.push({
      rule: rule.id,
      line: index === -1 ? null : index + 1,
      message: rule.message,
    })
  }

  return findings
}

/**
 * Files to check: CLI arguments, or the hook's JSON payload on stdin.
 *
 * Reading stdin here rather than piping through `jq` is deliberate — jq is not
 * installed on every machine that runs this repo, and a hook whose first pipe
 * stage is missing fails silently, which is the worst possible outcome for a
 * guard.
 */
async function resolveFiles() {
  const args = process.argv.slice(2).filter(Boolean)
  if (args.length > 0) return args

  if (process.stdin.isTTY) return []

  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  if (!raw.trim()) return []

  try {
    const payload = JSON.parse(raw)
    const path = payload?.tool_response?.filePath ?? payload?.tool_input?.file_path
    return path ? [path] : []
  } catch {
    return [] // Not JSON we understand — stay quiet rather than block on noise.
  }
}

const files = await resolveFiles()
const all = files.flatMap((file) => checkFile(file).map((f) => ({ ...f, file })))

if (all.length === 0) process.exit(0)

const lines = [
  'OdysseyAI design system — this file bypasses the shared UI kit:',
  '',
  ...all.map((f) => `  ${f.file}${f.line ? `:${f.line}` : ''}  [${f.rule}]\n      ${f.message}`),
  '',
  'Read .claude/skills/odyssey-ui/SKILL.md and /setup/style-guide.',
  'Fix by importing from @/components/ui — or, if the kit lacks it, add it there,',
  'export it from index.ts, and demo it on the Style Guide page.',
]

process.stderr.write(lines.join('\n') + '\n')
process.exit(2)

'use client'

import { Plus } from '@/components/ui/icons'
import { DataTable, Badge, TextLink, PrimaryLink, type Column } from '@/components/ui'
import type { listGroups } from '@/lib/site/instructions'

/**
 * The instruction-groups table. A client component only because DataTable's
 * column cells are functions, which a Server Component cannot pass across the
 * boundary — the page hands down plain rows.
 */

/** "Pick one", "Choose up to 3", "Choose 2 to 4" — the rule in plain words. */
function choiceRule(min: number, max: number): string {
  if (max === 1) return min > 0 ? 'Pick one' : 'Pick one (optional)'
  if (max === 0) return min > 0 ? `Choose at least ${min}` : 'Choose any number'
  if (min > 0 && min !== max) return `Choose ${min} to ${max}`
  if (min > 0 && min === max) return `Choose exactly ${min}`
  return `Choose up to ${max}`
}

type GroupRow = Awaited<ReturnType<typeof listGroups>>[number]

const columns: Column<GroupRow>[] = [
  {
    key: 'name',
    header: 'Instruction',
    sortable: true,
    cell: (g) => (
      <>
        <TextLink href={`/instructions/${g.id}`}>{g.name}</TextLink>
        {g.prompt && <span className="block text-xs text-muted">{g.prompt}</span>}
      </>
    ),
    sortValue: (g) => g.name,
  },
  {
    key: 'rule',
    header: 'Rule',
    sortable: true,
    cell: (g) => (
      <span className="text-muted">
        {choiceRule(g.minChoices, g.maxChoices)}
        {/* Neutral, not warning: required is a configuration, not a problem. */}
        {g.isRequired && <Badge className="ml-2">Required</Badge>}
      </span>
    ),
    sortValue: (g) => choiceRule(g.minChoices, g.maxChoices),
  },
  {
    key: 'options',
    header: 'Options',
    numeric: true,
    sortable: true,
    // A question with no answers is broken — the till has nothing to show.
    cell: (g) =>
      g.optionCount === 0 ? <Badge tone="danger">0 options</Badge> : g.optionCount,
    sortValue: (g) => g.optionCount,
  },
  {
    key: 'products',
    header: 'Products',
    numeric: true,
    sortable: true,
    cell: (g) =>
      g.productCount > 0 ? (
        <span className="text-muted">{g.productCount}</span>
      ) : (
        <span className="text-faint">—</span>
      ),
    sortValue: (g) => g.productCount,
  },
  {
    key: 'status',
    header: 'Status',
    sortable: true,
    // Active is the normal state; only the exception wears a badge.
    cell: (g) => (g.isActive ? null : <Badge>Inactive</Badge>),
    sortValue: (g) => (g.isActive ? 0 : 1),
  },
]

export function InstructionsTable({ rows }: { rows: GroupRow[] }) {
  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(g) => g.id}
      empty={{
        title: 'No instructions yet',
        hint: 'Create one — for example “Choice of bread” with white, brown and rye — then attach it to the products that should ask it.',
        action: (
          <PrimaryLink href="/instructions/new">
            <Plus size={15} />
            New instruction
          </PrimaryLink>
        ),
      }}
    />
  )
}

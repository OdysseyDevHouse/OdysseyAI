'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Badge, Button, Card, CardHeader, EmptyState, Icons, Switch, useToast } from '@/components/ui'
import type { DepartmentVisibility, PublishCounts, PublishMode } from '@/lib/site/onlineStore'
import { setDepartmentVisibilityAction } from './actions'

/**
 * The department tree, one switch each.
 *
 * The layout mirrors the Inventory department screen on purpose: an owner who
 * has arranged their departments there should recognise this instantly rather
 * than having to map one list onto another.
 *
 * A ticked department publishes everything filed BENEATH it too, so a child of
 * a ticked parent shows "shown via Groceries" instead of an unticked switch
 * that would read as "this is hidden" when it plainly is not.
 */

/**
 * Indent per level, matching the Inventory tree. Applied as a spacer element's
 * width — the one place this number lives — rather than a paddingLeft that
 * would fight the row's own horizontal padding.
 */
const INDENT = 24

type Node = DepartmentVisibility & { children: Node[]; depth: number }

function buildTree(departments: DepartmentVisibility[]): Node[] {
  const byId = new Map<number, Node>(
    departments.map((d) => [d.id, { ...d, children: [], depth: 0 }]),
  )
  const roots: Node[] = []

  for (const node of byId.values()) {
    const parent = node.parentId === null ? null : byId.get(node.parentId)
    // A department whose parent is inactive (and so absent here) would vanish
    // entirely; treating it as a root keeps it reachable.
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  const assignDepth = (nodes: Node[], depth: number) => {
    for (const node of nodes) {
      node.depth = depth
      assignDepth(node.children, depth + 1)
    }
  }
  assignDepth(roots, 0)
  return roots
}

function flatten(nodes: Node[], collapsed: Set<number>): Node[] {
  const out: Node[] = []
  const walk = (list: Node[]) => {
    for (const node of list) {
      out.push(node)
      if (!collapsed.has(node.id)) walk(node.children)
    }
  }
  walk(nodes)
  return out
}

export default function DepartmentTree({
  departments,
  counts,
  publishMode,
}: {
  departments: DepartmentVisibility[]
  counts: PublishCounts
  publishMode: PublishMode
}) {
  const router = useRouter()
  const toast = useToast()
  const [busy, startAction] = useTransition()
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())

  const tree = useMemo(() => buildTree(departments), [departments])
  const rows = useMemo(() => flatten(tree, collapsed), [tree, collapsed])

  function toggle(node: Node, next: boolean) {
    startAction(async () => {
      const result = await setDepartmentVisibilityAction(node.id, node.name, next)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      // Silence after a switch flips reads as "did nothing" — say what changed.
      toast.success(
        next
          ? `${node.name} is now shown in the online store.`
          : `${node.name} is now hidden from the online store.`,
      )
      router.refresh()
    })
  }

  function toggleCollapse(id: number) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (departments.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Icons.LayoutGrid size={22} />}
          title="No departments yet"
          hint="Departments are how an online store is browsed. Add some before publishing your catalogue."
          action={
            <Link href="/departments">
              <Button variant="primary">Go to departments</Button>
            </Link>
          }
        />
      </Card>
    )
  }

  return (
    <>
      {/* The mode this screen serves. Ticking departments does nothing at all
          under "flagged" or "all", and finding that out from an unchanged
          storefront would be maddening. */}
      {publishMode !== 'departments' && (
        <Card>
          <div className="flex items-start gap-3 px-6 py-4">
            <Icons.StatusWarning size={18} className="mt-0.5 shrink-0 text-warning" />
            <div className="text-sm">
              <p className="font-medium text-ink">
                These ticks are not what decides your catalogue right now.
              </p>
              <p className="text-muted">
                Your store publishes{' '}
                {publishMode === 'all'
                  ? 'everything in your product file'
                  : 'only products you have ticked individually'}
                . Switch to “Chosen departments only” for this screen to take effect.{' '}
                <Link href="/online-store/setup" className="font-medium text-brand hover:underline">
                  Go to setup
                </Link>
              </p>
            </div>
          </div>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Shown in the online store"
          description="Ticking a department also shows everything filed under it."
          action={
            /* A count is a count — neutral. Colour is saved for the one state
               that needs attention: a store publishing nothing. */
            <Badge tone={counts.departments === 0 ? 'danger' : 'neutral'}>
              {counts.departments.toLocaleString('en-ZA')} of{' '}
              {counts.total.toLocaleString('en-ZA')} products
            </Badge>
          }
        />

        <ul className="divide-y divide-border">
          {rows.map((node) => {
            const inherited = node.publishedByParent
            return (
              // px-4 py-1.5 — the shared table rhythm (TABLE_TD), so this
              // list sits at the same density as every other list, even
              // though its live Switches keep it off DataTable.
              <li key={node.id} className="flex items-center gap-3 px-4 py-1.5">
                {node.depth > 0 && (
                  <span
                    aria-hidden
                    className="shrink-0"
                    style={{ width: node.depth * INDENT }}
                  />
                )}
                {node.children.length > 0 ? (
                  <Button
                    variant="bare"
                    size="sm"
                    iconOnly
                    onClick={() => toggleCollapse(node.id)}
                    aria-label={collapsed.has(node.id) ? 'Expand' : 'Collapse'}
                    aria-expanded={!collapsed.has(node.id)}
                  >
                    {collapsed.has(node.id) ? (
                      <Icons.ChevronRight size={15} />
                    ) : (
                      <Icons.ChevronDown size={15} />
                    )}
                  </Button>
                ) : (
                  <span className="size-8 shrink-0" aria-hidden />
                )}

                <div className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{node.name}</span>
                  <span className="text-xs text-muted">
                    {node.productCount === 0
                      ? 'No products filed here'
                      : `${node.productCount.toLocaleString('en-ZA')} product${node.productCount === 1 ? '' : 's'}`}
                    {node.children.length > 0 &&
                      ` · ${node.children.length} sub-department${node.children.length === 1 ? '' : 's'}`}
                  </span>
                </div>

                {inherited ? (
                  // No switch: turning this "off" would be a lie, since the
                  // parent's tick is what publishes it.
                  <Badge tone="success">Shown via its parent</Badge>
                ) : (
                  <Switch
                    checked={node.showOnline}
                    disabled={busy}
                    onChange={(next) => toggle(node, next)}
                    label={`Show ${node.name} in the online store`}
                  />
                )}
              </li>
            )
          })}
        </ul>
      </Card>
    </>
  )
}

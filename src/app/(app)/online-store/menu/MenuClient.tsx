'use client'

/**
 * The menu editor.
 *
 * ── ARROWS, NOT DRAG ─────────────────────────────────────────────────────
 *
 * A menu is at most a couple of dozen short rows and the edit is almost always
 * "move this one up two". Arrows do that in two clicks, work on a phone, and
 * are reachable from a keyboard without a grab mode — which is three things a
 * drag surface has to be built to match. The page builder earns its drag layer
 * because it arranges a page you are looking at; a list of link labels does
 * not.
 *
 * ── AND WHY THE WHOLE MENU SAVES AT ONCE ─────────────────────────────────
 *
 * The row being edited is not meaningful on its own — an owner reorders three
 * things and adds a fourth, and every one of those is the same decision. Saving
 * per row would also mean a menu that is half-old and half-new for as long as
 * somebody is thinking, and this is the shop's front door.
 */

import { useState, useTransition } from 'react'
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Field,
  Icons,
  Input,
  PageBody,
  Select,
  useToast,
} from '@/components/ui'
import {
  MAX_MENU_CHILDREN,
  MAX_MENU_ITEMS,
  MENU_TARGETS,
  TARGETS_NEEDING_ID,
  type MenuItem,
  type MenuTarget,
} from '@/lib/storefront/menus'
import { saveMenuAction } from './actions'

/** Something an item can point at, offered by the server. */
export type MenuChoice = { kind: 'department' | 'page'; id: number; label: string }

/** The words an owner reads. */
const TARGET_LABEL: Record<MenuTarget, string> = {
  home: 'The front page',
  department: 'A department',
  page: 'One of my pages',
  product: 'A single product',
  search: 'Everything (search)',
  wishlist: 'Saved items',
  giftcard: 'Gift card balance',
  url: 'A web address',
}

/** An item being edited: the stored shape, minus ids it may not have yet. */
type Draft = {
  label: string
  targetKind: MenuTarget
  targetId: number | null
  targetUrl: string
  imageId: number | null
  children: Omit<Draft, 'children'>[]
}

const blank = (): Draft => ({
  label: '',
  targetKind: 'department',
  targetId: null,
  targetUrl: '',
  imageId: null,
  children: [],
})

export default function MenuClient({
  stored,
  generated,
  choices,
}: {
  stored: MenuItem[] | null
  generated: Omit<Draft, 'children'>[]
  choices: MenuChoice[]
}) {
  /*
   * Null means the shop has never made a menu, and the editor opens on the
   * offer to adopt the generated one rather than on an empty list. An empty
   * ARRAY is an owner who cleared theirs, and gets the empty list they asked
   * for — the same distinction the resolver keeps.
   */
  const [items, setItems] = useState<Draft[]>(() =>
    stored === null
      ? []
      : stored.map((i) => ({
          label: i.label,
          targetKind: i.targetKind,
          targetId: i.targetId,
          targetUrl: i.targetUrl,
          imageId: i.imageId,
          children: i.children.map((c) => ({
            label: c.label,
            targetKind: c.targetKind,
            targetId: c.targetId,
            targetUrl: c.targetUrl,
            imageId: c.imageId,
          })),
        })),
  )
  const [adopted, setAdopted] = useState(stored !== null)
  const [busy, startAction] = useTransition()
  const toast = useToast()

  const save = (next: Draft[], message: string) =>
    startAction(async () => {
      const result = await saveMenuAction('main', next)
      if (result.ok) {
        setItems(next)
        setAdopted(true)
        toast.success(message)
      } else {
        toast.error(result.error)
      }
    })

  const move = (index: number, by: number) => {
    const to = index + by
    if (to < 0 || to >= items.length) return
    const next = [...items]
    const [row] = next.splice(index, 1)
    next.splice(to, 0, row)
    setItems(next)
  }

  const patch = (index: number, changes: Partial<Draft>) =>
    setItems((list) => list.map((row, i) => (i === index ? { ...row, ...changes } : row)))

  return (
    <PageBody>
      <div className="flex flex-col gap-4">
        {!adopted && (
          <Callout tone="neutral" title="Your shop is using the menu we build for it">
            <p className="text-sm">
              Every department you publish, then your pages. Start from that and change what you
              like — your shop keeps working exactly as it does now until you save.
            </p>
            <div className="mt-3">
              <Button
                disabled={busy}
                onClick={() =>
                  save(
                    generated.map((g) => ({ ...g, children: [] })),
                    'Your menu is now yours to edit.',
                  )
                }
              >
                Start from what I have
              </Button>
            </div>
          </Callout>
        )}

        <Card>
          <CardHeader
            title="Main menu"
            description="Shown across the top of every page in your shop."
          />
          <CardBody>
            {items.length === 0 ? (
              <p className="text-sm text-muted">
                {adopted
                  ? 'Nothing in the menu. Your shop shows no links across the top.'
                  : 'Start from what you have, or add your first link below.'}
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {items.map((item, index) => (
                  <ItemRow
                    key={index}
                    item={item}
                    index={index}
                    count={items.length}
                    choices={choices}
                    onMove={move}
                    onPatch={patch}
                    onRemove={() => setItems((list) => list.filter((_, i) => i !== index))}
                  />
                ))}
              </div>
            )}

            <div className="mt-4 flex items-center justify-between gap-2">
              <Button
                variant="secondary"
                disabled={items.length >= MAX_MENU_ITEMS}
                onClick={() => setItems((list) => [...list, blank()])}
              >
                <Icons.Plus size={15} />
                Add a link
              </Button>
              <Button disabled={busy} onClick={() => save(items, 'Menu saved.')}>
                {busy ? 'Saving…' : 'Save menu'}
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>
    </PageBody>
  )
}

function ItemRow({
  item,
  index,
  count,
  choices,
  onMove,
  onPatch,
  onRemove,
}: {
  item: Draft
  index: number
  count: number
  choices: MenuChoice[]
  onMove: (index: number, by: number) => void
  onPatch: (index: number, changes: Partial<Draft>) => void
  onRemove: () => void
}) {
  const options = choices.filter((c) => c.kind === item.targetKind)

  return (
    <div className="rounded-card border border-border p-3">
      <div className="flex items-start gap-2">
        {/* Up and down beside each other, so reordering is one place rather
            than a handle here and a control there. */}
        <div className="flex shrink-0 flex-col gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Move ${item.label || 'this link'} up`}
            disabled={index === 0}
            onClick={() => onMove(index, -1)}
          >
            <Icons.ChevronUp size={14} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Move ${item.label || 'this link'} down`}
            disabled={index === count - 1}
            onClick={() => onMove(index, 1)}
          >
            <Icons.ChevronDown size={14} />
          </Button>
        </div>

        <div className="grid min-w-0 flex-1 gap-2 @lg:grid-cols-3">
          <Field label="What it says">
            <Input
              value={item.label}
              maxLength={60}
              placeholder="e.g. Sale"
              onChange={(e) => onPatch(index, { label: e.target.value })}
            />
          </Field>

          <Field label="Where it goes">
            <Select
              value={item.targetKind}
              onChange={(e) =>
                /*
                 * The id is cleared with the kind. A department id left behind
                 * on an item switched to "my pages" would point at whichever
                 * page happened to share that number — a link that works and
                 * goes somewhere nobody chose.
                 */
                onPatch(index, { targetKind: e.target.value as MenuTarget, targetId: null })
              }
            >
              {MENU_TARGETS.map((t) => (
                <option key={t} value={t}>
                  {TARGET_LABEL[t]}
                </option>
              ))}
            </Select>
          </Field>

          {TARGETS_NEEDING_ID.includes(item.targetKind) && item.targetKind !== 'product' && (
            <Field label="Which one" hint={options.length === 0 ? 'Nothing published yet.' : undefined}>
              <Select
                value={String(item.targetId ?? '')}
                onChange={(e) =>
                  onPatch(index, { targetId: e.target.value ? Number(e.target.value) : null })
                }
              >
                <option value="">Choose…</option>
                {options.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {item.targetKind === 'product' && (
            <Field label="Product number" hint="From the product's own page.">
              <Input
                value={String(item.targetId ?? '')}
                inputMode="numeric"
                onChange={(e) =>
                  onPatch(index, { targetId: e.target.value ? Number(e.target.value) : null })
                }
              />
            </Field>
          )}

          {item.targetKind === 'url' && (
            <Field label="Web address" hint="A full https:// link, or a path inside your shop.">
              <Input
                value={item.targetUrl}
                maxLength={300}
                placeholder="https://…"
                onChange={(e) => onPatch(index, { targetUrl: e.target.value })}
              />
            </Field>
          )}
        </div>

        <Button variant="ghost" size="sm" aria-label={`Remove ${item.label || 'this link'}`} onClick={onRemove}>
          <Icons.Trash size={14} />
        </Button>
      </div>

      {/*
        Children are offered on every item, because "does this one need a
        dropdown" is a question about this row rather than a mode the whole
        editor is in. One level only — see 188.
      */}
      <div className="mt-2 border-t border-border pt-2 pl-10">
        {item.children.map((child, ci) => (
          <div key={ci} className="mb-2 flex items-end gap-2">
            <Field label="Drop-down link">
              <Input
                value={child.label}
                maxLength={60}
                placeholder="e.g. Burgers"
                onChange={(e) =>
                  onPatch(index, {
                    children: item.children.map((c, i) =>
                      i === ci ? { ...c, label: e.target.value } : c,
                    ),
                  })
                }
              />
            </Field>
            <Field label="Department">
              <Select
                value={String(child.targetId ?? '')}
                onChange={(e) =>
                  onPatch(index, {
                    children: item.children.map((c, i) =>
                      i === ci
                        ? {
                            ...c,
                            targetKind: 'department' as const,
                            targetId: e.target.value ? Number(e.target.value) : null,
                          }
                        : c,
                    ),
                  })
                }
              >
                <option value="">Choose…</option>
                {choices
                  .filter((c) => c.kind === 'department')
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
              </Select>
            </Field>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Remove this drop-down link"
              onClick={() =>
                onPatch(index, { children: item.children.filter((_, i) => i !== ci) })
              }
            >
              <Icons.Trash size={14} />
            </Button>
          </div>
        ))}

        <Button
          variant="ghost"
          size="sm"
          disabled={item.children.length >= MAX_MENU_CHILDREN}
          onClick={() =>
            onPatch(index, {
              children: [
                ...item.children,
                { label: '', targetKind: 'department', targetId: null, targetUrl: '', imageId: null },
              ],
            })
          }
        >
          <Icons.Plus size={13} />
          Add a drop-down link
        </Button>
      </div>
    </div>
  )
}

'use client'

import { useState } from 'react'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  CurrencyInput,
  DataTable,
  EmptyState,
  Field,
  Icons,
  Input,
  Menu,
  MenuItem,
  MenuSeparator,
  NumberInput,
  PageBody,
  PageHeader,
  Radio,
  SegmentedControl,
  Select,
  Switch,
  TableToolbar,
  Tabs,
  Textarea,
  ToolbarSearch,
  useToast,
} from '@/components/ui'
import type { Column } from '@/components/ui'

/**
 * The style guide — every shared building block, rendered live and named.
 *
 * This page is documentation that cannot go stale: it imports the real
 * components, so whatever it shows IS what the app looks like today. When you
 * add something to @/components/ui, add it here too.
 */

type Product = { id: string; name: string; sku: string; qty: number; price: number }

const PRODUCTS: Product[] = [
  { id: '1', name: 'Coca-Cola 500ml', sku: 'CC500', qty: 124, price: 14.99 },
  { id: '2', name: 'Full Cream Milk 1L', sku: 'FCM1L', qty: 0, price: 22.0 },
  { id: '3', name: 'White Bread Loaf', sku: 'WBL01', qty: 38, price: 18.5 },
]

const rand = (value: number) => `R ${value.toFixed(2).replace('.', ',')}`

export default function StyleGuidePage() {
  return (
    <>
      <PageHeader
        title="Style Guide"
        subtitle="The shared building blocks, rendered live and named. Refer to any of these by name when asking to restyle a screen — e.g. “use the secondary button” or “give the GRV list the standard TableToolbar”."
      />
      <PageBody>
        <ButtonsSection />
        <FormSection />
        <BadgeSection />
        <ToastSection />
        <MenuSection />
        <TabsSection />
        <TableControlsSection />
        <DataTableSection />
        <EmptyStateSection />
        <TokensSection />
      </PageBody>
    </>
  )
}

/** Label + description pair used down the left of each demo row. */
function Spec({ name, note }: { name: string; note: string }) {
  return (
    <div className="w-56 shrink-0">
      <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-ink">{name}</code>
      <p className="mt-1 text-xs text-muted">{note}</p>
    </div>
  )
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-4 border-b border-border px-5 py-4 last:border-b-0">
      {children}
    </div>
  )
}

function ButtonsSection() {
  const variants = [
    { variant: 'primary', note: 'Main confirm / save action', label: 'Save', icon: true },
    { variant: 'secondary', note: 'Back / secondary actions', label: 'Back', icon: false },
    { variant: 'success', note: 'Positive go / confirm (POS)', label: 'Save', icon: false },
    { variant: 'danger', note: 'Destructive confirm', label: 'Delete', icon: false },
    { variant: 'danger-ghost', note: 'Inline destructive (tables)', label: 'Delete', icon: false },
    { variant: 'ghost', note: 'Low-emphasis / toolbar', label: 'Cancel', icon: false },
  ] as const

  return (
    <Card>
      <CardHeader title="Buttons" description="<Button variant=... /> — refer to a button by its variant name" />
      {variants.map(({ variant, note, label, icon }) => (
        <Row key={variant}>
          <Spec name={`variant="${variant}"`} note={note} />
          <Button variant={variant}>
            {icon && <Icons.Save size={16} />}
            {label}
          </Button>
          <Button variant={variant} iconOnly aria-label={`${label} (icon only)`}>
            <Icons.Plus size={16} />
          </Button>
          <Button variant={variant} disabled>
            Disabled
          </Button>
        </Row>
      ))}
      <Row>
        <Spec name="with icon" note="Icons from components/ui/icons — render before the label" />
        <Button variant="primary">
          <Icons.Save size={16} />
          Save
        </Button>
        <Button variant="ghost">
          <Icons.Download size={16} />
          Export
        </Button>
        <Button variant="danger">
          <Icons.Trash size={16} />
          Delete
        </Button>
      </Row>
    </Card>
  )
}

function FormSection() {
  const [posOnly, setPosOnly] = useState(true)
  const [selected, setSelected] = useState(true)
  const [pricing, setPricing] = useState('cost')

  return (
    <Card>
      <CardHeader
        title="Form controls"
        description="Inputs, selects, switches, checkboxes, radios — one skin, change it in styles.ts and every form updates"
      />
      <CardBody className="grid gap-5 md:grid-cols-2">
        <Field label="Text input">
          <Input placeholder="Product description..." />
        </Field>
        <Field label="With leading icon">
          <Input placeholder="Search..." icon={<Icons.Search size={16} />} />
        </Field>
        <Field label="Number input">
          <NumberInput placeholder="0" />
        </Field>
        <Field label="Currency input">
          <CurrencyInput placeholder="0.00" />
        </Field>
        <Field label="Select">
          <Select icon={<Icons.Filter size={16} />} defaultValue="">
            <option value="">Choose a department...</option>
            <option value="groceries">Groceries</option>
            <option value="bakery">Bakery</option>
          </Select>
        </Field>
        <Field label="Error state" error="Enter a valid email address.">
          <Input defaultValue="bad@" invalid />
        </Field>
        <Field label="Textarea" className="md:col-span-2">
          <Textarea placeholder="Notes..." />
        </Field>
      </CardBody>

      <Row>
        <Spec name="<Switch />" note="On/off settings — e.g. a flag" />
        <Switch
          checked={posOnly}
          onChange={setPosOnly}
          label="POS only"
          hint="Hidden in the back office"
        />
      </Row>
      <Row>
        <Spec name="<Checkbox />" note="Selecting items in a list/grid" />
        <Checkbox
          label="Select row"
          checked={selected}
          onChange={(event) => setSelected(event.target.checked)}
        />
      </Row>
      <Row>
        <Spec name="<Radio />" note="Group by shared name" />
        <div className="flex items-center gap-4">
          <Radio
            name="pricing"
            label="Cost-based"
            checked={pricing === 'cost'}
            onChange={() => setPricing('cost')}
          />
          <Radio
            name="pricing"
            label="Margin-based"
            checked={pricing === 'margin'}
            onChange={() => setPricing('margin')}
          />
        </div>
      </Row>
    </Card>
  )
}

function BadgeSection() {
  return (
    <Card>
      <CardHeader
        title="Badges"
        description="<Badge tone=... /> — status & count pills, coloured by meaning"
      />
      <CardBody className="flex flex-wrap items-center gap-2">
        <Badge tone="success">In stock</Badge>
        <Badge tone="danger">Out of stock</Badge>
        <Badge tone="warning">Low</Badge>
        <Badge tone="brand">New</Badge>
        <Badge tone="neutral">42</Badge>
      </CardBody>
    </Card>
  )
}

function ToastSection() {
  const toast = useToast()
  return (
    <Card>
      <CardHeader
        title="Toasts"
        description="useToast() — the standard outcome message for any action (saved, sent, failed). Auto-dismisses; errors linger longer."
      />
      <CardBody className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => toast.success('Product saved.')}>
          toast.success
        </Button>
        <Button variant="secondary" onClick={() => toast.error('Could not reach the store. Retrying...')}>
          toast.error
        </Button>
        <Button variant="secondary" onClick={() => toast.info('Export queued — we will email it.')}>
          toast.info
        </Button>
      </CardBody>
    </Card>
  )
}

function MenuSection() {
  const toast = useToast()
  return (
    <Card>
      <CardHeader
        title="Dropdown menu"
        description="<Menu> + <MenuItem> — handles open/close, outside-click, Esc, aria"
      />
      <CardBody>
        <Menu label="Actions" align="left">
          <MenuItem onClick={() => toast.info('Duplicated.')}>
            <Icons.Copy size={16} />
            Duplicate
          </MenuItem>
          <MenuItem onClick={() => toast.info('Exporting...')}>
            <Icons.Download size={16} />
            Export
          </MenuItem>
          <MenuSeparator />
          <MenuItem tone="danger" onClick={() => toast.error('Deleted.')}>
            <Icons.Trash size={16} />
            Delete
          </MenuItem>
        </Menu>
      </CardBody>
    </Card>
  )
}

function TabsSection() {
  const [tab, setTab] = useState('general')
  return (
    <Card>
      <CardHeader
        title="Tabs"
        description="<Tabs /> — the underline tab bar from the Edit Product page; use it for every tabbed screen"
      />
      <CardBody>
        <Tabs
          aria-label="Product sections"
          value={tab}
          onChange={setTab}
          items={[
            { value: 'general', label: 'General', icon: <Icons.Pencil size={16} /> },
            { value: 'properties', label: 'Properties', icon: <Icons.Search size={16} /> },
            { value: 'suppliers', label: 'Suppliers', icon: <Icons.Truck size={16} /> },
            { value: 'reports', label: 'Reports', icon: <Icons.BarChart size={16} /> },
          ]}
        />
        <p className="mt-4 text-sm text-muted">
          Active tab: <span className="font-medium text-ink">{tab}</span>. Icons are optional — pass{' '}
          <code className="rounded bg-surface-2 px-1 font-mono text-xs">label</code> only for a
          text-only tab bar.
        </p>
      </CardBody>
    </Card>
  )
}

function TableControlsSection() {
  const [view, setView] = useState('all')
  const [search, setSearch] = useState('')

  return (
    <Card>
      <CardHeader
        title="Table controls"
        description="The toolbar pieces that sit above a list — point at these by name"
      />
      <CardBody className="space-y-6">
        <div>
          <Spec name="<SegmentedControl />" note="Pill group for switching views (the GRV All / Orders / GRVs filter)." />
          <div className="mt-2">
            <SegmentedControl
              aria-label="GRV view"
              value={view}
              onChange={setView}
              options={[
                { value: 'all', label: 'All', count: 162 },
                { value: 'orders', label: 'Orders', count: 47 },
                { value: 'grvs', label: 'GRVs', count: 115 },
              ]}
            />
          </div>
        </div>

        <div>
          <Spec name="<ToolbarSearch />" note="Standard 36px search box with leading icon and brand focus ring." />
          <div className="mt-2">
            <ToolbarSearch
              value={search}
              onChange={setSearch}
              placeholder="Search number, supplier, reference..."
            />
          </div>
        </div>

        <div>
          <Spec name="<TableToolbar />" note="The whole bar: left-aligned controls + right-aligned actions slot." />
          <div className="mt-2">
            <TableToolbar
              actions={
                <>
                  <Button variant="ghost">
                    <Icons.Download size={16} />
                    Export
                  </Button>
                  <Button variant="primary">
                    <Icons.Plus size={16} />
                    New
                  </Button>
                </>
              }
            >
              <SegmentedControl
                aria-label="View"
                value={view}
                onChange={setView}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'orders', label: 'Orders' },
                  { value: 'grvs', label: 'GRVs' },
                ]}
              />
              <ToolbarSearch value={search} onChange={setSearch} />
            </TableToolbar>
          </div>
        </div>
      </CardBody>
    </Card>
  )
}

const PRODUCT_COLUMNS: Column<Product>[] = [
  { key: 'name', header: 'Product', sortable: true, cell: (row) => row.name },
  {
    key: 'sku',
    header: 'SKU',
    cell: (row) => <span className="text-muted">{row.sku}</span>,
    sortValue: (row) => row.sku,
  },
  { key: 'qty', header: 'Qty', numeric: true, sortable: true, cell: (row) => row.qty },
  {
    key: 'price',
    header: 'Price',
    numeric: true,
    sortable: true,
    cell: (row) => rand(row.price),
    sortValue: (row) => row.price,
  },
]

function DataTableSection() {
  const toast = useToast()
  return (
    <Card>
      <CardHeader
        title="Data table"
        description="<DataTable /> — sortable headers, right-aligned numerics, hover rows, inline row actions"
      />
      <DataTable
        columns={PRODUCT_COLUMNS}
        rows={PRODUCTS}
        getRowKey={(row) => row.id}
        actions={(row) => (
          <>
            <Button
              variant="secondary"
              size="sm"
              iconOnly
              aria-label={`Edit ${row.name}`}
              onClick={() => toast.info(`Editing ${row.name}`)}
            >
              <Icons.Pencil size={15} />
            </Button>
            <Button
              variant="danger-ghost"
              size="sm"
              iconOnly
              aria-label={`Delete ${row.name}`}
              onClick={() => toast.error(`Deleted ${row.name}`)}
            >
              <Icons.Trash size={15} />
            </Button>
          </>
        )}
      />
    </Card>
  )
}

function EmptyStateSection() {
  return (
    <Card>
      <CardHeader
        title="Empty state"
        description="<DataTable /> with no rows shows the built-in EmptyState"
      />
      <DataTable
        columns={PRODUCT_COLUMNS}
        rows={[]}
        getRowKey={(row) => row.id}
        empty={{ title: 'No products match', hint: 'Try a different search or filter.' }}
      />
    </Card>
  )
}

/* Swatch classes are written out in full: Tailwind scans source text, so a
   built-up `bg-${name}` would never make it into the stylesheet. */
const TOKENS = [
  { name: 'canvas', swatch: 'bg-canvas', note: 'Page background' },
  { name: 'surface', swatch: 'bg-surface', note: 'Cards, menus, inputs' },
  { name: 'surface-2', swatch: 'bg-surface-2', note: 'Table headers, hover' },
  { name: 'border', swatch: 'bg-border', note: 'Hairlines' },
  { name: 'border-strong', swatch: 'bg-border-strong', note: 'Input borders' },
  { name: 'ink', swatch: 'bg-ink', note: 'Primary text' },
  { name: 'ink-2', swatch: 'bg-ink-2', note: 'Table body text' },
  { name: 'muted', swatch: 'bg-muted', note: 'Labels, hints' },
  { name: 'faint', swatch: 'bg-faint', note: 'Placeholders' },
  { name: 'brand', swatch: 'bg-brand', note: 'Primary actions' },
  { name: 'brand-soft', swatch: 'bg-brand-soft', note: 'Active pill tint' },
  { name: 'success', swatch: 'bg-success', note: 'Good / in stock' },
  { name: 'warning', swatch: 'bg-warning', note: 'Needs attention' },
  { name: 'danger', swatch: 'bg-danger', note: 'Destructive / blocked' },
]

function TokensSection() {
  return (
    <Card>
      <CardHeader
        title="Colour tokens"
        description="Defined once in src/app/globals.css. Use the token name (bg-brand, text-muted) — never a raw hex or a stock Tailwind colour."
      />
      <CardBody className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {TOKENS.map((token) => (
          <div key={token.name} className="flex items-center gap-3">
            <div
              className={`size-9 shrink-0 rounded-control border border-border ${token.swatch}`}
            />
            <div className="min-w-0">
              <code className="font-mono text-xs text-ink">{token.name}</code>
              <p className="truncate text-xs text-muted">{token.note}</p>
            </div>
          </div>
        ))}
      </CardBody>
    </Card>
  )
}

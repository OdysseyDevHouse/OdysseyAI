'use client'

import { useState } from 'react'
import {
  Badge,
  CategoryTile,
  ChoiceTile,
  BulkActionBar,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  ChartTooltip,
  Checkbox,
  ColourInput,
  Combobox,
  ConfirmModal,
  CurrencyInput,
  DataTable,
  DateRangeField,
  EmptyState,
  Field,
  FieldGroup,
  FileInput,
  FilterBar,
  FilterChip,
  Icons,
  Input,
  MiniStat,
  LinkSegmentedControl,
  Menu,
  MenuItem,
  MenuSeparator,
  Modal,
  PinPad,
  NumberInput,
  PageBody,
  PageHeader,
  Pagination,
  Radio,
  SegmentedControl,
  SelectableCard,
  Select,
  RowTile,
  PickerResults,
  SettingGroup,
  SettingRow,
  Sparkline,
  StatStrip,
  StatTile,
  SummaryList,
  SummaryRow,
  SummaryTotal,
  Switch,
  TableSkeleton,
  TableToolbar,
  Tabs,
  Textarea,
  TextLink,
  TILE_SWATCHES,
  SwatchPicker,
  tileClass,
  ToolbarSearch,
  useChartColors,
  useToast,
} from '@/components/ui'
import type { Column } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'

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

/* A full stop, not a comma. The app writes money one way everywhere — mixing
   the two reads as a bug even where each is locally defensible. */
const rand = (value: number) => `R ${value.toFixed(2)}`

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
        <FieldGroupSection />
        <BadgeSection />
        <CalloutSection />
        <StatsSection />
        <SummarySection />
        <IdentitySection />
        <PickerResultsSection />
        <SettingRowSection />
        <SelectableCardSection />
        <TileSwatchSection />
        <ToastSection />
        <MenuSection />
        <TabsSection />
        <TableControlsSection />
        <DataTableSection />
        <SelectionSection />
        <ModalSection />
        <PinPadSection />
        <ComboboxSection />
        <FilterBarSection />
        <DateRangeSection />
        <CategoryTileSection />
        <PaginationSection />
        <EmptyStateSection />
        <SkeletonSection />
        <ChartSection />
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
    {
      variant: 'bare',
      note: 'Chromeless icon — inside other chrome (editor toolbar, sidebar)',
      label: 'Bold',
      icon: false,
    },
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
  const [colour, setColour] = useState('#2f6fed')
  const [selected, setSelected] = useState(true)
  const [pricing, setPricing] = useState('cost')
  // A real value, not a placeholder: the point of the demo is that zero renders
  // as 0.00 and stays that way on every machine.
  const [price, setPrice] = useState(0)

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
        <Field label="Currency input" hint="Always 2 decimals, full stop — never the browser locale">
          <CurrencyInput value={price} onChange={(e) => setPrice(Number(e.target.value) || 0)} />
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
        <Field
          label="File input"
          hint="Account documents. The browser draws the button; we skin it."
          className="md:col-span-2"
        >
          <FileInput />
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
        <Spec name="<ColourInput />" note="A colour: swatch to pick, hex to paste" />
        <ColourInput value={colour} onChange={setColour} />
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

function SettingRowSection() {
  const [on, setOn] = useState(true)

  return (
    <Card>
      <CardHeader
        title="Setting rows"
        description="<SettingGroup /> + <SettingRow /> — a labelled setting with its control on the right. Use for any settings screen rather than laying out icon, label and control by hand."
      />
      <CardBody>
        <SettingGroup title="Properties" description="What a group of settings is for.">
          <SettingRow
            icon={<Icons.Eye size={16} />}
            label="A switch setting"
            description="One line explaining what switching this on actually does."
          >
            <Switch checked={on} onChange={setOn} />
          </SettingRow>
          <SettingRow
            icon={<Icons.Percent size={16} />}
            label="A numeric setting"
            description="Controls keep their natural width and sit hard right, so a column of them lines up."
            htmlFor="styleGuideSettingNumber"
          >
            <NumberInput
              id="styleGuideSettingNumber"
              precision={2}
              defaultValue={0}
              className="w-32 text-right"
            />
            <span className="text-sm text-muted">%</span>
          </SettingRow>
          <SettingRow
            icon={<Icons.Barcode size={16} />}
            label="A select setting"
            description="The last row draws no divider, so the group closes cleanly."
            htmlFor="styleGuideSettingSelect"
          >
            <Select id="styleGuideSettingSelect" className="w-52" defaultValue="a">
              <option value="a">First choice</option>
              <option value="b">Second choice</option>
            </Select>
          </SettingRow>
        </SettingGroup>
      </CardBody>
    </Card>
  )
}

function SelectableCardSection() {
  const [choice, setChoice] = useState('normal')

  return (
    <Card>
      <CardHeader
        title="Selectable cards"
        description="<SelectableCard /> — a large choice tile with a title and explanation, for choices worth describing"
      />
      <CardBody className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <SelectableCard
          name="styleGuideChoice"
          value="normal"
          title="Normal product"
          description="A standard stocked item. Each sale reduces the quantity on hand by the amount sold."
          checked={choice === 'normal'}
          onChange={setChoice}
        />
        <SelectableCard
          name="styleGuideChoice"
          value="serial"
          title="Serial product"
          description="An item identified by a unique serial number."
          checked={choice === 'serial'}
          onChange={setChoice}
          badge={
            <Badge tone="brand">
              <Icons.Globe size={11} />
              Online only
            </Badge>
          }
          footer={
            <Button variant="ghost" size="sm" disabled className="w-full">
              Setup serial numbers
            </Button>
          }
        />
        <SelectableCard
          name="styleGuideChoice"
          value="service"
          title="Service product"
          description="A non-stocked item, such as a service or labour charge."
          checked={choice === 'service'}
          onChange={setChoice}
        />
      </CardBody>
    </Card>
  )
}

function TileSwatchSection() {
  const [picked, setPicked] = useState<string | null>(TILE_SWATCHES[0].token)

  return (
    <Card>
      <CardHeader
        title="Tile swatches"
        description="<SwatchPicker> over TILE_SWATCHES / tileClass() — the colour palette for records with no image (products, departments)"
      />
      <CardBody className="flex flex-wrap items-center gap-4">
        <div
          className={`flex size-16 items-center justify-center rounded-card text-2xl font-semibold text-white ${tileClass(picked)}`}
        >
          A
        </div>
        <div className="flex flex-col gap-2">
          <SwatchPicker value={picked} onChange={setPicked} />
          <SwatchPicker value={picked} onChange={setPicked} size="sm" />
        </div>
        <p className="max-w-80 text-xs text-muted">
          Records store the token name (<code>tile-3</code>), never a hex — so restyling the
          palette in globals.css repaints every existing record. The leading swatch clears the
          colour; a record with none falls back to a tile derived from its name.
        </p>
      </CardBody>
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

function CalloutSection() {
  return (
    <Card>
      <CardHeader
        title="Callouts"
        description="<Callout tone title action> — the inline notice. One per condition; when several conditions hold, show only the most severe."
      />
      <CardBody className="flex flex-col gap-3">
        <Callout tone="danger" title="This invoice is cancelled">
          Cancelled on 12 May by Thabo. The stock has been returned to the shelf.
        </Callout>
        <Callout
          tone="warning"
          title="Mail is not set up"
          action={
            <Button variant="secondary" size="sm">
              Open settings
            </Button>
          }
        >
          Statements can be generated but not sent until an SMTP server is configured.
        </Callout>
        <Callout tone="success" title="Statement run complete">
          142 statements sent, none failed.
        </Callout>
        <Callout tone="brand">
          Lay-bys are held for 60 days by default. Change the period under Setup → Lay-bys.
        </Callout>
      </CardBody>
    </Card>
  )
}

function StatsSection() {
  return (
    <Card>
      <CardHeader
        title="Stat strip"
        description="<StatStrip> of <StatTile> — a list screen's headline numbers. Tone only the tile that means “act on me”; three tiles all in the same ink is three tiles nobody looks at. <MiniStat> is the compact figure inside other chrome."
      />
      <CardBody className="flex flex-col gap-4">
        <StatStrip>
          <StatTile label="Products" value="1,284" hint="86 archived" />
          <StatTile label="Stock value" value={rand(482210.4)} hint="At cost" />
          <StatTile label="Below minimum" value="37" tone="warning" hint="Reorder these" />
          <StatTile label="Out of stock" value="4" tone="danger" hint="Losing sales" />
        </StatStrip>
        <div className="flex flex-wrap gap-2">
          <MiniStat label="Parsed" value="212" />
          <MiniStat label="Matched" value="196" tone="success" />
          <MiniStat label="Problems" value="3" tone="danger" />
        </div>
      </CardBody>
    </Card>
  )
}

function SummarySection() {
  return (
    <Card>
      <CardHeader
        title="Summary totals"
        description="<SummaryList> + <SummaryRow> + <SummaryTotal> — the totals panel on documents and forms. The grand total is the loudest number on purpose."
      />
      <CardBody className="max-w-xs">
        <SummaryList>
          <SummaryRow label="Subtotal" value={rand(1073.9)} />
          <SummaryRow label="Discount" value={`-${rand(53.7)}`} tone="warning" />
          <SummaryRow label="VAT (15%)" value={rand(153.03)} />
          <SummaryTotal label="Total inclusive" value={rand(1173.23)} />
        </SummaryList>
      </CardBody>
    </Card>
  )
}

function IdentitySection() {
  return (
    <Card>
      <CardHeader
        title="Row identity"
        description="<RowTile> — the leading initials tile that makes a row findable by shape. <TextLink> — the inline brand link for record references."
      />
      <CardBody className="flex flex-col gap-3 text-sm text-ink-2">
        {PRODUCTS.map((p) => (
          <div key={p.id} className="flex items-center gap-3">
            <RowTile label={p.name} />
            <TextLink href="/setup/style-guide">{p.sku}</TextLink>
            <span>{p.name}</span>
          </div>
        ))}
      </CardBody>
    </Card>
  )
}

function PickerResultsSection() {
  return (
    <Card>
      <CardHeader
        title="Picker results"
        description="<PickerResults> — the matches under a type-ahead search box, where something is chosen by typing rather than from a dropdown. Renders nothing when there are no results; say “nothing matched” above the field instead."
      />
      <CardBody className="max-w-xl">
        <Field label="Add a product">
          <Input defaultValue="mon" placeholder="Search by code or description…" />
        </Field>
        <PickerResults
          results={PRODUCTS.map((p) => ({
            key: p.id,
            label: p.name,
            meta: p.sku,
            trailing: formatMoney(p.price),
          }))}
          onPick={() => {}}
        />
      </CardBody>
    </Card>
  )
}

function FieldGroupSection() {
  return (
    <Card>
      <CardHeader
        title="Field groups"
        description="<FieldGroup title hint> — a titled cluster of related fields inside one card, for forms whose sections are too small to each deserve their own Card."
      />
      <CardBody className="grid max-w-2xl gap-4 sm:grid-cols-2">
        <FieldGroup title="What it applies to" hint="Leave both off to apply storewide.">
          <Field label="Department">
            <Select defaultValue="">
              <option value="">All departments</option>
              <option>Beverages</option>
            </Select>
          </Field>
        </FieldGroup>
        <FieldGroup title="What it pays">
          <Field label="Rate" className="max-w-32">
            <NumberInput defaultValue={2.5} />
          </Field>
        </FieldGroup>
      </CardBody>
    </Card>
  )
}

function SkeletonSection() {
  return (
    <Card>
      <CardHeader
        title="Loading skeleton"
        description="<TableSkeleton columns rows> — holds a table's real 36px row rhythm while data loads, instead of a spinner that collapses the page."
      />
      <TableSkeleton columns={4} rows={3} />
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
          <Spec
            name="<LinkSegmentedControl />"
            note="Same control, each segment a route — for list filters that live in the URL, so it works from a Server Component."
          />
          <div className="mt-2">
            <LinkSegmentedControl
              aria-label="Status"
              value="all"
              options={[
                { value: 'all', label: 'All', href: '/setup/style-guide' },
                { value: 'finalised', label: 'Finalised', href: '/setup/style-guide' },
                { value: 'saved', label: 'Saved', href: '/setup/style-guide' },
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

function SelectionSection() {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const toast = useToast()

  return (
    <Card>
      <CardHeader
        title="Row selection + bulk actions"
        description="<DataTable selectedKeys onSelectionChange /> with <BulkActionBar /> — click a checkbox, then shift-click another to take the range. Out-of-stock rows are unselectable via isRowSelectable."
      />
      <BulkActionBar
        count={selected.size}
        onClear={() => setSelected(new Set())}
        selectAll={{
          total: 412,
          selected: false,
          onSelectAll: () => toast.info('Would select all 412 matching the filter'),
        }}
      >
        <Button variant="ghost" size="sm" onClick={() => toast.success(`${selected.size} updated`)}>
          <Icons.Check size={15} />
          Change status
        </Button>
        <Menu label="More" variant="ghost">
          <MenuItem onClick={() => toast.info('Emailing statements')}>
            <Icons.Mail size={15} />
            Email statements
          </MenuItem>
          <MenuItem href="#" download>
            <Icons.Download size={15} />
            Export selection
          </MenuItem>
          <MenuSeparator />
          <MenuItem tone="danger" onClick={() => toast.error('Placed on hold')}>
            <Icons.Ban size={15} />
            Place on hold
          </MenuItem>
        </Menu>
      </BulkActionBar>
      <DataTable
        columns={PRODUCT_COLUMNS}
        rows={PRODUCTS}
        getRowKey={(row) => row.id}
        selectedKeys={selected}
        onSelectionChange={setSelected}
        /* Nothing on hand cannot be picked for a stock action — the reason a
           row is unselectable belongs to the screen, not the table. */
        isRowSelectable={(row) => row.qty > 0}
      />
    </Card>
  )
}

function ModalSection() {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const toast = useToast()

  return (
    <Card>
      <CardHeader
        title="Modal"
        description="<Modal /> and <ConfirmModal /> — built on the native <dialog>, so focus trapping, the inert background and Escape all come free"
      />
      <Row>
        <Spec name="<Modal>" note="Forms and detail panels" />
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Open modal
        </Button>
      </Row>
      <Row>
        <Spec name="<ConfirmModal>" note="Destructive confirms — danger action on the right" />
        <Button variant="danger-ghost" onClick={() => setConfirming(true)}>
          <Icons.Trash size={15} />
          Delete something
        </Button>
      </Row>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Set credit terms"
        description="Applies to every selected account."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setOpen(false)
                toast.success('Credit terms updated')
              }}
            >
              Apply
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Payment terms (days)" hint="0–365. Zero means cash on delivery.">
            <NumberInput defaultValue={30} />
          </Field>
          <Field label="Credit limit">
            <CurrencyInput defaultValue={10000} />
          </Field>
        </div>
      </Modal>

      <ConfirmModal
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false)
          toast.error('Deleted')
        }}
        title="Delete this department?"
        message="Fresh Produce has no products and no sub-departments, so it can be removed. This cannot be undone."
        confirmLabel="Delete department"
      />
    </Card>
  )
}

function PinPadSection() {
  const [entered, setEntered] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  return (
    <Card>
      <CardHeader
        title="PinPad"
        description="<PinPad /> — till sign-in and supervisor overrides. Touch targets sized for a counter screen; the physical keyboard works too"
      />
      <div className="flex flex-wrap items-start gap-6 px-5 py-5">
        <Spec name="<PinPad>" note="4 digits submit automatically; 6 need Enter" />
        <PinPad
          onSubmit={(pin) => {
            // 1234 fails here purely to show the error state.
            if (pin === '1234') {
              setError('That PIN was not recognised.')
              setEntered(null)
            } else {
              setError(null)
              setEntered(pin)
            }
          }}
          error={error}
          onCancel={() => {
            setEntered(null)
            setError(null)
          }}
        />
        <p className="text-xs text-muted">
          {entered ? `Accepted ${entered.length} digits.` : 'Try 1234 to see the error state.'}
        </p>
      </div>
    </Card>
  )
}

function ComboboxSection() {
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string | null>(null)

  const options = PRODUCTS.filter(
    (product) =>
      product.name.toLowerCase().includes(query.toLowerCase()) ||
      product.sku.toLowerCase().includes(query.toLowerCase()),
  ).map((product) => ({
    value: product.id,
    label: product.name,
    hint: product.sku,
    trailing: rand(product.price),
  }))

  return (
    <Card>
      <CardHeader
        title="Combobox"
        description="<Combobox /> — type-ahead for lists too long for a <Select>. Arrow keys wrap, Enter takes the highlighted row, so a scanner never needs the mouse."
      />
      <Row>
        <Spec name="<Combobox>" note="Product search at the till" />
        <div className="w-80">
          <Combobox
            options={options}
            query={query}
            onQueryChange={setQuery}
            onSelect={(option) => setPicked(option.label)}
            placeholder="Scan or search a product…"
          />
        </div>
        <p className="text-xs text-muted">{picked ? `Picked: ${picked}` : 'Nothing picked yet'}</p>
      </Row>
    </Card>
  )
}

function FilterBarSection() {
  return (
    <Card>
      <CardHeader
        title="Filter bar"
        description="<FilterBar /> + <FilterChip /> — the applied filters, each clearable on its own. Build the hrefs with hrefBuilder() from lib/searchParams so clearing one keeps the rest."
      />
      <div className="py-3">
        <FilterBar clearHref="#">
          <FilterChip label="Status" value="On hold" clearHref="#" />
          <FilterChip label="Group" value="Trade" clearHref="#" />
          <FilterChip label="Rep" value="N. Dlamini" clearHref="#" />
          <FilterChip label="Balance" value="Over limit" clearHref="#" />
        </FilterBar>
      </div>
    </Card>
  )
}

function DateRangeSection() {
  const [range, setRange] = useState({ from: '2026-08-01', to: '2026-08-05' })

  return (
    <Card>
      <CardHeader
        title="Date range"
        description="<DateRangeField /> — two native date inputs plus the presets people actually ask for. Native rather than a calendar of our own: it already matches the operator's locale and keyboard."
      />
      <Row>
        <Spec name="<DateRangeField>" note="Reports, statement runs, document lists" />
        <DateRangeField value={range} onChange={setRange} />
      </Row>
    </Card>
  )
}

function CategoryTileSection() {
  return (
    <Card>
      <CardHeader
        title="Category tiles and choice tiles"
        description="<CategoryTile /> identifies a SUBJECT by colour — a report category, a dataset. Never a state: `danger` red means something is wrong, a rose tile just means Suppliers. <ChoiceTile /> is the clickable card it usually sits in."
      />
      <Row>
        <Spec name="<CategoryTile tone icon>" note="Reports hub, builder source picker" />
        <div className="flex flex-wrap items-center gap-2">
          <CategoryTile icon={<Icons.BarChart size={18} />} tone="indigo" />
          <CategoryTile icon={<Icons.Boxes size={18} />} tone="teal" />
          <CategoryTile icon={<Icons.Contact size={18} />} tone="sky" />
          <CategoryTile icon={<Icons.Truck size={18} />} tone="rose" />
          <CategoryTile icon={<Icons.Coins size={18} />} tone="emerald" />
          <CategoryTile icon={<Icons.Settings size={18} />} tone="amber" />
          <CategoryTile icon={<Icons.Star size={18} />} tone="violet" />
          <CategoryTile icon={<Icons.PackageOpen size={18} />} tone="orange" />
          <CategoryTile icon={<Icons.FileText size={18} />} tone="slate" />
        </div>
      </Row>
      <Row>
        <Spec name="<ChoiceTile layout='stacked'>" note="Picking a dataset — roomy, few options" />
        <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2">
          <ChoiceTile
            title="Sales lines"
            description="One row per product sold — quantities, prices, discount and margin."
            icon={<CategoryTile icon={<Icons.ListOrdered size={18} />} tone="violet" />}
            footer={<Badge tone="neutral">Over a period</Badge>}
            onClick={() => {}}
          />
          <ChoiceTile
            title="Products"
            description="The catalogue as it stands now — stock on hand, cost and margin."
            icon={<CategoryTile icon={<Icons.Boxes size={18} />} tone="teal" />}
            footer={<Badge tone="neutral">As it is now</Badge>}
            onClick={() => {}}
          />
        </div>
      </Row>
      <Row>
        <Spec name="<ChoiceTile layout='inline'>" note="A long list — denser, names lead" />
        <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2">
          <ChoiceTile
            layout="inline"
            title="Sales by product"
            description="What sold, how much of it, and what it made."
            icon={<CategoryTile icon={<Icons.ListOrdered size={16} />} tone="violet" size="sm" />}
            onClick={() => {}}
          />
          <ChoiceTile
            layout="inline"
            title="Stock valuation"
            description="What is on the shelf and what it cost."
            icon={<CategoryTile icon={<Icons.Boxes size={16} />} tone="teal" size="sm" />}
            onClick={() => {}}
          />
        </div>
      </Row>
    </Card>
  )
}

function PaginationSection() {
  return (
    <Card>
      <CardHeader
        title="Pagination"
        description="<Pagination /> — links, not buttons, so a server-rendered list pages without becoming a Client Component. Renders nothing at all for a single page."
      />
      <Pagination page={3} pageCount={9} total={412} pageSize={50} hrefFor={() => '#'} />
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

function ChartSection() {
  const colors = useChartColors()
  // A shape with a visible peak and trough, so the sparkline demo shows what a
  // sparkline is actually for rather than a straight line.
  const series = [4, 9, 6, 12, 8, 15, 11, 18, 14, 21]

  return (
    <Card>
      <CardHeader
        title="Charts"
        description="useChartColors() resolves the --color-chart-* tokens for Recharts, which cannot read CSS variables. Never name a colour in a chart — take one from here."
      />
      <Row>
        <Spec name="colors.series" note="Categorical ramp, consumed in order and wrapped" />
        <div className="flex flex-wrap gap-3">
          {colors.series.map((color, i) => (
            <div key={color} className="flex items-center gap-2">
              <span
                className="size-8 rounded-control border border-border"
                style={{ background: color }}
              />
              <code className="font-mono text-xs text-muted">chart-{i + 1}</code>
            </div>
          ))}
        </div>
      </Row>
      <Row>
        <Spec name="<Sparkline />" note="A trend at the size of a word — KPI tiles, table rows" />
        <div className="flex flex-1 flex-wrap items-center gap-6">
          {colors.series.slice(0, 3).map((color) => (
            <div key={color} className="w-32">
              <Sparkline values={series} color={color} />
            </div>
          ))}
        </div>
      </Row>
      <Row>
        <Spec name="<ChartTooltip />" note="Pass to Recharts via <Tooltip content={...} />" />
        <ChartTooltip
          active
          label="12 Jun"
          payload={[{ name: 'Turnover', value: 48250, color: colors.series[0] }]}
          format={(v) => formatMoney(v)}
        />
      </Row>
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

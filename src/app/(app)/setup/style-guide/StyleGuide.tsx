'use client'

import { useState } from 'react'
import Image from 'next/image'
import {
  Accordion,
  ActionTile,
  Badge,
  CategoryTile,
  ChoiceTile,
  BulkActionBar,
  BulkOptionsDialog,
  Button,
  Callout,
  Tooltip,
  SettingsHint,
  Card,
  CardBody,
  CardHeader,
  ChartGlow,
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
  InlineField,
  FileInput,
  FilterBar,
  FilterChip,
  Icons,
  Input,
  MiniStat,
  LinkSegmentedControl,
  LinkSelect,
  ColumnPicker,
  Menu,
  MenuItem,
  MenuSeparator,
  Modal,
  PinPad,
  TenderTile,
  SignaturePad,
  LaneWeek,
  NumberInput,
  PageBody,
  PageHeader,
  Pagination,
  Radio,
  SegmentedControl,
  ReasonPicker,
  SectionTitle,
  SelectableCard,
  Select,
  RowTile,
  PickerResults,
  SettingGroup,
  SettingRow,
  WeekHours,
  type HoursRange,
  Sparkline,
  MeterBar,
  TableGlyph,
  FeatureGlyph,
  PromoArt,
  TintButton,
  StoreColumnTable,
  StatStrip,
  StatTile,
  SummaryList,
  SummaryRow,
  SummaryTotal,
  Switch,
  TableSkeleton,
  PageHeaderSkeleton,
  StatStripSkeleton,
  ToolbarSkeleton,
  TabsSkeleton,
  FormSkeleton,
  SettingRowsSkeleton,
  TableToolbar,
  Tabs,
  Textarea,
  TextLink,
  TILE_SWATCHES,
  TileGrid,
  toneForId,
  toneForTileToken,
  TouchRow,
  ProductTile,
  Slider,
  Stepper,
  SwatchPicker,
  GeneratedPictureModal,
  tileClass,
  ToolbarSearch,
  useChartColors,
  useToast,
} from '@/components/ui'
import type { Column } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { seatLayout } from '@/lib/site/floorGeometry'
import { quickKeyArt, quickKeyArtSrc } from '@/lib/quickKeyArt'
/* The REAL till line card, imported rather than mocked — the POS is behind a
   clerk PIN, so this page is the only place it can be looked at, and a copy
   here would drift from the thing it is meant to document. */
import { SaleLineCard } from '@/app/(pos)/pos/SaleLineCard'
import { LineOptionsModal } from '@/app/(pos)/pos/LineOptionsModal'
import InstructionsModal from '@/app/(pos)/pos/InstructionsModal'
import { ReceiptModal } from '@/app/(pos)/pos/ReceiptModal'
import { SplitPreview } from './SplitPreview'
import { GatePreview, FloorPreview } from './GatePreview'
import { ModuleMenuPreview } from './ModuleMenuPreview'
import { TenderPreview } from './TenderPreview'
import type { TillInstructionGroup } from '@/lib/site/instructions'
import type { TillProduct } from '@/lib/site/tillSearch'
import type { BasketLine } from '@/lib/basket'

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
        <SectionTitleSection />
        <CalloutSection />
        <TooltipSection />
        <SettingsHintSection />
        <StatsSection />
        <SummarySection />
        <IdentitySection />
        <PickerResultsSection />
        <SettingRowSection />
        <WeekHoursSection />
        <AccordionSection />
        <SelectableCardSection />
        <ReasonPickerSection />
        <TileSwatchSection />
        <GeneratedPictureSection />
        <ToastSection />
        <MenuSection />
        <ColumnPickerSection />
        <TabsSection />
        <TableControlsSection />
        <DataTableSection />
        <SelectionSection />
        <ModalSection />
        <PinPadSection />
        <SignaturePadSection />
        <LaneWeekSection />
        <ComboboxSection />
        <FilterBarSection />
        <DateRangeSection />
        <CategoryTileSection />
        <TillTileSection />
        <TenderTileSection />
        <SaleLineSection />
        <InstructionsSection />
        <ReceiptSection />
        <SplitBillSection />
        <TableGateSection />
        <ModuleMenuSection />
        <PaginationSection />
        <EmptyStateSection />
        <SkeletonSection />
        <ChartSection />
        <LayoutSection />
        <WordmarkSection />
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
    {
      variant: 'warning',
      note: 'Consequential but NOT destructive — money out, not a mistake (the till’s Refund)',
      label: 'Refund',
      icon: false,
    },
    { variant: 'danger', note: 'Destructive confirm', label: 'Delete', icon: false },
    { variant: 'danger-ghost', note: 'Inline destructive (tables)', label: 'Delete', icon: false },
    { variant: 'ghost', note: 'Low-emphasis / toolbar', label: 'Cancel', icon: false },
    {
      variant: 'key',
      note: 'A keypad key — neutral fill so ten of them read as a pad (the till’s PinPad)',
      label: '7',
      icon: false,
    },
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
      <Row>
        <Spec
          name="<TintButton tone>"
          note="The OTHER kind of button: wears a SUBJECT's colour, not a meaning's. Same tones as CategoryTile, so a disc and the buttons under it read as one identifier (the till's module menu). Only where a subject colour is already established beside it — never for a confirm, save or delete, which are always a Button."
        />
        <TintButton tone="emerald">
          <Icons.Plus size={16} />
          New sale
        </TintButton>
        <TintButton tone="indigo">
          <Icons.ListOrdered size={16} />
          Quote list
        </TintButton>
        <TintButton tone="sky">
          <Icons.ListOrdered size={16} />
          Order list
        </TintButton>
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
  const [tileWidth, setTileWidth] = useState(200)
  const [deviceCount, setDeviceCount] = useState(2)

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
        <Field
          label="Quiet focus, at till size"
          hint="quietFocus + size=&quot;touch&quot; — for the scan box that HOLDS focus all shift; click in to compare"
        >
          <Input
            placeholder="Scan or search products"
            icon={<Icons.Search size={18} />}
            size="touch"
            quietFocus
          />
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
        <Spec
          name="<InlineField label icon>"
          note="Label BESIDE the control, in its own card — for till dialogs built from equal-weight cards. Stacked forms keep <Field>."
        />
        <div className="grid w-full gap-3 sm:grid-cols-2">
          <InlineField label="Visit type" icon={<Icons.Armchair size={16} />}>
            <Select defaultValue="sit">
              <option value="sit">SIT DOWN</option>
              <option value="take">TAKEAWAY</option>
            </Select>
          </InlineField>
          <InlineField label="Waiter" icon={<Icons.Contact size={16} />}>
            <Select defaultValue="me">
              <option value="me">Tiaan Bryson Smith</option>
            </Select>
          </InlineField>
        </div>
      </Row>

      <Row>
        <Spec
          name="<Slider />"
          note="A number chosen by feel — tile size, a zoom, a tolerance. Anything typed exactly is a NumberInput."
        />
        <div className="w-full max-w-sm space-y-4">
          {/* Anchors, no hint — deliberately. The two stack into three lines of
              grey text under one control; see the Slider docblock. */}
          <Field label="Tile width">
            <Slider
              value={tileWidth}
              onChange={setTileWidth}
              min={110}
              max={420}
              step={10}
              unit="px"
              minLabel="Dense"
              maxLabel="Large"
            />
          </Field>
          {/* The till size, shown because it is the reason the size exists: a 4px
              native track is unhittable on a counter touchscreen. */}
          <Field label="At till size" hint='size="touch" — a finger, not a mouse'>
            <Slider
              value={tileWidth}
              onChange={setTileWidth}
              min={110}
              max={420}
              step={10}
              unit="px"
              size="touch"
            />
          </Field>
          <Field label="Disabled">
            <Slider value={200} onChange={() => {}} min={110} max={420} disabled unit="px" />
          </Field>
        </div>
      </Row>
      <Row>
        <Spec
          name="<Stepper />"
          note="A small whole number adjusted by one or two — tills on a licence, seats on a plan. Anything that could be any value is a NumberInput."
        />
        <div className="flex flex-wrap items-center gap-4">
          <Field label="Devices at this store">
            <Stepper value={deviceCount} onChange={setDeviceCount} min={1} max={99} label="Devices" />
          </Field>
          <Field label="At its floor">
            <Stepper value={1} onChange={() => {}} min={1} max={9} label="At the minimum" />
          </Field>
          <Field label="Disabled">
            <Stepper value={3} onChange={() => {}} min={1} max={9} label="Disabled" disabled />
          </Field>
        </div>
      </Row>

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

function WeekHoursSection() {
  const [hours, setHours] = useState<Record<string, HoursRange[]>>({
    '2': [['12:00', '14:30'], ['18:00', '21:30']],
    '3': [['08:00', '17:00']],
  })

  return (
    <Card>
      <CardHeader
        title="Opening times"
        description="<WeekHours /> — a week of opening times, one row per day. A day holds a LIST of ranges, so a split lunch/dinner service is expressible; an empty day means closed. Used by reservations and by the online store's trading hours, which store the same JSON."
      />
      <CardBody>
        <WeekHours hours={hours} onChange={setHours} rangeNoun="service" />
      </CardBody>
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
        {/* tone="default" only because this demo sits inside the style guide's
            own card — in a real screen a SettingGroup keeps the brand rule. */}
        <SettingGroup
          tone="default"
          title="Properties"
          description="What a group of settings is for."
        >
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

function AccordionSection() {
  // A Set, not a single value — more than one can be open at a time, which is
  // the whole difference between this and a tab strip.
  const [open, setOpen] = useState<Set<string>>(() => new Set(['first']))
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <Card>
      <CardHeader
        title="Accordion"
        description="<Accordion /> — a titled panel that folds away. Use to stack several groups of settings in one narrow column, where a tall page of everything-at-once would bury what somebody is working on. Any number can be open at once; the parent owns which, so a screen can open one in response to something selected elsewhere."
      />
      <CardBody className="flex flex-col gap-2">
        <Accordion
          title="An open panel"
          description="The description shows whether it is open or shut."
          open={open.has('first')}
          onToggle={() => toggle('first')}
        >
          <p className="text-sm text-muted">
            Whatever the panel holds — a form, a list, a set of tiles. Contents are unmounted
            when shut, so nothing inside keeps running or catches a Tab.
          </p>
        </Accordion>
        <Accordion
          title="A folded panel"
          description="Click the header anywhere to open it."
          open={open.has('second')}
          onToggle={() => toggle('second')}
        >
          <p className="text-sm text-muted">Now you can see me.</p>
        </Accordion>
        <Accordion
          title="With a badge"
          description="For a count, or a state worth seeing while shut."
          badge={<Badge tone="warning">3 to check</Badge>}
          open={open.has('third')}
          onToggle={() => toggle('third')}
        >
          <p className="text-sm text-muted">
            The badge sits between the title and the chevron, and stays visible when folded.
          </p>
        </Accordion>
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

const GUIDE_REASONS = [
  { id: 1, code: 'WRONG-ITEM', name: 'Wrong item rung up', allowsNote: false },
  { id: 2, code: 'DOUBLE-RUNG', name: 'Rung up twice', allowsNote: false },
  { id: 3, code: 'OTHER', name: 'Something else', allowsNote: true },
]

function ReasonPickerSection() {
  const [reasonId, setReasonId] = useState<number | null>(null)
  const [note, setNote] = useState('')

  return (
    <Card>
      <CardHeader
        title="Reason picker"
        description="<ReasonPicker /> — picking a coded reason from a short list, with the note that only appears for reasons whose code cannot say enough"
      />
      <CardBody className="max-w-md">
        <ReasonPicker
          reasons={GUIDE_REASONS}
          value={reasonId}
          note={note}
          onChange={setReasonId}
          onNoteChange={setNote}
          label="Why is this being voided?"
          hint="Choose “Something else” to see the note appear."
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

function GeneratedPictureSection() {
  const [open, setOpen] = useState(false)
  const [font, setFont] = useState('')
  const [made, setMade] = useState<string | null>(null)

  return (
    <Card>
      <CardHeader
        title="Generated picture"
        description="<GeneratedPictureModal> / <GeneratedPictureGallery> — builds a square PNG from a record's own initial and name on a gradient, for products that will never be photographed. Used on the product screen to make a TILL ICON. The result is an ordinary image File, saved through whatever upload the screen already has, so nothing downstream knows it was generated."
        action={
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
            <Icons.Sparkles size={15} />
            Generate a picture
          </Button>
        }
      />
      <CardBody className="flex flex-wrap items-center gap-4">
        {made ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={made}
            alt="The generated picture"
            className="size-24 rounded-card border border-border"
          />
        ) : (
          <div className="flex size-24 items-center justify-center rounded-card border border-dashed border-border text-xs text-faint">
            No picture
          </div>
        )}
        <p className="max-w-96 text-xs text-muted">
          One renderer draws both the live preview and the saved PNG, so what is approved is
          what is stored. The typeface is a SITE setting rather than a per-product one — a
          catalogue set in eight different faces reads as broken, not varied; the gradient is
          what tells one product from the next, and it is suggested from the name so the same
          product always opens on the same colour.
        </p>

        <GeneratedPictureModal
          open={open}
          onClose={() => setOpen(false)}
          name="2-Hole Punch 22"
          fontId={font}
          onFontChange={setFont}
          onPick={(file) => {
            // The style guide has nothing to upload to, so it just shows the
            // File it was handed — which is exactly what a real screen passes
            // to its own image action.
            setMade(URL.createObjectURL(file))
          }}
        />
      </CardBody>
    </Card>
  )
}

function BadgeSection() {
  return (
    <Card>
      <CardHeader
        title="Badges"
        description="<Badge tone=... /> — status & count pills, coloured by meaning. Add `dot` for the STATE of a record, where the mark is caught before the word is read; leave it off for a plain count. `solid` is the TILL variant (third row): a basket is read at arm's length, where a pale pill on a white card is a smudge — do not reach for it to make a back-office badge pop."
      />
      <CardBody className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="success">In stock</Badge>
          <Badge tone="danger">Out of stock</Badge>
          <Badge tone="warning">Low</Badge>
          <Badge tone="brand">New</Badge>
          <Badge tone="neutral">42</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge dot tone="brand">
            Draft
          </Badge>
          <Badge dot tone="success">
            Finalised
          </Badge>
          <Badge dot tone="warning">
            On hold
          </Badge>
          <Badge dot tone="danger">
            Cancelled
          </Badge>
          <Badge dot tone="neutral">
            Archived
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge solid tone="success">
            Sent
          </Badge>
          <Badge solid tone="danger">
            Refund
          </Badge>
          <Badge solid tone="warning">
            modified
          </Badge>
          <Badge solid tone="brand">
            new
          </Badge>
          <Badge solid tone="neutral">
            48 minutes
          </Badge>
        </div>
      </CardBody>
    </Card>
  )
}

function SectionTitleSection() {
  return (
    <Card>
      <CardHeader
        title="Card headings"
        description="All three heading components mark their card with a brand rule down its left edge by default, so a screen that mixes them still reads as one stack. The heading text itself is ink. Pass tone='default' to opt out of the rule."
      />
      <CardBody className="flex flex-col gap-4">
        <Card>
          <SectionTitle icon={<Icons.Info size={16} />}>Product overview</SectionTitle>
          <div className="px-5 py-4 text-sm text-muted">
            &lt;SectionTitle icon action&gt; — the heading bar inside a card that holds one
            section of a long form. The icon sits in a pale brand-soft tile; the rule down the
            card&apos;s left edge uses its own deeper brand-rule token, and is drawn by the card
            rather than by this heading, so it runs the card&apos;s full height.
          </div>
        </Card>
        <Card>
          <CardHeader
            title="Photographs"
            description="A card that is a screen in its own right — this one carries a description and can take an action."
          />
          <CardBody className="text-sm text-muted">
            &lt;CardHeader title description action&gt;.
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            icon={<Icons.Terminal size={16} />}
            title="Till licences"
            description="With an icon — the same 36px brand-soft tile SettingRow draws."
          />
          <CardBody className="text-sm text-muted">
            &lt;CardHeader icon&gt; — use it when the card&apos;s rows carry icons too, so the
            heading sits in the same column as the tiles beneath it rather than half a tile
            off. Omit it and the header is unchanged.
          </CardBody>
        </Card>
        <SettingGroup
          title="Scale properties"
          description="A group of switches and inputs, each one a SettingRow."
        >
          <SettingRow
            icon={<Icons.Percent size={16} />}
            label="A setting"
            description="The group is its own card, so it draws the left rule itself rather than being marked for a parent to draw."
          >
            <span className="text-sm text-muted">—</span>
          </SettingRow>
        </SettingGroup>
        <Card>
          <SectionTitle tone="default" icon={<Icons.Info size={16} />}>
            A quieter heading
          </SectionTitle>
          <div className="px-5 py-4 text-sm text-muted">
            tone=&quot;default&quot; — no rule, ink title. Use it for a card nested inside another
            card, where a second rule would compete with the outer one.
          </div>
        </Card>
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
          Posting is blocked until the February period is reopened.
        </Callout>
      </CardBody>
    </Card>
  )
}

function TooltipSection() {
  return (
    <Card>
      <CardHeader
        title="Tooltip"
        description="<Tooltip label side align trigger> — the full text of something that had to be clipped. Appears immediately on hover, unlike the browser's title= which waits about a second and cannot be styled. Pure CSS, so it costs no hydration on a screen rendering hundreds of them. Use trigger=&quot;card&quot; when an overlay link covers the text and would otherwise swallow the hover."
      />
      <CardBody className="flex flex-col gap-4">
        <div className="max-w-sm">
          <Tooltip
            label="Every document raised in the period — as a list of documents with their totals, or line by line with cost and margin."
            side="bottom"
            align="start"
          >
            <span className="block truncate text-xs text-muted">
              Every document raised in the period — as a list of documents with their totals, or
              line by line with cost and margin.
            </span>
          </Tooltip>
          <p className="mt-2 text-xs text-faint">
            Clipped to one line; hover it for the rest.
          </p>
        </div>
        <div className="flex items-center gap-6 pt-6">
          <Tooltip label="Opens above — the default.">
            <span className="text-sm text-ink-2 underline decoration-dotted">side=&quot;top&quot;</span>
          </Tooltip>
          <Tooltip label="Opens below, for anything near the top of the screen." side="bottom">
            <span className="text-sm text-ink-2 underline decoration-dotted">
              side=&quot;bottom&quot;
            </span>
          </Tooltip>
        </div>
        {/* The hub-tile case: an overlay link covers the text, so the tooltip
            has to react to the CARD's hover rather than the text's. */}
        <div className="group relative max-w-sm rounded-card border border-border bg-surface px-4 py-3.5 hover:border-border-strong">
          <a href="#tooltip" className="block outline-none after:absolute after:inset-0">
            <span className="block text-sm font-semibold text-ink">A tile with an overlay link</span>
            <Tooltip
              label="The whole card is clickable, so this text never receives :hover itself — trigger=&quot;card&quot; is what makes the tooltip appear anyway."
              side="bottom"
              align="start"
              trigger="card"
              className="mt-0.5"
            >
              <span className="block truncate text-xs text-muted">
                The whole card is clickable, so this text never receives :hover itself —
                trigger=&quot;card&quot; is what makes the tooltip appear anyway.
              </span>
            </Tooltip>
          </a>
        </div>
      </CardBody>
    </Card>
  )
}

function SettingsHintSection() {
  return (
    <Card>
      <CardHeader
        title="Settings hint"
        description="<SettingsHint href> — “the rule behind this number is set over there”. Quieter than a Callout on purpose: nothing is wrong, so it must not read as a warning. The screen's name comes from nav.ts, never typed at the call site."
      />
      <CardBody className="flex flex-col gap-3">
        <SettingsHint href="/setup/laybys">
          Deposit, duration and the cancellation fee are set in
        </SettingsHint>
        <SettingsHint href="/staff/pay-rules">
          Overtime, Sunday and public-holiday rates come from
        </SettingsHint>
        <SettingsHint href="/online-store/setup">
          Delivery charges and whether the shop is live are set in
        </SettingsHint>
      </CardBody>
    </Card>
  )
}

function StatsSection() {
  return (
    <Card>
      <CardHeader
        title="Stat strip"
        description="<StatStrip> of <StatTile> — a list screen's headline numbers. `tone` colours the VALUE and says the figure is an exception; `iconTone` colours only the medallion, for a subject with a natural colour. Tone only the tile that means “act on me”; three tiles all in the same ink is three tiles nobody looks at. <MiniStat> is the compact figure inside other chrome."
      />
      <CardBody className="flex flex-col gap-4">
        <StatStrip>
          <StatTile
            label="Products"
            value="1,284"
            hint="86 archived"
            icon={<Icons.Package size={20} />}
          />
          <StatTile
            label="Stock value"
            value={rand(482210.4)}
            hint="At cost"
            iconTone="success"
            icon={<Icons.Coins size={20} />}
          />
          <StatTile
            label="Below minimum"
            value="37"
            tone="warning"
            hint="Reorder these"
            icon={<Icons.StatusWarning size={20} />}
          />
          <StatTile
            label="Out of stock"
            value="4"
            tone="danger"
            hint="Losing sales"
            icon={<Icons.StatusFailure size={20} />}
          />
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
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader
          title="Loading skeleton"
          description="<TableSkeleton columns rows tile> — holds a table's real row rhythm while data loads, instead of a spinner that collapses the page. A plain row measures 33px; pass `tile` for lists with a leading thumbnail, which measure 49px."
        />
        <TableSkeleton columns={4} rows={3} />
        <div className="border-t border-border">
          <TableSkeleton columns={4} rows={2} tile />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Page skeletons"
          description="The pieces a route's loading.tsx is built from. Each mirrors a real component's measured height, so the page does not jump when data arrives: the header is 73px (its h-control action, not the title, sets that), and a stat tile is 84px — 102px with a hint."
        />
        <CardBody className="flex flex-col gap-4">
          <div>
            <p className="mb-2 text-xs text-muted">
              &lt;PageHeaderSkeleton titleWidth action back&gt;
            </p>
            {/* Bordered so the header's own bottom rule is visible in isolation. */}
            <div className="overflow-hidden rounded-card border border-border">
              <PageHeaderSkeleton titleWidth="w-40" />
            </div>
          </div>
          <div>
            <p className="mb-2 text-xs text-muted">&lt;StatStripSkeleton tiles columns hint&gt;</p>
            <StatStripSkeleton tiles={3} hint />
          </div>
          <div>
            <p className="mb-2 text-xs text-muted">&lt;ToolbarSkeleton controls actions inCard&gt;</p>
            <div className="overflow-hidden rounded-card border border-border">
              <ToolbarSkeleton />
            </div>
          </div>
          <div>
            <p className="mb-2 text-xs text-muted">&lt;TabsSkeleton tabs&gt;</p>
            <TabsSkeleton tabs={3} />
          </div>
          <div>
            <p className="mb-2 text-xs text-muted">&lt;FormSkeleton fields columns&gt;</p>
            <div className="overflow-hidden rounded-card border border-border">
              <FormSkeleton fields={4} />
            </div>
          </div>
          <div>
            <p className="mb-2 text-xs text-muted">&lt;SettingRowsSkeleton rows&gt;</p>
            <div className="overflow-hidden rounded-card border border-border">
              <SettingRowsSkeleton rows={2} />
            </div>
          </div>
          <p className="text-xs text-muted">
            &lt;PageSkeleton&gt; wraps a header and a PageBody-shaped column around these — it is
            what a generated loading.tsx returns.
          </p>
        </CardBody>
      </Card>
    </div>
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
  const [cols, setCols] = useState('4')
  const [hideTotal, setHideTotal] = useState(false)
  return (
    <Card>
      <CardHeader
        title="Dropdown menu"
        description="<Menu> + <MenuItem> — handles open/close, outside-click, Esc, aria. Pass `iconOnly` with a `triggerLabel` for the kebab at the end of a table row; the chevron drops with the text, since a lone ⋮ already reads as “opens something”. Pass `keepOpen` when the panel holds settings rather than commands, so adjusting one control does not dismiss the rest."
      />
      <CardBody className="flex items-center gap-3">
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

        <Menu
          iconOnly
          size="sm"
          variant="bare"
          align="left"
          triggerLabel="Actions for INV-1042"
          label={<Icons.MoreVertical size={16} />}
        >
          <MenuItem onClick={() => toast.info('Opened.')}>
            <Icons.Eye size={15} />
            View document
          </MenuItem>
          <MenuItem tone="danger" onClick={() => toast.error('Cancelled.')}>
            <Icons.Close size={15} />
            Cancel
          </MenuItem>
        </Menu>

        {/* The settings shape. Nothing in here is a MenuItem, and nothing in here
            closes the panel — including a native <select>, whose option list the
            OS draws outside the DOM and which used to read as a click elsewhere
            on the page. */}
        <Menu
          keepOpen
          align="left"
          variant="secondary"
          label={
            <>
              <Icons.SlidersHorizontal size={16} />
              Customize
            </>
          }
        >
          <div className="flex w-[260px] flex-col gap-4 p-5">
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-semibold text-ink">Columns</span>
              <Select value={cols} onChange={(e) => setCols(e.target.value)} aria-label="Columns">
                {['3', '4', '5', '6', '7'].map((n) => (
                  <option key={n} value={n}>
                    {n} across
                  </option>
                ))}
              </Select>
            </label>
            <Switch
              checked={hideTotal}
              label="Hide total"
              hint="Smaller tiles — no running total."
              onChange={setHideTotal}
            />
          </div>
        </Menu>
      </CardBody>
    </Card>
  )
}

function ColumnPickerSection() {
  const [visible, setVisible] = useState(new Set(['cost', 'markup']))
  const columns = [
    { id: 'item', label: 'Item', locked: true, group: 'Always' },
    { id: 'qty', label: 'Quantity', group: 'Always', locked: true },
    { id: 'cost', label: 'Unit cost', group: 'Cost' },
    { id: 'landed', label: 'Landed cost', group: 'Cost' },
    { id: 'markup', label: 'Markup %', group: 'Pricing' },
    { id: 'gp', label: 'GP %', group: 'Pricing' },
  ]

  return (
    <Card>
      <CardHeader
        title="Column picker"
        description="<ColumnPicker /> — for a table too wide to show at once. Multi-select, so unlike <Menu> it stays open while columns are ticked. Locked columns show ticked and disabled rather than hidden."
      />
      <CardBody className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <ColumnPicker
            columns={columns}
            visible={visible}
            onChange={setVisible}
            onReset={() => setVisible(new Set(['cost', 'markup']))}
            align="left"
          />
          <span className="text-sm text-muted">
            Showing: {['item', 'qty', ...visible].join(', ')}
          </span>
        </div>

        {/* Both heights, side by side with a Menu — the pairing that matters,
            since these two sit next to each other in a report toolbar and a
            mismatch is only visible against something else. */}
        <div className="flex items-center gap-3 border-t border-border pt-4">
          <ColumnPicker
            columns={columns}
            visible={visible}
            onChange={setVisible}
            align="left"
          />
          <ColumnPicker
            columns={columns}
            visible={visible}
            onChange={setVisible}
            align="left"
            size="md"
          />
          <Menu label="Export" variant="ghost">
            <MenuItem>PDF</MenuItem>
          </Menu>
          <span className="text-sm text-muted">
            Default <code>sm</code> (32px) for a list toolbar; <code>md</code> (40px) to sit level
            with full-height controls, as the report toolbar does.
          </span>
        </div>
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
          <Spec name="<SegmentedControl />" note="Pill group for switching views (the GRV All / Orders / GRVs filter). An optional `icon` per option gives each slice a shape — all of them or none, never some." />
          <div className="mt-2 flex flex-wrap gap-3">
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
            <SegmentedControl
              aria-label="Document status"
              value={view}
              onChange={setView}
              options={[
                { value: 'all', label: 'In progress', icon: <Icons.List size={15} /> },
                { value: 'orders', label: 'Finalised', icon: <Icons.StatusSuccess size={15} /> },
                { value: 'grvs', label: 'Cancelled', icon: <Icons.StatusFailure size={15} /> },
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
          <Spec
            name="<LinkSelect />"
            note="A navigating <select> for a filter with too many values to be segments — departments, suppliers, locations. Options carry their own href, so a Server Component can render it."
          />
          <div className="mt-2">
            <LinkSelect
              aria-label="Filter by department"
              icon={<Icons.LayoutGrid size={16} />}
              value=""
              className="w-64"
              options={[
                { value: '', label: 'All departments', href: '/setup/style-guide' },
                { value: '1', label: 'Groceries', href: '/setup/style-guide' },
                { value: '2', label: 'Groceries › Dry goods', href: '/setup/style-guide' },
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

        <div>
          <Spec
            name="<TableToolbar inCard />"
            note="For a toolbar that is a band inside a Card, above a table. Takes the card gutter and a rule; its controls line up with the column headings below. Without inCard the bar is free-standing and unpadded — right for a row sitting in a PageBody above a separate Card."
          />
          <div className="mt-2">
            <Card>
              <TableToolbar
                inCard
                actions={
                  <Button variant="primary">
                    <Icons.Plus size={16} />
                    New
                  </Button>
                }
              >
                <ToolbarSearch value={search} onChange={setSearch} />
              </TableToolbar>
              <DataTable rows={PRODUCTS} columns={PRODUCT_COLUMNS} getRowKey={(p) => p.id} />
            </Card>
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
  const [showOptions, setShowOptions] = useState(false)
  const toast = useToast()

  return (
    <Card>
      <CardHeader
        title="Row selection + bulk actions"
        description="<DataTable selectedKeys onSelectionChange /> with <BulkActionBar /> and <BulkOptionsDialog /> — click a checkbox, then shift-click another to take the range. The bar holds one button; every action lives in the dialog, which stays readable whether a list has three or twenty. Out-of-stock rows are unselectable via isRowSelectable."
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
        {/* One button, not a row of them: the actions live in the dialog, so a
            list with twenty of them looks exactly like a list with three. */}
        <Button variant="ghost" size="sm" onClick={() => setShowOptions(true)}>
          <Icons.SlidersHorizontal size={15} />
          Bulk options
        </Button>
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

      <BulkOptionsDialog
        open={showOptions}
        onClose={() => setShowOptions(false)}
        onPick={(key) => {
          setShowOptions(false)
          toast.info(`Would open the “${key}” form for ${selected.size} rows`)
        }}
        count={selected.size}
        noun="product"
        recent={['department']}
        groups={[
          {
            title: 'Product',
            options: [
              { key: 'department', label: 'Move to department', icon: <Icons.Landmark size={15} /> },
              { key: 'colour', label: 'Change product colour', icon: <Icons.Palette size={15} /> },
              { key: 'tax', label: 'Change selling tax', icon: <Icons.Percent size={15} /> },
            ],
          },
          {
            title: 'Properties',
            options: [
              { key: 'pos', label: 'Change visible on POS', icon: <Icons.Eye size={15} /> },
              { key: 'scale', label: 'Change scale item', icon: <Icons.Scale size={15} /> },
              { key: 'discount', label: 'Change max discount', icon: <Icons.Percent size={15} /> },
            ],
          },
          {
            title: 'Lifecycle',
            options: [
              { key: 'archive', label: 'Archive product', icon: <Icons.Archive size={15} /> },
              {
                key: 'delete',
                label: 'Delete products',
                icon: <Icons.Trash size={15} />,
                tone: 'danger',
              },
            ],
          },
        ]}
      />
    </Card>
  )
}

function ModalSection() {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [filling, setFilling] = useState(false)
  const [board, setBoard] = useState(false)
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
      <Row>
        <Spec
          name="<Modal bodyFills>"
          note="Body is a LAYOUT, not a document — side-by-side panes that each scroll on their own (the till's split screen). The default body grows to fit and scrolls as one, which on two panes means dragging one out of view to read the other."
        />
        <Button variant="secondary" onClick={() => setFilling(true)}>
          Open filling modal
        </Button>
      </Row>
      <Row>
        <Spec
          name={'<Modal size="full">'}
          note="A dialog that is a WORKSPACE rather than a question — the till's cash-up, where a denomination grid, a numpad and a dozen totals must all be readable at once. Capped at 1600px so the columns do not stretch into unreadable bands on a widescreen. Reach for it rarely: most dialogs ask one thing."
        />
        <Button variant="secondary" onClick={() => setBoard(true)}>
          Open full-width modal
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

      <Modal
        open={board}
        onClose={() => setBoard(false)}
        title="A board, not a form"
        description="Three columns of panels read across at once — what size=&quot;full&quot; is for."
        size="full"
        footer={
          <Button variant="secondary" onClick={() => setBoard(false)}>
            Close
          </Button>
        }
      >
        <div className="grid gap-4 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)_minmax(0,1fr)]">
          {['The count', 'What was taken', 'What it comes to'].map((title, col) => (
            <div key={title} className="flex flex-col gap-4">
              {Array.from({ length: col === 0 ? 1 : 2 }, (_, i) => (
                <section key={i} className="rounded-card border border-border bg-surface p-4">
                  <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
                    <span className="numeric flex h-5 w-5 shrink-0 items-center justify-center rounded-pill bg-brand-soft text-xs font-bold text-brand">
                      {col + i + 1}
                    </span>
                    {i === 0 ? title : 'Totals'}
                  </h3>
                  <p className="text-sm text-muted">
                    A numbered panel. The number is the shared vocabulary when a cash-up is
                    read out loud over the phone.
                  </p>
                </section>
              ))}
            </div>
          ))}
        </div>
      </Modal>

      <Modal
        open={filling}
        onClose={() => setFilling(false)}
        title="Two panes, each scrolling itself"
        description="What bodyFills is for — the till's split screen is this shape."
        size="xl"
        bodyFills
        footer={
          <Button variant="secondary" onClick={() => setFilling(false)}>
            Close
          </Button>
        }
      >
        <div className="flex min-h-0 flex-1 gap-3">
          {['Left pane', 'Right pane'].map((side) => (
            <div
              key={side}
              className="flex min-h-0 flex-1 flex-col rounded-card border border-border bg-surface-2"
            >
              <p className="shrink-0 border-b border-border px-4 py-3 text-sm font-semibold text-ink">
                {side}
              </p>
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
                {Array.from({ length: 20 }, (_, i) => (
                  <div
                    key={i}
                    className="rounded-card border border-border bg-surface p-3 text-sm text-ink-2"
                  >
                    Row {i + 1}
                  </div>
                ))}
              </div>
            </div>
          ))}
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
  const [rejects, setRejects] = useState(0)

  return (
    <Card>
      <CardHeader
        title="PinPad"
        description="<PinPad /> — till sign-in, unlock and the staff clock. Touch targets sized for a counter screen; the physical keyboard works too. The entry box masks what is typed, because the customer is on the other side of the screen"
      />
      <div className="flex flex-wrap items-start gap-6 px-5 py-5">
        <Spec name="<PinPad>" note="4 digits submit automatically; 5–6 need OK" />
        <Spec name="submitLabel" note="one grid cell — keep it as short as OK" />
        <Spec name="wide" note="the sign-in lock screen — 510px, taller keys" />
        <Spec name="rejectedAt" note="bump per refusal to shake; a count, not a flag" />
        <PinPad
          onSubmit={(pin) => {
            // 1234 fails here purely to show the error and shake states.
            if (pin === '1234') {
              setError('That PIN was not recognised.')
              setRejects((n) => n + 1)
              setEntered(null)
            } else {
              setError(null)
              setEntered(pin)
            }
          }}
          error={error}
          rejectedAt={rejects}
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

function LaneWeekSection() {
  const days = ['Mon 3', 'Tue 4', 'Wed 5', 'Thu 6', 'Fri 7'].map((label, i) => ({
    date: `2026-08-0${3 + i}`,
    label,
    isToday: i === 2,
  }))
  const block = (text: string) => (
    <div className="rounded-control border border-border bg-surface-2 px-1.5 py-1 text-xs text-ink">
      {text}
    </div>
  )
  return (
    <Card>
      <CardHeader
        title="LaneWeek"
        description="<LaneWeek /> — a week across, one row per person, blocks where the work is. Knows nothing about jobs: it takes lanes, days and blocks"
      />
      <div className="space-y-3 px-5 py-5">
        <Spec name="<LaneWeek>" note="read-only; scrolls horizontally rather than crushing days" />
        <LaneWeek
          lanes={[
            { id: 'p', label: 'Piet', hint: '3 visits' },
            { id: 'n', label: 'Naledi', hint: '1 visit' },
            { id: 'x', label: 'Nobody assigned', hint: '1 visit' },
          ]}
          days={days}
          blocks={[
            { id: 1, laneId: 'p', date: '2026-08-03', order: 480, content: block('08:00 Harbour Cafe') },
            { id: 2, laneId: 'p', date: '2026-08-03', order: 660, content: block('11:00 Mr Botha') },
            { id: 3, laneId: 'p', date: '2026-08-06', order: 540, content: block('09:00 Depot') },
            { id: 4, laneId: 'n', date: '2026-08-04', order: 600, content: block('10:00 Harbour Cafe') },
            { id: 5, laneId: 'x', date: '2026-08-05', order: 840, content: block('14:00 unassigned') },
          ]}
        />
        <p className="text-xs text-muted">
          Wednesday is marked as today. The unassigned lane is pinned last by the caller — a
          visit nobody is going to is what a dispatcher opens the week to find.
        </p>
      </div>
    </Card>
  )
}

function SignaturePadSection() {
  const [captured, setCaptured] = useState<{ url: string; bytes: number } | null>(null)

  return (
    <Card>
      <CardHeader
        title="SignaturePad"
        description="<SignaturePad /> — a customer signs with a finger and it comes back as a PNG. Used for sign-off checks on a job card"
      />
      <div className="space-y-4 px-5 py-5">
        <Spec name="<SignaturePad>" note="pointer events, so finger, stylus and mouse all draw" />
        <div className="max-w-xl">
          <SignaturePad
            statement="I confirm the work described on this job card has been completed to my satisfaction."
            onCapture={(png) => {
              // Shown back as a data URL purely so the guide can prove what was
              // produced. The real caller uploads the blob.
              const reader = new FileReader()
              reader.onload = () =>
                setCaptured({ url: String(reader.result), bytes: png.size })
              reader.readAsDataURL(png)
            }}
          />
        </div>
        {captured ? (
          <div className="space-y-1.5">
            <p className="text-xs text-muted">
              Captured {(captured.bytes / 1024).toFixed(1)} KB of PNG. Note the white
              ground — the pad draws in the theme ink colour, so a signature taken in
              dark mode would otherwise be invisible on a printed job sheet.
            </p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={captured.url}
              alt="Captured signature"
              className="max-w-xs rounded-card border border-border"
            />
          </div>
        ) : (
          <p className="text-xs text-muted">Sign above, then press Accept.</p>
        )}
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

/**
 * The till's three surfaces, side by side.
 *
 * Shown together rather than in three places because their whole design argument is
 * that they are ONE set: same disc, same radius, same border, same press. Split across
 * the page they would drift, which is exactly what happened on the POS this replaces.
 */
/** One key's drawn artwork, at the size the till draws it. */
function KeyArt({ slug }: { slug: string }) {
  const art = quickKeyArt({ actionSlug: slug })
  if (!art) return null
  return <img src={quickKeyArtSrc(art.file)} alt="" className="h-7 w-7" />
}

/**
 * The basket line, in each state a waiter has to tell apart.
 *
 * The REAL `SaleLineCard`, not a mock-up of one: the till is behind a clerk PIN,
 * so without this there is nowhere the line card can be looked at, and a
 * restyle of it could only be verified by someone standing at a till. Rendering
 * the real component is also the only way this page cannot drift from it.
 */
function SaleLineSection() {
  const [open, setOpen] = useState<string | null>('new')
  const [showingOptions, setShowingOptions] = useState(false)

  const line = (over: Partial<BasketLine>): BasketLine =>
    ({
      key: 'x',
      productId: 1,
      productCode: 'CAL',
      description: 'Calamari Strips',
      productType: 'normal',
      departmentId: 1,
      qty: 1,
      unitPriceIncl: 125,
      discountPct: 0,
      vatRatePct: 15,
      unitCostExcl: 60,
      maxDiscountPct: 10,
      shelfPriceIncl: 125,
      allowFractions: false,
      instructions: [],
      note: '',
      ...over,
    }) as BasketLine

  const modifier = (name: string) =>
    ({
      groupId: 1,
      groupName: 'Extras',
      optionId: 1,
      optionName: name,
      qty: 1,
      priceAdjustIncl: 0,
      productId: null,
      stockQtyPer: 0,
      printsOnKitchen: true,
      printsOnReceipt: true,
    }) as BasketLine['instructions'][number]

  const demo = [
    {
      state: 'unmodified' as const,
      note: 'On the tab when it was reopened, untouched since. Already with the kitchen.',
      line: line({
        key: 'unmodified',
        kitchenSentQty: 1,
        instructions: [modifier('Compound Butter')],
      }),
      total: 125,
      age: 12,
    },
    {
      state: 'modified' as const,
      note: 'Was on the tab, and something has changed this sitting — here the quantity.',
      line: line({
        key: 'modified',
        qty: 2,
        kitchenSentQty: 1,
        instructions: [modifier('Mushroom Sauce')],
      }),
      total: 250,
      age: 12,
    },
    {
      state: 'new' as const,
      note: 'Rung after the tab was reopened. Shown open, which is how a selected line looks.',
      /* shelfPriceIncl moves with the price, or the card would correctly flag
         this as an override and wear a "Price changed" badge the demo does not
         mean to show. */
      line: line({
        key: 'new',
        description: 'Dry Wors 200g',
        unitPriceIncl: 65,
        shelfPriceIncl: 65,
      }),
      total: 65,
      age: 0,
    },
  ]

  return (
    <Card>
      <CardHeader
        title="Sale line"
        description="<SaleLineCard /> — one line of the till basket. Each card answers four questions in order: what and how much, at which price, with what on it, and where it stands. The state chip and the age are what let a waiter reopening a table tell the lines the kitchen already has from the ones just added; only modified and new carry colour, so the two that need a second look are the two that get one."
      />
      {demo.map((d) => (
        <Row key={d.state}>
          <Spec name={`sessionState="${d.state}"`} note={d.note} />
          {/* The width the real basket gives it, so the wrapping is honest. */}
          <ul className="w-[500px] rounded-card bg-canvas py-1">
            <SaleLineCard
              line={d.line}
              lineTotal={d.total}
              effectiveDiscountPct={0}
              specialName={null}
              priceStructureName="Retail Price"
              sessionState={d.state}
              ageMinutes={d.age}
              selected={open === d.line.key}
              onSelect={() => setOpen(open === d.line.key ? null : d.line.key)}
              onStep={() => {}}
              onEdit={() => {}}
              onRemove={() => {}}
              onMore={() => setShowingOptions(true)}
            />
          </ul>
        </Row>
      ))}

      <Row>
        <Spec
          name="<LineOptionsModal />"
          note="What More opens — the rare per-line verbs, one tap deeper than + − Void. Sized so all seven fit a 1024×768 till without scrolling."
        />
        <div>
          <Button variant="secondary" onClick={() => setShowingOptions(true)}>
            Open the line options
          </Button>
          <LineOptionsModal
            line={showingOptions ? demo[0].line : null}
            onClose={() => setShowingOptions(false)}
            onChoose={() => setShowingOptions(false)}
          />
        </div>
      </Row>
    </Card>
  )
}

/**
 * The questions a product asks, as the till puts them.
 *
 * The real modal, imported rather than mocked, for the same reason the sale line
 * card is: it lives behind a clerk PIN, so this is the only place it can be
 * looked at without opening a till.
 */
function InstructionsSection() {
  const [asking, setAsking] = useState(false)

  const option = (
    id: number,
    name: string,
    extra: Partial<TillInstructionGroup['options'][number]> = {},
  ) => ({
    id,
    name,
    priceAdjust: 0,
    productId: null,
    quantity: 0,
    isDefault: false,
    /* 0 = no ceiling, which is what makes a tile countable — tapping it again
       adds another rather than toggling it off. */
    maxQty: 0,
    minQty: 0,
    defaultQty: 0,
    imageId: null,
    printsOnKitchen: true,
    printsOnReceipt: true,
    revealsGroupIds: [],
    ...extra,
  })

  const groups: TillInstructionGroup[] = [
    {
      id: 1,
      name: 'Sauces',
      prompt: 'What sauces would you like with your meal?',
      isRequired: false,
      minChoices: 0,
      maxChoices: 0,
      imageId: null,
      options: [
        option(1, 'Mushroom Sauce'),
        option(2, 'Compound Butter'),
        option(3, 'Garlic-Herb Butter'),
        option(4, 'Red Wine Sauce'),
        option(5, 'Milk Gravy'),
        option(6, 'Summer Sauce'),
        option(7, 'Pepper Steak'),
        option(8, 'Romesco Sauce'),
        option(9, 'Brisket with Carrots'),
      ],
    },
    {
      id: 2,
      name: 'Side-dish',
      prompt: 'What Side-dish would you like with your meal?',
      isRequired: false,
      minChoices: 0,
      maxChoices: 0,
      imageId: null,
      options: [
        option(10, 'Mashed potatoes', { priceAdjust: 55 }),
        option(11, 'Glazed carrots'),
        option(12, 'Asparagus'),
        option(13, 'Corn on the cob'),
        option(14, 'Onion rings'),
        option(15, 'Scalloped potatoes'),
      ],
    },
  ]

  const product = {
    id: 1,
    code: 'SB-103',
    description: 'Calamari Strips',
    priceIncl: 189,
  } as unknown as TillProduct

  return (
    <Card>
      <CardHeader
        title="Instructions"
        description="<InstructionsModal /> — the questions a product asks, answered before the line reaches the basket. Tapping an answer adds one MORE of it rather than toggling, so “mushroom sauce ×3” is three taps on the thing you are naming; the split minus at its right takes one back off. Every question is on one screen and the rail at the top only scrolls to them — paging would hide the order the cashier is building."
      />
      <Row>
        <Spec
          name="<InstructionsModal product groups byId>"
          note="Blocks the add until the questions are answered. The running total builds as answers are chosen, using the same adjustPerUnit the server posts with."
        />
        <div>
          <Button variant="secondary" onClick={() => setAsking(true)}>
            Ask the questions
          </Button>
          {asking && (
            <InstructionsModal
              product={product}
              qty={1}
              groups={[1, 2]}
              byId={new Map(groups.map((g) => [g.id, g]))}
              basePriceIncl={189}
              onCancel={() => setAsking(false)}
              onConfirm={() => setAsking(false)}
            />
          )}
        </div>
      </Row>
    </Card>
  )
}

/**
 * The last thing a cashier sees before the next customer.
 *
 * Real modal, same reason as the two above: it is behind a clerk PIN AND behind
 * a completed sale, so short of tendering real money at a till there is nowhere
 * else to look at it. Both button counts are here because the footer is the part
 * that breaks — five touch keys is the widest this row ever gets.
 */
function ReceiptSection() {
  const [showing, setShowing] = useState<'full' | 'offline' | 'big' | null>(null)

  return (
    <Card>
      <CardHeader
        title="Sale complete"
        description="<ReceiptModal /> — change first and biggest, because it is the only thing on screen with a job to do while the customer waits. The invoice number reads as filing rather than as a figure. Void is in the body, deliberately far from the key tapped a hundred times a day."
      />
      <Row>
        <Spec
          name="<ReceiptModal />"
          note="Posted, with change and void rights — the widest the footer gets: five touch keys, which is why the panel is md and the footer wraps."
        />
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setShowing('full')}>
            Open the receipt
          </Button>
          <Button variant="ghost" onClick={() => setShowing('offline')}>
            Rung up offline
          </Button>
          {/* The figure that decides the type size — a big note broken on a
              small purchase is the widest CHANGE ever gets. */}
          <Button variant="ghost" onClick={() => setShowing('big')}>
            Biggest change
          </Button>
        </div>
      </Row>

      <ReceiptModal
        open={showing !== null}
        documentNumber="INV_01_01_000001"
        change={showing === 'big' ? 1987.65 : 15}
        posted={showing !== 'offline'}
        canVoid={showing !== 'offline'}
        canPrint
        onClose={() => setShowing(null)}
        onPrint={() => {}}
        onOpen={() => {}}
        onGiftReceipt={() => {}}
        onEmail={() => {}}
        onVoid={() => setShowing(null)}
      />
    </Card>
  )
}

function SplitBillSection() {
  return (
    <Card>
      <CardHeader
        title="Split the bill"
        description="<SplitBillModal /> — the two bills side by side, and a line crossing between them. Both halves are on screen at once because the question a waiter is answering is “do each of these two bills now look right”, and that cannot be checked on a screen showing one of them. A line moves by drag OR by its Move button: on a till a drag needs a hold to start, so the button is the one-tap path and the drag is the fast one."
      />
      <Row>
        <Spec
          name="<SplitBillModal fromTable lines tables loadDestinationLines>"
          note="Destination first — a line cannot be dropped on a bill that has not been named. Picking an OCCUPIED table shows what it already holds, greyed and immovable, and the split appends to it. Nothing is written until Confirm."
        />
        <SplitPreview />
      </Row>
    </Card>
  )
}

function TableGateSection() {
  return (
    <Card>
      <CardHeader
        title="The table gate"
        description="<TableGate /> — every bill open in the shop, standing in front of the till. Split and Move are MODES rather than buttons on each tile: a quick key arms one, and the next tap on a bill runs it. The gate itself carries no button for either, so a shop that does not serve tables pays nothing for them; where the mode is armed, the amber banner says what the next tap will do and is also the way out."
      />
      <Row>
        <Spec
          name="<TableGate tabs tables splitting transferring onEmptyArm>"
          note="Works on BOTH the floor and list views — a shop that never drew a plan still has tables. Each tile decides for itself: a bill on a configured table is armable and rings amber, a free-text tab goes inert and says why. Armed with nothing to act on, the mode drops and onEmptyArm explains rather than leaving a dead banner up."
        />
      </Row>
      <GatePreview />
      <Row>
        <Spec
          name="<TableGate rooms features> — the floor view"
          note="The same component with a plan drawn. Tables are rendered by <TableGlyph />, the component the floor-plan designer draws with, so what a manager arranges is literally what a waiter sees — the alternative is two copies of the drawing that silently disagree. State is a TEXT colour the glyph inherits through currentColor, which is why a table's top, outline, chairs and code can never end up in different colours."
        />
      </Row>
      <FloorPreview />
    </Card>
  )
}

function TenderTileSection() {
  return (
    <Card>
      <CardHeader
        title="Tender tiles"
        description="<TenderTile /> — one payment-method key on the till's tender pad. A glyph above a name, because a cashier meeting the same six keys forty times a day aims at the shape. Every key wears the same brand circle: colour on that screen means how the sale is doing, not which method this is. A tender that cannot be taken keeps its place and says why — a key that vanishes leaves the cashier wondering whether the store has the facility at all"
      />
      <div className="flex flex-wrap items-start gap-6 px-5 py-5">
        <Spec name="<TenderTile name icon>" note="icon from tenderIcon(tender)" />
        <Spec name="refusal" note="a sentence, not a flag — it disables and explains" />
        <Spec name="tenderIcon(t)" note="icon → code → integrationKey, then Wallet" />
        <div className="grid w-full max-w-2xl auto-rows-fr grid-cols-2 gap-3 sm:grid-cols-3">
          <TenderTile name="Cash" icon={Icons.Banknote} onClick={() => {}} />
          <TenderTile name="Card" icon={Icons.CreditCard} onClick={() => {}} />
          <TenderTile
            name="Account"
            icon={Icons.Users}
            refusal="Needs a customer"
            onClick={() => {}}
          />
          <TenderTile name="Direct deposit" icon={Icons.Landmark} onClick={() => {}} />
          <TenderTile name="Online payment" icon={Icons.Globe} onClick={() => {}} />
          <TenderTile name="Exchange credit" icon={Icons.ArrowLeftRight} onClick={() => {}} />
        </div>
        {/* The whole pad the keys live in, so the amount panel and the footer
            can be looked at too — the POS itself is behind a clerk PIN. */}
        <TenderPreview />
      </div>
    </Card>
  )
}

function ModuleMenuSection() {
  return (
    <Card>
      <CardHeader
        title="The module menu"
        description="<ModuleMenu /> — the till's way between the kinds of document it writes. Most rows are a CARD with two buttons rather than one destination, because “quotes” is two opposite jobs: write a new one for the person standing there, or find the one written last week. A single row had to pick, and picking “write” meant looking one up cost you the basket."
      />
      <Row>
        <Spec
          name="<ModuleMenu current available onPick onOpenList>"
          note="onPick starts a NEW document — it clears the basket, so the shell asks first when there are lines. onOpenList lays the list over the top and touches nothing. Two callbacks rather than one with a flag: they differ in what they do to the screen behind, which is the only thing the cashier is deciding."
        />
        <Spec
          name="lay-bys keep one row"
          note="A lay-by is not something the basket BECOMES — it is opened from one already rung up, by taking a deposit. A “new lay-by” button here could only ever refuse, so that row stays the single tap it was."
        />
      </Row>
      <ModuleMenuPreview />
    </Card>
  )
}

function TillTileSection() {
  return (
    <Card>
      <CardHeader
        title="Till tiles"
        description="<ProductTile /> names a THING and shows what it costs; <ActionTile /> names an ACT and shows what it will do. Both put colour in a 44px squircle badge and leave the caption ink-on-surface — a grid of fully-saturated tiles has no hierarchy left and its white captions are the worst contrast on the screen. On an action tile the badge and caption share the top line and the hint runs full width beneath them."
      />
      <Row>
        <Spec name="<ActionTile tone icon hint>" note="A till quick key — runs something" />
        <div className="w-full max-w-xl">
          <TileGrid tileWidth={190} tileHeight={150}>
            {/* The real till art, resolved the way the till resolves it — a demo drawn
                with stand-in glyphs would not show that the pictures and their discs
                agree, which is the part worth checking. */}
            {/* `edge` carries the colour the SHOP chose for the key — here shown as
                the tile-* tokens a manager picks in the designer. A key with none
                stored simply has no edge, as "Void sale" shows. */}
            <ActionTile
              title="Cash up"
              hint="Counts the drawer and closes the shift."
              icon={<KeyArt slug="cashup" />}
              tone={quickKeyArt({ actionSlug: 'cashup' })?.tone}
              edge={toneForTileToken('tile-2') ?? undefined}
              onClick={() => {}}
            />
            <ActionTile
              title="Supervisor"
              hint="6 keys"
              icon={<KeyArt slug="supervisor" />}
              tone={quickKeyArt({ actionSlug: 'supervisor' })?.tone}
              edge={toneForTileToken('tile-1') ?? undefined}
              chevron
              corner={<Icons.KeyRound size={13} />}
              onClick={() => {}}
            />
            <ActionTile
              title="Void sale"
              hint="No colour stored — so no edge."
              icon={<KeyArt slug="void-sale" />}
              tone={quickKeyArt({ actionSlug: 'void-sale' })?.tone}
              onClick={() => {}}
            />
          </TileGrid>
        </div>
      </Row>
      <Row>
        <Spec name="<ProductTile tone price>" note="A product or a department" />
        <div className="w-full max-w-xl">
          <TileGrid tileWidth={190} tileHeight={150}>
            <ProductTile
              title="Country Fresh Chocolate 2L"
              subtitle="12 on hand"
              price="R 55.00"
              icon={<Icons.Package size={20} />}
              tone={toneForId(3)}
              edge={toneForId(3)}
              onClick={() => {}}
            />
            <ProductTile
              title="Frozen Foods"
              icon={<Icons.Tag size={20} />}
              tone={toneForId(5)}
              edge={toneForId(5)}
              chevron
              onClick={() => {}}
            />
          </TileGrid>
        </div>
      </Row>
      <Row>
        <Spec name="<ProductTile dashed>" note="The way OUT of a grid, not a thing in it" />
        <div className="w-full max-w-xl">
          <TileGrid tileWidth={190} tileHeight={150}>
            <ProductTile
              title="Back"
              subtitle="Butchery"
              icon={<Icons.Reverse size={20} />}
              dashed
              onClick={() => {}}
            />
          </TileGrid>
        </div>
      </Row>
      <Row>
        <Spec name="<TouchRow edge>" note="The department rail — colour down the edge" />
        <div className="flex w-full max-w-sm flex-col gap-2">
          {['Beer', 'Kitchen', 'Frozen Foods'].map((name, i) => (
            <TouchRow
              key={name}
              edge={toneForId(i + 2)}
              icon={<CategoryTile icon={<Icons.Tag size={18} />} tone={toneForId(i + 2)} size="lg" />}
              title={name}
              showChevron={false}
              onClick={() => {}}
            />
          ))}
        </div>
      </Row>
      <Row>
        <Spec
          name="<TouchRow tone='bare'>"
          note="Drops the border and the fill and keeps everything else — the geometry, the type scale, the whole-row hit target. For a row INSIDE a box somebody else drew, where a bordered row in a bordered card is a double frame: the till's module menu puts one at the head of each module card. The card carries the hairline and the shadow; the row inside it carries nothing."
        />
        <div className="flex w-full max-w-sm flex-col gap-3">
          <div className="rounded-card border border-border bg-surface p-2 shadow-card">
            <TouchRow
              icon={<CategoryTile icon={<Icons.ShoppingCart size={20} />} tone="emerald" size="lg" />}
              title="Point of sale"
              subtitle="tone='bare' — the card is the only box"
              tone="bare"
              onClick={() => {}}
            />
          </div>
          <div className="rounded-card border border-border bg-surface p-2 shadow-card">
            <TouchRow
              icon={<CategoryTile icon={<Icons.FileText size={20} />} tone="indigo" size="lg" />}
              title="Quotes"
              subtitle="Colour stays on the tile, not the frame"
              tone="bare"
              onClick={() => {}}
            />
          </div>
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
            <div key={color} className="w-40">
              <Sparkline values={series} color={color} />
            </div>
          ))}
        </div>
      </Row>
      <Row>
        <Spec
          name="<MeterBar />"
          note="A proportion drawn as one bar — an ageing balance across its buckets, or progress toward a total. Pass `total` to leave the shortfall as track. Tones mean what they mean everywhere else, so a mostly-danger bar reads as a problem without a figure being read."
        />
        <div className="flex flex-1 flex-col gap-4">
          <MeterBar
            segments={[
              { label: 'Current', value: 62, tone: 'success' },
              { label: '30 days', value: 21, tone: 'neutral' },
              { label: '60 days', value: 11, tone: 'warning' },
              { label: '90 days +', value: 6, tone: 'danger' },
            ]}
            showLegend
          />
          {/* `total` larger than the segments leaves the remainder as track,
              which is how progress differs from a share-of-whole. */}
          <MeterBar
            segments={[{ label: 'Reconciled', value: 34, tone: 'brand' }]}
            total={50}
            height={10}
          />
        </div>
      </Row>
      <Row>
        <Spec
          name="<TableGlyph />"
          note="A restaurant table, drawn — the top and its chairs, as one SVG. Used by BOTH the floor-plan designer and the till's floor view, which is the point: the designer promises “this is what the till shows”, and two copies of the drawing is how that promise quietly stops being true. It fills and strokes with `currentColor`, so the caller sets one text colour (its state token) and the top, outline, chairs and code all follow. Seats come in per edge from `seatLayout`, so a six-top dragged long and narrow moves its chairs to the long edges."
        />
        <div className="flex flex-1 flex-wrap items-end gap-6">
          {[
            { shape: 'round' as const, seats: 2, w: 70, h: 70, label: '2, round' },
            { shape: 'rect' as const, seats: 4, w: 104, h: 70, label: '4, rect' },
            { shape: 'oval' as const, seats: 6, w: 132, h: 70, label: '6, oval' },
            { shape: 'counter' as const, seats: 4, w: 150, h: 52, label: '4, counter' },
          ].map((t) => (
            <div key={t.label} className="flex flex-col items-center gap-1.5">
              <div className="relative text-ink" style={{ width: t.w, height: t.h }}>
                <TableGlyph
                  shape={t.shape}
                  seats={seatLayout(t.seats, t.w, t.h)}
                  footprint={{ width: t.w, height: t.h }}
                  className="absolute inset-0 h-full w-full"
                />
              </div>
              <span className="text-xs text-muted">{t.label}</span>
            </div>
          ))}
          {/* The same glyph in the till's three states — one text colour each. */}
          <div className="flex flex-col items-center gap-1.5">
            <div className="relative text-warning-ink" style={{ width: 104, height: 70 }}>
              <TableGlyph
                shape="rect"
                seats={seatLayout(4, 104, 70)}
                footprint={{ width: 104, height: 70 }}
                className="absolute inset-0 h-full w-full"
              />
            </div>
            <span className="text-xs text-muted">bill asked</span>
          </div>
        </div>
      </Row>
      <Row>
        <Spec
          name="<FeatureGlyph />"
          note="The fixed furniture of a room, drawn — the companion to <TableGlyph /> and shared by the designer and the till for the same reason. A wall is hatched so it cannot be mistaken for a long table, a door is drawn as its swing (which way it opens is the whole information), a bar carries a service edge, a pass is a hatched shelf, a plant is a pot with foliage. `kind: 'text'` renders nothing — a label is its own drawing. Colour arrives through `currentColor`, so the caller sets one text tone and fill, outline and label follow together."
        />
        <div className="flex flex-1 flex-wrap items-end gap-6">
          {[
            { kind: 'wall' as const, w: 96, h: 26, tone: 'text-ink-2' },
            { kind: 'bar' as const, w: 84, h: 46, tone: 'text-warning-ink' },
            { kind: 'pass' as const, w: 84, h: 46, tone: 'text-success' },
            { kind: 'door' as const, w: 52, h: 52, tone: 'text-border-strong' },
            { kind: 'plant' as const, w: 44, h: 50, tone: 'text-success' },
          ].map((f) => (
            <div key={f.kind} className="flex flex-col items-center gap-1.5">
              <div className={`relative ${f.tone}`} style={{ width: f.w, height: f.h }}>
                <FeatureGlyph kind={f.kind} className="absolute inset-0 h-full w-full" />
              </div>
              <span className="text-xs text-muted">{f.kind}</span>
            </div>
          ))}
        </div>
      </Row>
      <Row>
        <Spec
          name="<PromoArt kind />"
          note="The drawing beside a promo panel's copy — the one place a picture is not decoration, because it fills the dead space at the foot of a drawer where an icon would read as a control that has stopped working. Every stroke is `currentColor`, so the caller sets one text tone and the whole thing follows it into dark mode. In the kit rather than inline so the second panel to want one does not draw its own."
        />
        <div className="flex flex-1 items-center gap-3 rounded-card bg-brand-soft/60 p-4">
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-semibold leading-snug text-ink">
              All your sales,
              <br />
              in one place
            </p>
            <p className="mt-1.5 text-[13px] leading-snug text-muted">
              Fast, simple and built for your business.
            </p>
          </div>
          <PromoArt kind="bag" className="h-20 w-20 shrink-0 text-brand" />
        </div>
      </Row>
      <Row>
        <Spec
          name="<StoreColumnTable />"
          note="A row per thing, a column per store, a group total. For cross-store reports. The point of it is the dash: `null` is “this store does not carry this line” and is excluded from the total, while `0` is a real zero that counts. On a rebalancing report those two call for opposite actions, so collapsing them makes the report misleading rather than merely imprecise."
        />
        <div className="flex-1">
          <StoreColumnTable
            columns={[
              { siteId: 1, name: 'Main' },
              { siteId: 2, name: 'Northgate' },
            ]}
            rows={[
              {
                key: 'A-1042',
                label: 'Coffee beans, 1kg',
                values: [128, 96],
              },
              {
                /* Not ranged at Northgate — a dash, and it does not drag the
                   total down the way a zero would. */
                key: 'A-1077',
                label: 'Filter papers, box',
                values: [6, null],
              },
              {
                // Ranged and sold out. A real zero, and it counts.
                key: 'B-2210',
                label: 'Takeaway cups, 500',
                values: [0, 31],
              },
            ]}
            format={(n) => String(n)}
            firstHeading="Product"
            totalHeading="Group"
            emptyNote="A dash means the product is not carried at that store."
          />
        </div>
      </Row>
      <Row>
        <Spec
          name="<ChartGlow />"
          note="The halo under a plotted line. Put it in a chart's <defs> and point the line at it with filter=url(#id). Strength comes from --chart-glow, so light mode gets a whisper and dark a real glow."
        />
        <div className="flex flex-1 items-center gap-6">
          <svg width={180} height={44} className="overflow-visible" aria-hidden>
            <defs>
              <ChartGlow id="styleGuideGlow" strength={colors.glow} />
            </defs>
            <g filter="url(#styleGuideGlow)">
              <path
                d="M6,36 C30,34 40,20 62,22 C84,24 92,32 114,26 C136,20 148,8 174,8"
                fill="none"
                stroke={colors.series[0]}
                strokeWidth={2}
                strokeLinecap="round"
              />
              {[
                [6, 36],
                [62, 22],
                [114, 26],
                [174, 8],
              ].map(([cx, cy]) => (
                <circle key={cx} cx={cx} cy={cy} r={2.5} fill={colors.series[0]} />
              ))}
            </g>
          </svg>
          <code className="font-mono text-xs text-muted">colors.glow</code>
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

function LayoutSection() {
  return (
    <Card>
      <CardHeader
        title="Layout widths"
        description="Shared in src/components/ui/styles.ts. A record's panels must agree on where the page ends."
      />
      <CardBody className="p-0">
        <Row>
          <Spec name="EDIT_COLUMN" note="Max width of an editing screen — 1100px" />
          <div className="min-w-0 flex-1">
            {/* Scaled down so the proportion reads inside a demo card: the point
                is that stacked panels END in the same place, not the pixel value. */}
            <div className="flex flex-col gap-2">
              <div className="h-8 w-[70%] rounded-control border border-border bg-surface-2" />
              <div className="h-8 w-[70%] rounded-control border border-border bg-surface-2" />
              <div className="h-8 w-[70%] rounded-control border border-border bg-surface-2" />
            </div>
            <p className="mt-2 text-xs text-muted">
              A form, a variants panel and a photographs gallery are separate siblings on the
              product screen. Each wears this, so the right edge runs straight instead of stepping
              in and out down the page.
            </p>
          </div>
        </Row>
      </CardBody>
    </Card>
  )
}

function WordmarkSection() {
  return (
    <Card>
      <CardHeader
        title="The wordmark"
        description="The typeface the Odyssey logo is lettered in (Archivo, self-hosted by next/font). ONLY for headings that sit beside the logo — the till header, the login lockup. Body text stays on the system stack: it is what the OS hints best at small sizes, and a till must be readable the instant it opens."
      />
      <CardBody className="grid gap-5">
        <div className="grid gap-2">
          <Spec name=".wordmark" note="Uppercased and tightened to match the artwork" />
          <p className="wordmark text-[32px] text-ink">Odyssey POS</p>
        </div>
        <div className="grid gap-2">
          <Spec name=".wordmark-sub" note="The 'POINT OF SALE' subline — lighter, tracked wide" />
          <p className="wordmark-sub text-[15px] text-muted">Point of sale</p>
        </div>
        <div className="grid gap-2">
          <Spec name=".logo-plate" note="On <Image> for logo-full.png — a light plate in dark mode, since the wordmark artwork is dark navy and vanishes on a dark canvas" />
          <div className="rounded-card bg-canvas p-4">
            <Image
              src="/logo-full.png"
              alt="Odyssey Point of Sale"
              width={1109}
              height={304}
              className="logo-plate h-12 w-auto object-contain"
              unoptimized
            />
          </div>
        </div>
      </CardBody>
    </Card>
  )
}

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

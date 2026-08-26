/**
 * The OdysseyAI UI kit — import every shared building block from here:
 *
 *   import { Card, DataTable, Button } from '@/components/ui'
 *
 * See the live, named reference at /setup/style-guide. If a screen needs
 * something this kit doesn't have, add it here rather than styling it inline —
 * that is what keeps one change propagating to every screen.
 *
 * Tokens (colour, radius, shadow, control height) live in src/app/globals.css.
 * Shared class strings live in ./styles.ts.
 */

export { Button, ButtonLink, type ButtonSize, type ButtonVariant } from './Button'
export { TintButton } from './TintButton'
export { PromoArt, type PromoArtKind } from './PromoArt'
export {
  PosSignInArt,
  type PosSignInSpecial,
  type PosSignInPriceRow,
  type PosSignInOfferRow,
} from './PosSignInArt'
export { WeekHours, WeekHoursDay, WEEK_DAYS, type HoursRange } from './WeekHours'
export {
  buttonClass,
  buttonShape,
  CONTROL,
  FIELD_LABEL,
  CONTROL_H,
  CONTROL_H_TOUCH,
  CONTROL_INVALID,
  EDIT_COLUMN,
  MODAL_PANEL,
  MODAL_SIZE,
  type ModalSize,
  DRAWER_PANEL,
  DRAWER_SIZE,
  type DrawerSize,
  /* The coloured leading edge the department rail and the product tiles wear.
     Exported so the quick-key designer can dress its canvas as the till it is a
     preview of — a tile that looks different in the designer to the way it will
     look on the counter is the one thing that screen must not do. */
  EDGE_LEAD,
  EDGE_RING,
} from './styles'
export {
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_FRAME,
  TABLE_HEAD_STICKY,
  TABLE_HEAD_STICKY_INSET,
  TABLE_NUMERIC,
  TABLE_ROW,
  TABLE_SCROLLER,
  TABLE_TD,
  TABLE_TD_INPUT,
  TABLE_TH,
  TABLE_TH_CAPTION,
  TABLE_TOTAL_ROW,
} from './styles'
export { TableScroller } from './TableScroller'
export { useFitViewport } from './useFitViewport'

export {
  Field,
  InlineField,
  Input,
  NumberInput,
  CurrencyInput,
  Textarea,
  CodeArea,
  Select,
  Switch,
  Checkbox,
  Radio,
  ColourInput,
  type ControlSize,
} from './Field'
export { FileInput } from './FileInput'
export { Slider } from './Slider'
export { Stepper } from './Stepper'

export { Card, CardHeader, CardBody, CardFooter } from './Card'
export { DeepPanel, QuoteCard } from './DeepPanel'
export { SettingRow, SettingGroup } from './SettingRow'
export { SelectableCard } from './SelectableCard'
export { SectionTitle, SectionBody } from './SectionTitle'
export {
  TILE_SWATCHES,
  TILE_GRADIENTS,
  PICTURE_TILE_GRADIENTS,
  TILE_NONE,
  tileClass,
  tileInkClass,
  toneForTileToken,
  type TileSwatch,
} from './tiles'
export { SwatchPicker } from './SwatchPicker'
export {
  GeneratedPictureGallery,
  GeneratedPictureModal,
} from './GeneratedPicturePicker'
export { Badge, type BadgeTone } from './Badge'
export { Callout, type CalloutTone } from './Callout'
export { Tooltip } from './Tooltip'
export { SettingsHint } from './SettingsHint'
export {
  CategoryTile,
  CATEGORY_TONES,
  toneForId,
  type CategoryTone,
} from './CategoryTile'
export { ChoiceTile } from './ChoiceTile'
export { ReasonPicker, type PickableReason } from './ReasonPicker'
export { EmptyState } from './EmptyState'
export { FavoriteToggle } from './FavoriteToggle'
export { PageHeader, PageBody, PrimaryLink } from './PageHeader'
export { StatTile, StatStrip, MiniStat, SearchBar } from './Stats'
export { SummaryList, SummaryRow, SummaryTotal } from './Summary'
export { RowTile } from './RowTile'
export { PickerResults, type PickerResult } from './PickerResults'
/* The loaders. A <Skeleton> is still the first choice for a first load whose
   shape is known — these are for the waits it cannot cover. */
export { Orbit, Sweep, LoadingBar, LoadingDots, LoadingVeil } from './Loader'
export {
  Skeleton,
  TableSkeleton,
  PageSkeleton,
  PageHeaderSkeleton,
  StatStripSkeleton,
  ToolbarSkeleton,
  TabsSkeleton,
  FormSkeleton,
  SettingRowsSkeleton,
} from './Skeleton'
export { TextLink, TextLinkButton } from './TextLink'
export { FieldGroup } from './FieldGroup'

export { DataTable, type Column, type SortState, type SortDirection } from './DataTable'
export {
  TableToolbar,
  SegmentedControl,
  LinkSegmentedControl,
  LinkSelect,
  ToolbarSearch,
  type SegmentedOption,
} from './TableToolbar'
export { ColumnPicker, type ColumnOption } from './ColumnPicker'
export { Pagination } from './Pagination'
export { FilterBar, FilterChip } from './FilterBar'
export { BulkActionBar } from './BulkActionBar'
export { BulkOptionsDialog, type BulkOption, type BulkOptionGroup } from './BulkOptionsDialog'

export { Tabs, LinkTabs, type TabItem } from './Tabs'
export { Menu, MenuItem, MenuSeparator } from './Menu'
export { HtmlEditor, type InsertToken } from './HtmlEditor'
export { Modal, ConfirmModal } from './Modal'
export { Drawer } from './Drawer'
export { PinPad } from './PinPad'
export { SignaturePad } from './SignaturePad'
export {
  LaneWeek,
  type LaneWeekDay,
  type LaneWeekLane,
  type LaneWeekBlock,
} from './LaneWeek'

/* Till surfaces. Touch-sized and meant for the POS — see --spacing-touch in
   globals.css and the .till-surface rules at the foot of it. */
export { TileGrid, SHORT_TILE_MAX, isShortTile } from './TileGrid'
export { ProductTile } from './ProductTile'
export { TileGlyph, departmentGlyph, productGlyph } from './TileGlyph'
export { ActionTile } from './ActionTile'
export { NumPad, NumPadDisplay, numPadValue } from './NumPad'
export { TenderTile, tenderIcon } from './TenderTile'
export { TouchRow } from './TouchRow'
export { ExpandingCard } from './ExpandingCard'
export { Accordion } from './Accordion'
export { RowDisclosure } from './RowDisclosure'
export { Combobox, type ComboboxOption } from './Combobox'
export { DateRangeField, type DateRange } from './DateRangeField'
export { useChartColors, ChartTooltip, ChartGlow, type ChartColors } from './charts'
export { Sparkline } from './Sparkline'
export { MeterBar, type MeterSegment, type MeterTone } from './MeterBar'
export {
  TableGlyph,
  type TableGlyphShape,
  type TableGlyphSeats,
} from './TableGlyph'
export { FeatureGlyph, type FeatureGlyphKind } from './FeatureGlyph'
export {
  StoreColumnTable,
  type StoreColumn,
  type StoreRow,
} from './StoreColumnTable'
export { ToastProvider, useToast } from './Toast'

export * as Icons from './icons'
export { HUB_ICONS, hubGlyph } from './hubIcons'

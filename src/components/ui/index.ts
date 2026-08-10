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
export {
  buttonClass,
  CONTROL,
  CONTROL_H,
  CONTROL_H_TOUCH,
  CONTROL_INVALID,
  MODAL_PANEL,
  MODAL_SIZE,
  type ModalSize,
} from './styles'
export {
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_NUMERIC,
  TABLE_ROW,
  TABLE_TD,
  TABLE_TD_INPUT,
  TABLE_TH,
  TABLE_TOTAL_ROW,
} from './styles'

export {
  Field,
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

export { Card, CardHeader, CardBody, CardFooter } from './Card'
export { SettingRow, SettingGroup } from './SettingRow'
export { SelectableCard } from './SelectableCard'
export { SectionTitle } from './SectionTitle'
export {
  TILE_SWATCHES,
  TILE_GRADIENTS,
  TILE_NONE,
  tileClass,
  type TileSwatch,
} from './tiles'
export { SwatchPicker } from './SwatchPicker'
export { Badge, type BadgeTone } from './Badge'
export { Callout, type CalloutTone } from './Callout'
export {
  CategoryTile,
  CATEGORY_TONES,
  toneForId,
  type CategoryTone,
} from './CategoryTile'
export { ChoiceTile } from './ChoiceTile'
export { EmptyState } from './EmptyState'
export { FavoriteToggle } from './FavoriteToggle'
export { PageHeader, PageBody, PrimaryLink } from './PageHeader'
export { StatTile, StatStrip, MiniStat, SearchBar } from './Stats'
export { SummaryList, SummaryRow, SummaryTotal } from './Summary'
export { RowTile } from './RowTile'
export { PickerResults, type PickerResult } from './PickerResults'
export { Skeleton, TableSkeleton } from './Skeleton'
export { TextLink } from './TextLink'
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
export { Pagination } from './Pagination'
export { FilterBar, FilterChip } from './FilterBar'
export { BulkActionBar } from './BulkActionBar'

export { Tabs, LinkTabs, type TabItem } from './Tabs'
export { Menu, MenuItem, MenuSeparator } from './Menu'
export { HtmlEditor, type InsertToken } from './HtmlEditor'
export { Modal, ConfirmModal } from './Modal'
export { PinPad } from './PinPad'

/* Till surfaces. Touch-sized and meant for the POS — see --spacing-touch in
   globals.css and the .till-surface rules at the foot of it. */
export { TileGrid, SHORT_TILE_MAX, isShortTile } from './TileGrid'
export { ProductTile } from './ProductTile'
export { NumPad, NumPadDisplay, numPadValue } from './NumPad'
export { TouchRow } from './TouchRow'
export { ExpandingCard } from './ExpandingCard'
export { Combobox, type ComboboxOption } from './Combobox'
export { DateRangeField, type DateRange } from './DateRangeField'
export { useChartColors, ChartTooltip, type ChartColors } from './charts'
export { Sparkline } from './Sparkline'
export { ToastProvider, useToast } from './Toast'

export * as Icons from './icons'

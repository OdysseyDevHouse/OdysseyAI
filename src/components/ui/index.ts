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
export { buttonClass, CONTROL, CONTROL_H, CONTROL_INVALID } from './styles'
export {
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_NUMERIC,
  TABLE_ROW,
  TABLE_TD,
  TABLE_TD_INPUT,
  TABLE_TH,
} from './styles'

export {
  Field,
  Input,
  NumberInput,
  CurrencyInput,
  Textarea,
  Select,
  Switch,
  Checkbox,
  Radio,
} from './Field'

export { Card, CardHeader, CardBody, CardFooter } from './Card'
export { SelectableCard } from './SelectableCard'
export { SectionTitle } from './SectionTitle'
export { TILE_SWATCHES, tileClass, type TileSwatch } from './tiles'
export { Badge, type BadgeTone } from './Badge'
export { EmptyState } from './EmptyState'
export { PageHeader, PageBody, PrimaryLink } from './PageHeader'
export { StatTile, SearchBar } from './Stats'

export { DataTable, type Column, type SortState, type SortDirection } from './DataTable'
export {
  TableToolbar,
  SegmentedControl,
  ToolbarSearch,
  type SegmentedOption,
} from './TableToolbar'

export { Tabs, LinkTabs, type TabItem } from './Tabs'
export { Menu, MenuItem, MenuSeparator } from './Menu'
export { ToastProvider, useToast } from './Toast'

export * as Icons from './icons'

/**
 * The app's icon vocabulary — one import site for every glyph.
 *
 * Screens import from here, never from 'lucide-react' directly. Swapping the
 * icon set later (or re-pointing "delete" at a different glyph) is then a
 * single edit in this file instead of a repo-wide find and replace.
 *
 * Sizes: 16 inside buttons and table rows, 18 in nav and tabs, 20+ for empty
 * states. Pass `size` explicitly; lucide defaults to 24 which is too big here.
 */
export {
  // actions
  Save,
  Plus,
  Pencil,
  Trash2 as Trash,
  Download,
  Upload,
  Search,
  Funnel as Filter,
  X as Close,
  Check,
  RefreshCw as Refresh,
  Printer,
  Copy,
  // navigation / disclosure
  ChevronDown,
  ChevronUp,
  ChevronRight,
  ChevronLeft,
  ChevronsUpDown as SortNeutral,
  ArrowUp as SortAsc,
  ArrowDown as SortDesc,
  ArrowLeft,
  ArrowLeftRight,
  Ellipsis as MoreHorizontal,
  ExternalLink,
  CornerDownRight,
  ArrowRight,
  PanelLeft,
  // status / feedback
  CircleCheck as StatusSuccess,
  CircleX as StatusFailure,
  CircleAlert as StatusError,
  Info as StatusInfo,
  TriangleAlert as StatusWarning,
  LoaderCircle as Spinner,
  // domain
  LayoutDashboard,
  Package,
  Tags,
  Store,
  Building2,
  Users,
  Truck,
  FileText,
  Settings,
  Palette,
  ChartColumn as BarChart,
  Percent,
  Barcode,
  Globe,
  Database,
  Info,
  Boxes,
  LayoutGrid,
  Coins,
  Banknote,
  Warehouse,
  Shapes,
  Archive,
  ArchiveRestore,
  KeyRound,
  LogIn,
  Moon,
  Sun,
  // rich-text toolbar
  Bold,
  Italic,
  Underline,
  List,
  ListOrdered,
  Link2,
  Eraser,
  Bell,
  LogOut,
  CircleQuestionMark as HelpCircle,
} from 'lucide-react'

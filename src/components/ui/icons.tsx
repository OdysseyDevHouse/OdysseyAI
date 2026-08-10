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
  // The partner to Plus, for steppers — one fewer of a thing.
  Minus,
  // The shopper's basket, on the public storefront.
  ShoppingCart,
  // Saved for later. Filled or outlined via the `fill` prop, so the shape
  // never jumps between states.
  Heart,
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
  // Step back and forward through an edit history. Distinct from `Reverse`
  // above, which means reversing a posted DOCUMENT — a business act, not an
  // editing one — and must not be confused with it.
  Undo2 as Undo,
  Redo2 as Redo,
  // navigation / disclosure
  ChevronDown,
  ChevronUp,
  ChevronRight,
  ChevronLeft,
  ChevronsLeft as PageFirst,
  ChevronsRight as PageLast,
  ChevronsUpDown as SortNeutral,
  ArrowUp as SortAsc,
  ArrowDown as SortDesc,
  ArrowLeft,
  ArrowLeftRight,
  Ellipsis as MoreHorizontal,
  ExternalLink,
  CornerDownRight,
  // The grab affordance on a re-orderable row. Distinct from MoreHorizontal:
  // this one is never a menu, it only ever means "drag me".
  GripVertical as DragHandle,
  ArrowRight,
  PanelLeft,
  // selection — the checkbox column and the "N selected" bar
  Square as Unchecked,
  SquareCheck as Checked,
  SquareMinus as PartlyChecked,
  // status / feedback
  CircleCheck as StatusSuccess,
  CircleX as StatusFailure,
  CircleAlert as StatusError,
  Info as StatusInfo,
  TriangleAlert as StatusWarning,
  LoaderCircle as Spinner,
  /* Connection state, for the till. A shop's line drops several times a day and
     the cashier needs to know at a glance whether the sale they are about to take
     will reach the server now or sit in a queue. */
  Cloud as Online,
  CloudOff as Offline,
  RefreshCw as Syncing,
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
  ChartLine as LineChart,
  ChartPie as PieChart,
  // The report builder's vocabulary: a dataset to read, the columns chosen from
  // it, and the sum at the foot of one.
  Table2 as TableIcon,
  Columns3 as ColumnsIcon,
  Sigma,
  // "Generate with AI" — the wand is the action, the sparkle marks anything the
  // model produced so a generated report is never mistaken for a built one.
  Wand as Wand,
  Sparkles,
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
  // trading — sales documents, debtors and creditors
  Mail,
  Send,
  Calendar,
  CalendarRange,
  // a recurring billing agreement — the same thing, every month
  Repeat,
  Contact,
  CreditCard,
  Receipt,
  ReceiptText as TaxInvoice,
  History,
  Sheet as Spreadsheet,
  Wallet,
  HandCoins,
  // loyalty — the programme itself, a punch card's stamp, and a reward voucher.
  // Gem matches the rail icon the nav already uses for Loyalty.
  Gem,
  Stamp,
  Ticket,
  Undo2 as Reverse,
  CircleDollarSign as Money,
  Monitor as Terminal,
  Hash,
  // purchasing
  PackageOpen,
  PackagePlus,
  // product properties
  Eye,
  Tag,
  Lightbulb,
  Calculator,
  Ban,
  Scale,
  Clock,
  Archive,
  ArchiveRestore,
  Play,
  Pause,
  KeyRound,
  LogIn,
  Moon,
  Sun,
  // login screen
  EyeOff,
  Lock,
  ShieldCheck,
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
  // account contacts, documents and comments
  Paperclip,
  Pin,
  PinOff,
  MessageSquare,
  UserPlus,
  Phone,
  Star,
  File as FileIcon,
  FileImage,
  // A picture itself, rather than a file containing one — the storefront's
  // banner sections and their library.
  Image as Picture,
  FileSpreadsheet,
  FileArchive,
} from 'lucide-react'

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
  // Gift cards — the stored-value kind, on the till key and its screens.
  Gift,
  Search,
  Funnel as Filter,
  X as Close,
  Check,
  RefreshCw as Refresh,
  Printer,
  Copy,
  // Open a workspace edge to edge, and come back out of it. Used by the floor-plan
  // designer, whose canvas is unusable at the size a page column allows.
  Maximize2 as Maximize,
  Minimize2 as Minimize,
  // Step back and forward through an edit history. Distinct from `Reverse`
  // above, which means reversing a posted DOCUMENT — a business act, not an
  // editing one — and must not be confused with it.
  Undo2 as Undo,
  Redo2 as Redo,
  // text formatting — the page builder's formatted-writing toolbar
  AlignLeft,
  AlignCenter,
  AlignRight,
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
  // The row-actions kebab. Vertical because it sits in a narrow trailing
  // column, where a horizontal one reads as an ellipsis in the data.
  EllipsisVertical as MoreVertical,
  ExternalLink,
  CornerDownRight,
  // The Enter key, drawn. Only ever a keyboard hint — the global search palette
  // shows it against the highlighted row to say "this is what Enter opens".
  CornerDownLeft,
  // The Backspace key, drawn. The till's PIN pad has no room for the word and no
  // keyboard to point at, so the key wears the glyph a cashier already knows.
  // Not ChevronLeft, which on a touch screen reads as "go back a screen".
  Delete as Backspace,
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
  // A place on a map: an address, a delivery point. Distinct from Building2,
  // which is an organisation, and from Truck, which is the goods moving.
  MapPin,
  Users,
  Truck,
  // Work to be done on something: a job card, a repair, a service call. Distinct
  // from Factory, which is making stock, and from Settings, which is configuring
  // the shop.
  Wrench,
  FileText,
  // Somewhere a document is filed and can be opened — the till's "Open" key,
  // which lands on the back-office document. Distinct from FileText (the
  // document itself) and ExternalLink (leaving the app entirely).
  FolderOpen,
  Settings,
  // Per-DEVICE display choices, as distinct from Settings (which is the shop's).
  // The till's "Customize" opens tile options that belong to this screen only.
  SlidersHorizontal,
  // Fast, no ceremony — the till's quick sale, a walk-in that needs no table.
  Zap,
  // What everybody runs — the reports hub's Popular shelf. Distinct from Star
  // (what THIS person chose) and Zap (fast): this one is about other people.
  Flame,
  Palette,
  ChartColumn as BarChart,
  ChartLine as LineChart,
  ChartPie as PieChart,
  // The report builder's vocabulary: a dataset to read, the columns chosen from
  // it, and the sum at the foot of one.
  Table2 as TableIcon,
  Columns3 as ColumnsIcon,
  Sigma,
  // Ordering the finished rows, and the test a GROUP must pass to appear at all
  // — a filter on the totals rather than on the records, which is a different
  // question and so earns its own glyph.
  ArrowUpDown as SortIcon,
  Crosshair as TargetIcon,
  // "Generate with AI" — the wand is the action, the sparkle marks anything the
  // model produced so a generated report is never mistaken for a built one.
  Wand as Wand,
  Sparkles,
  // The opening mark, set large and pale behind a pull quote. Decorative
  // only — QuoteCard renders it aria-hidden.
  Quote,
  Percent,
  Barcode,
  Globe,
  Database,
  Info,
  Boxes,
  LayoutGrid,
  // The till's way between its modules — see ModuleMenu. Named for what it
  // opens rather than what it looks like, so a future redesign of the glyph
  // does not leave every call site named after three lines.
  Menu,
  Coins,
  Banknote,
  // the bank itself, as opposed to the money in it — the cashbook's own glyph
  Landmark,
  Warehouse,
  Shapes,
  // A single person, for the name field a local install signs in with —
  // `Users` is the plural and reads as a list of staff, not as one identity.
  User,
  // trading — sales documents, debtors and creditors
  Mail,
  Send,
  Calendar,
  CalendarRange,
  // a recurring billing agreement — the same thing, every month
  Repeat,
  /* Turning a thing on the spot, not looping it. Added for the floor plan's rotate
     control, where `Repeat` would have read as "do it again" on a button that turns a
     table 15°. */
  RotateCw,
  Contact,
  // How a customer is here: sitting down, taking away, collecting. A seat is
  // the one shape that reads as "visit type" without naming a single one of
  // them — Utensils would say "food" on a bar tab that is only ever drinks.
  Armchair,
  CreditCard,
  Receipt,
  ReceiptText as TaxInvoice,
  History,
  // Training mode. A mortarboard rather than a book: this is somebody being
  // taught the till, not documentation to read.
  GraduationCap,
  Sheet as Spreadsheet,
  // A count sheet. Same glyph the nav already uses for Stock Takes, so the menu
  // rail and the screen it opens agree with each other.
  ClipboardList,
  Wallet,
  HandCoins,
  // loyalty — the programme itself, a punch card's stamp, and a reward voucher.
  // Gem matches the rail icon the nav already uses for Loyalty.
  Gem,
  Stamp,
  Ticket,
  // the online store — the shop as a shopper sees it, not the till
  ShoppingBag,
  Undo2 as Reverse,
  CircleDollarSign as Money,
  Monitor as Terminal,
  Hash,
  // purchasing
  PackageOpen,
  PackagePlus,
  // making things — a build turns ingredients into stock of the made item
  Factory,
  // product properties
  Eye,
  Tag,
  Lightbulb,
  Calculator,
  Ban,
  Scale,
  Clock,
  // A moment on a calendar rather than a duration — a price change that happens
  // at 06:00 on the 14th. Clock alone reads as "how long", which is not this.
  CalendarClock,
  Archive,
  ArchiveRestore,
  Play,
  Pause,
  // The third of the transport trio, for a ticket lane that ENDS the clock
  // rather than pausing it (165). Square and not Stop: lucide has no Stop, and
  // a filled square is the universal stop mark on any recorder ever made.
  Square,
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
  Code,
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
  // A HANDSET somebody carries, as distinct from Phone above, which is a
  // telephone call. The mobile app's enrolled devices are its only user, and a
  // revoke list showing a call icon beside "Tiaan's iPhone" is the wrong
  // picture next to the right words.
  Smartphone,
  Star,
  File as FileIcon,
  FileImage,
  // A picture itself, rather than a file containing one — the storefront's
  // banner sections and their library.
  Image as Picture,
  // Several pictures in the same place, one after another — the storefront's
  // rotating banner, as distinct from the single `Picture` it is built from.
  Images as Pictures,
  // Two panes side by side, and stacked bands: the storefront's "picture beside
  // words" block and its spacer. Named for the shape rather than lucide's
  // `Columns2`/`Rows3`, whose digits describe that icon's own strokes.
  Columns2 as SplitPanes,
  Rows3 as StackedBands,
  FileSpreadsheet,
  FileArchive,
} from 'lucide-react'

/**
 * The type of any glyph above, for a component that takes one as a prop.
 *
 * Re-exported so a screen typing an icon prop has somewhere in the kit to get
 * this from. Importing it straight from 'lucide-react' works identically but
 * trips check-ui-kit.mjs — correctly, since a type import in a .tsx is one edit
 * away from becoming a value import and bypassing this file altogether.
 */
export type { LucideIcon } from 'lucide-react'

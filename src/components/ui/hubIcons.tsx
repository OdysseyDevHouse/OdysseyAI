'use client'

import * as Icons from './icons'
import type { HubIconName } from '@/lib/hub'
import type { LucideIcon } from './icons'

/**
 * Name → glyph for the icons a hub catalogue can name.
 *
 * Resolved here rather than in a catalogue because a catalogue is imported by a
 * SERVER component and a Lucide component cannot be serialised across the
 * boundary as a prop — so the catalogues carry a name and this maps it back.
 *
 * In the kit rather than inside HubView because there are now two renderers of
 * catalogue data: the hub screens themselves, and the global search palette,
 * which shows a screen's own glyph beside its description. Two copies of a
 * 37-entry map is two things to update when a catalogue names a new icon, and
 * the second copy is the one that silently renders nothing.
 */
export const HUB_ICONS: Record<HubIconName, LucideIcon> = {
  Wrench: Icons.Wrench,
  Users: Icons.Users,
  KeyRound: Icons.KeyRound,
  Store: Icons.Store,
  Warehouse: Icons.Warehouse,
  Percent: Icons.Percent,
  CreditCard: Icons.CreditCard,
  Terminal: Icons.Terminal,
  LayoutGrid: Icons.LayoutGrid,
  Hash: Icons.Hash,
  Check: Icons.Check,
  FileText: Icons.FileText,
  Package: Icons.Package,
  Scale: Icons.Scale,
  SlidersHorizontal: Icons.SlidersHorizontal,
  Database: Icons.Database,
  Palette: Icons.Palette,
  Settings: Icons.Settings,
  ShieldCheck: Icons.ShieldCheck,
  Coins: Icons.Coins,
  LineChart: Icons.LineChart,
  BarChart: Icons.BarChart,
  Landmark: Icons.Landmark,
  Receipt: Icons.Receipt,
  ListOrdered: Icons.ListOrdered,
  Lock: Icons.Lock,
  Reverse: Icons.Reverse,
  CloudOff: Icons.Offline,
  Mail: Icons.Mail,
  Truck: Icons.Truck,
  Clock: Icons.Clock,
  Repeat: Icons.Repeat,
  Tag: Icons.Tag,
  MessageSquare: Icons.MessageSquare,
  ShoppingBag: Icons.ShoppingBag,
  Boxes: Icons.Boxes,
  Bell: Icons.Bell,
  Gem: Icons.Gem,
  Stamp: Icons.Stamp,
}

/** One catalogue glyph, at the weight the hubs draw them. */
export function hubGlyph(name: HubIconName, size = 18) {
  const Icon = HUB_ICONS[name]
  return <Icon size={size} strokeWidth={1.7} />
}

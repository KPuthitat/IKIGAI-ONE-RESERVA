// Single source of truth for the admin modules (owner 2026-09-18: the top tab
// bar and the landing cards used to be two separate lists and drifted apart —
// one had REPORTA, the other had DELIVERA/IR). Both the ModuleTabs bar (admin
// layout) and the admin landing cards (admin/page.tsx) derive from this list,
// in this order, so they can never disagree again.
//
// Pure data + types (no runtime imports), safe in any server component.

import type { RbacPermissionKey } from "./rbac";
import type { IconName } from "@/components/Icon";
import type { HubCardProps } from "@/components/HubCard";

export type AdminModule = {
  key: string;
  /** Permission that unlocks it; null = always available (INVENTA). */
  perm: RbacPermissionKey | null;
  /** Clean module path (before branch-picker gating). */
  href: string;
  /** Active-path base for tab highlighting (differs from href for DELIVERA). */
  base: string;
  label: string;
  icon: IconName;
  tone: NonNullable<HubCardProps["tone"]>;
  /** i18n key for the short one-line card description (resolved by the caller
   *  with its lang, so the landing stays localized). */
  subKey: string;
  badge?: HubCardProps["badge"];
  /** Preview-only, dimmed card + no live page yet. */
  comingSoon?: boolean;
};

export const ADMIN_MODULES: AdminModule[] = [
  { key: "persona", perm: "persona.manage", href: "/admin/persona", base: "/admin/persona", label: "PERSONA", icon: "persona", tone: "brand", subKey: "portal.mod.persona" },
  { key: "reserva", perm: "reserva.manage", href: "/admin/reserva", base: "/admin/reserva", label: "RESERVA", icon: "reserva", tone: "sky", subKey: "portal.mod.reserva" },
  { key: "inventa", perm: null, href: "/staff/inventa", base: "/staff/inventa", label: "INVENTA", icon: "inventa", tone: "emerald", subKey: "portal.mod.inventa" },
  { key: "insigna", perm: "insigna.view", href: "/admin/insigna", base: "/admin/insigna", label: "INSIGNA", icon: "insigna", tone: "violet", subKey: "portal.mod.insigna", badge: { label: "NEW", tone: "emerald" } },
  { key: "recruita", perm: "recruita.access", href: "/admin/recruita", base: "/admin/recruita", label: "RECRUITA", icon: "recruita", tone: "amber", subKey: "portal.mod.recruita", badge: { label: "NEW", tone: "emerald" } },
  { key: "accounta", perm: "accounta.manage", href: "/admin/accounta", base: "/admin/accounta", label: "ACCOUNTA", icon: "accounta", tone: "rose", subKey: "portal.mod.accounta", badge: { label: "NEW", tone: "emerald" } },
  { key: "reporta", perm: "reporta.manage", href: "/admin/reporta", base: "/admin/reporta", label: "ANALYTICA", icon: "chart", tone: "emerald", subKey: "portal.mod.reporta", badge: { label: "NEW", tone: "emerald" } },
  { key: "delivera", perm: "delivera.manage", href: "/admin/delivera/kitchen", base: "/admin/delivera", label: "DELIVERA", icon: "inbox", tone: "sky", subKey: "portal.mod.delivera" },
  { key: "ir", perm: "ir.manage", href: "/admin/ir", base: "/admin/ir", label: "IR", icon: "shield", tone: "amber", subKey: "portal.mod.ir" },
  { key: "ascenda", perm: "ascenda.view", href: "/admin/ascenda", base: "/admin/ascenda", label: "ASCENDA", icon: "ascenda", tone: "slate", subKey: "portal.mod.ascenda", comingSoon: true, badge: { label: "เร็วๆ นี้", tone: "amber" } }
];

import Link from "next/link";
import { Icon, type IconName } from "@/components/Icon";

// Shared landing/hub card (owner 2026-08-02: การ์ดไอคอนทันสมัยแบบเดียวกันทั้ง
// ระบบ). One consistent look for every module's front door and every hub's
// section grid: an icon tile, an optional eyebrow, title, one-line description,
// and a clear "open" affordance — replacing the old text-only cards and the
// scattered decorative emoji. Renders as a full <Link> so the whole card is one
// obvious click target (owner: ปุ่มชัด ไม่ดูหลบซ่อน).

export type HubCardProps = {
  href: string;
  icon: IconName;
  title: string;
  sub?: string;
  eyebrow?: string;
  /** Small pill in the top-right, e.g. "NEW" / "เร็วๆ นี้". */
  badge?: { label: string; tone?: "emerald" | "amber" | "sky" | "slate" };
  /** "เปิด →" call-to-action text; hidden when omitted. */
  cta?: string;
  /** Dim + neutral CTA for coming-soon/preview cards. */
  muted?: boolean;
  /** Accent colour of the icon tile. Defaults to brand. */
  tone?: "brand" | "emerald" | "sky" | "violet" | "amber" | "rose" | "slate";
};

const TONE_TILE: Record<NonNullable<HubCardProps["tone"]>, string> = {
  brand: "bg-amber-50 text-brand",
  emerald: "bg-emerald-50 text-emerald-600",
  sky: "bg-sky-50 text-sky-600",
  violet: "bg-violet-50 text-violet-600",
  amber: "bg-amber-50 text-amber-600",
  rose: "bg-rose-50 text-rose-600",
  slate: "bg-slate-100 text-slate-600",
};

const BADGE_TONE: Record<NonNullable<HubCardProps["badge"]>["tone"] & string, string> = {
  emerald: "bg-emerald-100 text-emerald-700",
  amber: "bg-amber-100 text-amber-700",
  sky: "bg-sky-100 text-sky-700",
  slate: "bg-slate-100 text-slate-600",
};

export function HubCard({
  href, icon, title, sub, eyebrow, badge, cta, muted, tone = "brand",
}: HubCardProps) {
  return (
    <Link
      href={href}
      className={`card group flex flex-col gap-3 transition hover:shadow-xl hover:-translate-y-0.5 ${muted ? "opacity-80" : ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        <span className={`inline-flex h-12 w-12 items-center justify-center rounded-xl ${TONE_TILE[tone]} transition group-hover:scale-105`}>
          <Icon name={icon} className="h-6 w-6" />
        </span>
        {badge && (
          <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${BADGE_TONE[badge.tone ?? "emerald"]}`}>
            {badge.label}
          </span>
        )}
      </div>
      <div className="flex-1">
        {eyebrow && (
          <div className="text-[11px] tracking-[1px] text-slate-400 mb-0.5">{eyebrow}</div>
        )}
        <h2 className="text-xl font-bold text-slate-800 group-hover:text-brand transition-colors">
          {title}
        </h2>
        {sub && <p className="text-slate-500 text-sm mt-1">{sub}</p>}
      </div>
      {cta && (
        <span className={`inline-flex items-center gap-1 text-sm font-bold ${muted ? "text-slate-400" : "text-brand"}`}>
          {cta}
          <Icon name="arrowRight" className="h-4 w-4" strokeWidth={2.25} />
        </span>
      )}
    </Link>
  );
}

import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, isAdminCapable } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { fmtMoney } from "@/lib/format";
import Mascot from "@/app/components/Mascot";
import {
  inventaForecast, FORECAST_LEAD_DAYS, FORECAST_BUFFER_DAYS, FORECAST_OVERSTOCK_DAYS, type ForecastStatus
} from "@/lib/inventa-forecast";

export const dynamic = "force-dynamic";

// Admin-only: stock cost / tied-up capital is owner information.
const FILTERS: Array<{ key: "all" | ForecastStatus; label: string }> = [
  { key: "all", label: "ทั้งหมด" },
  { key: "reorder", label: "ควรสั่งเพิ่ม" },
  { key: "overstock", label: "สต๊อกเกิน" },
  { key: "dead", label: "ไม่เคลื่อนไหว" },
  { key: "ok", label: "ปกติ" }
];
const TAG: Record<ForecastStatus, { cls: string; label: string }> = {
  reorder: { cls: "tag-bad", label: "ควรสั่งเพิ่ม" },
  overstock: { cls: "tag-warn", label: "สต๊อกเกิน" },
  dead: { cls: "tag-mute", label: "ไม่เคลื่อนไหว" },
  ok: { cls: "tag-ok", label: "ปกติ" },
  no_sales: { cls: "tag-mute", label: "ไม่มียอดขาย" },
  skipped: { cls: "tag-mute", label: "ข้าม (นับเป็นขวด)" }
};

export default function ForecastPage({ searchParams }: { searchParams: { s?: string } }) {
  const user = requireUser();
  if (!isAdminCapable(user)) redirect("/staff/inventa");
  const lang = getLang();
  const branchId = user.activeBranchId ?? null;
  if (branchId == null) redirect("/staff/inventa");

  const f = inventaForecast(branchId);
  const sel = FILTERS.find((x) => x.key === searchParams.s)?.key ?? "all";
  const count = (k: "all" | ForecastStatus) => (k === "all" ? f.rows.length : f.rows.filter((r) => r.status === k).length);
  const rows = (sel === "all" ? f.rows : f.rows.filter((r) => r.status === sel))
    .slice()
    .sort((a, b) => (a.coverDays ?? 1e9) - (b.coverDays ?? 1e9));

  return (
    <div className="space-y-4">
      <div className="pl-11 md:pl-0 flex items-center gap-3">
        <Mascot pose="mortar" size={72} className="flex-shrink-0" />
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-slate-800">{t(lang, "inv.forecast.title")}</h1>
          <p className="text-sm text-slate-500">{t(lang, "inv.forecast.subtitle")}</p>
        </div>
      </div>

      {!f.hasSalesData && (
        <div className="card text-sm text-slate-600 flex items-center gap-3">
          <Mascot pose="sign" size={80} className="flex-shrink-0" />
          <span>ยังไม่มีข้อมูลยอดขาย CLINICA ใน 90 วันที่ผ่านมาของสาขานี้ — นำเข้ารายงานบิลก่อน แล้วระบบจะคำนวณให้</span>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="kpi kpi-bad relative">{f.totals.reorder > 0 && <Mascot pose="fire" size={52} className="absolute right-2 top-2" />}<div className="kpi-label">ควรสั่งเพิ่ม</div><div className="kpi-value">{f.totals.reorder}</div><div className="kpi-sub">เหลือไม่ถึง {FORECAST_LEAD_DAYS} วัน</div></div>
        <div className="kpi kpi-warn"><div className="kpi-label">สต๊อกเกิน</div><div className="kpi-value">{f.totals.overstock}</div><div className="kpi-sub">เกิน {FORECAST_OVERSTOCK_DAYS} วัน</div></div>
        <div className="kpi kpi-mute"><div className="kpi-label">ไม่เคลื่อนไหว</div><div className="kpi-value">{f.totals.dead}</div><div className="kpi-sub">มีของแต่ขายไม่ออก</div></div>
        <div className="kpi kpi-info"><div className="kpi-label">เงินจมในสต๊อก</div><div className="kpi-value">{fmtMoney(f.totals.tiedUpValue)}</div><div className="kpi-sub">฿ ตามราคาทุน</div></div>
      </div>

      <div className="flex gap-2 overflow-x-auto no-scrollbar">
        {FILTERS.map((x) => (
          <Link key={x.key} href={`/staff/inventa/forecast?s=${x.key}`} className={`chip ${sel === x.key ? "chip-active" : ""}`}>
            {x.label}<span className="chip-count">{count(x.key)}</span>
          </Link>
        ))}
      </div>

      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-slate-500">
            <tr>
              <th className="px-3 py-2">รายการ</th>
              <th className="px-3 py-2 text-right">คงเหลือ</th>
              <th className="px-3 py-2 text-right">ขาย/วัน</th>
              <th className="px-3 py-2 text-right">พอใช้ (วัน)</th>
              <th className="px-3 py-2 text-right">ควรสั่ง</th>
              <th className="px-3 py-2 text-right">เงินจม ฿</th>
              <th className="px-3 py-2">สถานะ</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.itemId} className="border-t border-[color:var(--card-border)]">
                <td className="px-3 py-2">
                  <div className="font-semibold text-slate-800">{r.name}</div>
                  <div className="text-xs text-slate-400">{[r.code, r.supplier].filter(Boolean).join(" · ")}</div>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{r.onHand}{r.unit ? ` ${r.unit}` : ""}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.perDay > 0 ? r.perDay.toFixed(2) : "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.coverDays == null ? "—" : Math.round(r.coverDays)}</td>
                <td className="px-3 py-2 text-right tabular-nums font-semibold">{r.suggestedQty > 0 ? r.suggestedQty : "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.tiedUpValue > 0 ? fmtMoney(r.tiedUpValue) : "—"}</td>
                <td className="px-3 py-2"><span className={`tag ${TAG[r.status].cls}`}>{TAG[r.status].label}</span></td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-400">ไม่มีรายการ</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-400 leading-relaxed">
        คำนวณจากยอดขายจริง {f.windowDays} วันล่าสุด (ณ {f.asOf}) · ควรสั่งให้พอใช้ {FORECAST_LEAD_DAYS + FORECAST_BUFFER_DAYS} วัน
        (รอของ {FORECAST_LEAD_DAYS} + สำรอง {FORECAST_BUFFER_DAYS}) · จับคู่ยากับบิลด้วยรหัสสินค้า ถ้าไม่ตรงใช้ชื่อเต็ม ·
        ใช้หน่วยขายเท่ากับหน่วยสต๊อก ถ้าสต๊อกนับเป็นแพ็กให้ตรวจก่อนสั่ง · ยาที่นับเป็นขวดเปิดแล้วไม่ถูกนำมาคำนวณ ·
        ใช้ตัดสินใจร่วมกับการนับสต๊อกจริง ไม่ได้สั่งซื้ออัตโนมัติ
      </p>
    </div>
  );
}

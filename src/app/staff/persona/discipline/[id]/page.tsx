import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { requireStaffOrAdmin } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { formatBkkDateTime } from "@/lib/time";
import { getWarning, recordView } from "@/lib/discipline";
import { nameWithPrefix } from "@/lib/name";
import WarningAcknowledgeClient from "./WarningAcknowledgeClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "หนังสือเตือน · PERSONA" };

const SEVERITY_LABEL: Record<string, string> = {
  verbal: "ตักเตือนด้วยวาจา",
  written_1: "ลายลักษณ์อักษร ครั้งที่ 1",
  written_2: "ลายลักษณ์อักษร ครั้งที่ 2",
  final: "หนังสือเตือนครั้งสุดท้าย"
};

export default function StaffDisciplineDetailPage({ params }: { params: { id: string } }) {
  const user = requireStaffOrAdmin();
  const lang = getLang();
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const w = getWarning(id);
  if (!w) notFound();
  if (w.user_id !== user.id) {
    // Different user trying to read — bounce to their own list.
    redirect("/staff/persona/discipline");
  }

  // Audit log: record one view per server-side render. The client
  // component fires another view on mount so both SSR + hydration
  // are captured. Best-effort — no try/catch since logPersonaAction-
  // style swallow happens at the helper.
  recordView(w.id, null, null);

  return (
    <div className="space-y-4">
      <div>
        <Link href="/staff/persona/discipline" className="text-sm text-slate-500 hover:text-brand">
          ← {t(lang, "staff.persona.discipline.backToList")}
        </Link>
      </div>

      <div className="card space-y-3 border-rose-300 bg-rose-50/20">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div>
            <div className="text-[10px] font-mono text-slate-400 mb-1">
              {w.ref_no ? `#${w.ref_no}` : ""}
            </div>
            <div className="text-xs text-rose-700 font-bold uppercase tracking-[0.5px]">
              {SEVERITY_LABEL[w.severity] ?? w.severity}
            </div>
            <h1 className="text-xl font-bold text-slate-800 mt-1">{w.title}</h1>
          </div>
          {w.acknowledged_at && (
            <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${
              w.acknowledged_method === "pin_explicit"
                ? "bg-emerald-100 text-emerald-700"
                : "bg-amber-100 text-amber-700"
            }`}>
              ✓ {w.acknowledged_method === "pin_explicit"
                  ? t(lang, "staff.persona.discipline.ackPin")
                  : t(lang, "staff.persona.discipline.ackAuto")}
            </span>
          )}
        </div>

        <div className="text-[11px] text-slate-500">
          {t(lang, "staff.persona.discipline.issuedBy", { name: nameWithPrefix(w.issued_by_prefix, w.issued_by_name) })}
          · {formatBkkDateTime(w.issued_at)}
          {w.effective_date && (
            <span className="ml-2">
              · {t(lang, "staff.persona.discipline.effectiveDate", { date: w.effective_date })}
            </span>
          )}
        </div>

        <div className="bg-white rounded-lg border border-slate-200 p-4 whitespace-pre-wrap text-sm text-slate-800 leading-relaxed">
          {w.body}
        </div>

        {w.reason_category && (
          <div className="text-xs text-slate-500">
            {t(lang, "staff.persona.discipline.categoryLabel")}: {w.reason_category}
          </div>
        )}
      </div>

      <WarningAcknowledgeClient
        warningId={w.id}
        alreadyAcked={!!w.acknowledged_at}
      />
    </div>
  );
}

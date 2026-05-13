import Link from "next/link";
import type { Metadata } from "next";
import { requireStaffOrAdmin } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { listWarningsForUser } from "@/lib/discipline";
import OwlMascot from "../../../components/OwlMascot";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "หนังสือเตือนของฉัน · PERSONA" };

const SEVERITY_LABEL: Record<string, string> = {
  verbal: "ตักเตือนด้วยวาจา",
  written_1: "ลายลักษณ์อักษร ครั้งที่ 1",
  written_2: "ลายลักษณ์อักษร ครั้งที่ 2",
  final: "หนังสือเตือนครั้งสุดท้าย"
};

export default function StaffDisciplineListPage() {
  const user = requireStaffOrAdmin();
  const lang = getLang();
  const warnings = listWarningsForUser(user.id);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "staff.persona.discipline.title")}
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {t(lang, "staff.persona.discipline.subtitle")}
        </p>
      </div>

      {warnings.length === 0 ? (
        <div className="card text-center py-10">
          <OwlMascot size={96} mood="smile" />
          <p className="text-sm text-emerald-700 font-bold mt-3">
            ✓ {t(lang, "staff.persona.discipline.empty")}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {warnings.map((w) => (
            <li key={w.id}>
              <Link href={`/staff/persona/discipline/${w.id}`}
                className={`card block hover:shadow-lg transition ${
                  w.acknowledged_at ? "opacity-70" : "border-rose-300 bg-rose-50/30"
                }`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    {w.ref_no && (
                      <div className="text-[10px] font-mono text-slate-400 mb-0.5">#{w.ref_no}</div>
                    )}
                    <div className="font-bold text-slate-800">{w.title}</div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {SEVERITY_LABEL[w.severity] ?? w.severity}
                    </div>
                    <div className="text-[10px] text-slate-400 mt-1">
                      {t(lang, "staff.persona.discipline.issuedBy", { name: w.issued_by_name })}
                      · {new Date(w.issued_at).toISOString().slice(0, 16).replace("T", " ")}
                    </div>
                  </div>
                  <div>
                    {w.acknowledged_at ? (
                      <span className="text-[10px] px-2 py-0.5 rounded font-bold bg-emerald-100 text-emerald-700">
                        ✓ {t(lang, "staff.persona.discipline.acknowledged")}
                      </span>
                    ) : (
                      <span className="text-[10px] px-2 py-0.5 rounded font-bold bg-rose-100 text-rose-700">
                        ⏳ {t(lang, "staff.persona.discipline.pending")}
                      </span>
                    )}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

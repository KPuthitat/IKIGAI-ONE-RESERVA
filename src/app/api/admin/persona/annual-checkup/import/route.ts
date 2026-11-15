import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { buildImportPlan, canImportCheckup, commitImport, ImportRefused, type RoundInput } from "@/lib/annual-checkup-import";
import { parseCheckupWorkbook } from "@/lib/annual-checkup-xlsx";

// POST /api/admin/persona/annual-checkup/import  (multipart)
//   file            the planning workbook (.xlsx, ≤ 5 MB)
//   mode            "preview" (writes nothing, returns the plan) | "commit" (needs planHash from the preview)
//   roundId         an existing round to import into again; or name [+ yearBe, startDate, endDate, location] for a new one
//   planHash        the hash the preview returned — the commit is refused if anything changed since
//   skipUnresolved  "1" to import only the rows that were understood (the rest stay for a later import)
// Allowed: super_admin, or clinic staff holding the recorder flag (canImportCheckup).

const MAX_BYTES = 5 * 1024 * 1024;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const field = (f: FormData, k: string): string | null => { const v = f.get(k); return typeof v === "string" && v.trim() ? v.trim() : null; };

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
  if (!canImportCheckup(user)) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ ok: false, error: "bad_form" }, { status: 400 }); }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ ok: false, error: "no_file", message: "กรุณาเลือกไฟล์ Excel (.xlsx)" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ ok: false, error: "too_large", message: "ไฟล์เกิน 5 MB" }, { status: 400 });
  if (!/\.xlsx$/i.test(file.name)) return NextResponse.json({ ok: false, error: "bad_type", message: "รองรับเฉพาะไฟล์ .xlsx" }, { status: 400 });

  const roundId = Number(field(form, "roundId"));
  const yearBe = Number(field(form, "yearBe"));
  const start = field(form, "startDate"), end = field(form, "endDate");
  if ((start && !DATE.test(start)) || (end && !DATE.test(end))) return NextResponse.json({ ok: false, error: "bad_date", message: "วันที่ต้องอยู่ในรูปแบบ ปปปป-ดด-วว" }, { status: 400 });
  const input: RoundInput = {
    roundId: Number.isInteger(roundId) && roundId > 0 ? roundId : null, name: field(form, "name"),
    yearBe: Number.isInteger(yearBe) && yearBe > 2400 ? yearBe : null, startDate: start, endDate: end, location: field(form, "location")
  };
  const mode = field(form, "mode") === "commit" ? "commit" : "preview";

  const parsed = parseCheckupWorkbook(Buffer.from(await file.arrayBuffer()));
  const db = getDb();
  try {
    if (mode === "preview") return NextResponse.json({ ok: true, plan: buildImportPlan(db, parsed, input) });
    const planHash = field(form, "planHash") ?? "";
    const result = commitImport(db, parsed, input, user.id, { planHash, skipUnresolved: field(form, "skipUnresolved") === "1" });
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    if (e instanceof ImportRefused) return NextResponse.json({ ok: false, error: e.code, message: e.message }, { status: 422 });
    throw e;
  }
}

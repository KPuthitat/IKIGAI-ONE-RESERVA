import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { handleClinical } from "@/lib/annual-checkup-api";
import { isRecorderEligible } from "@/lib/annual-checkup-db";
import { buildLabPlan, commitLabPlan, LabImportRefused, parseLabWorkbook } from "@/lib/health-report/lab-import";
import { loadItems } from "@/lib/health-report/store";

// POST multipart: file (.xlsx ≤ 5 MB), roundId, mode "preview" | "commit".
//   preview → what would happen (nothing is written). commit → needs planHash from the preview; overwrite / registerByName / confirmImplausible
//   are the choices the person made on the preview screen. Only clinic recorders (the gateway checks again on every write).
const MAX_BYTES = 5 * 1024 * 1024;
const flag = (f: FormData, k: string) => f.get(k) === "1";

export async function POST(req: Request) {
  return handleClinical(async (user) => {
    if (!isRecorderEligible(user.id)) return NextResponse.json({ ok: false, error: "not_recorder", message: "ท่านไม่มีสิทธิ์ลงผลตรวจสุขภาพ" }, { status: 403 });
    let form: FormData;
    try { form = await req.formData(); } catch { return NextResponse.json({ ok: false, error: "bad_form", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 }); }
    const file = form.get("file");
    const roundId = Number(form.get("roundId"));
    if (!Number.isInteger(roundId) || roundId <= 0) return NextResponse.json({ ok: false, error: "bad_round", message: "ไม่พบรอบตรวจ" }, { status: 400 });
    if (!(file instanceof File) || file.size === 0) return NextResponse.json({ ok: false, error: "no_file", message: "กรุณาเลือกไฟล์ Excel (.xlsx)" }, { status: 400 });
    if (file.size > MAX_BYTES) return NextResponse.json({ ok: false, error: "too_large", message: "ไฟล์เกิน 5 MB" }, { status: 400 });
    if (!/\.xlsx$/i.test(file.name)) return NextResponse.json({ ok: false, error: "bad_type", message: "รองรับเฉพาะไฟล์ .xlsx" }, { status: 400 });
    const db = getDb();
    const items = loadItems(db);
    const parsed = parseLabWorkbook(Buffer.from(await file.arrayBuffer()), items);
    if (parsed.issues.length && parsed.rows.length === 0) return NextResponse.json({ ok: false, error: "bad_file", message: parsed.issues.join(" ") }, { status: 422 });
    try {
      if (form.get("mode") !== "commit") return NextResponse.json({ ok: true, plan: buildLabPlan(db, user, roundId, parsed, items, { registerByName: flag(form, "registerByName") }) });
      const result = commitLabPlan(db, user, roundId, parsed, items, { planHash: String(form.get("planHash") ?? ""), overwrite: flag(form, "overwrite"), registerByName: flag(form, "registerByName"), confirmImplausible: flag(form, "confirmImplausible") });
      return NextResponse.json({ ok: true, result });
    } catch (e) {
      if (e instanceof LabImportRefused) return NextResponse.json({ ok: false, error: e.code, message: e.message }, { status: 422 });
      throw e;
    }
  });
}

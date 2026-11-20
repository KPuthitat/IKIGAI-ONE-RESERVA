import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { attachResultFile, isRecorderEligible } from "@/lib/annual-checkup-db";
import { handleClinical } from "@/lib/annual-checkup-api";

// POST multipart {orderId, file} — attach a lab result file (PDF / image, ≤ 12 MB) to a DRAFT result. Stored outside the web root;
// opened only through /api/annual-checkup/file/[resultId] with a 5-minute signed link. Old files are kept (revisions may point at them).
const MAX_BYTES = 12 * 1024 * 1024;
const TYPES: Record<string, string> = { "application/pdf": ".pdf", "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png", "image/webp": ".webp" };
const DATA_ROOT = process.env.HEALTH_DATA_ROOT ?? path.join(process.cwd(), "data", "health");

export async function POST(req: Request) {
  return handleClinical(async (user) => {
    let form: FormData;
    try { form = await req.formData(); } catch { return NextResponse.json({ ok: false, error: "bad_form", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 }); }
    const orderId = Number(form.get("orderId"));
    const file = form.get("file");
    if (!Number.isInteger(orderId) || orderId <= 0 || !(file instanceof File) || file.size === 0) return NextResponse.json({ ok: false, error: "no_file", message: "กรุณาเลือกไฟล์" }, { status: 400 });
    if (file.size > MAX_BYTES) return NextResponse.json({ ok: false, error: "too_large", message: "ไฟล์เกิน 12 MB" }, { status: 400 });
    const ext = TYPES[file.type];
    if (!ext) return NextResponse.json({ ok: false, error: "bad_type", message: "รองรับเฉพาะ PDF และรูปภาพ (JPG, PNG, WEBP)" }, { status: 400 });

    // Stored first, then attached through the gateway (the real check); if it refuses, the file is removed again. A cheap eligibility
    // check first means someone who is not clinical staff cannot even make the server write a file.
    if (!isRecorderEligible(user.id)) return NextResponse.json({ ok: false, error: "not_recorder", message: "ท่านไม่มีสิทธิ์ลงผลตรวจสุขภาพ" }, { status: 403 });
    const rel = path.posix.join("annual-checkup", `order-${orderId}-${randomBytes(8).toString("hex")}${ext}`);
    const full = path.join(DATA_ROOT, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, Buffer.from(await file.arrayBuffer()));
    try {
      const resultId = attachResultFile(user, orderId, { filePath: rel, fileMime: file.type });
      return NextResponse.json({ ok: true, resultId });
    } catch (e) {
      await fs.unlink(full).catch(() => undefined);      // refused: leave nothing behind
      throw e;
    }
  });
}

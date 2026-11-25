import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { getOrderValues, recordResult } from "@/lib/annual-checkup-db";
import { handleClinical } from "@/lib/annual-checkup-api";
import { itemsOfTest, loadItems, validateValues, valuesFromResult, valuesToInput } from "@/lib/health-report/store";

// POST {orderId, values: {itemCode: number|string|null}, confirmImplausible?, merge?} — save a test's items as a DRAFT result.
// Values are checked against the report catalogue; a number outside what a living person can show (glucose 1590) is
// refused until the caller says it was checked (confirmImplausible). Who may write is still decided by the gateway + triggers.
const Body = z.object({
  orderId: z.number().int().positive(),
  values: z.record(z.string().max(40), z.union([z.number().finite(), z.string().max(1000), z.null()])),
  confirmImplausible: z.boolean().optional(),
  merge: z.boolean().optional()           // keep the items already saved and change only the ones sent (whole-round entry of one item)
});

export async function POST(req: Request) {
  return handleClinical(async (user) => {
    const p = Body.safeParse(await req.json().catch(() => ({})));
    if (!p.success) return NextResponse.json({ ok: false, error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
    const db = getDb();
    const o = db.prepare("SELECT t.code FROM annual_checkup_orders o JOIN annual_checkup_tests t ON t.id = o.test_id WHERE o.id = ?").get(p.data.orderId) as { code: string } | undefined;
    if (!o) return NextResponse.json({ ok: false, error: "order_not_found", message: "ไม่พบรายการตรวจ" }, { status: 404 });
    const testItems = itemsOfTest(loadItems(db), o.code);
    const issues = validateValues(testItems, p.data.values);
    const hard = issues.filter((i) => i.problem !== "implausible");
    if (hard.length) return NextResponse.json({ ok: false, error: "invalid_values", message: "มีค่าที่กรอกไม่ถูกต้อง", issues: hard }, { status: 422 });
    const soft = issues.filter((i) => i.problem === "implausible");
    if (soft.length && !p.data.confirmImplausible) return NextResponse.json({ ok: false, error: "implausible", message: "มีค่าที่ผิดปกติมากจนอาจพิมพ์ผิด กรุณาตรวจและยืนยัน", issues: soft }, { status: 409 });
    const values = p.data.merge ? { ...valuesFromResult(testItems, getOrderValues(user, p.data.orderId)), ...p.data.values } : p.data.values;
    const input = valuesToInput(testItems, values);
    const id = recordResult(user, p.data.orderId, input);
    return NextResponse.json({ ok: true, resultId: id });
  });
}

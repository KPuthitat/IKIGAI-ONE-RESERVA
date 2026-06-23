import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isRevshareBranch, getPartner, previewSettlement } from "@/lib/revshare-db";
import { generateStatementPdf } from "@/lib/revshare-statement-pdf";
import { TH_MONTHS_FULL } from "@/lib/revshare";

export const dynamic = "force-dynamic";

const STATUS_TH: Record<string, string> = { draft: "ร่าง", issued: "ออกใบเรียกเก็บแล้ว", paid: "รับชำระแล้ว" };

export async function GET(req: Request) {
  const user = requirePermission("accounta.manage");
  const branchId = user.activeBranchId ?? null;
  if (branchId == null || !isRevshareBranch(branchId)) {
    return NextResponse.json({ error: "not_revshare_branch" }, { status: 403 });
  }
  const sp = new URL(req.url).searchParams;
  const partnerId = Number(sp.get("partner")), year = Number(sp.get("year")), month = Number(sp.get("month"));
  if (![partnerId, year, month].every(Number.isInteger)) return NextResponse.json({ error: "bad_params" }, { status: 400 });

  const partner = getPartner(partnerId, branchId);
  if (!partner) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const preview = previewSettlement(partnerId, branchId, year, month);
  if (!preview) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const seller = getDb().prepare(`
    SELECT b.name, b.reg_address, b.tax_branch_code, b.contact_phone, c.tax_id AS company_tax_id, c.address AS company_address
    FROM branches b LEFT JOIN companies c ON c.id = b.company_id WHERE b.id = ?
  `).get(branchId) as { name: string; reg_address: string | null; tax_branch_code: string | null; contact_phone: string | null; company_tax_id: string | null; company_address: string | null };

  const pdf = await generateStatementPdf({
    seller: { name: seller.name, address: seller.reg_address ?? seller.company_address, taxBranchCode: seller.tax_branch_code, phone: seller.contact_phone, taxId: seller.company_tax_id },
    partner: { name: partner.name, venue: partner.venue },
    buyer: { taxId: partner.tax_id, address: partner.address, branchCode: partner.branch_code },
    monthLabel: `${TH_MONTHS_FULL[month]} ${year + 543}`,
    invoiceNo: preview.stored?.invoice_no ?? null,
    status: STATUS_TH[preview.stored?.status ?? "draft"],
    withVat: partner.vat_enabled && preview.result.vatAmount > 0,
    result: preview.result,
    breakdown: preview.breakdown.map((b) => ({ label: b.label, sales: b.sales, roundGP: b.roundGP }))
  });

  return new NextResponse(pdf as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="revshare-${partnerId}-${year}-${String(month).padStart(2, "0")}.pdf"`
    }
  });
}

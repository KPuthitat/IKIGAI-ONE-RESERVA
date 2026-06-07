// INVENTA purchase-order PDF generator (owner 2026-06-06).
//
// Replaces the old browser-print HTML preview (which overflowed the page)
// with a real, downloadable A4 PDF. Server-side via pdfkit + an embedded
// LINE Seed Sans TH TTF so Thai shapes correctly (fontkit applies the
// font's OpenType layout). Column widths are computed to fit the A4
// content box and the item column wraps, so the table can never run off
// the page. Multi-page orders repeat the table header on each page.
//
// pdfkit is marked external in next.config.js so its AFM data files load
// at runtime instead of being (incorrectly) bundled by webpack.

import PDFDocument from "pdfkit";
import path from "node:path";

export type PoPdfLine = {
  item_name: string;
  item_code: string | null;
  unit: string | null;
  qty_on_hand: number | null;
  order_qty: number;
  unit_cost_at_order: number;
};

export type PoPdfData = {
  orderId: number;
  status: string;          // already-localised Thai status label
  createdAtIso: string;
  note: string | null;
  requesterName: string | null;
  approverName: string | null;
  supplierName: string;
  buyerName: string;
  buyerAddress: string;
  buyerTaxId: string | null;
  buyerBranchCode: string | null;
  buyerPhone: string | null;
  lines: PoPdfLine[];
  /** Supplier-facing copy (owner 2026-06-08): hide on-hand + cost + total
   *  columns and the subtotal — show only รายการ / รหัส / จำนวน / หน่วย. */
  hideCost?: boolean;
};

const FONT_REG = path.join(process.cwd(), "public", "fonts", "LINESeedSansTH-Regular.ttf");
const FONT_BOLD = path.join(process.cwd(), "public", "fonts", "LINESeedSansTH-Bold.ttf");

const TH_MONTHS = [
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"
];

/** "6 มิถุนายน 2569" — full Thai month + Buddhist-era year. */
function thaiDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  // Use Bangkok-local calendar date.
  const bkk = new Date(d.getTime() + 7 * 3600_000);
  return `${bkk.getUTCDate()} ${TH_MONTHS[bkk.getUTCMonth()]} ${bkk.getUTCFullYear() + 543}`;
}

function baht(n: number): string {
  return "฿" + n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Generate the PO PDF and resolve to a Buffer. */
export function generatePoPdf(data: PoPdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 40 });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      doc.registerFont("th", FONT_REG);
      doc.registerFont("th-b", FONT_BOLD);

      const left = doc.page.margins.left;
      const right = doc.page.width - doc.page.margins.right;
      const contentW = right - left;
      const bottom = doc.page.height - doc.page.margins.bottom;

      // ── Header ──────────────────────────────────────────────────
      doc.font("th-b").fontSize(20).fillColor("#1a1a2e")
        .text("ใบสั่งซื้อ", left, doc.page.margins.top);
      doc.font("th").fontSize(10).fillColor("#666666")
        .text(`เลขที่ PO-${data.orderId}`, left, doc.y + 2);
      doc.text(`วันที่ ${thaiDate(data.createdAtIso)}  ·  สถานะ ${data.status}`);

      // Buyer block (right-aligned)
      const buyerTop = doc.page.margins.top;
      doc.font("th-b").fontSize(11).fillColor("#1a1a2e")
        .text(data.buyerName, left + contentW / 2, buyerTop, { width: contentW / 2, align: "right" });
      doc.font("th").fontSize(9).fillColor("#555555");
      if (data.buyerAddress) {
        doc.text(data.buyerAddress, left + contentW / 2, doc.y + 1, { width: contentW / 2, align: "right" });
      }
      if (data.buyerTaxId) {
        const code = data.buyerBranchCode ? ` (สาขา ${data.buyerBranchCode})` : "";
        doc.text(`เลขประจำตัวผู้เสียภาษี ${data.buyerTaxId}${code}`, { width: contentW / 2, align: "right" });
      }
      if (data.buyerPhone) {
        doc.text(`โทร. ${data.buyerPhone}`, { width: contentW / 2, align: "right" });
      }

      // Supplier line
      let y = Math.max(doc.y, buyerTop + 70) + 14;
      doc.font("th").fontSize(10).fillColor("#666666").text("ผู้จำหน่าย:", left, y, { continued: true });
      doc.font("th-b").fillColor("#1a1a2e").text(` ${data.supplierName}`);
      y = doc.y + 10;

      // ── Table ───────────────────────────────────────────────────
      // Column widths (sum = contentW = 515pt on A4 @ 40pt margins).
      // Supplier copy (hideCost) drops คงเหลือ/ทุน/รวม and widens the rest.
      const cols = data.hideCost ? [
        { key: "no", label: "#", w: 26, align: "left" as const },
        { key: "item", label: "รายการ", w: 253, align: "left" as const },
        { key: "code", label: "รหัส", w: 110, align: "left" as const },
        { key: "order", label: "จำนวนสั่ง", w: 56, align: "right" as const },
        { key: "unit", label: "หน่วย", w: 70, align: "left" as const }
      ] : [
        { key: "no", label: "#", w: 22, align: "left" as const },
        { key: "item", label: "รายการ", w: 148, align: "left" as const },
        { key: "code", label: "รหัส", w: 82, align: "left" as const },
        { key: "onhand", label: "คงเหลือ", w: 50, align: "right" as const },
        { key: "order", label: "สั่ง", w: 42, align: "right" as const },
        { key: "unit", label: "หน่วย", w: 48, align: "left" as const },
        { key: "cost", label: "ทุน/หน่วย", w: 60, align: "right" as const },
        { key: "total", label: "รวม", w: 63, align: "right" as const }
      ];
      const colX: number[] = [];
      { let x = left; for (const c of cols) { colX.push(x); x += c.w; } }
      const cellPad = 3;

      function drawHeaderRow(atY: number): number {
        doc.font("th-b").fontSize(9).fillColor("#1a1a2e");
        cols.forEach((c, i) => {
          doc.text(c.label, colX[i] + cellPad, atY + 4, {
            width: c.w - cellPad * 2, align: c.align
          });
        });
        const hb = atY + 18;
        doc.moveTo(left, hb).lineTo(right, hb).strokeColor("#888888").lineWidth(0.8).stroke();
        return hb + 3;
      }

      y = drawHeaderRow(y);

      doc.font("th").fontSize(9).fillColor("#333333");
      let subtotal = 0;
      const numFmt = (n: number) =>
        n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      data.lines.forEach((l, idx) => {
        const lineTotal = l.order_qty * l.unit_cost_at_order;
        subtotal += lineTotal;
        // Value per column key — so the supplier (hideCost) + internal
        // column sets both render from one source.
        const cellFor = (key: string): string => {
          switch (key) {
            case "no": return String(idx + 1);
            case "item": return l.item_name;
            case "code": return l.item_code ?? "—";
            case "onhand": return l.qty_on_hand != null ? String(l.qty_on_hand) : "—";
            case "order": return String(l.order_qty);
            case "unit": return l.unit ?? "—";
            case "cost": return numFmt(l.unit_cost_at_order);
            case "total": return numFmt(lineTotal);
            default: return "";
          }
        };
        // Row height = tallest cell (item column wraps).
        const itemCol = cols.find((c) => c.key === "item")!;
        const itemH = doc.heightOfString(l.item_name, { width: itemCol.w - cellPad * 2 });
        const rowH = Math.max(16, itemH + 6);

        // Page break — repeat the header on the new page.
        if (y + rowH > bottom - 90) {
          doc.addPage();
          y = doc.page.margins.top;
          y = drawHeaderRow(y);
          doc.font("th").fontSize(9).fillColor("#333333");
        }

        cols.forEach((c, i) => {
          doc.text(cellFor(c.key), colX[i] + cellPad, y + 2, {
            width: c.w - cellPad * 2, align: c.align,
            // Keep the รหัส (drug code) on a single line (owner 2026-06-07).
            // The "/" in codes like IKGPH/A0226 is a break opportunity, so
            // even with the wider column we explicitly disable wrapping.
            lineBreak: c.key !== "code"
          });
        });
        y += rowH;
        doc.moveTo(left, y - 2).lineTo(right, y - 2).strokeColor("#eeeeee").lineWidth(0.5).stroke();
      });

      // Subtotal row — internal copy only (hidden on the supplier PDF).
      if (!data.hideCost) {
        const totalW = cols[cols.length - 1].w;
        y += 4;
        doc.moveTo(left, y).lineTo(right, y).strokeColor("#888888").lineWidth(0.8).stroke();
        y += 6;
        doc.font("th-b").fontSize(11).fillColor("#1a1a2e");
        doc.text("รวมเป็นเงิน (ทุน)", left, y, { width: contentW - totalW - 10, align: "right" });
        doc.text(baht(subtotal), right - totalW, y, { width: totalW, align: "right" });
        y = doc.y + 10;
      } else {
        y += 6;
      }

      // Note
      if (data.note) {
        doc.font("th").fontSize(9).fillColor("#555555")
          .text(`หมายเหตุ: ${data.note}`, left, y, { width: contentW });
        y = doc.y + 6;
      }

      // ── Signatures ──────────────────────────────────────────────
      const sigY = Math.max(y + 30, bottom - 60);
      const halfW = (contentW - 40) / 2;
      doc.strokeColor("#888888").lineWidth(0.8);
      doc.moveTo(left + 20, sigY).lineTo(left + 20 + halfW, sigY).stroke();
      doc.moveTo(right - halfW - 20, sigY).lineTo(right - 20, sigY).stroke();
      doc.font("th").fontSize(9).fillColor("#555555");
      doc.text(`ผู้ขอสั่งซื้อ${data.requesterName ? " — " + data.requesterName : ""}`,
        left + 20, sigY + 4, { width: halfW, align: "center" });
      doc.text(`ผู้อนุมัติ${data.approverName ? " — " + data.approverName : ""}`,
        right - halfW - 20, sigY + 4, { width: halfW, align: "center" });

      doc.end();
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

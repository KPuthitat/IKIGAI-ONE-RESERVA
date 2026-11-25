// The health check-up booklet as an A5 PDF, laid out like docs/design/health-report-template.pdf (owner 2026-11-25): cover, general
// information, one block per section (navy bar, striped table, cream summary boxes), "what is this test?" pages, the doctor's summary,
// the education page and the back cover. Built from the same Report model as the web page, so the two cannot disagree.
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import path from "node:path";
import fs from "node:fs";
import type { Report, RRow, RSection } from "./report";
import { BACK_COVER } from "./contacts";

const ROOT = process.cwd();
const FONT_REG = path.join(ROOT, "public", "fonts", "LINESeedSansTH-Regular.ttf");
const FONT_BOLD = path.join(ROOT, "public", "fonts", "LINESeedSansTH-Bold.ttf");
const LOGOS = path.join(ROOT, "public", "health-report", "logos.png");
const COVER = path.join(ROOT, "public", "health-report", "cover.jpg");
const NAVY = "#0B1F3A", GOLD = "#D4AF37", CREAM = "#FBF6E9", CREAM_LINE = "#EBDDB4", ROW_A = "#E5E7EB", ROW_B = "#F3F4F6", INK = "#111827", MUTED = "#6B7280", RED = "#B42318";
const PW = 419.53, PH = 595.28, M = 18, W = PW - 2 * M;
const TOP = 86, BOTTOM = PH - 54;

const TH_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
const longDate = (iso: string | null) => { if (!iso) return "—"; const [y, m, d] = iso.slice(0, 10).split("-").map(Number); return `${d} ${TH_MONTHS[m - 1]} ${y + 543}`; };

/** LINE Seed Sans TH has no superscripts, ≥ ≤ µ → or the little squares: write them with plain characters so nothing prints as an empty box. */
const san = (t: string): string => t.replace(/³/g, "^3").replace(/⁶/g, "^6").replace(/²/g, "^2").replace(/≥/g, ">=").replace(/≤/g, "<=").replace(/µ/g, "u").replace(/→/g, "->").replace(/[▪]/g, "•").replace(/◦/g, "o");

export async function generateReportPdf(report: Report, o: { consultUrl: string | null }): Promise<Buffer> {
  const qr = o.consultUrl ? await QRCode.toBuffer(o.consultUrl, { margin: 0, width: 240, color: { dark: "#000000", light: "#FFFFFF" } }) : null;
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: [PW, PH], margin: 0, bufferPages: true, autoFirstPage: false, info: { Title: "Health Check up report", Author: "AT HOME CLINIC · OMNIA HEALTH" } });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c)); doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject);
      doc.registerFont("th", FONT_REG); doc.registerFont("th-b", FONT_BOLD);
      let y = TOP;
      const kinds: Array<"cover" | "page" | "back"> = [];

      const text = (s0: string, x: number, yy: number, w: number, a: { size?: number; bold?: boolean; color?: string; align?: "left" | "center" | "right"; lineGap?: number } = {}) => {
        const s = san(s0);
        doc.font(a.bold ? "th-b" : "th").fontSize(a.size ?? 8).fillColor(a.color ?? INK).text(s, x, yy, { width: w, align: a.align ?? "left", lineGap: a.lineGap ?? 0 });
      };
      const h = (s: string, w: number, size: number, bold = false) => { doc.font(bold ? "th-b" : "th").fontSize(size); return doc.heightOfString(san(s), { width: w }); };
      const line1 = (s: string, x: number, yy: number, w: number, a: Parameters<typeof text>[4] = {}) => {
        doc.font(a.bold ? "th-b" : "th").fontSize(a.size ?? 8).fillColor(a.color ?? INK).text(san(s), x, yy, { width: w, align: a.align ?? "left", lineBreak: false, ellipsis: true, height: (a.size ?? 8) * 1.4 });
      };

      const pageHeader = (title: string, titleEn?: string) => {
        doc.addPage(); kinds.push("page");
        text("Health", M, 14, 80, { size: 21, bold: true, color: NAVY });
        doc.font("th-b").fontSize(8.5).fillColor(NAVY).text("Check up report", M + 74, 21, { lineBreak: false });
        text("รายงานผลการตรวจสุขภาพ", M, 38, 150, { size: 8.5, color: NAVY });
        text("ปรึกษาแพทย์ได้ที่นี่", PW - M - 160, 15, 112, { size: 10.5, bold: true, color: NAVY, align: "right" });
        text("Medical consultation available here", PW - M - 160, 30, 112, { size: 4.8, color: NAVY, align: "right" });
        doc.roundedRect(PW - M - 44, 12, 44, 36, 5).fill("#000000");
        if (qr) { doc.roundedRect(PW - M - 42, 14, 24, 24, 1).fill("#FFFFFF"); doc.image(qr, PW - M - 41, 15, { width: 22, height: 22 }); text("SCAN", PW - M - 17, 17, 16, { size: 5, bold: true, color: "#FFFFFF", align: "center" }); text("ME", PW - M - 17, 25, 16, { size: 7, bold: true, color: "#FFFFFF", align: "center" }); }
        else text("SCAN ME", PW - M - 44, 26, 44, { size: 6, bold: true, color: "#FFFFFF", align: "center" });
        doc.roundedRect(M, 54, W, 20, 8).fill(NAVY);
        const t = titleEn ? `${title} • ${titleEn}` : title;
        text(t, M + 6, 59.5, W - 12, { size: t.length > 62 ? 8 : 9.5, bold: true, color: "#FFFFFF", align: "center" });
        y = TOP;
      };
      const ensure = (need: number, title: string, titleEn?: string) => { if (y + need > BOTTOM) pageHeader(title, titleEn); };

      // ── cover ──
      doc.addPage(); kinds.push("cover");
      const sx = PW / 583, sy = PH / 825;
      doc.save().moveTo(0, 0).lineTo(375 * sx, 0).lineTo(0, 258 * sy).closePath().fill(NAVY).restore();
      doc.save().moveTo(375 * sx, 0).lineTo(PW, 0).lineTo(PW, 410 * sy).lineTo(127 * sx, 172 * sy).closePath().clip();
      try { if (fs.existsSync(COVER)) doc.image(COVER, 90, -10, { height: 330 }); } catch { /* the photo is decoration */ }
      doc.restore();
      doc.save().moveTo(127 * sx, 172 * sy).lineTo(PW, 410 * sy).lineTo(PW, 447 * sy).lineTo(160 * sx, 214 * sy).closePath().fill(GOLD).restore();
      text("Health", 72 * sx, 296, 380, { size: 58, bold: true, color: NAVY });
      text("Check up report", 72 * sx, 372, 380, { size: 27, bold: true, color: NAVY });
      text("รายงานผลการตรวจสุขภาพ", 72 * sx, 404, 380, { size: 22, color: NAVY });
      if (fs.existsSync(LOGOS)) doc.image(LOGOS, 50 * sx, 440, { width: 485 * sx });
      const footer = (n: number | null, total: number | null) => {
        doc.moveTo(M, PH - 38).lineTo(PW - M, PH - 38).strokeColor("#D1D5DB").lineWidth(0.4).stroke();
        if (fs.existsSync(LOGOS)) doc.image(LOGOS, M, PH - 33, { height: 14 });
        if (n != null) text(`หน้าที่ ${String(n).padStart(2, "0")} จาก ${total}`, PW / 2 - 40, PH - 49, 80, { size: 5, align: "center", color: MUTED });
        text(BACK_COVER.social, PW / 2 - 55, PH - 28, 110, { size: 7.5, color: "#374151", align: "center" });
        text(BACK_COVER.slogan[0], PW - M - 100, PH - 31, 100, { size: 6.5, bold: true, color: NAVY, align: "right" });
        text(BACK_COVER.slogan[1], PW - M - 100, PH - 23, 100, { size: 5.8, color: NAVY, align: "right" });
      };

      // ── general information ──
      const g = report.sections.find((s) => s.key === "general");
      pageHeader("รายงานผลการตรวจสุขภาพ", "Health check up report");
      const hd = report.header;
      doc.roundedRect(M, y, W, 22, 6).fill("#E5E7EB");
      text("General information", M + 10, y + 5.5, 100, { size: 9, bold: true });
      text("ข้อมูลส่วนตัวของผู้รับบริการ", M + 112, y + 6.5, 150, { size: 8 });
      y += 28;
      const info: Array<[string, string, string, string]> = [
        ["วันที่ตรวจสุขภาพ", "Check up date", longDate(hd.examDate), ""], ["ชื่อ - นามสกุล", "Name - Surname", hd.name, `อายุ: ${hd.age != null ? hd.age + " ปี" : "—"}`],
        ["ชื่อบริษัท", "Company name", hd.company ?? "—", `รหัสพนักงาน: ${hd.employeeCode ?? "—"}`], ["ตำแหน่ง", "Position", hd.position ?? "—", `แผนก: ${hd.department ?? "—"}`]
      ];
      doc.rect(M, y, W, 76).fill(CREAM);
      info.forEach(([k, e, v, r], i) => { const yy = y + 5 + i * 18; text(`${k} : `, M + 12, yy, 60, { size: 6.5, color: MUTED }); text(v, M + 70, yy - 1, 170, { size: 8.5, bold: true }); text(e, M + 12, yy + 8, 80, { size: 4.8, color: MUTED }); if (r) text(r, M + 248, yy - 1, 130, { size: 8 }); });
      y += 82;
      const row = (code: string) => g?.rows.find((r) => r.code === code);
      const cur = (r: RRow | undefined) => (r ? r.cells[r.cells.length - 1]?.text ?? "-" : "-");
      doc.rect(M, y, W, 16).fill("#E5E7EB");
      text("Past history", M + 6, y + 4, 60, { size: 7.5, bold: true }); text("ประวัติสุขภาพของผู้รับบริการ", M + 56, y + 4.5, 110, { size: 6.5 });
      text(`น้ำหนัก : ${cur(row("WEIGHT"))} กก.   ส่วนสูง : ${cur(row("HEIGHT"))} ซม.`, M + 170, y + 4.5, 200, { size: 7 });
      y += 20;
      const hist: Array<[string, string, string]> = [["หมู่โลหิต", "ABO/Rh Group", cur(row("BLOOD_GROUP"))], ["ความดันโลหิต", "Blood pressure", `${cur(row("BP_SYS"))}/${cur(row("BP_DIA"))} mmHg`], ["ชีพจร", "Pulse", `${cur(row("PULSE"))} ครั้ง/นาที`],
        ["ประวัติสูบบุหรี่", "History of smoking", cur(row("SMOKING"))], ["ประวัติแพ้ยา/อาหาร", "History of Food / Drug allergy", cur(row("ALLERGY"))], ["ประวัติโรคประจำตัว", "History of Underlying disease", cur(row("UNDERLYING"))], ["ประวัติดื่มสุรา", "History of Alcohol drinking", cur(row("ALCOHOL"))]];
      hist.forEach(([k, e, v], i) => { const cx = M + 4 + (i % 3) * 126, cy = y + Math.floor(i / 3) * 22; text(`${k} : ${v}`, cx, cy, 124, { size: 6.5 }); text(e, cx, cy + 8, 124, { size: 4.6, color: MUTED }); });
      y += Math.ceil(hist.length / 3) * 22 + 6;
      doc.rect(M, y, W, 15).fill("#E5E7EB");
      text("Physical examination", M + 6, y + 4, 100, { size: 7.5, bold: true }); text("ผลการตรวจร่างกาย", M + 200, y + 4, 80, { size: 7, bold: true, align: "center" }); text("ค่าอ้างอิง", M + 310, y + 4, 60, { size: 7, bold: true, align: "center" });
      y += 18;
      const exam = (g?.rows ?? []).filter((r) => r.code.startsWith("EX_"));
      exam.forEach((r, i) => {
        doc.rect(M, y, W, 16).fill(i % 2 ? ROW_B : ROW_A);
        const [en, thp] = [r.en, r.th];
        doc.font("th-b").fontSize(7.5); const ew = doc.widthOfString(en); text("•", M + 8, y + 4, 6, { size: 8 }); text(en, M + 16, y + 4.5, 130, { size: 7.5, bold: true }); text(`( ${thp} )`, M + 20 + ew, y + 5, 150, { size: 6.5 });
        const c = r.cells[r.cells.length - 1];
        text(c?.text ?? "-", M + 200, y + 4.5, 80, { size: 7.5, align: "center", bold: c?.flag === "abnormal", color: c?.flag === "abnormal" ? RED : INK }); text("Normal (ปกติ)", M + 310, y + 5.5, 60, { size: 6, align: "center", color: MUTED });
        y += 17;
      });
      y += 6;
      text("สรุปผลการตรวจร่างกาย :", M + 6, y, 140, { size: 8, bold: true }); text("Summary of Physical examination", M + 6, y + 9, 140, { size: 5.5, color: MUTED });
      const bmiLine = (g?.lines ?? []).find((l) => l.startsWith("ดัชนีมวลกาย"));
      text("ค่าดัชนีมวลกาย :", M + 230, y, 90, { size: 8, bold: true }); text("Body Mass Index : BMI", M + 230, y + 9, 90, { size: 5.5, color: MUTED });
      text(cur(row("BMI")), M + 318, y, 30, { size: 8, bold: true });
      y += 20;
      if (bmiLine) text(`- ${bmiLine.replace(/^ดัชนีมวลกาย\s[\d.]+\sกก\.\/ตร\.ม\.\s—\s/, "")}`, M + 14, y, W - 28, { size: 7 });
      const gNote = g?.note; if (gNote?.summary) { y += 12; text(`- ${gNote.summary}`, M + 14, y, W - 28, { size: 7 }); }

      // ── a table section ──
      const years = report.years.length ? report.years : [0];
      const colName = 128, colYear = 40, colRef = 80;
      const colUnit = W - colName - colYear * years.length - colRef;
      const tableHead = (s: RSection) => {
        text("ค่าที่ตรวจได้", M, y, colName, { size: 7.5, bold: true, align: "center" });
        years.forEach((yr, i) => { const cx = M + colName + i * colYear; text(String(yr || "ผล"), cx, y, colYear, { size: 7.5, bold: i === years.length - 1, align: "center", color: NAVY }); doc.moveTo(cx + 10, y + 9).lineTo(cx + colYear - 10, y + 9).strokeColor(NAVY).lineWidth(0.4).stroke(); });
        text("ค่าอ้างอิง", M + colName + colYear * years.length, y, colRef, { size: 7.5, bold: true, align: "center" }); text("หน่วย", M + W - colUnit, y, colUnit, { size: 7.5, bold: true, align: "center" });
        y += 13;
        void s;
      };
      const rowH = (r: RRow) => Math.max(21, 7 + Math.min(3, (r.ref.split("\n").length)) * 7);
      const tableSection = (s: RSection) => {
        pageHeader(s.th, s.en);
        if (s.intro && !s.rows.some((r) => r.explain)) { const hh = h(s.intro.body, W - 8, 6.5); text(s.intro.body, M + 4, y, W - 8, { size: 6.5 }); y += hh + 6; }
        tableHead(s);
        s.rows.forEach((r, i) => {
          const rh = rowH(r);
          if (y + rh > BOTTOM - 70) { pageHeader(s.th, s.en); tableHead(s); }
          doc.roundedRect(M, y, W, rh - 1.5, 3).fill(i % 2 ? ROW_B : ROW_A);
          line1(r.en, M + 8, y + 3, colName - 10, { size: 8, bold: true }); line1(r.th, M + 8, y + 13.5, colName - 10, { size: 5.6, color: "#374151" });
          r.cells.forEach((c, k) => { const last = k === r.cells.length - 1; const cx = M + colName + k * colYear; line1(c.text, cx, last && r.flagWord ? y + 1.5 : y + (rh - 10) / 2 - 1, colYear, { size: last ? 8.5 : 7.5, bold: last, align: "center", color: last && r.flagWord ? RED : last ? INK : MUTED }); if (last && r.flagWord) { const w = r.flagWord; const ty = y + 13.5; const tw = 4.2; const tx = cx + colYear / 2 - (w.length * 2.7 + tw + 2) / 2; if (w === "สูง") doc.polygon([tx, ty + 4.5], [tx + tw, ty + 4.5], [tx + tw / 2, ty]).fill(RED); else if (w === "ต่ำ" || w === "ลดลง") doc.polygon([tx, ty], [tx + tw, ty], [tx + tw / 2, ty + 4.5]).fill(RED); line1(w, tx + tw + 2, ty - 1.5, colYear, { size: 5.8, bold: true, align: "left", color: RED }); } });
          const refLines = r.ref.split("\n").slice(0, 3);
          refLines.forEach((rl, k) => line1(rl, M + colName + colYear * years.length + 2, y + (rh - 1.5 - refLines.length * 7) / 2 + k * 7, colRef - 4, { size: 5.6, align: "center", color: "#374151" }));
          line1(r.unit || "-", M + W - colUnit, y + (rh - 10) / 2, colUnit - 2, { size: 6, align: "center", color: "#374151" });
          y += rh;
        });
        y += 4;
        const box = (title: string, titleEn: string, lines: string[]) => {
          const body = lines.filter(Boolean);
          if (!body.length) return;
          const bh = 14 + body.reduce((a, l) => a + h(l, W - 40, 7) + 3, 0) + 8;
          if (y + bh > BOTTOM) { pageHeader(s.th, s.en); }
          doc.roundedRect(M, y, W, bh, 5).fillAndStroke(CREAM, CREAM_LINE);
          text(title, M + 10, y + 5, W - 20, { size: 8, bold: true }); text(titleEn, M + 10, y + 14, W - 20, { size: 5.4, color: MUTED });
          let yy = y + 22; for (const l of body) { text(`- ${l}`, M + 18, yy, W - 36, { size: 7 }); yy += h(l, W - 40, 7) + 3; }
          y += bh + 4;
        };
        box(`สรุปผล${s.th.replace(/^ผลการตรวจ|^ตรวจ/, "")} :`, `Summary of ${s.en}`, [...s.lines, ...(s.note?.summary ? s.note.summary.split("\n") : [])]);
        if (s.note?.recommendation) box("คำแนะนำโดยแพทย์ :", "Doctor's recommendation", s.note.recommendation.split("\n"));
      };

      // "what is this test?" page (as in the booklet, after the CBC / urine / chemistry tables)
      const explainPage = (s: RSection) => {
        const rows = s.rows.filter((r) => !!r.explain);
        if (!rows.length) return;
        pageHeader(s.th, s.en);
        if (s.intro) { const hh = h(s.intro.body, W - 8, 6.8); text(s.intro.body, M + 4, y, W - 8, { size: 6.8 }); y += hh + 8; }
        rows.forEach((r, i) => {
          const th = h(r.explain!, 215, 6.3), rh = Math.max(20, th + 8);
          if (y + rh > BOTTOM) { pageHeader(s.th, s.en); }
          doc.roundedRect(M, y, W, rh - 1.5, 3).fill(i % 2 ? ROW_B : ROW_A);
          line1(r.en, M + 8, y + 3, 140, { size: 7.6, bold: true }); line1(r.th, M + 8, y + 12.5, 140, { size: 5.2, color: "#374151" });
          text(r.explain!, M + 160, y + 4, 215, { size: 6.3 });
          y += rh;
        });
      };

      const order = ["cbc", "ua", "chem", "audio", "vision", "pft"];
      for (const key of order) {
        const s = report.sections.find((x) => x.key === key); if (!s) continue;
        tableSection(s);
        if (key === "audio" && s.edu) {
          const hh = h(s.edu.body, W - 16, 5.9) + 22;
          if (y + hh > BOTTOM) pageHeader(s.th, s.en);
          doc.roundedRect(M, y, W, 20, 4).fill("#E5E7EB"); text(s.edu.title.split("·")[0].trim(), M + 8, y + 5, W - 16, { size: 8, bold: true }); y += 24;
          text(s.edu.body, M + 8, y, W - 16, { size: 5.9 }); y += hh - 18;
        }
        if (key === "cbc" || key === "ua" || key === "chem") explainPage(s);
      }
      // imaging + other lab + stool + cervical + drug
      for (const key of ["cxr", "ecg"]) {
        const s = report.sections.find((x) => x.key === key); if (!s) continue;
        ensure(120, s.th, s.en);
        if (key === "cxr") pageHeader(s.th, s.en); else { doc.roundedRect(M, y, W, 20, 8).fill(NAVY); text(`${s.th} • ${s.en}`, M + 6, y + 5.5, W - 12, { size: 8.5, bold: true, color: "#FFFFFF", align: "center" }); y += 28; }
        const lines = [...s.lines, ...(s.note?.summary ? s.note.summary.split("\n") : []), ...(s.note?.recommendation ? [s.note.recommendation] : [])];
        const bh = Math.max(90, 24 + lines.reduce((a, l) => a + h(l, W - 40, 7) + 3, 0));
        doc.roundedRect(M, y, W, bh, 5).fillAndStroke(CREAM, CREAM_LINE);
        text(`สรุปผล${s.th}`, M + 10, y + 6, W - 20, { size: 8, bold: true }); let yy = y + 22; for (const l of lines) { text(`- ${l}`, M + 18, yy, W - 36, { size: 7 }); yy += h(l, W - 40, 7) + 3; }
        y += bh + 8;
        if (s.edu) { const hh = h(s.edu.body, W - 16, 5.9) + 20; if (y + hh > BOTTOM) pageHeader(s.th, s.en); doc.roundedRect(M, y, W, 16, 4).fill("#E5E7EB"); text(s.edu.title.split("·")[0].trim(), M + 8, y + 4, W - 16, { size: 7.5, bold: true }); y += 19; text(s.edu.body, M + 8, y, W - 16, { size: 5.9 }); y += hh - 16; }
        if (s.file) { text("(ภาพ/ไฟล์ผลตรวจแนบในพอร์ทัล)", M + 8, y, W - 16, { size: 6, color: MUTED }); y += 10; }
      }
      const labs = ["other", "stool", "cervical", "drug"].map((k) => report.sections.find((x) => x.key === k)).filter((x): x is RSection => !!x);
      if (labs.length) {
        const first = labs[0];
        pageHeader("รายการตรวจทางห้องปฏิบัติการอื่นๆ", "Other laboratory examination");
        for (const s of labs) {
          if (s.key !== "other") { ensure(30, "รายการตรวจทางห้องปฏิบัติการอื่นๆ", "Other laboratory examination"); text(`${s.en} · ${s.th}`, M + 4, y, W - 8, { size: 8, bold: true }); y += 13; }
          s.rows.forEach((r, i) => {
            const rh = Math.max(21, 7 + Math.min(4, r.ref.split("\n").length) * 6.5);
            if (y + rh > BOTTOM - 40) pageHeader("รายการตรวจทางห้องปฏิบัติการอื่นๆ", "Other laboratory examination");
            doc.roundedRect(M, y, W, rh - 1.5, 3).fill(i % 2 ? ROW_B : ROW_A);
            line1(r.en, M + 8, y + 3, 150, { size: 7.6, bold: true }); line1(r.th, M + 8, y + 13.5, 150, { size: 5.2, color: "#374151" });
            const c = r.cells[r.cells.length - 1]; line1(c?.text ?? "-", M + 165, y + (rh - 10) / 2, 70, { size: 8, bold: true, align: "center", color: r.flagWord ? RED : INK });
            const rl = r.ref.split("\n").slice(0, 4); rl.forEach((t, k) => line1(t, M + 240, y + (rh - 1.5 - rl.length * 6.5) / 2 + k * 6.5, W - 240 - 36, { size: 5.2, align: "center", color: "#374151" }));
            line1(r.unit || "-", M + W - 36, y + (rh - 10) / 2, 34, { size: 6, align: "center", color: "#374151" });
            y += rh;
          });
          const lines = [...s.lines, ...(s.note?.summary ? s.note.summary.split("\n") : []), ...(s.note?.recommendation ? [s.note.recommendation] : [])].filter(Boolean);
          if (lines.length) { const bh = 14 + lines.reduce((a, l) => a + h(l, W - 40, 7) + 3, 0) + 6; if (y + bh > BOTTOM) pageHeader("รายการตรวจทางห้องปฏิบัติการอื่นๆ", "Other laboratory examination"); doc.roundedRect(M, y, W, bh, 5).fillAndStroke(CREAM, CREAM_LINE); let yy = y + 7; for (const l of lines) { text(`- ${l}`, M + 12, yy, W - 28, { size: 7 }); yy += h(l, W - 40, 7) + 3; } y += bh + 4; }
        }
        void first;
      }

      // ── the doctor's overall summary and recommendation ──
      const ov = report.summary.overall;
      pageHeader("สรุปผลการตรวจสุขภาพ", "Summary and recommendation");
      if (ov.verdict) { doc.roundedRect(M, y, W, 22, 6).fill(CREAM); text(`ภาพรวมผลตรวจ : ${ov.verdict}`, M + 10, y + 6, W - 20, { size: 9, bold: true }); y += 28; }
      if (report.summary.abnormal.length) {
        text(`รายการที่ผิดปกติ (${report.summary.abnormal.length})`, M + 4, y, W, { size: 8.5, bold: true }); y += 13;
        for (const a of report.summary.abnormal) { const t = `• ${a.name} ${a.value} (${a.word}) — ${a.section}`; const hh = h(t, W - 12, 6.8); if (y + hh > BOTTOM) pageHeader("สรุปผลการตรวจสุขภาพ", "Summary and recommendation"); text(t, M + 8, y, W - 12, { size: 6.8 }); y += hh + 2; }
        y += 6;
      }
      const sum = [ov.summary, ...(report.sections.map((s) => s.note?.summary).filter(Boolean) as string[])].filter(Boolean);
      const rec = [ov.recommendation, ...(report.sections.map((s) => s.note?.recommendation).filter(Boolean) as string[])].filter(Boolean);
      for (const [title, titleEn, arr] of [["สรุปผลการตรวจสุขภาพ", "Summary", sum], ["คำแนะนำของแพทย์", "Doctor's recommendation", rec]] as Array<[string, string, string[]]>) {
        if (!arr.length) continue;
        const bh = 20 + arr.reduce((a, l) => a + h(l, W - 40, 7.2) + 4, 0) + 6;
        if (y + bh > BOTTOM) pageHeader("สรุปผลการตรวจสุขภาพ", "Summary and recommendation");
        doc.roundedRect(M, y, W, bh, 5).fillAndStroke(CREAM, CREAM_LINE); text(title, M + 10, y + 5, W - 20, { size: 8.5, bold: true }); text(titleEn, M + 10, y + 14.5, W - 20, { size: 5.4, color: MUTED });
        let yy = y + 24; for (const l of arr) { text(`- ${l}`, M + 16, yy, W - 34, { size: 7.2 }); yy += h(l, W - 40, 7.2) + 4; } y += bh + 6;
      }
      for (const k of ["vision", "pft"]) {
        const s = report.sections.find((x) => x.key === k); if (!s?.edu) continue;
        const [tth, ten] = s.edu.title.split("·").map((x) => x.trim());
        const bh = 26 + h(s.edu.body, W - 20, 6) + 6;
        if (y + bh > BOTTOM) pageHeader("สรุปผลการตรวจสุขภาพ", "Summary and recommendation");
        doc.roundedRect(M, y, W, 22, 5).fill("#E5E7EB"); text(tth, M + 8, y + 3, W - 16, { size: 7.8, bold: true }); text(ten ?? "", M + 8, y + 13, W - 16, { size: 5.6 }); y += 26;
        text(s.edu.body, M + 10, y, W - 20, { size: 6 }); y += bh - 22;
      }

      // ── back cover ──
      doc.addPage(); kinds.push("back");
      doc.save().moveTo(0, 0).lineTo(375 * sx, 0).lineTo(0, 258 * sy).closePath().fill(NAVY).restore();
      doc.save().moveTo(375 * sx, 0).lineTo(PW, 0).lineTo(PW, 410 * sy).lineTo(127 * sx, 172 * sy).closePath().clip();
      try { if (fs.existsSync(COVER)) doc.image(COVER, 90, -10, { height: 330 }); } catch { /* decoration */ }
      doc.restore();
      doc.save().moveTo(127 * sx, 172 * sy).lineTo(PW, 410 * sy).lineTo(PW, 447 * sy).lineTo(160 * sx, 214 * sy).closePath().fill(GOLD).restore();
      text(BACK_COVER.slogan[0], 74 * sx, 376 * sy, 400, { size: 17, bold: true }); text(BACK_COVER.slogan[1], 74 * sx, 402 * sy, 400, { size: 14 });
      let by = 436 * sy;
      for (const c of BACK_COVER.companies) {
        text(c.name, 74 * sx, by, 440, { size: 8.5, bold: true }); by += 12.5;
        text(c.address, 74 * sx, by, 440, { size: 6.5, color: "#4B5563" }); by += h(c.address, 440 * sx, 6.5) + 1.5;
        text(`เลขประจำตัวผู้เสียภาษีนิติบุคคล ${c.taxId}`, 74 * sx, by, 440, { size: 6.5, color: "#4B5563" }); by += 10;
        doc.circle(74 * sx + 4, by + 4, 4).fill(NAVY); text(c.email, 74 * sx + 11, by, 160, { size: 6.5, color: "#4B5563" });
        doc.circle(74 * sx + 168, by + 4, 4).fill(NAVY); text(c.phone, 74 * sx + 175, by, 190, { size: 6.5, color: "#4B5563" }); by += 20;
      }
      if (fs.existsSync(LOGOS)) doc.image(LOGOS, 40 * sx, 478, { width: 330 * sx });
      if (qr) { doc.roundedRect(PW - M - 50, PH - 100, 50, 42, 5).fill("#000000"); doc.roundedRect(PW - M - 47, PH - 97, 27, 27, 1).fill("#FFFFFF"); doc.image(qr, PW - M - 46, PH - 96, { width: 25, height: 25 }); text("SCAN", PW - M - 18, PH - 95, 16, { size: 5.4, bold: true, color: "#FFFFFF", align: "center" }); text("ME", PW - M - 18, PH - 87, 16, { size: 8, bold: true, color: "#FFFFFF", align: "center" }); }

      // ── footers: every page except the cover and back cover carries "หน้าที่ X จาก Y" ──
      const range = doc.bufferedPageRange();
      const content = kinds.filter((k) => k === "page").length;
      let n = 0;
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        doc.page.margins.bottom = 0;
        if (kinds[i] === "page") { n++; footer(n, content); } else footer(null, null);
      }
      doc.end();
    } catch (e) { reject(e); }
  });
}

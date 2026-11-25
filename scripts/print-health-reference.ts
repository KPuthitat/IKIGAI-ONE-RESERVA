// Writes docs/health-report-reference-ranges.md from the catalogue — the table the doctor checks before the values are used.
// Run: node --import tsx scripts/print-health-reference.ts
import fs from "node:fs";
import { ITEMS, SECTIONS } from "../src/lib/health-report/catalog";
import { refLabel } from "../src/lib/health-report/interpret";

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
const lines: string[] = [
  "# ตารางค่าอ้างอิง — เล่มผลตรวจสุขภาพ (สร้างอัตโนมัติจาก `src/lib/health-report/catalog.ts`)",
  "",
  "ค่าทั้งหมดคัดจากเล่มต้นแบบ `docs/design/health-report-template.pdf` · **ยึดตามเล่มต้นแบบทั้งหมด (เจ้าของยืนยัน 2569-11-25)** ·",
  "คอลัมน์ \"ช่วงที่ยอมรับได้\" คือช่วงที่เป็นไปได้ของคนจริง ใช้ถามยืนยันตอนกรอก (เช่น น้ำตาล 1590 จะถามก่อนบันทึก) ไม่ใช่ค่าอ้างอิงทางการแพทย์",
  ""
];
for (const s of SECTIONS) {
  const items = ITEMS.filter((i) => i.section === s.key);
  if (!items.length) continue;
  lines.push(`## ${s.th} · ${s.en}`, "", "| รหัส | รายการ | หน่วย | ค่าอ้างอิง | ช่วงที่ยอมรับได้ | หมายเหตุ |", "|---|---|---|---|---|---|");
  for (const i of items) {
    const note = [i.check ? "⚠ ขอให้แพทย์ยืนยัน" : "", i.hidden ? "ไม่แสดงในเล่ม" : "", i.restricted ? "เห็นเฉพาะแพทย์และเจ้าตัว" : "", i.computed ? `คำนวณอัตโนมัติ (${i.computed})` : ""].filter(Boolean).join(" · ");
    const ref = i.kind === "choice" && !i.refText ? `ปกติ = ${Array.isArray(i.normal) ? i.normal.join(", ") : "แสดงผลอย่างเดียว"}` : (refLabel(i) || "—");
    lines.push(`| ${i.code} | ${cell(i.en)} | ${cell(i.unit ?? "")} | ${cell(ref)} | ${i.plausible ? `${i.plausible[0]} – ${i.plausible[1]}` : ""} | ${note} |`);
  }
  lines.push("");
}
lines.push("## กติกาแปลผล (ใช้ตามที่เจ้าของระบบกำหนด)", "",
  "- **การได้ยิน:** เกิน 25 เดซิเบลถือว่าลดลงที่ความถี่นั้น เขียนว่า \"การได้ยินของหู[ขวา/ซ้าย]ลดลงที่ความถี่ …\" ถ้าทั้ง 7 ความถี่เกิน 25 เขียน \"ลดลงทุกความถี่\" หูขวาและซ้ายอยู่บรรทัดเดียวคั่นด้วย ` / ` (ถ้าหูข้างใดปกติ ผมเขียนว่า \"ปกติ\" ในบรรทัดเดียวกัน — **คำนี้ผมเลือกเอง ขอให้ยืนยัน**)",
  "- **ปอด:** FEV1/FVC ผิดปกติเมื่อ ≤ 75 ในอายุต่ำกว่า 50 ปี และ ≤ 70 ในอายุ 50 ปีขึ้นไป · FVC และ FEV1 ผิดปกติเมื่อ ≤ 80% ของค่าคาดคะเน · ไม่ใช้ FEF25-75 · ต่ำเฉพาะอัตราส่วน = กลุ่มก้ำกึ่ง · **การแบ่งเป็นแบบอุดกั้น/จำกัดการขยายตัว/ผสม เป็นการตีความของผมตามหน้าอธิบายในเล่ม ขอให้แพทย์ยืนยัน**",
  "- **ค่าที่แจ้งเตือนแพทย์ทันที:** เอนไซม์ตับ (AST, ALT) เกิน 5 เท่าของค่าสูงสุดที่อ้างอิง (ตั้งค่าได้) · ค่าเริ่มต้นอื่นที่ผมใส่เอง **ขอให้แพทย์ยืนยัน:** น้ำตาล < 50 หรือ > 400, Hb < 7, เกล็ดเลือด < 20 หรือ > 1000, เม็ดเลือดขาว < 2 หรือ > 30",
  "- **ดัชนีมวลกาย:** น้ำหนัก ÷ ส่วนสูง² ใช้เกณฑ์เอเชีย-แปซิฟิก (< 18.5 ต่ำกว่าเกณฑ์, 18.5–22.9 ปกติ, 23–24.9 น้ำหนักเกิน, 25–29.9 อ้วนระดับ 1, ≥ 30 อ้วนระดับ 2) **ขอให้แพทย์ยืนยัน**",
  "- **ค่าที่คำนวณอัตโนมัติ:** Globulin = Total protein − Albumin · Indirect bilirubin = Total − Direct", "");
fs.writeFileSync("docs/health-report-reference-ranges.md", lines.join("\n"));
console.log(`wrote ${ITEMS.length} items`);

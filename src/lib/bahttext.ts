// Thai baht text — turns a number into คำอ่านภาษาไทย for documents like the
// substitute-receipt (ใบรับรองแทนใบเสร็จรับเงิน). Pure; client+server safe.
// Handles เอ็ด / ยี่สิบ / สิบ rules and ล้าน chunking; satang to ถ้วน/สตางค์.

const TH_DIGIT = ["ศูนย์", "หนึ่ง", "สอง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "แปด", "เก้า"];
const TH_PLACE = ["", "สิบ", "ร้อย", "พัน", "หมื่น", "แสน"];

/** Read a 1–6 digit chunk (leading zeros ignored). */
function readUpTo6(raw: string): string {
  const s = raw.replace(/^0+/, "");
  if (s === "") return "";
  const len = s.length;
  let out = "";
  for (let i = 0; i < len; i++) {
    const d = Number(s[i]);
    const place = len - 1 - i;
    if (d === 0) continue;
    if (place === 0 && d === 1 && len > 1) out += "เอ็ด";
    else if (place === 1 && d === 2) out += "ยี่สิบ";
    else if (place === 1 && d === 1) out += "สิบ";
    else out += TH_DIGIT[d] + TH_PLACE[place];
  }
  return out;
}

/** Read a whole non-negative integer (chunked by ล้าน every 6 digits). */
function readInteger(nStr: string): string {
  const s = nStr.replace(/^0+/, "");
  if (s === "") return "ศูนย์";
  const chunks: string[] = [];
  let rest = s;
  while (rest.length > 6) { chunks.unshift(rest.slice(-6)); rest = rest.slice(0, -6); }
  chunks.unshift(rest);
  let out = "";
  for (let i = 0; i < chunks.length; i++) {
    const seg = readUpTo6(chunks[i]);
    if (seg) out += seg;
    if (i < chunks.length - 1) out += "ล้าน";
  }
  return out;
}

/** "1,999.50" → "หนึ่งพันเก้าร้อยเก้าสิบเก้าบาทห้าสิบสตางค์". */
export function bahtText(amount: number): string {
  if (!Number.isFinite(amount)) return "";
  const neg = amount < 0;
  const a = Math.abs(Math.round(amount * 100) / 100);
  const baht = Math.floor(a);
  const satang = Math.round((a - baht) * 100);
  let text = readInteger(String(baht)) + "บาท";
  text += satang === 0 ? "ถ้วน" : readInteger(String(satang)) + "สตางค์";
  return (neg ? "ลบ" : "") + text;
}

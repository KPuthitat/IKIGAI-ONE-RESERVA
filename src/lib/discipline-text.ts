// Client-safe wording + severity ladder for the "forgot to clock out" warning
// (owner 2026-10-04). Shared by the server (what gets recorded) and the staff
// form (what the person is shown before pressing รับทราบ), so the two can never
// drift apart.

export type MissingOutSeverity = "verbal" | "written_1" | "written_2";

/** Stepped ladder by how many "ลงเวลา" notes the person already has in the last
 *  12 months: first lapse = a light verbal note, 2nd–3rd = a written letter,
 *  4th+ = second written letter. Never auto-escalates to a final warning — that
 *  stays an admin decision. */
export function missingOutSeverity(priorCount: number): MissingOutSeverity {
  if (priorCount <= 0) return "verbal";
  if (priorCount <= 2) return "written_1";
  return "written_2";
}

const SEVERITY_TH: Record<MissingOutSeverity, string> = {
  verbal: "ตักเตือนด้วยวาจา",
  written_1: "หนังสือเตือนลายลักษณ์อักษร ครั้งที่ 1",
  written_2: "หนังสือเตือนลายลักษณ์อักษร ครั้งที่ 2"
};

function dateTh(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const months = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
  return `${d} ${months[m - 1]} พ.ศ. ${y + 543}`;
}

export function missingOutWarningText(priorCount: number, workDate: string): {
  severity: MissingOutSeverity; severityLabel: string; title: string; body: string; isWritten: boolean;
} {
  const severity = missingOutSeverity(priorCount);
  const nth = priorCount + 1;
  const written = severity !== "verbal";
  return {
    severity,
    severityLabel: SEVERITY_TH[severity],
    isWritten: written,
    title: written
      ? `หนังสือเตือน: ไม่ลงเวลาออกงาน (ครั้งที่ ${nth})`
      : "ตักเตือน: ไม่ลงเวลาออกงาน",
    body: `พนักงานไม่ได้ลงเวลาออกงานของวันที่ ${dateTh(workDate)} (ครั้งที่ ${nth} ในรอบ 12 เดือน) ` +
      `ซึ่งเป็นการละเลยหน้าที่ลงเวลาตามระเบียบของบริษัท พนักงานรับทราบ และรับรองเวลาออกงานที่ถูกต้องผ่านระบบแล้ว ` +
      `หากเกิดซ้ำจะถูกพิจารณาโทษทางวินัยตามลำดับ`
  };
}

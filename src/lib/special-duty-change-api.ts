// LINE notices for changing who does a special-duty day (owner 2026-11-01). Shared by the manager and employee API
// routes — route files may only export handlers, so the helpers live here.
import { getDb } from "./db";
import { noticeFlex, pushIndividually } from "./special-duty-notify";
import { managerLineIds } from "./special-duty-swap";
import type { ChangeRequestView, replaceDutyWorker } from "./special-duty-evidence";

const base = () => (process.env.NEXT_PUBLIC_PUBLIC_BASE_URL || "").replace(/\/$/, "");
const lineOf = (id: number | null) => id == null ? null : (getDb().prepare("SELECT line_user_id AS l FROM users WHERE id = ?").get(id) as { l: string | null } | undefined)?.l ?? null;
const TH_M = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
export const thDate = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return `${d} ${TH_M[m - 1]} ${y + 543}`; };
const log = (e: unknown) => console.error("duty change push", e);

/** After a change: the new person is told what to do, the person replaced is told why (the reason is not shown to the new person). */
export function pushReplacement(r: ReturnType<typeof replaceDutyWorker>, ym: string, staffUrlMonth = ym): void {
  const url = `${base()}/staff/persona/special-duty?month=${staffUrlMonth}`;
  const when = thDate(r.date);
  pushIndividually([lineOf(r.toUserId)], noticeFlex({ title: "ได้รับมอบหมายตำแหน่งงานค่าตอบแทนพิเศษ", lines: [`${r.positionName} · ${when}`, r.afterWork ? "ผู้จัดการระบุว่าท่านเป็นผู้ปฏิบัติงานจริงในวันนี้" : "ผู้จัดการมอบหมายให้ท่านปฏิบัติงานแทนในวันนี้"], url, button: "เปิดดู" })).catch(log);
  pushIndividually([lineOf(r.fromUserId)], noticeFlex({ title: "เปลี่ยนผู้ปฏิบัติงานตำแหน่งงานพิเศษ", lines: [`${r.positionName} · ${when}`, `เปลี่ยนผู้ปฏิบัติงานแทนท่าน · สาเหตุ: ${r.reasonText}`], url, button: "เปิดดู" })).catch(log);
}

/** An employee asked: tell the branch managers. */
export function pushChangeRequested(v: ChangeRequestView, ym: string): void {
  pushIndividually(managerLineIds(branchOfDay(v.dayId)), noticeFlex({
    title: "มีคำขอเปลี่ยนผู้ปฏิบัติงานตำแหน่งงานพิเศษ",
    lines: [`${v.requesterName} · ${v.positionName} · ${thDate(v.date)}`, `สาเหตุ: ${v.reasonText}`, v.proposedName ? `เสนอให้ ${v.proposedName} ทำแทน` : "ยังไม่ได้เสนอผู้ทำแทน"],
    url: `${base()}/admin/persona/special-duty?month=${ym}`, button: "เปิดดู"
  })).catch(log);
}

function branchOfDay(dayId: number): number {
  return (getDb().prepare("SELECT p.branch_id AS b FROM special_duty_days d JOIN special_duty_positions p ON p.id = d.position_id WHERE d.id = ?").get(dayId) as { b: number }).b;
}

/** The manager answered: tell the employee who asked. (An approval also tells the two people through pushReplacement.) */
export function pushChangeDecided(requesterId: number, positionName: string, date: string, approved: boolean, decisionNote: string | null, ym: string): void {
  pushIndividually([lineOf(requesterId)], noticeFlex({
    title: approved ? "อนุมัติการเปลี่ยนผู้ปฏิบัติงานแล้ว" : "ไม่อนุมัติการเปลี่ยนผู้ปฏิบัติงาน",
    lines: [`${positionName} · ${thDate(date)}`, ...(decisionNote ? [`หมายเหตุ: ${decisionNote}`] : []), ...(approved ? [] : ["ท่านยังคงเป็นผู้ปฏิบัติงานวันนี้"])],
    url: `${base()}/staff/persona/special-duty?month=${ym}`, button: "เปิดดู"
  })).catch(log);
}

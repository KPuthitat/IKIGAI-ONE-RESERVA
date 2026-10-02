// IR — LINE Flex card to the RM team's group when a new incident report is
// filed (owner 2026-10-02). Pushed via the platform OA to the branch's
// configured group (ir_settings.line_group_id). Never blocks the filing: the
// route fires it and moves on; a missing group / token just logs and skips.

import { sendLinePush, type LineFlexMessage } from "./line";
import { getPlatformChannel } from "./messaging-channels";
import { getDb } from "./db";
import { publicBaseUrl } from "./line-login";
import { nameWithPrefix } from "./name";
import {
  getReportDetail, getIrLineGroupId, severityMeta, statusMeta, categoryLabel, incidentTypeLabel, personRoleLabel,
  type IrReportDetail
} from "./ir-db";

export type IrCardMeta = { branchName: string; reportUrl: string | null };

const SEVERITY_COLOR: Record<number, string> = {
  1: "#10b981", 2: "#0ea5e9", 3: "#f59e0b", 4: "#f97316", 5: "#e11d48"
};

function clip(s: string | null | undefined, max: number): string {
  const t = (s ?? "").trim().replace(/\s+\n/g, "\n");
  if (!t) return "—";
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
function fmtWhen(s: string): string {
  const d = new Date(s.includes("T") || s.includes(" ") ? s : `${s}T00:00:00`);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString("th-TH", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function kv(label: string, value: string, color = "#1a1a2e"): unknown {
  return {
    type: "box", layout: "horizontal", contents: [
      { type: "text", text: label, size: "sm", color: "#666666", flex: 4, wrap: true },
      { type: "text", text: value, size: "sm", color, flex: 6, wrap: true }
    ]
  };
}
function section(title: string, text: string): unknown[] {
  return [
    { type: "text", text: title, size: "xs", weight: "bold", color: "#0e2724", margin: "md" },
    { type: "text", text, size: "sm", color: "#333333", wrap: true }
  ];
}

/** The "new incident report" card. Pure — takes the detail row + meta. */
export function irNewReportFlex(r: IrReportDetail, meta: IrCardMeta): LineFlexMessage {
  const sev = severityMeta(r.severity);
  const color = SEVERITY_COLOR[r.severity] ?? "#0e2724";
  const reporter = r.is_anonymous
    ? "ไม่ระบุตัวตน"
    : `${r.reporter_name ? nameWithPrefix(r.reporter_prefix, r.reporter_name) : "—"}${r.self_involved === 1 ? " (ผู้เกี่ยวข้องโดยตรง)" : ""}`;
  const people = r.people.length
    ? r.people.map((p) => `${p.name} · ${personRoleLabel(p.role)}`).join("\n")
    : null;
  const body: unknown[] = [
    kv("ระดับ", `${sev.value} · ${sev.labelTh}`, color),
    kv("หมวด", `${categoryLabel(r.category)} · ${incidentTypeLabel(r.incident_type)}`),
    kv("เกิดเมื่อ", `${fmtWhen(r.occurred_at)}${r.location_detail ? ` · ${r.location_detail}` : ""}`),
    kv("ผู้แจ้ง", reporter),
    ...(people ? [kv("ผู้เกี่ยวข้อง", people)] : []),
    { type: "separator", margin: "md", color: "#eeeeee" },
    ...section("เกิดอะไรขึ้น", clip(r.description, 300)),
    ...(r.impact ? section("ผลกระทบ", clip(r.impact, 160)) : []),
    ...(r.reporter_root_cause ? section("สาเหตุราก (ผู้แจ้ง)", clip(r.reporter_root_cause, 200)) : []),
    ...(r.rca.recommendations.length
      ? section("ข้อเสนอแนะ (ผู้แจ้ง)", r.rca.recommendations.slice(0, 3).map((x, i) => `${i + 1}. ${clip(x, 90)}`).join("\n") + (r.rca.recommendations.length > 3 ? `\n…อีก ${r.rca.recommendations.length - 3} ข้อ` : ""))
      : [])
  ];
  const footer: unknown = meta.reportUrl
    ? {
        type: "box", layout: "vertical", paddingAll: "12px", spacing: "sm",
        contents: [
          { type: "button", style: "primary", color: "#0e2724", height: "sm", action: { type: "uri", label: "เปิดดูรายงาน / ทบทวน", uri: meta.reportUrl } },
          { type: "text", text: "ทีม RM ทบทวนและกำหนดมาตรการในระบบ NOKHOOK OS", size: "xxs", color: "#aaaaaa", wrap: true, align: "center" }
        ]
      }
    : {
        type: "box", layout: "vertical", paddingAll: "10px",
        contents: [{ type: "text", text: "ทีม RM ทบทวนและกำหนดมาตรการในระบบ NOKHOOK OS", size: "xxs", color: "#aaaaaa", wrap: true, align: "center" }]
      };
  const code = r.code ?? `#${r.id}`;
  return {
    type: "flex",
    altText: `IR ใหม่ ${code} · ระดับ ${sev.value} ${sev.labelTh} · ${categoryLabel(r.category)} · ${meta.branchName}`,
    contents: {
      type: "bubble", size: "mega",
      header: {
        type: "box", layout: "vertical", backgroundColor: color, paddingAll: "16px", spacing: "xs",
        contents: [
          { type: "text", text: `NOKHOOK OS · IR · ${meta.branchName}`, size: "xxs", color: "#ffffffcc" },
          { type: "text", text: `รายงานเหตุการณ์ใหม่ ${code}`, size: "lg", weight: "bold", color: "#ffffff", wrap: true },
          { type: "text", text: `${sev.labelTh} · ${categoryLabel(r.category)}`, size: "xs", color: "#ffffffcc", wrap: true }
        ]
      },
      body: { type: "box", layout: "vertical", spacing: "sm", paddingAll: "16px", contents: body },
      footer
    }
  };
}

/** Build the card for a report and push it to the branch's RM group. Returns
 *  what happened so a test send can report back; a missing group/token is a
 *  skip, not an error, for the filing path. */
export async function notifyIrRmGroup(branchId: number, reportId: number): Promise<{ ok: boolean; skipped?: string; error?: string }> {
  const groupId = getIrLineGroupId(branchId);
  if (!groupId) return { ok: false, skipped: "no_group" };
  const token = getPlatformChannel()?.channel_token?.trim() ?? null;
  if (!token) return { ok: false, skipped: "platform_oa_not_configured" };
  const r = getReportDetail(reportId, branchId);
  if (!r) return { ok: false, error: "not_found" };
  const branch = getDb().prepare("SELECT name FROM branches WHERE id = ?").get(branchId) as { name: string } | undefined;
  const base = publicBaseUrl();
  const flex = irNewReportFlex(r, { branchName: branch?.name ?? `สาขา #${branchId}`, reportUrl: base ? `${base}/admin/ir/${r.id}` : null });
  const res = await sendLinePush(token, { to: groupId, messages: [flex] });
  return { ok: res.ok, error: res.ok ? undefined : (res.error ?? `line_${res.status}`) };
}

/** Fire-and-forget wrapper for the filing routes: never throws, only logs. */
export function notifyIrRmGroupAsync(branchId: number, reportId: number): void {
  notifyIrRmGroup(branchId, reportId)
    .then((r) => { if (!r.ok && r.error) console.warn(`[ir-notify] push failed for report ${reportId}: ${r.error}`); })
    .catch((e) => console.warn("[ir-notify] push threw:", e));
}

// ── Reporter feedback when the RM closes the case (owner 2026-10-02) ─────────
// Pushed to the reporter's own LINE (users.line_user_id) when the status
// reaches closed / dismissed. Anonymous reports have no reporter to tell.

export function irCaseClosedFlex(r: IrReportDetail, meta: IrCardMeta): LineFlexMessage {
  const dismissed = r.status === "dismissed";
  const color = dismissed ? "#475569" : "#166534";
  const st = statusMeta(r.status);
  const code = r.code ?? `#${r.id}`;
  const body: unknown[] = [
    { type: "text", text: dismissed
        ? "ทีม RM ทบทวนแล้ว เห็นว่ารายการนี้ไม่นับเป็นเหตุการณ์ — ไม่ใช่ความผิดของผู้แจ้ง ขอบคุณที่ช่วยกันเฝ้าระวัง"
        : "ทีม RM ทบทวนและกำหนดมาตรการแล้ว ขอบคุณที่แจ้งและช่วยวิเคราะห์ — รายงานของคุณช่วยกันไม่ให้เกิดซ้ำ",
      size: "sm", color: "#333333", wrap: true },
    { type: "separator", margin: "md", color: "#eeeeee" },
    kv("หมวด", `${categoryLabel(r.category)} · ${incidentTypeLabel(r.incident_type)}`),
    kv("เกิดเมื่อ", fmtWhen(r.occurred_at)),
    kv("สถานะ", st.labelTh, color),
    ...(r.root_cause ? section("สาเหตุราก (ทีม RM)", clip(r.root_cause, 300)) : []),
    ...(r.corrective_action ? section("มาตรการแก้ไข / ป้องกัน", clip(r.corrective_action, 400)) : []),
    ...(r.assignee_name ? [kv("ผู้รับผิดชอบ", nameWithPrefix(r.assignee_prefix, r.assignee_name))] : []),
    ...(r.due_date ? [kv("กำหนดเสร็จ", fmtWhen(r.due_date))] : [])
  ];
  const footer: unknown = {
    type: "box", layout: "vertical", paddingAll: "12px", spacing: "sm",
    contents: [
      ...(meta.reportUrl ? [{ type: "button", style: "primary", color: "#0e2724", height: "sm", action: { type: "uri", label: "เปิดดูรายงาน", uri: meta.reportUrl } }] : []),
      { type: "text", text: "NOKHOOK OS · IR · ไม่ใช่การลงโทษ เน้นเรียนรู้และป้องกัน", size: "xxs", color: "#aaaaaa", wrap: true, align: "center" }
    ]
  };
  return {
    type: "flex",
    altText: `IR ${code} ${dismissed ? "ทบทวนแล้ว ไม่นับเป็นเหตุการณ์" : "ปิดเคสแล้ว"} · ${meta.branchName}`,
    contents: {
      type: "bubble", size: "mega",
      header: {
        type: "box", layout: "vertical", backgroundColor: color, paddingAll: "16px", spacing: "xs",
        contents: [
          { type: "text", text: `NOKHOOK OS · IR · ${meta.branchName}`, size: "xxs", color: "#ffffffcc" },
          { type: "text", text: dismissed ? `รายงาน ${code} ทบทวนแล้ว` : `เคส ${code} ปิดแล้ว`, size: "lg", weight: "bold", color: "#ffffff", wrap: true },
          { type: "text", text: `${st.labelTh} · ${categoryLabel(r.category)}`, size: "xs", color: "#ffffffcc", wrap: true }
        ]
      },
      body: { type: "box", layout: "vertical", spacing: "sm", paddingAll: "16px", contents: body },
      footer
    }
  };
}

/** Push the closed-case card to the reporter. Skips (not an error) when the
 *  report is anonymous, the reporter has no LINE, or the OA isn't configured. */
export async function notifyIrReporterClosed(branchId: number, reportId: number): Promise<{ ok: boolean; skipped?: string; error?: string }> {
  const r = getReportDetail(reportId, branchId);
  if (!r) return { ok: false, error: "not_found" };
  if (r.is_anonymous === 1 || r.reporter_user_id == null) return { ok: false, skipped: "anonymous" };
  const u = getDb().prepare("SELECT line_user_id FROM users WHERE id = ?").get(r.reporter_user_id) as { line_user_id: string | null } | undefined;
  const to = u?.line_user_id?.trim() || null;
  if (!to) return { ok: false, skipped: "no_line_user_id" };
  const token = getPlatformChannel()?.channel_token?.trim() ?? null;
  if (!token) return { ok: false, skipped: "platform_oa_not_configured" };
  const branch = getDb().prepare("SELECT name FROM branches WHERE id = ?").get(branchId) as { name: string } | undefined;
  const base = publicBaseUrl();
  const flex = irCaseClosedFlex(r, { branchName: branch?.name ?? `สาขา #${branchId}`, reportUrl: base ? `${base}/staff/ir/${r.id}` : null });
  const res = await sendLinePush(token, { to, messages: [flex] });
  return { ok: res.ok, error: res.ok ? undefined : (res.error ?? `line_${res.status}`) };
}

export function notifyIrReporterClosedAsync(branchId: number, reportId: number): void {
  notifyIrReporterClosed(branchId, reportId)
    .then((r) => { if (!r.ok && r.error) console.warn(`[ir-notify] reporter push failed for report ${reportId}: ${r.error}`); })
    .catch((e) => console.warn("[ir-notify] reporter push threw:", e));
}

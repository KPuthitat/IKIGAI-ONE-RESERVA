// Where is this purchase right now? (owner 2026-11-26) One model for the flow chart: Memo → signatures → PR → approvals → PO → goods → bills.
// A purchase may skip the memo (a PR opened directly) — those steps show as "ข้าม". Funding requests have their own shorter chain.
import { getDb } from "./db";
import { approvalState } from "./pr-authority";
import { getPo, getPr, listLinkedBills, listItems, listPrs, type PrRow, type Viewer } from "./purchasing";
import { getMemoDetail, listMemos, type MemoDetail } from "./memos";
import { getCompare, type Scope } from "./quotes";

export type StepState = "done" | "current" | "todo" | "skipped" | "failed";
export type FlowPerson = { id?: number; name: string; status: "done" | "waiting" | "rejected"; at?: string | null };
export type FlowStep = { key: string; label: string; state: StepState; lines: string[]; people: FlowPerson[] };
export type Flow = {
  kind: "purchase" | "funding"; steps: FlowStep[]; headline: string; waitingOn: string[]; waitingIds: number[]; finished: boolean; failed: boolean;
  memoId: number | null; memoNo: string | null; prId: number | null; prNo: string | null; poNo: string | null;
};

const step = (key: string, label: string, state: StepState, lines: string[] = [], people: FlowPerson[] = []): FlowStep => ({ key, label, state, lines, people });
const MAX_WAIT = 6;
/** One line on the chart about the quote comparison: how many rivals and who won, or why none were needed. */
function compareLine(scope: Scope, id: number): string {
  const c = getCompare(scope, id);
  if (c.soleSource) return "เทียบราคา: เป็นรายเดียวในตลาด (ระบุเหตุผลแล้ว)";
  if (c.quotes.length === 0) return c.required ? "เทียบราคา: ยังไม่มีใบเสนอราคา" : "";
  const won = c.quotes.find((q) => q.id === c.chosenQuoteId);
  return `เทียบราคา ${c.quotes.length} ราย${won ? ` · เลือก ${won.vendorName}` : " · ยังไม่ได้เลือก"}`;
}

/** Build the chart from a memo and/or a PR (either one is enough; the other is found through the link between them). */
export function buildFlow(args: { memoId?: number | null; prId?: number | null }): Flow {
  const db = getDb();
  let memoId = args.memoId ?? null, prId = args.prId ?? null;
  if (memoId == null && prId != null) memoId = (db.prepare("SELECT memo_id FROM purchase_requests WHERE id = ?").get(prId) as { memo_id: number | null } | undefined)?.memo_id ?? null;
  if (prId == null && memoId != null) prId = (db.prepare("SELECT pr_id FROM memos WHERE id = ?").get(memoId) as { pr_id: number | null } | undefined)?.pr_id ?? null;
  const memo: MemoDetail | null = memoId != null ? getMemoDetail(memoId) : null;
  if (memo?.kind === "funding") return fundingFlow(memo);
  const pr: PrRow | null = prId != null ? getPr(prId) : null;

  const steps: FlowStep[] = [];
  let headline = "", waitingOn: string[] = [], failed = false, finished = false;
  const stopAt = (msg: string) => { failed = true; headline = msg; };

  // 1–2: memo and its signatures (skipped when the PR was opened directly)
  if (!memo) {
    steps.push(step("memo", "เขียน Memo", "skipped", ["เปิด PR โดยตรง — ไม่ผ่าน Memo"]));
    steps.push(step("sign", "ลงนาม Memo", "skipped"));
  } else {
    const memoOk = memo.status !== "draft";
    steps.push(step("memo", "เขียน Memo", memoOk ? "done" : memo.status === "cancelled" ? "failed" : "current",
      [`${memo.memoNo} · ${memo.authorName}`, compareLine("memo", memo.id), memo.status === "draft" ? "ร่าง — ยังไม่ส่งขอลงนาม" : memo.status === "cancelled" ? "ยกเลิก" : ""].filter(Boolean)));
    const people: FlowPerson[] = memo.signers.map((s) => ({ id: s.userId, name: s.name, status: s.status === "signed" ? "done" : s.status === "rejected" ? "rejected" : "waiting", at: s.signedAt }));
    const waiting = people.filter((p) => p.status === "waiting").map((p) => p.name);
    const rejected = people.find((p) => p.status === "rejected");
    const signed = memo.status === "approved" || memo.status === "pr_opened";
    const signState: StepState = signed ? "done" : memo.status === "pending" ? "current" : memo.status === "rejected" || memo.status === "cancelled" ? "failed" : "todo";
    steps.push(step("sign", "ลงนาม Memo", signState, [`ลงนามแล้ว ${memo.signed}/${memo.signerCount}`], people));
    if (memo.status === "draft") headline = "Memo ยังเป็นร่าง — รอผู้เขียนส่งขอลงนาม", waitingOn = [memo.authorName];
    else if (memo.status === "pending") { headline = `รอลงนาม Memo: ${waiting.slice(0, MAX_WAIT).join(", ")}`; waitingOn = waiting; }
    else if (memo.status === "rejected") stopAt(`Memo ไม่ได้รับความเห็นชอบ${rejected ? ` (${rejected.name})` : ""} — รอผู้เขียนแก้ไขแล้วส่งใหม่`);
    else if (memo.status === "cancelled") stopAt("Memo ถูกยกเลิก");
    else if (memo.status === "approved") { headline = `Memo ลงนามครบแล้ว — รอ ${memo.authorName} เปิด PR`; waitingOn = [memo.authorName]; }
  }

  // 3–4: PR and its approvals
  const prStarted = !!pr && pr.status !== "draft";
  steps.push(step("pr", "เปิด PR", pr ? (pr.status === "cancelled" ? "failed" : pr.status === "draft" ? "current" : "done") : memo?.status === "approved" ? "current" : "todo",
    pr ? [`${pr.prNo} · ${pr.requestedByName}`, memo ? "" : compareLine("pr", pr.id), pr.status === "draft" ? "ร่าง — ยังไม่ส่งอนุมัติ" : ""].filter(Boolean) : memo?.status === "approved" ? ["ดึงรายการจาก Memo มาให้อัตโนมัติ"] : []));
  if (pr) {
    const ap = pr.status === "draft" ? null : approvalState(pr.id);
    const people: FlowPerson[] = ap ? [...ap.approvals.map((a) => ({ id: a.userId, name: a.name, status: a.decision === "approve" ? "done" as const : "rejected" as const, at: a.at })),
      ...(ap.approved ? [] : ap.eligible.map((e) => ({ id: e.id, name: e.name, status: "waiting" as const })))] : [];
    const state: StepState = pr.status === "rejected" ? "failed" : pr.status === "draft" ? "todo" : pr.status === "submitted" ? "current" : pr.status === "cancelled" ? "failed" : "done";
    steps.push(step("approve", "อนุมัติ PR", state, ap ? [`เกณฑ์: ${ap.ruleText}`, ap.approved ? "ครบตามเกณฑ์" : ap.remainingText] : [], people));
    if (pr.status === "draft") { headline = "PR ยังเป็นร่าง — รอผู้ขอส่งอนุมัติ"; waitingOn = [pr.requestedByName]; }
    else if (pr.status === "submitted" && ap) { const w = ap.eligible.map((e) => e.name); headline = `รออนุมัติ PR: ${ap.remainingText}${w.length ? ` (${w.slice(0, MAX_WAIT).join(", ")})` : ""}`; waitingOn = w; }
    else if (pr.status === "rejected") stopAt(`PR ไม่อนุมัติ${pr.decisionNote ? `: ${pr.decisionNote}` : ""}`);
    else if (pr.status === "cancelled") stopAt("PR ถูกยกเลิก");
  } else {
    steps.push(step("approve", "อนุมัติ PR", "todo"));
  }

  // 5–7: PO, goods, bills
  const po = pr ? getPo(pr.id) : null;
  const afterApproval = !!pr && ["approved", "ordered", "received", "closed"].includes(pr.status);
  steps.push(step("po", "ใบสั่งซื้อ (PO)", po ? "done" : pr?.status === "approved" ? "current" : "todo", po ? [`${po.poNo} · ${po.vendorName}`, po.expectedDate ? `กำหนดส่ง ${po.expectedDate}` : ""].filter(Boolean) : pr?.status === "approved" ? ["รอแอดมินสาขา/ผู้บริหารเปิด PO"] : []));
  const toStock = pr ? listItems(pr.id).some((i) => i.inventaItemId) : false;
  steps.push(step("receive", "รับของ", pr?.status === "received" || pr?.status === "closed" ? "done" : pr?.status === "ordered" ? "current" : "todo",
    po?.receivedAt ? [`รับเมื่อ ${po.receivedAt}`, po.stockAppliedAt ? "เพิ่มเข้าสต๊อก INVENTA แล้ว" : toStock ? "" : ""].filter(Boolean) : toStock ? ["รับแล้วสต๊อก INVENTA เพิ่มเอง"] : []));
  const bills = pr ? listLinkedBills(pr.id).length : 0;
  steps.push(step("bill", "ผูกบิล · ปิดงาน", pr?.status === "closed" ? "done" : pr?.status === "received" ? "current" : "todo", pr && (pr.status === "received" || pr.status === "closed") ? [`ผูกบิลแล้ว ${bills} ใบ`] : []));
  if (!failed && afterApproval) {
    if (pr!.status === "approved") { headline = "PR อนุมัติแล้ว — รอเปิดใบสั่งซื้อ (PO)"; waitingOn = ["แอดมินสาขา / ผู้บริหาร"]; }
    else if (pr!.status === "ordered") { headline = `สั่งซื้อแล้ว (${po?.poNo ?? "PO"}) — รอรับของ`; waitingOn = ["แอดมินสาขา"]; }
    else if (pr!.status === "received") { headline = "รับของแล้ว — รอผูกบิลที่ลงบัญชีเพื่อปิดงาน"; waitingOn = ["ฝ่ายบัญชี"]; }
    else if (pr!.status === "closed") { headline = "เสร็จสิ้น — ผูกบิลครบแล้ว"; finished = true; }
  }
  if (!headline) headline = "ยังไม่เริ่ม";
  void prStarted;
  return { kind: "purchase", steps, headline, waitingOn, waitingIds: waitingIdsOf(steps, memo, pr), finished, failed, memoId, memoNo: memo?.memoNo ?? null, prId: pr?.id ?? null, prNo: pr?.prNo ?? null, poNo: po?.poNo ?? null };
}

/** Ids of the people the purchase is waiting on right now (signers / approvers / the author), so "waiting for me" can be told apart. */
function waitingIdsOf(steps: FlowStep[], memo: MemoDetail | null, pr: PrRow | null): number[] {
  const cur = steps.find((s) => s.state === "current");
  if (!cur) return [];
  const ids = cur.people.filter((p) => p.status === "waiting" && p.id != null).map((p) => p.id as number);
  if (!ids.length) {
    if (cur.key === "pr") { if (pr) ids.push(pr.requestedBy); else if (memo) ids.push(memo.authorId); }
    if (cur.key === "memo" && memo) ids.push(memo.authorId);
  }
  return ids;
}

/** Funding request (SCB → KBANK): memo → signatures → awaiting transfer → transferred. */
function fundingFlow(memo: MemoDetail): Flow {
  const db = getDb();
  const t = db.prepare("SELECT status, transferred_on, actual_amount, out_line_id FROM fund_transfers WHERE memo_id = ? ORDER BY id DESC LIMIT 1").get(memo.id) as { status: string; transferred_on: string | null; actual_amount: number | null; out_line_id: number | null } | undefined;
  const people: FlowPerson[] = memo.signers.map((s) => ({ id: s.userId, name: s.name, status: s.status === "signed" ? "done" : s.status === "rejected" ? "rejected" : "waiting", at: s.signedAt }));
  const waiting = people.filter((p) => p.status === "waiting").map((p) => p.name);
  const signed = memo.status === "approved";
  const failed = memo.status === "rejected" || memo.status === "cancelled" || t?.status === "cancelled";
  const steps = [
    step("memo", "เขียน Memo ขอเบิกเงิน", memo.status === "draft" ? "current" : "done", [`${memo.memoNo} · ${memo.authorName}`, `${memo.fromAccountName ?? ""} → ${memo.toAccountName ?? ""}`]),
    step("sign", "ลงนาม", signed ? "done" : memo.status === "pending" ? "current" : failed ? "failed" : "todo", [`ลงนามแล้ว ${memo.signed}/${memo.signerCount}`], people),
    step("transfer", "ฝ่ายการเงินโอน", t?.status === "transferred" ? "done" : t?.status === "awaiting" ? "current" : t?.status === "cancelled" ? "failed" : "todo", t?.status === "awaiting" ? ["รอบันทึกว่าโอนแล้ว (หรือรอจับคู่จาก statement)"] : []),
    step("funds", "เงินเข้าบัญชีจัดซื้อ", t?.status === "transferred" ? "done" : "todo", t?.status === "transferred" ? [`โอนเมื่อ ${t.transferred_on ?? "—"}${t.actual_amount != null ? ` · ฿${t.actual_amount.toLocaleString("th-TH")}` : ""}`, t.out_line_id != null ? "จับคู่จาก statement อัตโนมัติ" : ""].filter(Boolean) : [])
  ];
  let headline = "", waitingOn: string[] = [], finished = false;
  if (memo.status === "draft") { headline = "Memo ยังเป็นร่าง — รอผู้เขียนส่งขอลงนาม"; waitingOn = [memo.authorName]; }
  else if (memo.status === "pending") { headline = `รอลงนาม: ${waiting.slice(0, MAX_WAIT).join(", ")}`; waitingOn = waiting; }
  else if (failed) headline = memo.status === "rejected" ? "Memo ไม่ได้รับความเห็นชอบ" : "ยกเลิกแล้ว";
  else if (t?.status === "awaiting") { headline = "ลงนามครบแล้ว — รอฝ่ายการเงินโอนเงิน"; waitingOn = ["ฝ่ายการเงิน"]; }
  else if (t?.status === "transferred") { headline = "โอนเงินแล้ว — พร้อมให้ฝ่ายจัดซื้อใช้"; finished = true; }
  return { kind: "funding", steps, headline, waitingOn, waitingIds: waitingIdsOf(steps, memo, null), finished, failed, memoId: memo.id, memoNo: memo.memoNo, prId: null, prNo: null, poNo: null };
}

// ── the tracker: every purchase still moving ──
export type FlowRow = { key: string; kind: "purchase" | "funding"; title: string; number: string; amount: number; branchName: string; waitingMe: boolean; flow: Flow };

/** Purchases that are not finished: memos (with their PR when there is one) and PRs opened directly. People waiting for me come first. */
export function listInFlight(viewer: Viewer, branchIds: number[]): FlowRow[] {
  const rows: FlowRow[] = [];
  const memos = listMemos(viewer).filter((m) => m.status !== "cancelled");
  const seenMemo = new Set(memos.map((m) => m.id));
  for (const m of memos) {
    const flow = buildFlow({ memoId: m.id });
    if (flow.finished) continue;
    if (m.prId) { const st = getPr(m.prId)?.status; if (st === "cancelled" || st === "closed") continue; }
    rows.push({ key: `m${m.id}`, kind: flow.kind, title: m.subject, number: m.prNo ? `${m.memoNo} → ${m.prNo}` : m.memoNo, amount: m.total, branchName: m.branchName, waitingMe: flow.waitingIds.includes(viewer.userId), flow });
  }
  for (const p of listPrs({ branchIds, status: ["draft", "submitted", "approved", "ordered", "received"] })) {
    if (p.memoId != null && seenMemo.has(p.memoId)) continue;
    const flow = buildFlow({ prId: p.id });
    if (flow.finished) continue;
    rows.push({ key: `p${p.id}`, kind: "purchase", title: p.title, number: p.poNo ? `${p.prNo} → ${p.poNo}` : p.prNo, amount: p.total, branchName: p.branchName, waitingMe: flow.waitingIds.includes(viewer.userId), flow });
  }
  return rows.sort((a, b) => Number(b.waitingMe) - Number(a.waitingMe));
}

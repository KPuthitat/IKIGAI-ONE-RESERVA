// นกฮูกเลขา phase A — owner-only, tag-only, read-only. Run: node --import tsx scripts/test-owl-secretary.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-owl-secretary.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const S = await import("../src/lib/owl-secretary");
  const D = await import("../src/lib/owl-data");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };

  const owner = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status,line_user_id) VALUES ('o','x','Owner','super_admin','active','Uowner')").run().lastInsertRowid);
  const adm = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status,line_user_id) VALUES ('ad','x','Admin','admin','active','Uadmin')").run().lastInsertRowid);
  const staff = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES ('s','x','สมชาย','staff','active')").run().lastInsertRowid);
  // a brand-new DB loses columns added earlier in the same migration pass when leave_requests is rebuilt (known; prod is not affected)
  for (const c of ["last_escalated_at TEXT", "current_tier INTEGER", "ref_no TEXT"]) { try { db.exec(`ALTER TABLE leave_requests ADD COLUMN ${c}`); } catch { /* already there */ } }
  const br = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('nama','NAMA')").run().lastInsertRowid);
  db.prepare("INSERT INTO leave_requests (user_id,type,date_from,date_to,days,reason,status,branch_id,ref_no) VALUES (?,?,?,?,?,?,?,?,?)").run(staff, "sick", "2026-12-01", "2026-12-02", 2, "ลับมาก ผ่าตัด", "pending", br, "L20261201");

  let asked: string[] = [];
  const scopes: string[] = [];
  const ask = async (q: string, scope: string) => { asked.push(q); scopes.push(scope); return { answer: "คำตอบทดสอบ", model: "m", inputTokens: 10, outputTokens: 5 }; };
  const SECRET = "test-secret";
  const raw = (who: string | undefined, text: string, tagged = true, g = "G1", others?: string[]) => S.handleGroupMessage({ groupId: g, lineUserId: who, text, mentionedSelf: tagged, ask, others, secret: SECRET });
  const say = async (who: string | undefined, text: string, tagged = true, g = "G1", others?: string[]) => { const r = await raw(who, text, tagged, g, others); return r && typeof r !== "string" ? "FLEX " + JSON.stringify(r.flex) : r; };

  ok("an untagged message is never read or answered", (await say("Uowner", "สรุปคำขอลา", false)) === null && asked.length === 0);
  ok("a group that is not enabled stays silent for strangers", (await say("Uadmin", "สรุปคำขอลา")) === null);
  ok("…and the owner is told how to enable it, nothing is answered", /เปิดใช้กลุ่มนี้/.test((await say("Uowner", "สรุปคำขอลา")) ?? "") && asked.length === 0);
  ok("an admin cannot enable a group", /เฉพาะเจ้าของ/.test((await say("Uadmin", "เปิดใช้กลุ่มนี้")) ?? "") && !db.prepare("SELECT 1 FROM owl_secretary_groups").get());
  ok("an unknown LINE user cannot enable a group", /เฉพาะเจ้าของ/.test((await say(undefined, "เปิดใช้กลุ่มนี้")) ?? ""));
  ok("the owner enables the group from inside it", /เปิดใช้กลุ่มนี้แล้ว/.test((await say("Uowner", "เปิดใช้กลุ่มนี้")) ?? "") && !!db.prepare("SELECT 1 FROM owl_secretary_groups WHERE group_id='G1'").get());
  ok("the owner's question goes to the AI and the answer comes back", (await say("Uowner", "สรุปคำขอลาที่รออนุมัติ")) === "คำตอบทดสอบ" && asked[0] === "สรุปคำขอลาที่รออนุมัติ");
  ok("an admin in an enabled group is refused politely, AI not called", /เจ้าของให้สิทธิ์/.test((await say("Uadmin", "สรุปคำขอลา")) ?? "") && asked.length === 1);
  ok("an approve/reject command without a leave number is refused, AI not called", /ระบุเลขอ้างอิง/.test((await say("Uowner", "อนุมัติใบลา")) ?? "") && /ระบุเลขอ้างอิง/.test((await say("Uowner", "ไม่อนุมัติคนนี้")) ?? "") && asked.length === 1
    && (db.prepare("SELECT status FROM leave_requests WHERE ref_no='L20261201'").get() as { status: string }).status === "pending");
  ok("asking about what is waiting for approval is a question, not a command", (await say("Uowner", "คำขอที่รออนุมัติมีอะไรบ้าง")) === "คำตอบทดสอบ" && (await say("Uowner", "ใบลาที่อนุมัติแล้ว")) === "คำตอบทดสอบ");
  ok("an empty tag shows help", /ลองพิมพ์/.test((await say("Uowner", "")) ?? ""));
  ok("a different group is not enabled", (await say("Uadmin", "สรุป", true, "G2")) === null);
  ok("tool output for the group has no leave reason", (() => { const j = JSON.stringify(D.pendingLeaveList({})); return j.includes("L20261201") && j.includes("สมชาย") && !j.includes("ผ่าตัด") && !j.includes("reason"); })());
  ok("mention stripping removes only the bot's tag", S.stripSelfMention("@นกฮูก สรุปคำขอลา @สมชาย", { mentionees: [{ index: 0, length: 6, isSelf: true }, { index: 18, length: 7, isSelf: false }] }) === "สรุปคำขอลา @สมชาย");
  ok("only a tag of the bot counts as tagging it", S.mentionsSelf({ mentionees: [{ isSelf: true }] }) && !S.mentionsSelf({ mentionees: [{ isSelf: false }] }) && !S.mentionsSelf(undefined));

  // granting (owner 2026-11-21: only people the owner allowed, e.g. admins, may command)
  const stf = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status,line_user_id) VALUES ('st2','x','พนักงาน','staff','active','Ustaff')").run().lastInsertRowid);
  ok("an admin cannot grant anyone", /เฉพาะเจ้าของ/.test((await say("Uadmin", "ให้สิทธิ์ @คน", true, "G1", ["Uadmin"])) ?? "") && !db.prepare("SELECT 1 FROM owl_secretary_users").get());
  ok("a staff member cannot be granted (admins only)", /ไม่พบผู้ที่แท็ก/.test((await say("Uowner", "ให้สิทธิ์ @พนักงาน", true, "G1", ["Ustaff"])) ?? "") && !db.prepare("SELECT 1 FROM owl_secretary_users").get());
  ok("granting without tagging anyone is refused", /ไม่พบผู้ที่แท็ก/.test((await say("Uowner", "ให้สิทธิ์")) ?? ""));
  ok("the owner grants an admin by tagging them", /ให้สิทธิ์แล้ว 1/.test((await say("Uowner", "ให้สิทธิ์ @Admin", true, "G1", ["Uadmin"])) ?? "") && !!db.prepare("SELECT 1 FROM owl_secretary_users WHERE user_id = ?").get(adm));
  const before = asked.length;
  ok("a granted admin is answered, with people-matters scope only", (await say("Uadmin", "สรุปคำขอลาที่รออนุมัติ")) === "คำตอบทดสอบ" && asked.length === before + 1 && scopes[scopes.length - 1] === "hr");
  ok("the owner still gets the full scope", (await say("Uowner", "ค่าใช้จ่ายเดือนนี้")) === "คำตอบทดสอบ" && scopes[scopes.length - 1] === "all");
  ok("a command (not a question) never reaches the AI", asked.length === before + 2);
  ok("a granted admin cannot enable groups or grant others", /เฉพาะเจ้าของ/.test((await say("Uadmin", "เปิดใช้กลุ่มนี้")) ?? "") && /เฉพาะเจ้าของ/.test((await say("Uadmin", "ให้สิทธิ์ @คน", true, "G1", ["Uadmin"])) ?? ""));
  ok("the HR scope has no money tools", (await import("../src/lib/owl-ai")).HR_TOOLS.has("leave_summary") && !(await import("../src/lib/owl-ai")).HR_TOOLS.has("expense_summary") && !(await import("../src/lib/owl-ai")).HR_TOOLS.has("daybook_summary") && !(await import("../src/lib/owl-ai")).HR_TOOLS.has("income_summary"));
  ok("the owner revokes the right", /ถอนสิทธิ์แล้ว/.test((await say("Uowner", "ถอนสิทธิ์ @Admin", true, "G1", ["Uadmin"])) ?? "") && /เจ้าของให้สิทธิ์/.test((await say("Uadmin", "สรุปคำขอลา")) ?? ""));

  // ── phase B: leave decisions behind a confirm button ──
  const ins = (ref: string, tier: number | null, branchId: number) => Number(db.prepare("INSERT INTO leave_requests (user_id,type,date_from,date_to,days,reason,status,branch_id,ref_no,current_tier) VALUES (?,?,?,?,?,?,?,?,?,?)").run(staff, "personal", "2026-12-10", "2026-12-10", 1, "ส่วนตัว", "pending", branchId, ref, tier).lastInsertRowid);
  const status = (ref: string) => db.prepare("SELECT status, current_tier AS tier, decided_by AS by FROM leave_requests WHERE ref_no = ?").get(ref) as { status: string; tier: number | null; by: number | null };
  const dataOf = (flex: string, kind: "y" | "n") => (flex.match(new RegExp(`"data":"(owl_leave:${kind}:[^"]+)"`)) ?? [])[1] ?? "";
  const press = (data: string, who: string | undefined, nowSec?: number, g = "G1") => S.handleConfirmPostback({ data, groupId: g, lineUserId: who, secret: SECRET, nowSec });
  await say("Uowner", "เปิดใช้กลุ่มนี้");
  const l2 = ins("L20261202", null, br), l3 = ins("L20261203", 1, br), l4 = ins("L20261204", null, br);
  void l2; void l3; void l4;

  const card = await say("Uowner", "อนุมัติ L20261201");
  ok("approve command gives a confirm card and changes nothing yet", card!.startsWith("FLEX") && card!.includes("ยืนยันอนุมัติใบลา L20261201") && !card!.includes("ผ่าตัด") && status("L20261201").status === "pending");
  const yes = dataOf(card!, "y"), no = dataOf(card!, "n");
  ok("someone else pressing the button does nothing", press(yes, "Uadmin") === null && press(yes, undefined) === null && status("L20261201").status === "pending");
  ok("a forged or altered button does nothing", press(yes.slice(0, -2) + "00", "Uowner") === null && press(yes.replace(":a:", ":r:"), "Uowner") === null && status("L20261201").status === "pending");
  ok("an expired button is refused", /หมดอายุ/.test(press(yes, "Uowner", Math.floor(Date.now() / 1000) + 400) ?? "") && status("L20261201").status === "pending");
  ok("a button from a group that is not enabled does nothing", press(yes, "Uowner", undefined, "G9") === null);
  ok("the cancel button cancels", /ยกเลิกคำสั่ง/.test(press(no, "Uowner") ?? "") && status("L20261201").status === "pending");
  ok("the owner's confirm approves the leave through the web rules", /อนุมัติใบลา L20261201 ของ สมชาย แล้ว/.test(press(yes, "Uowner") ?? "") && status("L20261201").status === "approved" && status("L20261201").by === owner);
  ok("pressing again says it was already decided", /ตัดสินแล้ว/.test(press(yes, "Uowner") ?? ""));
  ok("the decision is logged as made via the LINE group", !!db.prepare("SELECT 1 FROM persona_activity_log WHERE user_id = ? AND action = 'leave.approved.line_group'").get(owner));

  const rej = await say("Uowner", "ไม่อนุมัติ L20261202");
  ok("reject goes through the same confirm step and rejects", rej!.includes("ยืนยันไม่อนุมัติใบลา L20261202") && /ไม่อนุมัติใบลา L20261202/.test(press(dataOf(rej!, "y"), "Uowner") ?? "") && status("L20261202").status === "rejected");
  const t1 = await say("Uowner", "อนุมัติ L20261203");
  ok("tier-1 approval only advances to tier 2, and says so", t1!.includes("ชั้นที่ 1") && /ส่งต่อชั้นที่ 2/.test(press(dataOf(t1!, "y"), "Uowner") ?? "") && status("L20261203").status === "pending" && status("L20261203").tier === 2);
  ok("an unknown number is refused", /ไม่พบใบลา/.test((await say("Uowner", "อนุมัติ L20269999")) ?? ""));
  ok("a decided request cannot be decided again from the command", /ตัดสินแล้ว/.test((await say("Uowner", "อนุมัติ L20261201")) ?? ""));
  ok("an admin without the right gets no card", /เจ้าของให้สิทธิ์/.test((await say("Uadmin", "อนุมัติ L20261204")) ?? "") && status("L20261204").status === "pending");
  await say("Uowner", "ให้สิทธิ์ @Admin", true, "G1", ["Uadmin"]);
  ok("a granted admin outside the request's branch is refused (branch guard)", /ไม่ได้ดูแล/.test((await say("Uadmin", "อนุมัติ L20261204")) ?? "") && status("L20261204").status === "pending");
  db.prepare("INSERT INTO user_branches (user_id,branch_id) VALUES (?,?)").run(adm, br);
  const ac = await say("Uadmin", "อนุมัติ L20261204");
  ok("a granted admin of that branch gets a card, but only they can press it", ac!.startsWith("FLEX") && press(dataOf(ac!, "y"), "Uowner") === null && /อนุมัติใบลา L20261204/.test(press(dataOf(ac!, "y"), "Uadmin") ?? "") && status("L20261204").by === adm);
  ok("a right revoked before pressing blocks the decision", await (async () => {
    ins("L20261205", null, br);
    const c = await say("Uadmin", "อนุมัติ L20261205");
    await say("Uowner", "ถอนสิทธิ์ @Admin", true, "G1", ["Uadmin"]);
    return /ถูกถอน/.test(press(dataOf(c!, "y"), "Uadmin") ?? "") && status("L20261205").status === "pending";
  })());
  await say("Uowner", "ให้สิทธิ์ @Admin", true, "G1", ["Uadmin"]);

  // daily cap
  for (let i = 0; i < S.DAILY_CAP - 1; i++) db.prepare("INSERT INTO owl_ai_usage (model,question,created_by) VALUES ('m','[LINE กลุ่ม] x',?)").run(owner);
  // 1 real answer already logged above → cap reached now
  ok("after the daily cap the owner is told to ask tomorrow", /ครบ/.test((await say("Uowner", "ถามอีก")) ?? ""));
  ok("the owner can disable the group", /เลิกใช้/.test((await say("Uowner", "เลิกใช้กลุ่มนี้")) ?? "") && !db.prepare("SELECT 1 FROM owl_secretary_groups").get());

  console.log(failed ? `\n${failed} FAILED` : "\nAll checks passed");
  cleanup(); process.exit(failed ? 1 : 0);
})();

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
  const br = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('nama','NAMA')").run().lastInsertRowid);
  db.prepare("INSERT INTO leave_requests (user_id,type,date_from,date_to,days,reason,status,branch_id,ref_no) VALUES (?,?,?,?,?,?,?,?,?)").run(staff, "sick", "2026-12-01", "2026-12-02", 2, "ลับมาก ผ่าตัด", "pending", br, "L-0001");

  let asked: string[] = [];
  const ask = async (q: string) => { asked.push(q); return { answer: "คำตอบทดสอบ", model: "m", inputTokens: 10, outputTokens: 5 }; };
  const say = (who: string | undefined, text: string, tagged = true, g = "G1") => S.handleGroupMessage({ groupId: g, lineUserId: who, text, mentionedSelf: tagged, ask });

  ok("an untagged message is never read or answered", (await say("Uowner", "สรุปคำขอลา", false)) === null && asked.length === 0);
  ok("a group that is not enabled stays silent for strangers", (await say("Uadmin", "สรุปคำขอลา")) === null);
  ok("…and the owner is told how to enable it, nothing is answered", /เปิดใช้กลุ่มนี้/.test((await say("Uowner", "สรุปคำขอลา")) ?? "") && asked.length === 0);
  ok("an admin cannot enable a group", /เฉพาะเจ้าของ/.test((await say("Uadmin", "เปิดใช้กลุ่มนี้")) ?? "") && !db.prepare("SELECT 1 FROM owl_secretary_groups").get());
  ok("an unknown LINE user cannot enable a group", /เฉพาะเจ้าของ/.test((await say(undefined, "เปิดใช้กลุ่มนี้")) ?? ""));
  ok("the owner enables the group from inside it", /เปิดใช้กลุ่มนี้แล้ว/.test((await say("Uowner", "เปิดใช้กลุ่มนี้")) ?? "") && !!db.prepare("SELECT 1 FROM owl_secretary_groups WHERE group_id='G1'").get());
  ok("the owner's question goes to the AI and the answer comes back", (await say("Uowner", "สรุปคำขอลาที่รออนุมัติ")) === "คำตอบทดสอบ" && asked[0] === "สรุปคำขอลาที่รออนุมัติ");
  ok("an admin in an enabled group is refused politely, AI not called", /เฉพาะเจ้าของ/.test((await say("Uadmin", "สรุปคำขอลา")) ?? "") && asked.length === 1);
  ok("approving is refused for now, AI not called", /ยังไม่ได้/.test((await say("Uowner", "อนุมัติใบลา L-0001")) ?? "") && /ยังไม่ได้/.test((await say("Uowner", "ไม่อนุมัติคนนี้")) ?? "") && asked.length === 1
    && (db.prepare("SELECT status FROM leave_requests WHERE ref_no='L-0001'").get() as { status: string }).status === "pending");
  ok("asking about what is waiting for approval is a question, not a command", (await say("Uowner", "คำขอที่รออนุมัติมีอะไรบ้าง")) === "คำตอบทดสอบ" && (await say("Uowner", "ใบลาที่อนุมัติแล้ว")) === "คำตอบทดสอบ");
  ok("an empty tag shows help", /ลองพิมพ์/.test((await say("Uowner", "")) ?? ""));
  ok("a different group is not enabled", (await say("Uadmin", "สรุป", true, "G2")) === null);
  ok("tool output for the group has no leave reason", (() => { const j = JSON.stringify(D.pendingLeaveList({})); return j.includes("L-0001") && j.includes("สมชาย") && !j.includes("ผ่าตัด") && !j.includes("reason"); })());
  ok("mention stripping removes only the bot's tag", S.stripSelfMention("@นกฮูก สรุปคำขอลา @สมชาย", { mentionees: [{ index: 0, length: 6, isSelf: true }, { index: 18, length: 7, isSelf: false }] }) === "สรุปคำขอลา @สมชาย");
  ok("only a tag of the bot counts as tagging it", S.mentionsSelf({ mentionees: [{ isSelf: true }] }) && !S.mentionsSelf({ mentionees: [{ isSelf: false }] }) && !S.mentionsSelf(undefined));

  // daily cap
  for (let i = 0; i < S.DAILY_CAP - 1; i++) db.prepare("INSERT INTO owl_ai_usage (model,question,created_by) VALUES ('m','[LINE กลุ่ม] x',?)").run(owner);
  // 1 real answer already logged above → cap reached now
  ok("after the daily cap the owner is told to ask tomorrow", /ครบ/.test((await say("Uowner", "ถามอีก")) ?? ""));
  ok("the owner can disable the group", /เลิกใช้/.test((await say("Uowner", "เลิกใช้กลุ่มนี้")) ?? "") && !db.prepare("SELECT 1 FROM owl_secretary_groups").get());

  console.log(failed ? `\n${failed} FAILED` : "\nAll checks passed");
  cleanup(); process.exit(failed ? 1 : 0);
})();

// End-to-end check of the clinical routes against the REAL built app. Run `npm run build` first, then `npm run e2e:annual-checkup`.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
const DB = path.join(process.cwd(), "data", "e2e-ac.db");
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) fs.rmSync(f, { force: true });
fs.mkdirSync(path.dirname(DB), { recursive: true });
process.env.DATABASE_PATH = DB; process.env.RESERVA_SECRET_KEY = "e2e-secret-key-0123456789"; process.env.HEALTH_DATA_ROOT = path.join(process.cwd(), "data", "e2e-health");
(async () => {
  const { getDb } = await import("../src/lib/db");
  const db = getDb();
  const mk = (u: string, role: string, extra: Record<string, unknown> = {}, branch?: number) => {
    const cols = ["username", "password_hash", "display_name", "role", "status", ...Object.keys(extra)];
    const id = Number(db.prepare(`INSERT INTO users (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(u, "x", u, role, "active", ...Object.values(extra)).lastInsertRowid);
    if (branch) db.prepare("INSERT INTO user_branches (user_id, branch_id, is_admin) VALUES (?,?,0)").run(id, branch);
    return id;
  };
  const clinic = (db.prepare("SELECT id FROM branches WHERE slug='at-home-clinic'").get() as { id: number }).id;
  db.prepare("INSERT INTO branches (slug,name) VALUES ('nama-e2e','NAMA')").run();
  const nama = (db.prepare("SELECT id FROM branches WHERE slug='nama-e2e'").get() as { id: number }).id;
  const R = mk("recorder", "staff", { health_result_recorder: 1 }, clinic);
  const D = mk("doctor", "staff", { clinical_role: "doctor", license_no: "ว.12345", health_result_approver: 1 }, clinic);
  const A = mk("emp-a", "staff", {}, nama), HR = mk("hr", "staff", { is_hr_analytics: 1 }, nama);
  const round = Number(db.prepare("INSERT INTO annual_checkup_rounds (name,year_be,status) VALUES ('ตรวจสุขภาพประจำปี 2569',2569,'open')").run().lastInsertRowid);
  const payer = Number(db.prepare("INSERT INTO annual_checkup_payers (round_id,name_th) VALUES (?, 'บริษัท ทดสอบ')").run(round).lastInsertRowid);
  const tid = (c: string) => (db.prepare("SELECT id FROM annual_checkup_tests WHERE code=?").get(c) as { id: number }).id;
  const oHav = Number(db.prepare("INSERT INTO annual_checkup_orders (round_id,user_id,payer_id,test_id,status) VALUES (?,?,?,?,'ordered')").run(round, A, payer, tid("HAV")).lastInsertRowid);
  const oUr = Number(db.prepare("INSERT INTO annual_checkup_orders (round_id,user_id,payer_id,test_id,status) VALUES (?,?,?,?,'waived')").run(round, A, payer, tid("URINE")).lastInsertRowid);
  const sess = (uid: number) => { const id = `e2e-${uid}-${Math.random().toString(16).slice(2)}`; db.prepare("INSERT INTO sessions (id,user_id,active_branch_id,expires_at) VALUES (?,?,?,?)").run(id, uid, null, new Date(Date.now() + 3600_000).toISOString()); return id; };
  const cookie = { R: sess(R), D: sess(D), A: sess(A), HR: sess(HR) };

  const port = 3999;
  const srv = spawn("npx", ["next", "start", "-p", String(port)], { env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let out = ""; srv.stdout.on("data", (d) => (out += d)); srv.stderr.on("data", (d) => (out += d));
  for (let i = 0; i < 60 && !/Ready|started server/i.test(out); i++) await new Promise((r) => setTimeout(r, 1000));
  const base = `http://localhost:${port}`;
  let failed = 0;
  const ok = (n: string, c: boolean, extra = "") => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n} ${extra}`); } };
  type Opt = { who?: keyof typeof cookie; extraCookie?: string; json?: unknown; form?: FormData; method?: string };
  const call = async (url: string, o: Opt = {}) => {
    const headers: Record<string, string> = {};
    const ck = [o.who ? `reserva_session=${cookie[o.who]}` : "", o.extraCookie ?? ""].filter(Boolean).join("; ");
    if (ck) headers.cookie = ck;
    if (o.json !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(base + url, { method: o.method ?? (o.json !== undefined || o.form ? "POST" : "GET"), headers, body: o.json !== undefined ? JSON.stringify(o.json) : o.form, redirect: "manual" });
    const text = await r.text();
    return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), setCookie: r.headers.get("set-cookie") ?? "", loc: r.headers.get("location") ?? "" };
  };
  try {
    // pages
    const pg = await call("/staff/health/annual-checkup", { who: "R" });
    ok("recorder opens the rounds page and sees the round", pg.status === 200 && pg.text.includes("ตรวจสุขภาพประจำปี 2569"), `status ${pg.status}`);
    const pgA = await call("/staff/health/annual-checkup", { who: "A" });
    ok("an ordinary employee is sent away (no round names in the page)", (pgA.status >= 300 && pgA.status < 400 || pgA.status === 200) && !pgA.text.includes("ตรวจสุขภาพประจำปี 2569"), `status ${pgA.status} loc ${pgA.loc}`);
    const pgHR = await call(`/staff/health/annual-checkup/${round}`, { who: "HR" });
    ok("HR cannot open the round overview", !pgHR.text.includes("emp-a"), `status ${pgHR.status}`);
    const ov = await call(`/staff/health/annual-checkup/${round}`, { who: "R" });
    ok("recorder opens the overview and sees the person", ov.status === 200 && ov.text.includes("emp-a"));
    const person = await call(`/staff/health/annual-checkup/${round}/person/u${A}`, { who: "R" });
    ok("recorder opens the person page (the waived test is shown as waived)", person.status === 200 && person.text.includes("งดตรวจ"), `status ${person.status}`);
    ok("the person page is not served to HR / the employee", !(await call(`/staff/health/annual-checkup/${round}/person/u${A}`, { who: "HR" })).text.includes("เหตุผลที่งดตรวจ") && !(await call(`/staff/health/annual-checkup/${round}/person/u${A}`, { who: "A" })).text.includes("เหตุผลที่งดตรวจ"));
    ok("no session → not served", !(await call("/staff/health/annual-checkup")).text.includes("ตรวจสุขภาพประจำปี 2569"));
    // record
    ok("recorder records a draft", (await call("/api/annual-checkup/result", { who: "R", json: { orderId: oHav, valueText: "ไม่พบภูมิคุ้มกัน", interpretation: "follow_up" } })).json?.ok === true);
    for (const w of ["A", "HR"] as const) { const r = await call("/api/annual-checkup/result", { who: w, json: { orderId: oHav, valueText: "x" } }); ok(`${w} is refused (403)`, r.status === 403, `status ${r.status}`); }
    ok("no session → 401", (await call("/api/annual-checkup/result", { json: { orderId: oHav, valueText: "x" } })).status === 401);
    ok("bad body → 400", (await call("/api/annual-checkup/result", { who: "R", json: { orderId: "x" } })).status === 400);
    ok("a waived test refuses a result (422)", (await call("/api/annual-checkup/result", { who: "R", json: { orderId: oUr, valueText: "x" } })).status === 422);
    ok("bulk saves a row", (await call("/api/annual-checkup/result/bulk", { who: "R", json: { items: [{ orderId: oHav, valueText: "ไม่พบภูมิคุ้มกัน", interpretation: "follow_up" }] } })).json?.saved === 1);
    ok("the waive reason is stored by the recorder only", (await call("/api/annual-checkup/clinical", { who: "R", json: { orderId: oUr, waiveReason: "งดตามแพทย์" } })).json?.ok === true && (await call("/api/annual-checkup/clinical", { who: "HR", json: { orderId: oUr, waiveReason: "x" } })).status === 403);
    // verify needs the unlock
    const resId = (db.prepare("SELECT id FROM annual_checkup_results WHERE order_id=?").get(oHav) as { id: number }).id;
    ok("the doctor without the unlock cannot verify", (await call("/api/annual-checkup/verify", { who: "D", json: { ids: [resId] } })).status === 403);
    ok("a cookie made by hand (the bare user id) does NOT unlock", (await call("/api/annual-checkup/verify", { who: "D", extraCookie: `ac_unlock=${D}`, json: { ids: [resId] } })).status === 403);
    ok("a recorder cannot even try the unlock", (await call("/api/annual-checkup/unlock", { who: "R", json: { license: "12345" } })).status === 403);
    ok("a wrong licence number is refused", (await call("/api/annual-checkup/unlock", { who: "D", json: { license: "99999" } })).status === 403);
    const un = await call("/api/annual-checkup/unlock", { who: "D", json: { license: "ว.12345" } });
    const m = /ac_unlock=([^;]+)/.exec(un.setCookie);
    ok("the right licence number unlocks and sets a signed, httpOnly cookie", un.json?.ok === true && !!m && /HttpOnly/i.test(un.setCookie) && decodeURIComponent(m![1]).includes("."), un.setCookie);
    const unlockCk = `ac_unlock=${m![1]}`;
    ok("a recorder using the doctor's cookie is still refused (not approver)", (await call("/api/annual-checkup/verify", { who: "R", extraCookie: unlockCk, json: { ids: [resId] } })).status === 403);
    ok("with the unlock the doctor verifies", (await call("/api/annual-checkup/verify", { who: "D", extraCookie: unlockCk, json: { ids: [resId] } })).json?.verified === 1);
    ok("a verified result is locked against the recorder (422)", (await call("/api/annual-checkup/result", { who: "R", json: { orderId: oHav, valueText: "แก้" } })).status === 422);
    ok("conclusion + release by the doctor", (await call("/api/annual-checkup/conclusion", { who: "D", extraCookie: unlockCk, json: { roundId: round, subject: `u${A}`, summary: "follow_up", doctorComment: "ติดตาม" } })).json?.ok === true
      && (await call("/api/annual-checkup/release", { who: "D", extraCookie: unlockCk, json: { roundId: round, subject: `u${A}` } })).json?.released === 1);
    ok("a revision needs a reason and sends the result back to draft", (await call("/api/annual-checkup/revise", { who: "D", extraCookie: unlockCk, json: { resultId: resId, reason: "", valueText: "x" } })).status === 400
      && (await call("/api/annual-checkup/revise", { who: "D", extraCookie: unlockCk, json: { resultId: resId, reason: "แล็บแก้ผล", valueText: "พบภูมิคุ้มกัน", interpretation: "normal" } })).json?.ok === true
      && (db.prepare("SELECT status, revision FROM annual_checkup_results WHERE id=?").get(resId) as { status: string; revision: number }).revision === 2);
    // files
    const fd = new FormData(); fd.set("orderId", String(oHav)); fd.set("file", new File([Buffer.from("%PDF-1.4 e2e")], "lab.pdf", { type: "application/pdf" }));
    const up = await call("/api/annual-checkup/file/upload", { who: "R", form: fd });
    ok("recorder attaches a lab file", up.json?.ok === true, up.text);
    const bad = new FormData(); bad.set("orderId", String(oHav)); bad.set("file", new File(["MZ"], "x.exe", { type: "application/x-msdownload" }));
    ok("a non-PDF/image file is refused", (await call("/api/annual-checkup/file/upload", { who: "R", form: bad })).status === 400);
    const f2 = new FormData(); f2.set("orderId", String(oHav)); f2.set("file", new File([Buffer.from("%PDF")], "a.pdf", { type: "application/pdf" }));
    ok("an employee cannot upload a file and nothing is left on disk", (await call("/api/annual-checkup/file/upload", { who: "A", form: f2 })).status === 403);
    const page2 = await call(`/staff/health/annual-checkup/${round}/person/u${A}`, { who: "R" });
    const href = /href="(\/api\/annual-checkup\/file\/\d+\?t=[^"]+)"/.exec(page2.text)?.[1]?.replace(/&amp;/g, "&");
    ok("the person page links the file with a signed link", !!href, page2.text.slice(0, 200));
    if (href) {
      const f = await call(href, { who: "R" });
      ok("the file opens with the link (and is not cached)", f.status === 200 && f.text.startsWith("%PDF"));
      ok("the same link is refused for another user", (await call(href, { who: "D" })).status === 403);
      ok("the link without the token / with a wrong token is refused", (await call(href.split("?")[0], { who: "R" })).status === 403 && (await call(href.split("?")[0] + "?t=abc.def", { who: "R" })).status === 403);
      ok("no session → the file is not served", (await call(href)).status === 401);
    }
    ok("every file open and the writes are audited", (db.prepare("SELECT COUNT(*) n FROM annual_checkup_audit WHERE action='file.view'").get() as { n: number }).n >= 1 && (db.prepare("SELECT COUNT(*) n FROM annual_checkup_audit").get() as { n: number }).n > 8);
    ok("the lock route works", (await call("/api/annual-checkup/unlock", { who: "D", method: "DELETE" })).json?.ok === true);
  } finally { srv.kill("SIGTERM"); try { process.kill(-(srv.pid as number)); } catch { /* ignore */ } }
  console.log(failed ? `\n✗ ${failed} FAILED` : "\n✓ E2E ALL PASS");
  if (failed) console.error(out.slice(-1500));
  fs.rmSync(path.join(process.cwd(), "data", "e2e-health"), { recursive: true, force: true });
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) fs.rmSync(f, { force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

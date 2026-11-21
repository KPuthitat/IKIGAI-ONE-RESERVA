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
  const bcryptEarly = (await import("bcryptjs")).default;
  const R = mk("recorder", "staff", { health_result_recorder: 1, pin_hash: bcryptEarly.hashSync("4321", 4) }, clinic);
  const D = mk("doctor", "staff", { clinical_role: "doctor", license_no: "ว.12345", health_result_approver: 1, pin_hash: bcryptEarly.hashSync("4321", 4) }, clinic);
  const A = mk("emp-a", "staff", {}, nama), HR = mk("hr", "staff", { is_hr_analytics: 1 }, nama);
  const round = Number(db.prepare("INSERT INTO annual_checkup_rounds (name,year_be,status) VALUES ('ตรวจสุขภาพประจำปี 2569',2569,'open')").run().lastInsertRowid);
  const payer = Number(db.prepare("INSERT INTO annual_checkup_payers (round_id,name_th) VALUES (?, 'บริษัท ทดสอบ')").run(round).lastInsertRowid);
  const tid = (c: string) => (db.prepare("SELECT id FROM annual_checkup_tests WHERE code=?").get(c) as { id: number }).id;
  const oHav = Number(db.prepare("INSERT INTO annual_checkup_orders (round_id,user_id,payer_id,test_id,status) VALUES (?,?,?,?,'ordered')").run(round, A, payer, tid("HAV")).lastInsertRowid);
  const oUr = Number(db.prepare("INSERT INTO annual_checkup_orders (round_id,user_id,payer_id,test_id,status) VALUES (?,?,?,?,'waived')").run(round, A, payer, tid("URINE")).lastInsertRowid);
  const bcrypt = (await import("bcryptjs")).default;
  const E = mk("emp-e", "staff", { pin_hash: bcrypt.hashSync("4321", 4) }, nama);
  const sess = (uid: number) => { const id = `e2e-${uid}-${Math.random().toString(16).slice(2)}`; db.prepare("INSERT INTO sessions (id,user_id,active_branch_id,expires_at) VALUES (?,?,?,?)").run(id, uid, null, new Date(Date.now() + 3600_000).toISOString()); return id; };
  const SELF = mk("emp-self", "staff", {}, nama);
  db.prepare("INSERT INTO annual_checkup_queue (round_id, user_id, queue_no) VALUES (?,?,77)").run(round, SELF);
  const cookie = { R: sess(R), D: sess(D), A: sess(A), HR: sess(HR), E: sess(E), SELF: sess(SELF) };

  const port = 3999;
  const srv = spawn("npx", ["next", "start", "-p", String(port)], { env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let out = ""; srv.stdout.on("data", (d) => (out += d)); srv.stderr.on("data", (d) => (out += d));
  for (let i = 0; i < 60 && !/Ready|started server/i.test(out); i++) await new Promise((r) => setTimeout(r, 1000));
  const base = `http://localhost:${port}`;
  let failed = 0;
  const ok = (n: string, c: boolean, extra = "") => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n} ${extra}`); } };
  type Opt = { who?: keyof typeof cookie; extraCookie?: string; json?: unknown; form?: FormData; method?: string; noClinic?: boolean };
  const clinicCookie: Record<string, string> = {};   // the 20-minute PIN window of the clinician (R / D), added to their calls below
  const call = async (url: string, o: Opt = {}) => {
    const headers: Record<string, string> = {};
    const ck = [o.who ? `reserva_session=${cookie[o.who]}` : "", o.who && !o.noClinic ? (clinicCookie[o.who] ?? "") : "", o.extraCookie ?? ""].filter(Boolean).join("; ");
    if (ck) headers.cookie = ck;
    if (o.json !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(base + url, { method: o.method ?? (o.json !== undefined || o.form ? "POST" : "GET"), headers, body: o.json !== undefined ? JSON.stringify(o.json) : o.form, redirect: "manual" });
    const text = await r.text();
    return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), setCookie: r.headers.get("set-cookie") ?? "", loc: r.headers.get("location") ?? "" };
  };
  try {
    // self check-in from the registration poster
    const SES = await import("../src/lib/annual-checkup-session");
    const regTok = SES.makeStationToken(SES.REGISTER_CODE), bloodTok = SES.makeStationToken("BLOOD");
    const rid = round;
    const page = await call(`/staff/persona/checkup-queue/station/${encodeURIComponent(regTok)}`, { who: "SELF" });
    ok("the registration poster page offers the employee a one-tap check-in with their own number", page.status === 200 && page.text.includes("ยืนยันลงทะเบียน") && page.text.includes(">77<") || (page.status === 200 && page.text.includes("77") && page.text.includes("ยืนยันลงทะเบียน")), `status ${page.status}`);
    ok("a forged or other-station token cannot check in", (await call("/api/annual-checkup/me/checkin", { who: "SELF", json: { roundId: rid, token: bloodTok } })).status === 422 && (await call("/api/annual-checkup/me/checkin", { who: "SELF", json: { roundId: rid, token: regTok.replace("REGISTER", "XEGISTER") } })).status === 422);
    ok("no session → 401", (await call("/api/annual-checkup/me/checkin", { json: { roundId: rid, token: regTok } })).status === 401);
    ok("someone who is not in the round cannot check in", (await call("/api/annual-checkup/me/checkin", { who: "HR", json: { roundId: rid, token: regTok } })).status === 422);
    const ci = await call("/api/annual-checkup/me/checkin", { who: "SELF", json: { roundId: rid, token: regTok } });
    ok("the employee checks themselves in", ci.status === 200 && ci.json?.ok === true && ci.json?.already === false, `status ${ci.status}`);
    ok("a second tap changes nothing", (await call("/api/annual-checkup/me/checkin", { who: "SELF", json: { roundId: rid, token: regTok } })).json?.already === true);
    const row = db.prepare("SELECT checked_in_at, checked_in_by FROM annual_checkup_queue WHERE user_id = ?").get(SELF) as { checked_in_at: string | null; checked_in_by: number };
    ok("it is stamped as their own check-in", row.checked_in_at !== null && row.checked_in_by === SELF);
    const after = await call(`/staff/persona/checkup-queue/station/${encodeURIComponent(regTok)}`, { who: "SELF" });
    ok("scanning again after check-in sends them to their own page", after.status >= 300 && after.status < 400 && after.loc.includes("/staff/persona/checkup-queue"), `status ${after.status} ${after.loc}`);
    // the PIN gate: nothing clinical is served, page or API, until the clinician has typed their PIN
    const g1 = await call("/staff/health/annual-checkup/queue", { who: "R" });
    ok("without the PIN a clinic page redirects to the PIN page and shows nobody", g1.status >= 300 && g1.status < 400 && g1.loc.includes("/staff/health/annual-checkup/pin") && !g1.text.includes("emp-a"), `status ${g1.status} ${g1.loc}`);
    const g2 = await call("/api/annual-checkup/result", { who: "R", json: { orderId: oHav, valueText: "x" } });
    ok("without the PIN a clinical API refuses (403 pin_required)", g2.status === 403 && g2.json?.error === "pin_required", `status ${g2.status}`);
    ok("the PIN page itself opens for the clinician", (await call("/staff/health/annual-checkup/pin", { who: "R" })).status === 200);
    const wrong = await call("/api/annual-checkup/clinic/pin", { who: "R", json: { pin: "0000" } });
    ok("a wrong PIN is refused and opens nothing", wrong.status === 403 && !wrong.setCookie.includes("ac_clinic=") || wrong.status === 400, `status ${wrong.status}`);
    ok("an ordinary employee cannot open the clinic window", (await call("/api/annual-checkup/clinic/pin", { who: "A", json: { pin: "4321" } })).status === 403);
    for (const w of ["R", "D"] as const) {
      const r = await call("/api/annual-checkup/clinic/pin", { who: w, json: { pin: "4321" } });
      const m = /ac_clinic=([^;]+)/.exec(r.setCookie);
      ok(`${w} types the right PIN and gets a 20-minute window`, r.status === 200 && !!m, `status ${r.status}`);
      if (m) clinicCookie[w] = `ac_clinic=${m[1]}`;
    }
    const other = await call("/staff/health/annual-checkup/queue", { who: "A", extraCookie: clinicCookie.R });
    ok("someone else's clinic cookie does not open the clinic for an employee (sent away, nothing shown)", other.status >= 300 && other.status < 400 && other.loc.includes("/staff") && other.loc.includes("error=forbidden"), `status ${other.status} loc ${other.loc}`);
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
    // ── phase 5: the employee's own page ──
    const oE = Number(db.prepare("INSERT INTO annual_checkup_orders (round_id,user_id,payer_id,test_id,status) VALUES (?,?,?,?,'ordered')").run(round, E, payer, tid("HAV")).lastInsertRowid);
    await call("/api/annual-checkup/result", { who: "R", json: { orderId: oE, valueText: "พบภูมิคุ้มกัน", interpretation: "normal" } });
    const fe = new FormData(); fe.set("orderId", String(oE)); fe.set("file", new File([Buffer.from("%PDF-1.4 mine")], "mine.pdf", { type: "application/pdf" }));
    await call("/api/annual-checkup/file/upload", { who: "R", form: fe });
    const un2 = await call("/api/annual-checkup/unlock", { who: "D", json: { license: "ว.12345" } });
    const ck2 = /(ac_unlock=[^;]+)/.exec(un2.setCookie)?.[1] ?? "";
    const resE = (db.prepare("SELECT id FROM annual_checkup_results WHERE order_id = ?").get(oE) as { id: number }).id;
    await call("/api/annual-checkup/verify", { who: "D", extraCookie: ck2, json: { ids: [resE] } });
    await call("/api/annual-checkup/conclusion", { who: "D", extraCookie: ck2, json: { roundId: round, subject: `u${E}`, summary: "normal", doctorComment: "สุขภาพดีมาก" } });
    ok("the doctor releases E's result", (await call("/api/annual-checkup/release", { who: "D", extraCookie: ck2, json: { roundId: round, subject: `u${E}` } })).json?.released === 1);
    const first = await call("/staff/health/annual", { who: "E" });
    ok("E first sees the consent notice and no result", first.status === 200 && first.text.includes("ข้อตกลงการคุ้มครองข้อมูลส่วนบุคคล") && !first.text.includes("พบภูมิคุ้มกัน"), `status ${first.status}`);
    ok("the PIN step is refused until consent is given", (await call("/api/annual-checkup/me/unlock", { who: "E", json: { pin: "4321" } })).status === 403);
    ok("E accepts the consent", (await call("/api/annual-checkup/me/consent", { who: "E", json: {} })).json?.ok === true);
    const second = await call("/staff/health/annual", { who: "E" });
    ok("then E is asked for the PIN and still sees no result", second.text.includes("ยืนยันตัวตนเพื่อดูผลตรวจ") && !second.text.includes("พบภูมิคุ้มกัน"));
    ok("a wrong PIN is refused", (await call("/api/annual-checkup/me/unlock", { who: "E", json: { pin: "0000" } })).status === 403);
    ok("a hand-made view cookie (the bare user id) opens nothing", !(await call("/staff/health/annual", { who: "E", extraCookie: `ac_view=${E}` })).text.includes("พบภูมิคุ้มกัน"));
    const okPin = await call("/api/annual-checkup/me/unlock", { who: "E", json: { pin: "4321" } });
    const viewCk = /(ac_view=[^;]+)/.exec(okPin.setCookie)?.[1] ?? "";
    ok("the right PIN opens a signed, httpOnly viewing window", okPin.json?.ok === true && !!viewCk && /HttpOnly/i.test(okPin.setCookie) && decodeURIComponent(viewCk).includes("."), okPin.setCookie);
    const mine = await call("/staff/health/annual", { who: "E", extraCookie: viewCk });
    ok("E now sees their result, the doctor's comment and the audit list", mine.text.includes("พบภูมิคุ้มกัน") && mine.text.includes("สุขภาพดีมาก") && mine.text.includes("ใครเปิดดูข้อมูลฉัน"));
    ok("the viewing window of E is no use to another employee", !(await call("/staff/health/annual", { who: "A", extraCookie: viewCk })).text.includes("พบภูมิคุ้มกัน"));
    const mhref = /href="(\/api\/annual-checkup\/me\/file\/\d+\?t=[^"]+)"/.exec(mine.text)?.[1]?.replace(/&amp;/g, "&");
    ok("the page links the file with a signed link", !!mhref);
    if (mhref) {
      const f = await call(mhref, { who: "E", extraCookie: viewCk });
      ok("E opens their own file", f.status === 200 && f.text.startsWith("%PDF"));
      ok("without the open viewing window the link is refused", (await call(mhref, { who: "E" })).status === 403);
      ok("another employee cannot use the link", (await call(mhref, { who: "A", extraCookie: viewCk })).status === 403);
      ok("clinical staff cannot use the employee route", (await call(mhref, { who: "R", extraCookie: viewCk })).status === 403);
      ok("no session → 401", (await call(mhref)).status === 401);
    }
    ok("releasing is audited and E sees who opened their data", (db.prepare("SELECT COUNT(*) n FROM annual_checkup_audit WHERE action='self.view' AND actor_id = ?").get(E) as { n: number }).n >= 1);
    const hr = await call("/admin/annual-checkup-status", { who: "HR" });
    ok("HR sees counts and no name or result", hr.status === 200 && hr.text.includes("ความคืบหน้าตรวจสุขภาพประจำปี") && !/emp-e|emp-a|พบภูมิคุ้มกัน|สุขภาพดีมาก/.test(hr.text), `status ${hr.status}`);
    const stA = await call("/admin/annual-checkup-status", { who: "A" });
    ok("an ordinary employee cannot open the HR status page", stA.status !== 200 || !stA.text.includes("แยกตามบริษัทผู้จ่าย"), `status ${stA.status}`);
    ok("the clinic recorder is not an HR viewer either", !(await call("/admin/annual-checkup-status", { who: "R" })).text.includes("แยกตามบริษัทผู้จ่าย"));
    ok("the consent route is for the owner only", (await call("/api/admin/persona/annual-checkup/consent", { who: "HR", json: { version: "9", body: "x" } })).status === 403);
    // ── queue number + QR check-in ──
    db.prepare("UPDATE annual_checkup_rounds SET start_date = '2026-12-10', location = 'AT HOME CLINIC', appt_time = '08:00' WHERE id = ?").run(round);
    db.prepare("INSERT INTO annual_checkup_queue (round_id, user_id, queue_no) VALUES (?,?,1)").run(round, A);
    db.prepare("INSERT INTO annual_checkup_queue (round_id, user_id, queue_no) VALUES (?,?,2)").run(round, E);
    const tokA = (db.prepare("SELECT checkin_token t FROM annual_checkup_queue WHERE user_id = ?").get(A) as { t: string }).t;
    const tokE = (db.prepare("SELECT checkin_token t FROM annual_checkup_queue WHERE user_id = ?").get(E) as { t: string }).t;
    const qa = await call("/staff/persona/checkup-queue", { who: "A" });
    ok("the employee page shows their number, the fasting advice and no other person's token", qa.status === 200 && qa.text.includes("ลำดับตรวจสุขภาพประจำปี") && qa.text.includes("งดน้ำและงดอาหาร 8 ชั่วโมง") && !qa.text.includes(tokE), `status ${qa.status}`);
    ok("the QR is made from the token alone (the page never prints the name or code in the QR value)", !qa.text.includes("IKG-") && !/QR emp-/.test(qa.text));
    ok("someone with no queue place sees the empty state, not another person's", (await call("/staff/persona/checkup-queue", { who: "HR" })).text.includes("ยังไม่มีลำดับตรวจของท่าน"));
    ok("no session → the queue page is not served", !(await call("/staff/persona/checkup-queue")).text.includes("ลำดับของท่าน"));
    ok("an employee cannot scan (403)", (await call("/api/annual-checkup/queue/scan", { who: "A", json: { token: tokE } })).status === 403);
    ok("HR cannot scan or check in (403)", (await call("/api/annual-checkup/queue/scan", { who: "HR", json: { token: tokA } })).status === 403 && (await call("/api/annual-checkup/queue/checkin", { who: "HR", json: { token: tokA } })).status === 403);
    ok("no session → 401", (await call("/api/annual-checkup/queue/scan", { json: { token: tokA } })).status === 401);
    ok("an unknown or malformed token is a plain 404, never an error page", (await call("/api/annual-checkup/queue/scan", { who: "R", json: { token: "0".repeat(32) } })).status === 404 && (await call("/api/annual-checkup/queue/scan", { who: "R", json: { token: "x' OR '1'='1" } })).status === 404);
    const sc = await call("/api/annual-checkup/queue/scan", { who: "R", json: { token: tokA } });
    ok("the clinic recorder's scan shows the name, number and tests", sc.json?.ok === true && sc.json.scan.label === "emp-a" && sc.json.scan.queue_no === 1 && Array.isArray(sc.json.scan.tests));
    const c1 = await call("/api/annual-checkup/queue/checkin", { who: "R", json: { token: tokA } });
    ok("check-in is recorded with the staff member", c1.json?.ok === true && c1.json.already === false && c1.json.scan.checked_in_by === "recorder");
    const c2 = await call("/api/annual-checkup/queue/checkin", { who: "R", json: { token: tokA } });
    ok("scanning the same QR again changes nothing and says it was already checked in", c2.json?.already === true && c2.json.scan.checked_in_at === c1.json.scan.checked_in_at
      && (db.prepare("SELECT COUNT(*) n FROM annual_checkup_audit WHERE action = 'queue.checkin'").get() as { n: number }).n === 1);
    ok("the employee page then shows they are checked in (no QR needed any more)", (await call("/staff/persona/checkup-queue", { who: "A" })).text.includes("เช็กอินแล้ว"));
    const qpage = await call("/staff/health/annual-checkup/queue", { who: "R" });
    ok("the clinic roster page lists the round in queue order with arrived / not yet", qpage.status === 200 && qpage.text.includes("emp-a") && qpage.text.includes("emp-e"));
    ok("the roster is not served to HR or an employee", !(await call("/staff/health/annual-checkup/queue", { who: "HR" })).text.includes("emp-e") && !(await call("/staff/health/annual-checkup/queue", { who: "A" })).text.includes("emp-e"));
    ok("only the owner / recorder may change queue numbers through the admin route", (await call("/api/admin/persona/annual-checkup/queue", { who: "A", json: { roundId: round, subject: `u${E}`, queueNo: 7 } })).status === 403
      && (await call("/api/admin/persona/annual-checkup/queue", { who: "R", json: { roundId: round, subject: `u${E}`, queueNo: 1 } })).status === 422
      && (await call("/api/admin/persona/annual-checkup/queue", { who: "R", json: { roundId: round, subject: `u${E}`, queueNo: 7 } })).json?.ok === true);
    // ── stations, kit number, sent to the doctor ──
    const qA = (db.prepare("SELECT id FROM annual_checkup_queue WHERE user_id = ?").get(A) as { id: number }).id;
    const qE = (db.prepare("SELECT id FROM annual_checkup_queue WHERE user_id = ?").get(E) as { id: number }).id;
    ok("the kit number is linked by a recorder only, and a number used by someone else is refused", (await call("/api/annual-checkup/queue/kit", { who: "A", json: { queueId: qA, kitNo: "K-1" } })).status === 403
      && (await call("/api/annual-checkup/queue/kit", { who: "R", json: { queueId: qA, kitNo: "K-1" } })).json?.ok === true
      && (await call("/api/annual-checkup/queue/kit", { who: "R", json: { queueId: qE, kitNo: "K-1" } })).status === 422
      && (await call("/api/annual-checkup/queue/kit", { who: "R", json: { queueId: qA, kitNo: "bad kit!" } })).status === 422);
    const flat = (t: string) => t.replace(/<!-- -->/g, "");   // React separates adjacent text nodes with comments in the HTML
    const withKit = await call("/staff/persona/checkup-queue", { who: "A" });
    ok("after check-in the employee page shows the kit number and the stations (blood only: the urine test is waived and adds none)", flat(withKit.text).includes("K-1") && flat(withKit.text).includes("สถานีที่ต้องไป (0/1)") && withKit.text.includes("เจาะเลือด") && !withKit.text.includes("ปัสสาวะและอุจจาระ"), withKit.text.slice(0, 120));
    ok("before check-in the employee page keeps the route hidden", (await call("/staff/persona/checkup-queue", { who: "E" })).text.includes("เมื่อเจ้าหน้าที่สแกนเช็กอินแล้ว"));
    ok("a station cannot be passed by an employee / HR, before check-in, or when it is not on the route", (await call("/api/annual-checkup/queue/station", { who: "A", json: { token: tokA, station: "BLOOD" } })).status === 403
      && (await call("/api/annual-checkup/queue/station", { who: "HR", json: { token: tokA, station: "BLOOD" } })).status === 403
      && (await call("/api/annual-checkup/queue/station", { who: "R", json: { token: tokE, station: "BLOOD" } })).status === 422
      && (await call("/api/annual-checkup/queue/station", { who: "R", json: { token: tokA, station: "SPECIMEN" } })).status === 422);
    const ps1 = await call("/api/annual-checkup/queue/station", { who: "R", json: { token: tokA, station: "BLOOD" } });
    const ps2 = await call("/api/annual-checkup/queue/station", { who: "R", json: { token: tokA, station: "BLOOD" } });
    ok("staff at the station mark it passed; a second scan changes nothing", ps1.json?.ok === true && ps1.json.already === false && ps2.json?.already === true);
    ok("the employee page then shows the station as passed", flat((await call("/staff/persona/checkup-queue", { who: "A" })).text).includes("สถานีที่ต้องไป (1/1)"));
    ok("only a recorder may send results to the doctor (HR / employee refused)", (await call("/api/annual-checkup/submit", { who: "HR", json: { roundId: round, subject: `u${A}` } })).status === 403
      && (await call("/api/annual-checkup/submit", { who: "A", json: { roundId: round, subject: `u${A}` } })).status === 403);
    const sub = await call("/api/annual-checkup/submit", { who: "R", json: { roundId: round, subject: `u${A}` } });
    ok("the recorder sends a finished person to the doctor", sub.json?.ok === true && !!sub.json.submittedAt, sub.text);
    ok("a person with a test still to record cannot be sent (422)", (await call("/api/annual-checkup/submit", { who: "R", json: { roundId: round, subject: `u${E}` } })).json?.ok === true
      || (await call("/api/annual-checkup/submit", { who: "R", json: { roundId: round, subject: `e${99999}` } })).status === 422);
    ok("the clinic roster shows kit and stations", (await call("/staff/health/annual-checkup/queue", { who: "R" })).text.includes("K-1"));
    ok("the stations screen and its route are for the owner / a recorder only", (await call("/api/admin/persona/annual-checkup/stations", { who: "A", json: { action: "assign", testCode: "URIC", stationId: 1 } })).status === 403
      && (await call("/api/admin/persona/annual-checkup/stations", { who: "R", json: { action: "assign", testCode: "URIC", stationId: 1 } })).json?.ok === true
      && (await call("/api/admin/persona/annual-checkup/stations", { who: "R", json: { action: "save", nameTh: "สถานีใหม่", code: "NEW1", sortNo: 9, active: true } })).json?.ok === true);
    ok("the lock route works", (await call("/api/annual-checkup/unlock", { who: "D", method: "DELETE" })).json?.ok === true);
  } finally { srv.kill("SIGTERM"); try { process.kill(-(srv.pid as number)); } catch { /* ignore */ } }
  console.log(failed ? `\n✗ ${failed} FAILED` : "\n✓ E2E ALL PASS");
  if (failed) console.error(out.slice(-1500));
  fs.rmSync(path.join(process.cwd(), "data", "e2e-health"), { recursive: true, force: true });
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) fs.rmSync(f, { force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

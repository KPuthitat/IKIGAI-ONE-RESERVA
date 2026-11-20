import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import QRCode from "qrcode";
import { requireUser, isAdminCapable, isAdminUnlocked } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { canImportCheckup } from "@/lib/annual-checkup-import";
import { listStationCatalogue } from "@/lib/annual-checkup-stations";
import { makeStationToken, REGISTER_CODE } from "@/lib/annual-checkup-session";
import PrintButton from "./PrintButton";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "โปสเตอร์ QR ประจำสถานี · ตรวจสุขภาพประจำปี", robots: { index: false } };

const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL ?? "https://ikigaimedihealth.com").replace(/\/$/, "");
const PATH = "/print/annual-checkup-stations";
const dayTh = (iso: string) => new Date(`${iso}T00:00:00+07:00`).toLocaleDateString("th-TH", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Bangkok" });

type Step = [string, string];
const STATION_STEPS: Step[] = [["1", "เช็กอินกับเจ้าหน้าที่\nแล้วรับหมายเลขคิว"], ["2", "ตรวจเสร็จที่สถานีนี้\nสแกน QR ด้วยมือถือ"], ["3", "กดปุ่ม “ยืนยันผ่านการตรวจ”\nที่สถานีนี้"]];
const REGISTER_STEPS: Step[] = [["1", "สแกน QR นี้\nด้วยกล้องมือถือ"], ["2", "ดูหมายเลขคิว\nและ QR ประจำตัวของท่าน"], ["3", "แสดง QR ประจำตัว\nให้เจ้าหน้าที่สแกนเช็กอิน"]];

// A4 posters for the check-up day, one per station plus the registration poster. Lives OUTSIDE /admin so the page has no menu or header to print.
// Owner or a clinic recorder only (the same people who may import the round and set the stations).
export default async function PrintStationPostersPage({ searchParams }: { searchParams: { only?: string } }) {
  const user = requireUser();
  if (!canImportCheckup(user)) redirect("/staff?error=forbidden");
  if (isAdminCapable(user) && !isAdminUnlocked(user)) redirect(`/admin/unlock?next=${encodeURIComponent(PATH)}`);

  const round = getDb().prepare("SELECT name, year_be, start_date, location FROM annual_checkup_rounds WHERE status = 'open' ORDER BY id DESC LIMIT 1").get() as
    { name: string; year_be: number | null; start_date: string | null; location: string | null } | undefined;
  const stations = listStationCatalogue().stations.filter((s) => s.active === 1);
  const only = searchParams.only;
  type P = { key: string; kind: "register" | "station"; title: string; tag: string; url: string; steps: Step[] };
  const all: P[] = [
    { key: REGISTER_CODE, kind: "register", title: "ลงทะเบียน", tag: "เริ่มที่นี่", url: `${PUBLIC_BASE}/staff/persona/checkup-queue/station/${encodeURIComponent(makeStationToken(REGISTER_CODE))}`, steps: REGISTER_STEPS },
    ...stations.map((s, i): P => ({ key: s.code, kind: "station", title: s.name_th, tag: `สถานีที่ ${i + 1}`, url: `${PUBLIC_BASE}/staff/persona/checkup-queue/station/${encodeURIComponent(makeStationToken(s.code))}`, steps: STATION_STEPS }))
  ];
  const posters = only ? all.filter((p) => p.key === only) : all;
  const withQr = await Promise.all(posters.map(async (p) => ({ ...p, qr: await QRCode.toDataURL(p.url, { width: 900, margin: 0, errorCorrectionLevel: "M", color: { dark: "#1F2547", light: "#FFFFFF" } }) })));
  const heading = round ? (round.name || `ตรวจสุขภาพประจำปี ${round.year_be ?? ""}`) : "ตรวจสุขภาพประจำปี";
  const when = round?.start_date ? dayTh(round.start_date) : null;

  return (
    <div className="qr-root">
      <style>{CSS}</style>
      <div className="toolbar">
        <div className="toolbar-title">โปสเตอร์ QR ประจำสถานี · พิมพ์กระดาษ A4 แนวตั้ง หนึ่งสถานีต่อหนึ่งแผ่น</div>
        <div className="toolbar-row">
          <PrintButton label={only ? "สั่งพิมพ์ใบนี้" : `สั่งพิมพ์ทั้งหมด (${withQr.length} แผ่น)`} />
          <Link href="/admin/persona/annual-checkup/stations" className="toolbar-link">← กลับไปหน้าสถานี</Link>
          {only && <Link href={PATH} className="toolbar-link">ดูทั้งหมด</Link>}
        </div>
        <div className="toolbar-hint">ในหน้าต่างพิมพ์: เลือกกระดาษ A4, ขอบ “ไม่มี/ต่ำสุด” และติ๊ก “พิมพ์พื้นหลัง (Background graphics)” เพื่อให้สีออกครบ</div>
        {!only && <div className="toolbar-chips">{all.map((p) => <Link key={p.key} href={`${PATH}?only=${encodeURIComponent(p.key)}`} className="chip-link">{p.title}</Link>)}</div>}
      </div>
      <div className="sheets">
        {withQr.map((p) => (
          <section key={p.key} className="poster">
            <div className="bg-a" /><div className="bg-b" />
            <header className="head">
              <div className="brand">NOKHOOK OS</div>
              <div className="h-title">{heading}</div>
              {(when || round?.location) && <div className="h-meta">{[when, round?.location].filter(Boolean).join(" · ")}</div>}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="mascot" src={p.kind === "register" ? "/mascot/wai.webp" : "/mascot/thumbs.webp"} alt="" />
            </header>
            <div className="tag">{p.tag}</div>
            <h1 className="name">{p.title}</h1>
            <div className="qr-frame"><div className="qr-in">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.qr} alt={`QR ${p.title}`} />
            </div></div>
            <div className="lead">{p.kind === "register" ? "สแกนเพื่อดูหมายเลขคิวของท่าน" : "ตรวจเสร็จแล้ว สแกนที่นี่"}</div>
            <ol className="steps">
              {p.steps.map(([n, t]) => <li key={n}><span className="n">{n}</span><span className="t">{t}</span></li>)}
            </ol>
            <footer className="foot"><span>AT HOME CLINIC · IKIGAI MEDIHEALTH</span><span>{PUBLIC_BASE.replace(/^https?:\/\//, "")}</span></footer>
          </section>
        ))}
        {withQr.length === 0 && <div className="empty">ไม่พบสถานีนี้</div>}
      </div>
    </div>
  );
}

const CSS = `
.qr-root{background:#E9E6F2;min-height:100vh;padding:16px;font-family:inherit}
.toolbar{max-width:900px;margin:0 auto 14px;background:#fff;border-radius:16px;padding:14px 16px;box-shadow:0 2px 10px rgba(31,37,71,.12)}
.toolbar-title{font-weight:700;color:#1F2547;margin-bottom:10px}
.toolbar-row{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.toolbar-link{color:#6B4FD8;font-weight:600;font-size:14px}
.toolbar-hint{margin-top:10px;font-size:12px;color:#64748b}
.toolbar-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.chip-link{font-size:12px;border:1px solid #cbd5e1;border-radius:999px;padding:4px 10px;color:#334155;background:#f8fafc}
.sheets{display:flex;flex-direction:column;align-items:center;gap:14px}
.empty{color:#475569;padding:40px}
/* The poster is drawn at real A4 size in mm; on screen it is shown at about half size */
.poster{position:relative;width:210mm;height:297mm;overflow:hidden;background:#FFF8EC;color:#1F2547;display:flex;flex-direction:column;align-items:center;zoom:.5;box-shadow:0 4px 24px rgba(31,37,71,.2);-webkit-print-color-adjust:exact;print-color-adjust:exact;box-sizing:border-box}
.poster *{box-sizing:border-box}
.bg-a{position:absolute;left:-40mm;bottom:40mm;width:120mm;height:120mm;border-radius:50%;background:radial-gradient(circle,rgba(51,198,181,.22),rgba(51,198,181,0) 70%)}
.bg-b{position:absolute;right:-45mm;bottom:70mm;width:130mm;height:130mm;border-radius:50%;background:radial-gradient(circle,rgba(122,90,230,.20),rgba(122,90,230,0) 70%)}
.head{position:relative;align-self:stretch;height:58mm;background:linear-gradient(100deg,#7A5AE6 0%,#5C86EA 48%,#33C6B5 100%);color:#fff;padding:12mm 14mm 0;border-radius:0 0 14mm 14mm}
.brand{font-size:11pt;letter-spacing:.35em;font-weight:700;opacity:.9}
.h-title{font-size:25pt;font-weight:800;line-height:1.15;margin-top:3mm;max-width:118mm}
.h-meta{font-size:12pt;margin-top:3mm;opacity:.95;max-width:118mm}
.mascot{position:absolute;right:10mm;top:9mm;height:62mm;width:auto;filter:drop-shadow(0 3mm 4mm rgba(31,37,71,.28))}
.tag{position:relative;margin-top:-6mm;background:#14B8A6;color:#fff;font-weight:800;font-size:15pt;padding:2.2mm 9mm;border-radius:999px;box-shadow:0 2mm 4mm rgba(20,184,166,.35)}
.name{position:relative;margin:6mm 14mm 0;text-align:center;font-size:40pt;font-weight:800;line-height:1.12;color:#1F2547;max-width:182mm}
.qr-frame{position:relative;margin-top:7mm;padding:3.2mm;border-radius:14mm;background:linear-gradient(135deg,#7A5AE6,#33C6B5);box-shadow:0 4mm 8mm rgba(107,79,216,.28)}
.qr-in{background:#fff;border-radius:11mm;padding:7mm;width:112mm;height:112mm}
.qr-in img{display:block;width:100%;height:100%;image-rendering:pixelated}
.lead{position:relative;margin-top:6mm;font-size:21pt;font-weight:700;color:#6B4FD8}
.steps{position:relative;list-style:none;display:flex;gap:5mm;margin:7mm 12mm 0;padding:0;align-self:stretch;justify-content:center}
.steps li{flex:1;background:#fff;border-radius:6mm;padding:4mm 4mm 4mm;display:flex;flex-direction:column;align-items:center;gap:2.5mm;text-align:center;box-shadow:0 1.5mm 4mm rgba(31,37,71,.12);max-width:60mm}
.steps .n{width:10mm;height:10mm;border-radius:50%;background:linear-gradient(135deg,#7A5AE6,#33C6B5);color:#fff;font-weight:800;font-size:15pt;display:flex;align-items:center;justify-content:center}
.steps .t{font-size:11.5pt;line-height:1.35;white-space:pre-line;color:#1F2547}
.foot{position:absolute;left:0;right:0;bottom:0;height:15mm;background:#1F2547;color:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 14mm;font-size:10.5pt;font-weight:600;letter-spacing:.04em}
@page{size:A4 portrait;margin:0}
@media print{
  /* the app-wide print rule hides everything except .payslip / .printable; this page prints all of its own sheets */
  body .qr-root, body .qr-root *{visibility:visible!important}
  html,body{background:#fff!important}
  .qr-root{background:#fff;padding:0;min-height:0}
  .toolbar{display:none!important}
  .sheets{display:block}
  .poster{zoom:1;box-shadow:none;margin:0;break-after:page;page-break-after:always}
  .poster:last-child{break-after:auto;page-break-after:auto}
}
`;

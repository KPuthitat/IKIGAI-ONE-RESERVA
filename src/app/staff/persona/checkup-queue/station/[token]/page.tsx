import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getMyQueue } from "@/lib/annual-checkup-db";
import { readStationToken, REGISTER_CODE } from "@/lib/annual-checkup-session";
import StationScanConfirm from "./StationScanConfirm";
import SelfCheckIn from "./SelfCheckIn";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ผ่านสถานีตรวจ · NOKHOOK OS PORTAL" };

// The page behind a station's QR poster. The employee must be signed in (the login sends them back here); before check-in they are sent to
// their own number + QR page, after check-in they confirm with one tap and their own "ผ่านการตรวจแล้ว" is recorded for that station. The clinic's scan stays the official confirmation.
export default function StationScanPage({ params }: { params: { token: string } }) {
  const user = requireUser();
  const code = readStationToken(decodeURIComponent(params.token));
  const back = <Link href="/staff/persona/checkup-queue" className="btn-secondary text-sm inline-block">กลับไปหน้าลำดับตรวจ</Link>;
  const shell = (body: React.ReactNode) => <div className="space-y-4 max-w-md mx-auto"><h1 className="text-xl font-bold text-slate-800">ผ่านสถานีตรวจ</h1>{body}</div>;
  if (!code) return shell(<div className="card p-5 text-sm text-slate-700 space-y-3"><p>QR นี้ไม่ถูกต้อง กรุณาสแกน QR ที่ติดประจำสถานีอีกครั้ง</p>{back}</div>);
  // Any station poster scanned before checking in: show the employee their own number and personal QR instead of an error.
  const q = getMyQueue(user)[0];
  if (code === REGISTER_CODE) {
    // the registration poster: the employee checks themselves in with one tap (already in → straight to their own page)
    if (!q) return shell(<div className="card p-5 text-sm text-slate-700 space-y-3"><p>ยังไม่มีลำดับตรวจของท่านในรอบที่เปิดอยู่ กรุณาแจ้งเจ้าหน้าที่ที่จุดลงทะเบียน</p>{back}</div>);
    if (q.checked_in_at) redirect("/staff/persona/checkup-queue");
    return shell(<SelfCheckIn roundId={q.round_id} roundName={q.round_name} queueNo={q.queue_no} token={decodeURIComponent(params.token)} />);
  }
  if (q && !q.checked_in_at) redirect("/staff/persona/checkup-queue");
  if (!q) return shell(<div className="card p-5 text-sm text-slate-700 space-y-3"><p>ไม่พบลำดับตรวจของท่านในรอบที่เปิดอยู่</p>{back}</div>);
  const st = q.stations.find((x) => x.code === code);
  if (!st) return shell(<div className="card p-5 text-sm text-slate-700 space-y-3"><p>สถานีนี้ไม่อยู่ในรายการตรวจของท่าน</p>{back}</div>);
  return shell(<StationScanConfirm roundId={q.round_id} code={code} name={st.name_th} already={st.passed || st.self_marked} official={st.passed} />);
}

import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { listForUser } from "@/lib/policy-notices";
import { thaiMeetingTime } from "@/lib/policy-notices-notify";
import EmptyState from "@/app/components/EmptyState";
import Mascot from "@/app/components/Mascot";
import AckButton from "./AckButton";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ประกาศนโยบาย · NOKHOOK OS" };

const fmtTime = (iso: string) => new Date(iso).toLocaleString("th-TH", { dateStyle: "long", timeStyle: "short", timeZone: "Asia/Bangkok" });

// /staff/persona/policy-notices — meeting announcements and post-meeting letters for this employee.
// The only action here is "รับทราบ"; nothing about other people is shown.
export default function StaffPolicyNoticesPage() {
  const user = requireUser();
  const notices = listForUser(user.id);
  const pending = notices.filter((n) => n.status === "published" && !n.ackedAt);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Mascot pose={pending.length ? "notes" : "thumbs"} size={72} className="flex-shrink-0" />
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-slate-800">ประกาศนโยบาย</h1>
          <p className="text-sm text-slate-500">{pending.length ? `มี ${pending.length} เรื่องที่รอให้ท่านกดรับทราบ` : "ไม่มีเรื่องค้างรับทราบ"}</p>
        </div>
      </div>

      {notices.length === 0 && <EmptyState>ยังไม่มีประกาศ</EmptyState>}

      {notices.map((n) => (
        <article key={n.id} className={`card space-y-3 ${n.status === "published" && !n.ackedAt ? "border-amber-300" : ""}`}>
          <div className="flex items-start justify-between gap-2">
            <h2 className="font-bold text-slate-800">{n.title}</h2>
            {n.status === "scheduled" && <span className="tag tag-info flex-shrink-0">นัดประชุม</span>}
            {n.status !== "scheduled" && (n.ackedAt ? <span className="tag tag-ok flex-shrink-0">รับทราบแล้ว</span> : n.status === "closed" ? <span className="tag tag-mute flex-shrink-0">ปิดแล้ว</span> : <span className="tag tag-warn flex-shrink-0">รอรับทราบ</span>)}
          </div>

          {n.purpose && <p className="text-sm text-slate-600 whitespace-pre-line">{n.purpose}</p>}

          {n.status === "scheduled" && (
            <div className="rounded-2xl bg-[color:var(--surface-field)] p-3 text-sm text-slate-700 space-y-1">
              {n.meetingAt && <div><b>วันเวลา:</b> {thaiMeetingTime(n.meetingAt)}</div>}
              {n.location && <div><b>สถานที่:</b> {n.location}</div>}
              <div className="text-xs text-slate-500 pt-1">หลังประชุมจะมีหนังสือสรุปให้ท่านอ่านและกดรับทราบที่หน้านี้</div>
            </div>
          )}

          {n.items && n.items.map((it, i) => (
            <section key={i} className="rounded-2xl border border-[color:var(--card-border)] p-3 space-y-2">
              <div className="flex items-center gap-2"><span className="tag tag-brand">{i + 1}</span><h3 className="font-bold text-slate-800">{it.topic}</h3></div>
              <p className="text-sm text-slate-700 whitespace-pre-line">{it.details}</p>
              {it.suggestions && (
                <div className="rounded-xl bg-[color:var(--surface-field)] p-2.5 text-sm">
                  <div className="text-[11px] font-bold text-slate-500 mb-0.5">ข้อเสนอแนะจากพนักงาน</div>
                  <p className="text-slate-700 whitespace-pre-line">{it.suggestions}</p>
                </div>
              )}
            </section>
          ))}

          {n.status === "published" && !n.ackedAt && (
            <>
              {n.ackDeadline && <p className="text-xs text-amber-700">กรุณากดรับทราบภายใน {n.ackDeadline.split("-").reverse().join("/")}</p>}
              <AckButton noticeId={n.id} />
            </>
          )}
          {n.ackedAt && <p className="text-xs text-emerald-700">ท่านรับทราบเมื่อ {fmtTime(n.ackedAt)}</p>}
        </article>
      ))}
    </div>
  );
}

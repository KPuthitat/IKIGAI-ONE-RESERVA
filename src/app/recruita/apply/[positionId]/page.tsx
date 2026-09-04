import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDb, getSystemSettings } from "@/lib/db";
import { parseCustomQuestions } from "@/lib/recruita";
import { getRecruitaChannel, DEFAULT_RECRUITA_OA_LINK } from "@/lib/messaging-channels";
import { getFormTemplate } from "@/lib/recruita-form-template";
import ApplyClient from "./ApplyClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "สมัครงาน · IKIGAI Recruit" };

type Row = {
  id: number;
  title: string;
  code: string | null;
  branch_name: string | null;
  department: string | null;
  custom_questions: string;
};

export default function ApplyPage({ params }: { params: { positionId: string } }) {
  const id = Number(params.positionId);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const db = getDb();
  const p = db.prepare(`
    SELECT p.id, p.title, p.code, p.department, p.custom_questions,
           b.name AS branch_name
    FROM recruita_positions p
    LEFT JOIN branches b ON b.id = p.branch_id
    WHERE p.id = ? AND p.status = 'open'
  `).get(id) as Row | undefined;
  if (!p) notFound();
  const customQuestions = parseCustomQuestions(p.custom_questions);

  // Pass through the RECRUITA OA's LIFF ID so the client can boot
  // the LIFF SDK + auto-capture the applicant's LINE userId when
  // they open this page via the Rich Menu / chat link. Web-form
  // applicants (no LIFF id, or LIFF init fails) get null and the
  // form works the same — just without the auto-bind.
  const recruitaChannel = getRecruitaChannel();
  const liffId = recruitaChannel?.liff_id ?? null;
  // "Add OA as friend" deep link for the apply gate (RC-4) — shown when the
  // applicant opens the form outside LINE. Falls back to the owner default.
  const oaLink = (recruitaChannel?.oa_link ?? "").trim() || DEFAULT_RECRUITA_OA_LINK;
  // Global privacy-policy URL (single source of truth — see
  // /admin/system-settings). Passed into the PDPA consent section so
  // the applicant can review the actual policy text before ticking
  // consent. NULL/empty = no "ดูนโยบาย" button rendered.
  const settings = getSystemSettings();
  const privacyPolicyUrl = settings.privacy_policy_url ?? null;
  // PDPA policy image uploaded in /admin/system-settings. When set,
  // ApplyClient shows a "เปิดดูนโยบาย" button linking here; NULL =
  // fall back to the built-in DEFAULT_RECRUITA_PDPA_TEXT. The
  // ?v=<updated_at> param busts the serve route's 5-min cache when
  // the admin replaces the image.
  const pdpaImageUrl = settings.recruita_pdpa_image_path
    ? `/api/recruita/pdpa-image?v=${encodeURIComponent(settings.updated_at ?? "")}`
    : null;

  // Admin-editable form template → per-field { enabled, required, label }.
  // ApplyClient reads this to hide / rename / require standard fields.
  // Default template mirrors the form, so an un-customised template
  // renders the form exactly as before.
  const template = getFormTemplate();
  const fieldCfg: Record<string, { enabled: boolean; required: boolean; label: string; label_en: string }> = {};
  for (const sec of template.sections) {
    for (const fld of sec.fields) {
      fieldCfg[fld.key] = {
        enabled: fld.enabled, required: fld.required,
        label: fld.label_th, label_en: fld.label_en
      };
    }
  }

  // Active employees the applicant can pick as their ผู้แนะนำ (referral, owner
  // 2026-09-03). Name + nickname only — no PII. Resigned/disabled/test accounts
  // excluded so a referral can't be credited to someone no longer here.
  const referrers = db.prepare(`
    SELECT id, display_name, nickname_th
    FROM users
    WHERE role IN ('staff', 'admin')
      AND employment_type IS NOT NULL
      AND is_test_account = 0
      AND status NOT IN ('disabled', 'resigned', 'terminated')
    ORDER BY display_name
  `).all() as Array<{ id: number; display_name: string; nickname_th: string | null }>;

  return (
    <div className="min-h-screen bg-amber-50/40 py-6 px-4">
      <main className="max-w-2xl mx-auto">
        <ApplyClient
          positionId={p.id}
          positionTitle={p.title}
          positionCode={p.code}
          branchName={p.branch_name}
          department={p.department}
          customQuestions={customQuestions}
          liffId={liffId}
          oaLink={oaLink}
          privacyPolicyUrl={privacyPolicyUrl}
          pdpaImageUrl={pdpaImageUrl}
          fieldCfg={fieldCfg}
          referrers={referrers}
        />
      </main>
    </div>
  );
}

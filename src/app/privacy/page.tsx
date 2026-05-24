import Link from "next/link";
import type { Metadata } from "next";
import { getLang } from "@/lib/lang-server";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "นโยบายความเป็นส่วนตัว · IKIGAI OS RESERVA"
};

// Public-facing PDPA notice. Linked from the LIFF claim consent
// checkbox + (future) the footer of every customer-facing page.
// The content is hand-written rather than i18n-keyed because legal
// language doesn't translate well via tooling — we keep TH + EN
// side-by-side in this single component instead.
export default function PrivacyPage() {
  const lang = getLang();
  return (
    <main className="min-h-screen bg-slate-50 py-8 px-4">
      <div className="max-w-2xl mx-auto bg-white rounded-2xl shadow-sm border border-slate-200 p-6 sm:p-8 space-y-6">
        <header className="border-b border-slate-200 pb-4">
          <div className="text-[11px] tracking-[1px] text-slate-400">
            IKIGAI OS · RESERVA
          </div>
          <h1 className="text-2xl font-bold text-slate-800 mt-1">
            {lang === "en"
              ? "Privacy Policy"
              : "นโยบายความเป็นส่วนตัว (PDPA)"}
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            {lang === "en"
              ? "Last updated: 24 May 2026"
              : "อัปเดตล่าสุด: 24 พฤษภาคม 2569"}
          </p>
        </header>

        {lang === "en" ? <PolicyEn /> : <PolicyTh />}

        <div className="border-t border-slate-200 pt-4 text-center text-xs">
          <Link href="/" className="text-brand hover:underline">
            ← {lang === "en" ? "Back to home" : "กลับหน้าหลัก"}
          </Link>
        </div>
      </div>
    </main>
  );
}

function PolicyTh() {
  return (
    <article className="prose prose-sm max-w-none text-slate-700 space-y-4">
      <Section title="1. ผู้ควบคุมข้อมูล">
        <p>
          IKIGAI ONE (ในนามของร้านอาหารในเครือ — NAMA PASTA SRIRACHA,
          HYPOPLARAEMIA, AT HOME CLINIC, OMNIA HEALTH LAB) เป็นผู้ควบคุมข้อมูล
          ส่วนบุคคลของท่านตามพระราชบัญญัติคุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562
        </p>
      </Section>

      <Section title="2. ข้อมูลที่เราเก็บ">
        <ul className="list-disc list-inside space-y-1">
          <li>ชื่อและเบอร์โทรศัพท์ — เพื่อยืนยันและติดต่อกลับเรื่องการจอง</li>
          <li>LINE User ID — เพื่อส่งคิวอาร์โค้ดและการแจ้งเตือนการจอง</li>
          <li>วันเวลาจองและจำนวนคน — เพื่อจัดโต๊ะและบริการ</li>
          <li>
            ข้อมูลด้านอาหารที่แพ้ — เป็นข้อมูลด้านสุขภาพ ทางร้านใช้เฉพาะเพื่อ
            เตรียมอาหารให้ปลอดภัย (มาตรา 26)
          </li>
          <li>โอกาสพิเศษ (เช่น วันเกิด) — เพื่อปรับการบริการให้เหมาะสม</li>
        </ul>
      </Section>

      <Section title="3. วัตถุประสงค์ในการใช้ข้อมูล">
        <ul className="list-disc list-inside space-y-1">
          <li>การจองและการบริการที่ร้าน</li>
          <li>การแจ้งเตือนผ่าน LINE (เตือนล่วงหน้า / ยืนยัน / ยกเลิก)</li>
          <li>การวิเคราะห์เพื่อปรับปรุงบริการ (เฉพาะข้อมูลรวม ไม่ระบุตัวตน)</li>
          <li>โปรโมชั่นสำหรับลูกค้าใหม่ (เช่น ไอติมฟรี)</li>
        </ul>
      </Section>

      <Section title="4. การเก็บรักษาและการลบ">
        <p>
          ข้อมูลการจองเก็บไว้ 60 วันหลังวันจอง แล้วลบอัตโนมัติ
          ข้อมูลสุขภาพ (อาหารที่แพ้) ลบพร้อมการจอง
        </p>
      </Section>

      <Section title="5. การเปิดเผยข้อมูล">
        <p>
          เราใช้บริการ LINE Messaging API (บริษัท LINE Corporation, ประเทศญี่ปุ่น)
          เพื่อส่งข้อความ LINE User ID ของท่านจึงถูกประมวลผลโดย LINE ตามนโยบาย
          ความเป็นส่วนตัวของ LINE เราไม่ขายหรือให้ข้อมูลแก่บุคคลที่สาม
          เพื่อวัตถุประสงค์ทางการตลาด
        </p>
      </Section>

      <Section title="6. สิทธิของเจ้าของข้อมูล">
        <p>ท่านมีสิทธิ์ตาม PDPA ได้แก่:</p>
        <ul className="list-disc list-inside space-y-1">
          <li>ขอเข้าถึงและขอสำเนาข้อมูลของท่าน</li>
          <li>ขอแก้ไขข้อมูลที่ไม่ถูกต้อง</li>
          <li>ขอลบข้อมูล (Right to be forgotten)</li>
          <li>ขอระงับการใช้ข้อมูล</li>
          <li>คัดค้านการประมวลผล</li>
          <li>เพิกถอนความยินยอม (ผ่านการตอบกลับใน LINE)</li>
        </ul>
        <p className="mt-2">
          ติดต่อขอใช้สิทธิ์ได้ทาง LINE OA ของร้าน หรือเขียนข้อความ
          &quot;ขอลบข้อมูล&quot; ในแชท LINE ของร้านนั้น ๆ
        </p>
      </Section>

      <Section title="7. ความปลอดภัย">
        <p>
          ข้อมูลที่อ่อนไหว (เช่น คีย์ระบบ LINE) ถูกเข้ารหัสในฐานข้อมูลด้วย
          AES-256-GCM ข้อมูลส่วนบุคคลส่งผ่าน HTTPS เท่านั้น
        </p>
      </Section>

      <Section title="8. ติดต่อ">
        <p>
          คำถามเกี่ยวกับนโยบายนี้ ติดต่อได้ทาง LINE OA ของร้านที่ท่านใช้บริการ
        </p>
      </Section>
    </article>
  );
}

function PolicyEn() {
  return (
    <article className="prose prose-sm max-w-none text-slate-700 space-y-4">
      <Section title="1. Data Controller">
        <p>
          IKIGAI ONE (on behalf of its restaurants — NAMA PASTA SRIRACHA,
          HYPOPLARAEMIA, AT HOME CLINIC, OMNIA HEALTH LAB) is the data
          controller of your personal data under the Thailand Personal Data
          Protection Act 2019 (PDPA).
        </p>
      </Section>

      <Section title="2. What we collect">
        <ul className="list-disc list-inside space-y-1">
          <li>Name and phone number — to confirm and contact you about your booking</li>
          <li>LINE User ID — to deliver QR codes and booking notifications</li>
          <li>Date, time, party size — to allocate tables and prepare service</li>
          <li>
            Food allergies — health data, used only to prepare your meal safely
            (PDPA section 26)
          </li>
          <li>Special occasion (e.g. birthday) — to tailor the service</li>
        </ul>
      </Section>

      <Section title="3. Purpose">
        <ul className="list-disc list-inside space-y-1">
          <li>Booking management and on-site service</li>
          <li>LINE notifications (reminder / confirmation / cancellation)</li>
          <li>Service improvement analytics (aggregated, non-identifying)</li>
          <li>First-time-customer perks (e.g. free ice cream)</li>
        </ul>
      </Section>

      <Section title="4. Retention">
        <p>
          Booking data is kept for 60 days after the booking date, then
          automatically deleted. Health data (allergies) is deleted alongside
          the booking.
        </p>
      </Section>

      <Section title="5. Third-party processors">
        <p>
          We use the LINE Messaging API (LINE Corporation, Japan) to send
          messages. Your LINE User ID is therefore processed by LINE under its
          own privacy policy. We do not sell or share data with third parties
          for marketing.
        </p>
      </Section>

      <Section title="6. Your rights">
        <p>Under PDPA you have the right to:</p>
        <ul className="list-disc list-inside space-y-1">
          <li>Access and obtain a copy of your data</li>
          <li>Rectify inaccurate data</li>
          <li>Erasure (right to be forgotten)</li>
          <li>Restrict processing</li>
          <li>Object to processing</li>
          <li>Withdraw consent (via reply on LINE)</li>
        </ul>
        <p className="mt-2">
          Exercise these rights by messaging the restaurant&apos;s LINE OA, or
          send &quot;delete my data&quot; in the LINE chat.
        </p>
      </Section>

      <Section title="7. Security">
        <p>
          Sensitive credentials (e.g. LINE channel keys) are encrypted at rest
          with AES-256-GCM. Personal data is transmitted only over HTTPS.
        </p>
      </Section>

      <Section title="8. Contact">
        <p>
          Questions about this policy? Reach out via the LINE OA of the
          restaurant you booked with.
        </p>
      </Section>
    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="font-bold text-slate-800 text-base mb-2">{title}</h2>
      <div className="text-sm leading-relaxed">{children}</div>
    </section>
  );
}

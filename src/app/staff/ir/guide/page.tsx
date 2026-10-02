// /staff/ir/guide — คู่มือการเขียนรายงานความเสี่ยง (IR) สำหรับพนักงานทุกคน
// (owner 2026-10-01). Static, in-app, reachable by every signed-in employee.
import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { IR_SEVERITIES, IR_CONTRIBUTING_FACTORS, IR_STATUSES } from "@/lib/ir-vocab";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "คู่มือการเขียนรายงานความเสี่ยง (IR)" };

const TOC = [
  ["what", "1. IR คืออะไร ทำไมต้องเขียน"],
  ["when", "2. เมื่อไหร่ต้องเขียน"],
  ["who", "3. ใครเป็นคนเขียน"],
  ["severity", "4. ระดับความรุนแรง"],
  ["facts", "5. เขียน “เกิดอะไรขึ้น” อย่างไร"],
  ["rca", "6. วิเคราะห์สาเหตุราก (5 Whys + ปัจจัยร่วม)"],
  ["recs", "7. เขียนข้อเสนอแนะอย่างไร"],
  ["after", "8. หลังส่งรายงานเกิดอะไรขึ้น"],
  ["examples", "9. ตัวอย่างรายงานที่ดี"],
  ["checklist", "10. เช็กลิสต์ก่อนกด “ส่งรายงาน”"]
] as const;

export default function IrGuidePage() {
  requireUser();
  return (
    <div className="space-y-5 max-w-3xl">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <Link href="/staff/ir" className="text-sm text-slate-500 hover:text-brand">← ความเสี่ยง / IR</Link>
          <h1 className="text-2xl font-bold text-slate-800 mt-1">คู่มือการเขียนรายงานความเสี่ยง (IR)</h1>
          <p className="text-sm text-slate-500 mt-1">อ่าน 5 นาที ก่อนเขียนรายงานครั้งแรก · ใช้ได้ทั้งร้านอาหารและคลินิก</p>
        </div>
        <Link href="/staff/ir/new" className="btn btn-primary text-sm">+ แจ้งเหตุการณ์</Link>
      </div>

      <nav className="card !p-3.5">
        <div className="text-xs font-bold text-slate-500 mb-1.5">สารบัญ</div>
        <ol className="grid sm:grid-cols-2 gap-x-4 gap-y-1 text-sm">
          {TOC.map(([id, label]) => <li key={id}><a href={`#${id}`} className="text-brand hover:underline">{label}</a></li>)}
        </ol>
      </nav>

      <Section id="what" title="1. IR คืออะไร ทำไมต้องเขียน">
        <p><b>IR (Incident Report)</b> คือรายงาน “เหตุการณ์ที่ไม่ควรเกิด” ในที่ทำงาน — ตั้งแต่เรื่องเล็กที่เกือบพลาด ไปจนถึงเรื่องที่ลูกค้าหรือเพื่อนร่วมงานได้รับผลกระทบ</p>
        <p>เราเขียน IR เพื่อ <b>หาสาเหตุและแก้ที่ระบบ</b> ไม่ใช่เพื่อหาคนผิด เหตุการณ์เดียวกันมักเกิดซ้ำกับคนละคน ถ้าเราแก้แค่ “บอกให้ระวัง” มันจะกลับมาอีก แต่ถ้าเราแก้ขั้นตอน อุปกรณ์ หรือการจัดคน มันจะไม่กลับมา</p>
        <Callout tone="emerald" title="กติกาของเรา (No-blame)">
          การเขียน IR ด้วยตัวเอง = ความรับผิดชอบและความกล้า ไม่มีการลงโทษจากการรายงานตามจริง สิ่งที่จะถูกตำหนิคือ <b>การปกปิด</b> หรือรายงานเท็จ
        </Callout>
      </Section>

      <Section id="when" title="2. เมื่อไหร่ต้องเขียน">
        <ul className="list-disc pl-5 space-y-1">
          <li><b>เกิดขึ้นจริง</b> — ลูกค้า/พนักงานบาดเจ็บ ของเสียหาย เสิร์ฟผิด จ่ายยาผิด เงินหาย ระบบล่ม ฯลฯ</li>
          <li><b>เกือบพลาด (Near Miss)</b> — เกือบเกิดแต่จับได้ก่อน เช่น เกือบจ่ายยาผิดขนาด เกือบเสิร์ฟเมนูที่ลูกค้าแพ้ <span className="text-slate-500">— เรื่องพวกนี้สำคัญที่สุด เพราะได้เรียนรู้ฟรีโดยไม่มีใครเจ็บ</span></li>
          <li><b>ข้อร้องเรียน</b> — ลูกค้าตำหนิ ไม่พอใจ ขอคืนเงิน รีวิวลบที่มีเหตุจากเรา</li>
        </ul>
        <p><b>เขียนภายใน 24 ชั่วโมง</b> ตอนที่ยังจำรายละเอียดได้ ถ้ายังไม่ครบก็ส่งก่อนแล้วกลับมาแก้ไขเพิ่มได้จนกว่าจะปิดเคส</p>
        <p className="text-slate-500 text-sm">ไม่แน่ใจว่าควรเขียนไหม? <b>เขียน</b> ทีม RM จะเป็นคนตัดสินว่านับเป็นเหตุการณ์หรือไม่</p>
      </Section>

      <Section id="who" title="3. ใครเป็นคนเขียน">
        <p><b>คนที่อยู่ในเหตุการณ์หรือเป็นผู้ทำให้เกิด</b> ล็อกอินและเขียนด้วยตัวเอง — เพราะคุณคือคนที่รู้ว่าเกิดอะไรขึ้นจริงๆ และรู้ว่าอะไรทำให้พลาด</p>
        <ul className="list-disc pl-5 space-y-1">
          <li>ติ๊ก “ฉันเป็นผู้เกี่ยวข้องโดยตรง” ถ้าคุณเป็นคนทำหรืออยู่ในเหตุการณ์</li>
          <li><b>เพิ่มชื่อผู้อื่น</b> ที่เกี่ยวข้องทุกคน (เพื่อนร่วมงานที่ร่วมเหตุการณ์ คนที่เห็น คนที่ได้รับผลกระทบ) — เพื่อให้ทีม RM สอบถามเพิ่มได้ ไม่ใช่เพื่อโยนความผิด เลือกจากรายชื่อพนักงาน หรือพิมพ์ชื่อถ้าเป็นบุคคลภายนอก เช่น ลูกค้า</li>
          <li>ถ้าหลายคนอยู่ในเหตุการณ์ ให้คนที่เกี่ยวข้องมากที่สุดเขียน 1 ฉบับ แล้วใส่ชื่อคนอื่นไว้ ไม่ต้องเขียนซ้ำหลายฉบับ</li>
          <li>แจ้งแบบ <b>ไม่ระบุตัวตน</b> ได้ในกรณีที่กังวล แต่จะแก้ไขรายงานภายหลังไม่ได้ และทีม RM จะสอบถามเพิ่มไม่ได้</li>
        </ul>
      </Section>

      <Section id="severity" title="4. ระดับความรุนแรง">
        <p>เลือกตาม <b>ผลที่เกิดขึ้นจริง</b> (ไม่ใช่ที่อาจจะเกิด) ถ้าลังเลระหว่าง 2 ระดับ เลือกระดับที่สูงกว่า</p>
        <div className="space-y-1.5">
          {IR_SEVERITIES.map((s) => (
            <div key={s.value} className="flex items-start gap-2 text-sm">
              <span className={`text-[11px] px-1.5 py-0.5 rounded border shrink-0 ${s.tone}`}>{s.value} · {s.labelTh}</span>
              <span className="text-slate-600">{s.descTh}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section id="facts" title="5. เขียน “เกิดอะไรขึ้น” อย่างไร">
        <p>ตอบให้ครบ <b>ใคร · ทำอะไร · ที่ไหน · เมื่อไร · อย่างไร · ผลเป็นอย่างไร</b> เขียนเฉพาะ <b>สิ่งที่เห็นและทำจริง</b> ไม่ใส่ความรู้สึก ไม่เดาเจตนาของคนอื่น</p>
        <Compare
          bad="ลูกค้าโวยวายเพราะน้องใหม่ไม่ระวังทำซุปหก"
          good="12:40 ขณะเสิร์ฟซุปร้อน 3 ถ้วยในถาดเดียวให้โต๊ะ 5 ถาดเอียง ซุปหกใส่ข้อมือซ้ายลูกค้า ผิวแดง ไม่พอง ลูกค้าขอให้ไม่คิดเงินมื้อนั้น"
          why="แบบดีมีเวลา จำนวน ตำแหน่ง และผลที่เกิดจริง ไม่มีคำตัดสิน (“ไม่ระวัง”) และไม่ระบุว่าใครผิด"
        />
        <ul className="list-disc pl-5 space-y-1">
          <li><b>ลำดับเหตุการณ์</b> — เขียนเป็นบรรทัดตามเวลา ก่อนเกิด → ตอนเกิด → หลังเกิด ช่วยให้เห็นว่าจุดไหนที่ “ถ้าทำต่างไปจะไม่เกิด”</li>
          <li><b>ผลกระทบ</b> — ต่อลูกค้า (บาดเจ็บ/ไม่พอใจ/ค่าชดเชย) ต่อพนักงาน ต่อทรัพย์สิน ต่อชื่อเสียง ใส่ตัวเลขถ้ามี (จำนวนเงิน จำนวนคน)</li>
          <li><b>แก้ไขเฉพาะหน้า</b> — ทำอะไรไปแล้วตอนนั้น (ปฐมพยาบาล เปลี่ยนของ ขอโทษ แจ้งหัวหน้า) และผลเป็นอย่างไร</li>
        </ul>
      </Section>

      <Section id="rca" title="6. วิเคราะห์สาเหตุราก (Root Cause Analysis)">
        <p>“สาเหตุราก” คือสาเหตุที่ <b>ถ้าแก้แล้วเหตุการณ์จะไม่เกิดซ้ำ</b> ส่วนใหญ่ไม่ใช่สิ่งแรกที่นึกถึง (“ไม่ระวัง”) แต่เป็นสิ่งที่อยู่ลึกลงไป (ขั้นตอน การจัดคน อุปกรณ์)</p>
        <h3 className="font-semibold text-slate-700 mt-2">วิธี 5 Whys — ถาม “ทำไม” ซ้ำจากคำตอบก่อนหน้า</h3>
        <ol className="space-y-1 text-sm rounded-lg border border-slate-200 p-3 bg-slate-50/60">
          <li><b>ทำไม #1</b> ซุปหก? → เพราะยกถาด 3 ถ้วยคนเดียวแล้วถาดเอียง</li>
          <li><b>ทำไม #2</b> ยก 3 ถ้วยคนเดียว? → เพราะมีออเดอร์ 4 โต๊ะพร้อมกัน และคนเสิร์ฟมีคนเดียว</li>
          <li><b>ทำไม #3</b> คนเสิร์ฟมีคนเดียว? → เพราะช่วงพีคไม่มีการจัดคนสำรองจากครัวมาช่วย</li>
          <li><b>ทำไม #4</b> ไม่มีคนสำรอง? → เพราะไม่มีกติกาว่าช่วงพีคใครต้องมาช่วยเสิร์ฟ และไม่มีกติกาจำกัดของร้อนต่อถาด</li>
          <li className="text-emerald-700"><b>→ สาเหตุราก:</b> ไม่มีขั้นตอนรับมือช่วงพีคสำหรับการเสิร์ฟของร้อน (คน + กติกา) — แก้ตรงนี้แล้วจะไม่เกิดซ้ำกับใครก็ตาม</li>
        </ol>
        <ul className="list-disc pl-5 space-y-1 mt-2">
          <li>หยุดถามเมื่อถึงสิ่งที่ <b>ร้านแก้ได้จริง</b> (ไม่ต้องครบ 5 ชั้น) ถ้าคำตอบกลายเป็น “เพราะคนนั้นสะเพร่า” ให้ถามต่อว่า <i>ทำไมระบบถึงปล่อยให้ความสะเพร่าครั้งเดียวกลายเป็นเหตุการณ์ได้</i></li>
          <li>คำตอบที่ดีมักขึ้นต้นด้วย “ไม่มีขั้นตอน…” “ไม่มีการตรวจ…” “อุปกรณ์…” “ไม่ได้ส่งต่อข้อมูล…” มากกว่า “คนนั้นไม่…”</li>
        </ul>
        <h3 className="font-semibold text-slate-700 mt-3">ปัจจัยร่วม — ติ๊กทุกข้อที่มีส่วน</h3>
        <div className="grid sm:grid-cols-2 gap-1.5 text-sm">
          {IR_CONTRIBUTING_FACTORS.map((f) => (
            <div key={f.key} className="rounded-lg border border-slate-200 px-2.5 py-1.5">
              <span className="font-medium text-slate-700">{f.labelTh}</span>
              <span className="block text-[11px] text-slate-400">{f.hintTh}</span>
            </div>
          ))}
        </div>
        <p className="mt-2"><b>สรุปสาเหตุราก</b> 1–2 ประโยค: สิ่งที่ถ้าแก้แล้วจะไม่เกิดซ้ำ — ทีม RM จะใช้ประโยคนี้ตั้งต้นในการประชุมทบทวน</p>
      </Section>

      <Section id="recs" title="7. เขียนข้อเสนอแนะอย่างไร">
        <p>ข้อเสนอแนะที่ดี <b>แก้ที่ระบบ</b> และ <b>ลงมือทำได้</b>: ระบุว่า <b>ทำอะไร · ใครทำ · เมื่อไร</b> เสนอได้มากกว่า 1 ข้อ เรียงจากข้อที่ได้ผลที่สุด</p>
        <div className="grid sm:grid-cols-2 gap-2 text-sm">
          <div className="rounded-lg border border-rose-200 bg-rose-50/50 p-3">
            <div className="text-xs font-bold text-rose-700 mb-1">อ่อน (แก้ที่คน)</div>
            <ul className="list-disc pl-4 space-y-0.5 text-slate-600">
              <li>จะระวังมากขึ้น</li>
              <li>เตือนพนักงานให้ตั้งใจ</li>
              <li>อบรมซ้ำ (โดยไม่เปลี่ยนอะไร)</li>
            </ul>
          </div>
          <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-3">
            <div className="text-xs font-bold text-emerald-700 mb-1">แข็ง (แก้ที่ระบบ)</div>
            <ul className="list-disc pl-4 space-y-0.5 text-slate-600">
              <li>ของร้อนจำกัด 2 ถ้วยต่อถาด ติดป้ายที่จุดจ่ายอาหาร (หัวหน้ากะ · สัปดาห์หน้า)</li>
              <li>ช่วงพีค 12:00–13:30 ครัวส่ง 1 คนมาช่วยเสิร์ฟ (ผู้จัดการ · เริ่มรอบตารางถัดไป)</li>
              <li>เปลี่ยนถาดเป็นแบบมีขอบกันลื่น (จัดซื้อ · ภายใน 2 สัปดาห์)</li>
            </ul>
          </div>
        </div>
        <p className="text-sm text-slate-500 mt-1">ลำดับความแข็งของมาตรการ: <b>กำจัดความเสี่ยงออก</b> &gt; เปลี่ยนอุปกรณ์/ขั้นตอน &gt; ป้าย/เช็กลิสต์ &gt; อบรม &gt; เตือนให้ระวัง</p>
      </Section>

      <Section id="after" title="8. หลังส่งรายงานเกิดอะไรขึ้น">
        <ol className="list-decimal pl-5 space-y-1">
          <li>รายงานขึ้นสถานะ <b>ใหม่</b> ทีม RM เห็นทันทีในเมนู IR ฝั่งผู้ดูแล</li>
          <li>ทีม RM ทบทวน (สถานะ <b>กำลังทบทวน</b>) อาจสอบถามคุณหรือผู้ที่ถูกระบุชื่อเพิ่มเติม และนำเข้าประชุมประจำสัปดาห์</li>
          <li>กำหนดมาตรการ ผู้รับผิดชอบ และกำหนดเสร็จ (สถานะ <b>กำลังแก้ไข</b>) — ข้อเสนอแนะของคุณจะถูกนำไปพิจารณาตรงนี้</li>
          <li>เมื่อมาตรการเสร็จ → <b>ปิดเคส</b> หรือถ้าทบทวนแล้วไม่นับเป็นเหตุการณ์ → <b>ไม่นับเป็นเหตุการณ์</b> (ไม่ใช่ความผิดของผู้แจ้ง)</li>
        </ol>
        <div className="flex flex-wrap gap-1.5 mt-1">
          {IR_STATUSES.map((s) => <span key={s.value} className={`text-[11px] px-1.5 py-0.5 rounded border ${s.tone}`}>{s.labelTh}</span>)}
        </div>
        <p className="mt-1">คุณ <b>แก้ไขรายงานของตัวเองได้ตลอด</b> จนกว่าจะปิดเคส — นึกอะไรออกเพิ่ม กลับมาเติมได้ และทุกคนในสาขาอ่านรายงานของกันและกันได้ เพื่อเรียนรู้ร่วมกัน</p>
      </Section>

      <Section id="examples" title="9. ตัวอย่างรายงานที่ดี">
        <Example
          title="ร้านอาหาร · เกิดขึ้นจริง · ระดับ 3 ปานกลาง · หมวด อุบัติเหตุในครัว"
          rows={[
            ["เกิดอะไรขึ้น", "12:40 ขณะเสิร์ฟซุปร้อน 3 ถ้วยในถาดเดียวให้โต๊ะ 5 ถาดเอียง ซุปหกใส่ข้อมือซ้ายลูกค้า ผิวแดง ไม่พอง"],
            ["ลำดับเหตุการณ์", "12:30 รับออเดอร์ 4 โต๊ะพร้อมกัน / 12:38 ยกถาด 3 ถ้วยคนเดียว / 12:40 ซุปหก / 12:41 ล้างน้ำเย็น ขอโทษลูกค้า แจ้งหัวหน้า"],
            ["ผลกระทบ", "ลูกค้าแดงที่ข้อมือ ไม่ต้องพบแพทย์ · ไม่คิดเงินมื้อนั้น 640 บาท · เสื้อลูกค้าเปื้อน"],
            ["5 Whys", "ยกถาดหนัก → ออเดอร์พร้อมกัน 4 โต๊ะ คนเสิร์ฟคนเดียว → ไม่มีคนสำรองช่วงพีค → ไม่มีกติกาช่วงพีคและกติกาของร้อนต่อถาด"],
            ["ปัจจัยร่วม", "ขั้นตอน/วิธีทำงาน · คน (คนไม่พอ) · อุปกรณ์ (ถาดลื่น)"],
            ["สรุปสาเหตุราก", "ไม่มีขั้นตอนรับมือช่วงพีคสำหรับการเสิร์ฟของร้อน (คนสำรอง + จำกัดจำนวนต่อถาด)"],
            ["ข้อเสนอแนะ", "1) ของร้อนไม่เกิน 2 ถ้วยต่อถาด ติดป้ายจุดจ่าย (หัวหน้ากะ · สัปดาห์หน้า) 2) ช่วงพีคครัวส่ง 1 คนช่วยเสิร์ฟ (ผู้จัดการ · ตารางรอบถัดไป) 3) เปลี่ยนถาดมีขอบกันลื่น (จัดซื้อ · 2 สัปดาห์)"],
            ["ผู้เกี่ยวข้อง", "ตัวเอง (ผู้เสิร์ฟ) · เพื่อนร่วมงานในครัว (ผู้เห็นเหตุการณ์) · ลูกค้าโต๊ะ 5 (ผู้ได้รับผลกระทบ · บุคคลภายนอก)"]
          ]}
        />
        <Example
          title="คลินิก · เกือบพลาด · ระดับ 1 · หมวด ยา/เวชภัณฑ์"
          rows={[
            ["เกิดอะไรขึ้น", "15:10 เตรียมยา A ขนาด 10 มก. ให้ผู้รับบริการ แต่หยิบขวด 20 มก. ซึ่งฉลากสีเดียวกัน ตรวจซ้ำก่อนให้จึงพบ เปลี่ยนเป็นขวดที่ถูกต้อง ผู้รับบริการไม่ได้รับยา"],
            ["ผลกระทบ", "ไม่มีผลต่อผู้รับบริการ · เสียเวลา 5 นาที"],
            ["5 Whys", "หยิบผิดขวด → ฉลากสีเดียวกัน วางชั้นเดียวกัน → ไม่มีการแยกเก็บยาที่ชื่อ/สีคล้ายกัน → ไม่มีกติกาจัดเก็บยากลุ่มเสี่ยงสับสน"],
            ["ปัจจัยร่วม", "วัตถุดิบ/ยา (ฉลากคล้าย) · ขั้นตอน (ไม่มีกติกาแยกเก็บ) · สิ่งแวดล้อม (แสงน้อย)"],
            ["สรุปสาเหตุราก", "ยาชื่อ/ฉลากคล้ายกันถูกเก็บติดกันโดยไม่มีสัญลักษณ์เตือน"],
            ["ข้อเสนอแนะ", "1) แยกชั้นเก็บ 10 มก./20 มก. และติดสติกเกอร์ “ระวังสับสน” (หัวหน้าพยาบาล · สัปดาห์นี้) 2) เพิ่มการตรวจซ้ำ 2 คนสำหรับยากลุ่มนี้ลงใน WI (RM · 2 สัปดาห์)"]
          ]}
        />
      </Section>

      <Section id="checklist" title="10. เช็กลิสต์ก่อนกด “ส่งรายงาน”">
        <ul className="space-y-1.5">
          {[
            "เวลา สถานที่ หมวด ชนิด และระดับความรุนแรง เลือกตามผลที่เกิดจริง",
            "“เกิดอะไรขึ้น” มีครบ ใคร ทำอะไร ที่ไหน เมื่อไร อย่างไร ผลเป็นอย่างไร — ไม่มีคำตัดสินคน",
            "ใส่ชื่อผู้เกี่ยวข้องทุกคน (เพื่อนร่วมงาน พยาน ผู้ได้รับผลกระทบ)",
            "ถาม “ทำไม” จนถึงสิ่งที่ร้านแก้ได้จริง และติ๊กปัจจัยร่วม",
            "สรุปสาเหตุราก 1–2 ประโยค ไม่ใช่ “เพราะไม่ระวัง”",
            "ข้อเสนอแนะอย่างน้อย 1 ข้อ แก้ที่ระบบ ระบุ ทำอะไร ใครทำ เมื่อไร",
            "ส่งภายใน 24 ชม. — ยังไม่ครบก็ส่งก่อน แล้วกลับมาแก้ไขเพิ่มได้"
          ].map((x) => (
            <li key={x} className="flex items-start gap-2 text-sm text-slate-700">
              <span className="mt-0.5 w-4 h-4 rounded border border-slate-300 shrink-0" aria-hidden />
              {x}
            </li>
          ))}
        </ul>
        <div className="pt-2">
          <Link href="/staff/ir/new" className="btn btn-primary text-sm">พร้อมแล้ว — แจ้งเหตุการณ์</Link>
        </div>
      </Section>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="card space-y-2.5 scroll-mt-20">
      <h2 className="text-lg font-bold text-slate-800">{title}</h2>
      <div className="text-sm text-slate-700 space-y-2">{children}</div>
    </section>
  );
}
function Callout({ tone, title, children }: { tone: "emerald" | "amber"; title: string; children: React.ReactNode }) {
  const cls = tone === "emerald" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-900";
  return (
    <div className={`rounded-lg border px-3 py-2.5 text-sm ${cls}`}>
      <div className="font-bold mb-0.5">{title}</div>
      <div>{children}</div>
    </div>
  );
}
function Compare({ bad, good, why }: { bad: string; good: string; why: string }) {
  return (
    <div className="grid sm:grid-cols-2 gap-2 text-sm">
      <div className="rounded-lg border border-rose-200 bg-rose-50/50 p-3">
        <div className="text-xs font-bold text-rose-700 mb-1">แบบนี้ยังไม่ดี</div>
        <p className="text-slate-700">“{bad}”</p>
      </div>
      <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-3">
        <div className="text-xs font-bold text-emerald-700 mb-1">แบบนี้ดี</div>
        <p className="text-slate-700">“{good}”</p>
      </div>
      <p className="sm:col-span-2 text-xs text-slate-500">{why}</p>
    </div>
  );
}
function Example({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return (
    <div className="rounded-xl border border-slate-200 overflow-hidden">
      <div className="bg-slate-50 px-3 py-2 text-xs font-bold text-slate-600">{title}</div>
      <dl className="divide-y divide-slate-100">
        {rows.map(([k, v]) => (
          <div key={k} className="grid sm:grid-cols-[9rem_1fr] gap-x-3 gap-y-0.5 px-3 py-2 text-sm">
            <dt className="text-xs text-slate-400 sm:pt-0.5">{k}</dt>
            <dd className="text-slate-700">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

# IKIGAI ONE RESERVA

ระบบจองโต๊ะร้านอาหาร 2 สาขา (NAMA PASTA SRIRACHA / HYPOPLARAEMIA)

**ฟีเจอร์**

- กำหนด floor plan ลาก-วางได้
- ลูกค้าจองผ่านลิงก์ ระบบเลือกโต๊ะที่เหมาะสมที่สุดให้
- ปุ่ม "ลูกค้ามาแล้ว / ไม่มา / ยกเลิก" สำหรับแอดมิน — โต๊ะถูกปล่อยทันทีเมื่อยกเลิก
- เลือกสาขาได้ + กำหนดสิทธิ์พนักงานเฉพาะสาขา
- แจ้งเตือนผ่าน LINE Messaging API (ฟรี 200 ข้อความ/เดือน)
- Export CSV ให้ทีมการตลาด + dashboard ภาพรวมรายวัน + 7 วัน + ที่มาของลูกค้า
- เก็บข้อมูลย้อนหลัง 60 วัน (ปรับได้ใน `.env`)

## 1) ติดตั้ง Node.js

ระบบต้องใช้ Node.js เวอร์ชัน LTS (≥ 20)

**Windows (แนะนำใช้ winget — มากับ Windows 11 อยู่แล้ว):**

```powershell
winget install OpenJS.NodeJS.LTS
```

หรือดาวน์โหลด installer จาก <https://nodejs.org/> แล้วเปิด PowerShell ใหม่

ตรวจสอบ:

```powershell
node --version
npm --version
```

## 2) ติดตั้งโปรเจกต์

```powershell
cd "C:\Users\ikiga\OneDrive\Clinic Desktop\IKIGAI ONE\IKIGAI ONE RESERVA"
npm install
copy .env.example .env
```

แก้ค่าใน `.env` (อย่างน้อยตั้ง `SESSION_SECRET` กับ `CRON_SECRET` ให้เป็น string สุ่มยาวๆ)

## 3) สร้างฐานข้อมูล

```powershell
npm run db:init
```

จะได้ไฟล์ `data/reserva.db` พร้อม:

- 2 สาขา: `nama-sriracha`, `hypoplaraemia`
- โต๊ะตัวอย่าง 8 โต๊ะต่อสาขา (ปรับได้ใน /admin/floor-plan)
- บัญชี admin เริ่มต้น: **`admin` / `admin1234`** ← เปลี่ยนรหัสผ่านทันทีหลัง login

## 4) รันเซิร์ฟเวอร์

```powershell
npm run dev
```

เปิด <http://localhost:3000>

- หน้าจองลูกค้า: <http://localhost:3000/book/nama-sriracha>
- หน้าแอดมิน: <http://localhost:3000/admin>

## 5) ตั้งค่า LINE Messaging API

LINE Notify ปิดบริการตั้งแต่ 31 มี.ค. 2025 — ต้องใช้ Messaging API (ฟรี 200 push/เดือน) แทน

1. เข้า <https://developers.line.biz/console/> ล็อกอินด้วย LINE Business ID ที่ผูกกับ OA ของร้าน
2. สร้าง Provider → สร้าง Channel แบบ **Messaging API** ของแต่ละสาขา
3. ในหน้า Channel:
   - คัดลอก **Channel secret** (Basic settings)
   - คัดลอก **Channel access token** (Messaging API → Issue/Reissue) **เก็บแบบยาว**
4. เปิด Webhook ในหน้า Messaging API → ตั้ง webhook URL:
   - `https://<your-domain>/api/line/webhook/nama-sriracha`
   - `https://<your-domain>/api/line/webhook/hypoplaraemia`
   - กด **Verify** ต้อง 200 OK
5. ใน `/admin/settings` (เลือกสาขา) → วาง Channel Access Token + Channel Secret
6. หา **userId พนักงาน**: ให้พนักงาน add LINE OA → ใน Channel Console เข้า Webhook events log ดู userId หรือเขียน script log
7. ใส่ใน "LINE userId พนักงาน" เป็น JSON array เช่น `["U1234abcd...","U5678efgh..."]`

> ลูกค้าจะได้รับแจ้งเตือนก็ต่อเมื่อ **add LINE OA แล้ว** เพราะ LINE Messaging API ไม่อนุญาต push ไปยัง user ที่ยังไม่ได้ follow

## 6) ตั้ง cron แจ้งเตือน

มี 2 วิธี เลือกอย่างใดอย่างหนึ่ง:

### วิธี A — Windows Task Scheduler (เครื่องที่รันระบบเปิดตลอด)

1. เปิด Task Scheduler → Create Task
2. Trigger: รายซ้ำทุก 5 นาที
3. Action: `cmd.exe /c "cd /d C:\Users\ikiga\OneDrive\Clinic Desktop\IKIGAI ONE\IKIGAI ONE RESERVA && npm run cron:run"`
4. Run whether user is logged on or not

### วิธี B — เรียก HTTP endpoint (ใช้ตอน deploy บน server)

```bash
curl -X POST https://your-domain/api/cron -H "x-cron-token: <CRON_SECRET ใน .env>"
```

ใช้บริการฟรี เช่น <https://cron-job.org/> ตั้งให้รันทุก 5 นาที

cron จะทำ 3 อย่าง:

1. ส่ง LINE reminder ก่อนถึงเวลาจอง (ตั้งใน `/admin/settings` default 60 นาที)
2. mark `no_show` อัตโนมัติถ้าเลยเวลา 30 นาทีและยังไม่ได้กด "ลูกค้ามาแล้ว"
3. ลบข้อมูล booking ที่เกิน `RETENTION_DAYS` (default 60)

## 7) สิทธิ์ผู้ใช้

| บทบาท | ทำได้ |
|---|---|
| **admin** | จัดการ floor plan / staff / settings / export + ทุกอย่างที่ staff ทำได้ |
| **staff** | ดู dashboard + การจอง + กดสถานะ "ลูกค้ามาแล้ว/ไม่มา/ยกเลิก" + ย้ายโต๊ะ |

แอดมินสามารถจำกัดสิทธิ์พนักงานเฉพาะสาขาได้ใน `/admin/staff`

## 8) ปุ่มสลับสาขา

ผู้ใช้ที่มีสิทธิ์ในหลายสาขาจะมี dropdown ที่ header เลือกสลับสาขาได้

## โครงสร้าง

```
src/
├── app/                      Next.js App Router
│   ├── page.tsx              เลือกสาขา (public)
│   ├── book/[branch]/        ฟอร์มจองของลูกค้า
│   ├── admin/                หน้าแอดมิน + พนักงาน
│   └── api/                  REST endpoints + LINE webhook + cron
├── lib/
│   ├── db.ts                 SQLite (better-sqlite3)
│   ├── schema.sql            DB schema
│   ├── auth.ts               session/cookie/redirect helpers
│   ├── password.ts           bcrypt (ใช้ในสคริปต์ standalone ได้)
│   ├── table-allocator.ts    best-fit เลือกโต๊ะที่เหมาะสมที่สุด
│   ├── line.ts               LINE Messaging API
│   ├── csv.ts                CSV export
│   ├── retention.ts          ลบข้อมูลเก่า
│   └── time.ts               helpers สำหรับโซนเวลา Asia/Bangkok
├── scripts/
│   ├── init-db.ts            สร้าง DB + admin + 2 สาขา + โต๊ะตัวอย่าง
│   └── cron.ts               รัน reminder + cleanup standalone
└── data/                     จัดเก็บไฟล์ SQLite (.gitignore แล้ว)
```

## Build production

```powershell
npm run build
npm start
```

หรือ deploy ไป Vercel แล้วย้าย DB ไป Turso (SQLite cloud ฟรี) — ภายหลัง

## คำสั่งที่ใช้บ่อย

```powershell
npm run dev          # dev server (hot reload)
npm run build        # build production
npm start            # รัน production build
npm run db:init      # สร้าง schema + seed admin
npm run cron:run     # รัน reminder + cleanup ครั้งเดียว
```

## ปัญหาที่พบบ่อย

- **`better-sqlite3` ติดตั้งไม่ได้** — ต้องมี Visual Studio Build Tools บน Windows: `npm install --global windows-build-tools` (รันใน PowerShell admin) หรือใช้ `npm install --build-from-source` ภายหลังจากลง MSVC แล้ว
- **LINE webhook เรียกไม่ได้บน localhost** — ใช้ ngrok: `ngrok http 3000` แล้วเอา URL `*.ngrok.io` ไปวางใน LINE Console
- **ลูกค้าไม่ได้รับแจ้งเตือน** — ตรวจว่า (1) ลูกค้า add LINE OA แล้ว (2) `line_user_id` มีค่าใน `bookings` (3) Channel Token ใน `/admin/settings` ถูกต้อง (4) ดู `notification_log` table

## License

Private. ใช้ภายในร้าน NAMA PASTA SRIRACHA / HYPOPLARAEMIA เท่านั้น

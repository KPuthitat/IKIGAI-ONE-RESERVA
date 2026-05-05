# Deploy ขึ้น ikigaimedihealth.com/reserva

เซิร์ฟเวอร์ของคุณเป็น **Ubuntu + Nginx + Node.js (Express)** อยู่แล้ว
เราจะรัน Next.js เป็น process แยกที่พอร์ต **3010** แล้วให้ Nginx forward `/reserva/*` มาที่นั้น

## ขั้นตอน 1: เตรียมเซิร์ฟเวอร์ (ครั้งเดียว)

SSH เข้าเซิร์ฟเวอร์แล้ว:

```bash
# ตรวจ Node.js (ต้อง ≥ 20)
node --version

# ถ้ายังเก่า ติดตั้ง Node 20 LTS ผ่าน NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs build-essential

# build-essential จำเป็นสำหรับ better-sqlite3 (compile C++)
```

## ขั้นตอน 2: อัปโหลดโค้ด

**ตัวเลือก A: ผ่าน rsync จากเครื่อง Windows ของคุณ** (PowerShell + WSL หรือ Git Bash)

```bash
rsync -avz --exclude node_modules --exclude .next --exclude data \
  "/c/Users/ikiga/OneDrive/Clinic Desktop/IKIGAI ONE/IKIGAI ONE RESERVA/" \
  user@ikigaimedihealth.com:/var/www/reserva/
```

**ตัวเลือก B: ผ่าน git** (push โค้ดขึ้น GitHub/GitLab ก่อน)

```bash
sudo mkdir -p /var/www/reserva
sudo chown $USER:$USER /var/www/reserva
git clone <your-repo-url> /var/www/reserva
```

## ขั้นตอน 3: ตั้งค่า env + install + build

```bash
cd /var/www/reserva
cp deploy/env.production.example .env
nano .env   # แก้ SESSION_SECRET, CRON_SECRET ให้เป็น random string ยาวๆ

npm install --omit=dev
npm run build

# สร้าง DB + admin เริ่มต้น (admin/admin1234)
mkdir -p data
npm run db:init

# เปลี่ยน owner เป็น www-data (user ที่ systemd จะรันด้วย)
sudo chown -R www-data:www-data /var/www/reserva
```

## ขั้นตอน 4: ติดตั้ง systemd service

```bash
sudo cp deploy/reserva.service /etc/systemd/system/
sudo cp deploy/reserva-cron.service /etc/systemd/system/
sudo cp deploy/reserva-cron.timer /etc/systemd/system/

sudo systemctl daemon-reload
sudo systemctl enable --now reserva
sudo systemctl enable --now reserva-cron.timer

# ตรวจสถานะ
sudo systemctl status reserva
sudo journalctl -u reserva -f      # ดู log realtime, Ctrl+C ออก

# ทดสอบจาก localhost ภายในเซิร์ฟเวอร์
curl http://127.0.0.1:3010/reserva/
```

ถ้าเห็น HTML กลับมา = Next.js รันได้

## ขั้นตอน 5: เพิ่ม Nginx location block

```bash
# หาไฟล์ config ของ ikigaimedihealth.com
sudo ls /etc/nginx/sites-enabled/

# น่าจะเป็นไฟล์ ikigaimedihealth.com หรือ default
sudo nano /etc/nginx/sites-enabled/ikigaimedihealth.com
```

ดูใน `deploy/nginx-reserva.conf` แล้วคัดลอก:

1. บล็อก `map $http_upgrade ...` — วางไว้ **นอก** server block (ที่ระดับ http) — ถ้า nginx อื่นๆ มีอยู่แล้วก็ข้าม
2. บล็อก `location = /reserva` และ `location /reserva/` — วางไว้ **ใน** server block ของ ikigaimedihealth.com (server { ... })

ทดสอบและ reload:

```bash
sudo nginx -t                    # ต้องเป็น "syntax is ok"
sudo systemctl reload nginx
```

## ขั้นตอน 6: ทดสอบ

เปิดบราวเซอร์ → <https://ikigaimedihealth.com/reserva/>

ควรเห็นหน้าเลือกสาขา 2 ร้าน

หน้าแอดมิน: <https://ikigaimedihealth.com/reserva/admin>
- login: `admin / admin1234`
- เปลี่ยนรหัสทันทีที่หน้า /admin/staff

## ขั้นตอน 7: ตั้งค่า LINE webhook

ใน LINE Developers Console ของแต่ละสาขา:

- Webhook URL: `https://ikigaimedihealth.com/reserva/api/line/webhook/nama-sriracha`
- Webhook URL: `https://ikigaimedihealth.com/reserva/api/line/webhook/hypoplaraemia`
- กด **Verify** ต้อง 200 OK
- เปิด "Use webhook" = ON

แล้ววาง Channel Token + Secret ที่ `/reserva/admin/settings`

## การ update โค้ดในอนาคต

### ผ่าน git
```bash
cd /var/www/reserva
sudo bash deploy/deploy.sh
```

### ผ่าน rsync จากเครื่อง Windows
```bash
rsync -avz --exclude node_modules --exclude .next --exclude data \
  "/c/Users/ikiga/OneDrive/Clinic Desktop/IKIGAI ONE/IKIGAI ONE RESERVA/" \
  user@ikigaimedihealth.com:/var/www/reserva/
ssh user@ikigaimedihealth.com 'cd /var/www/reserva && sudo bash deploy/deploy.sh'
```

## Backup ฐานข้อมูล

```bash
# backup รายวัน (ใส่ใน crontab)
0 3 * * * sqlite3 /var/www/reserva/data/reserva.db ".backup /var/backups/reserva-$(date +\%F).db"
```

## ปัญหาที่พบบ่อย

**`502 Bad Gateway`**: service ไม่ได้รัน
```bash
sudo systemctl status reserva
sudo journalctl -u reserva -n 50
```

**`404 Not Found` ที่ /reserva**: nginx ยังไม่ reload หรือ location block ผิด
```bash
sudo nginx -t
sudo systemctl reload nginx
```

**CSS/JS ไม่โหลด** (หน้าขาว): basePath ใน .env ไม่ตรงกับ URL — ตรวจ `NEXT_PUBLIC_BASE_PATH=/reserva` แล้ว `npm run build` ใหม่

**`better-sqlite3` install ไม่ผ่าน**: ขาด build tools
```bash
sudo apt install -y build-essential python3
npm rebuild better-sqlite3
```

**Cookie ไม่ทำงาน / login ตีกลับ**: ตรวจว่า nginx ส่ง `X-Forwarded-Proto $scheme;` (มีอยู่ใน nginx-reserva.conf แล้ว)

# Deploy V2 — Big Refactor (unified login + module structure)

โครงสร้างใหม่:

| URL | หน้า |
|---|---|
| `/` | redirect ไป `/login` |
| `/login` | login รวม (เลือก ADMIN / STAFF) |
| `/admin` | admin module picker (PERSONA + RESERVA) |
| `/admin/persona` | admin info module PERSONA → ลิงก์ไป `/payroll` |
| `/admin/reserva/*` | RESERVA backend (เดิม `/reserva/admin/*`) |
| `/staff` | staff module picker |
| `/staff/persona` | ลงเวลาเข้า/ออกงาน |
| `/staff/reserva` | ดูการจอง |
| `/persona` | ทางลัด → `/staff/persona` |
| `/reserva` | จองโต๊ะลูกค้า — โชว์ NAMA เด่น |
| `/reserva/[branch]` | ฟอร์มจอง (เดิม `/reserva/book/[branch]`) |
| `/payroll/*` | Express เดิม — login ใหม่จะมาจาก `/login` |

## ⚠️ Breaking changes

- **basePath ลบ**: ตั้ง `NEXT_PUBLIC_BASE_PATH=` (ลบบรรทัดในไฟล์ .env)
- **users**: ใช้ Payroll DB เป็นหลัก — ลบ admin/admin1234 เดิม login ด้วย **admin/ikigai2026**
- **URL เก่าใช้ไม่ได้**: `/reserva/admin/*` → 404 ใช้ `/admin/reserva/*` แทน

## ขั้นตอน Deploy

### 1. ที่ Windows: push code (GitHub Desktop)

- Commit message: `restructure: unified login + module-based portal + SSO with Payroll`
- Commit to main → Push origin

### 2. ที่ Server (DigitalOcean Console)

#### 2.1 Patch Payroll Express ก่อน

```bash
cd /var/www/ikigai-payroll/webapp/middleware
cp requireAuth.js requireAuth.js.bak.$(date +%s)
```

ก่อนอื่นต้องดึงไฟล์ใหม่จาก reserva repo (เพราะอยู่ใน `/var/www/reserva/deploy/payroll-patches/`):

```bash
# pull reserva ก่อนเพื่อให้มีไฟล์ patch
cd /var/www/reserva
sudo -u www-data git pull
```

จากนั้น copy patch ไป Payroll:

```bash
cp /var/www/reserva/deploy/payroll-patches/requireAuth.js /var/www/ikigai-payroll/webapp/middleware/requireAuth.js

# แก้ /payroll/login redirect → /login
sed -i.bak 's|res\.sendFile(path\.join(__dirname, .public., .login\.html.))|res.redirect("/login")|' /var/www/ikigai-payroll/webapp/server.js

# verify
grep -A 3 "Login page" /var/www/ikigai-payroll/webapp/server.js
node -c /var/www/ikigai-payroll/webapp/server.js && echo "syntax OK"
```

#### 2.2 ลบ NEXT_PUBLIC_BASE_PATH ออกจาก .env

```bash
sed -i '/^NEXT_PUBLIC_BASE_PATH=/d' /var/www/reserva/.env
echo "PAYROLL_DB_PATH=/var/www/ikigai-payroll/webapp/db/payroll.db" >> /var/www/reserva/.env
cat /var/www/reserva/.env
```

#### 2.3 Update Nginx config

```bash
# backup ก่อน
cp /etc/nginx/sites-enabled/ikigai-payroll /etc/nginx/sites-enabled/ikigai-payroll.bak.$(date +%s)

# คัดลอกไฟล์ใหม่
cp /var/www/reserva/deploy/nginx-ikigai-payroll.conf /etc/nginx/sites-enabled/ikigai-payroll

# ทดสอบ
nginx -t
```

⚠️ **ห้าม reload nginx จนกว่า Next.js + Payroll ใหม่จะรัน**

#### 2.4 Build + restart Next.js

```bash
cd /var/www/reserva
npm install        # อาจมี dependency ใหม่
npm run build
chown -R www-data:www-data /var/www/reserva
systemctl restart reserva
sleep 3
systemctl status reserva --no-pager | head -10
```

#### 2.5 Restart Payroll Express

หา process manager:

```bash
ps aux | grep "node.*ikigai-payroll" | grep -v grep
systemctl list-units --type=service | grep -i payroll || pm2 list 2>/dev/null
```

restart ตามนั้น เช่น:
```bash
# ถ้า systemd
systemctl restart <ชื่อ-payroll-service>
# ถ้า pm2
pm2 restart server
```

#### 2.6 Reload Nginx (สุดท้ายเสมอ)

```bash
nginx -t && systemctl reload nginx
```

#### 2.7 Smoke test

```bash
echo "==== / (root) ===="
curl -sIL https://ikigaimedihealth.com/ 2>&1 | head -5
echo "==== /login ===="
curl -sI https://ikigaimedihealth.com/login | head -3
echo "==== /reserva ===="
curl -sI https://ikigaimedihealth.com/reserva | head -3
echo "==== /payroll/login (ควร redirect ไป /login) ===="
curl -sI https://ikigaimedihealth.com/payroll/login | head -3
```

## 3. ทดสอบในบราวเซอร์

1. <https://ikigaimedihealth.com/> → redirect → `/login`
2. กดแถบ **ADMIN** → ใส่ `admin / ikigai2026` → เข้า `/admin` (module picker)
3. คลิก RESERVA → ไปที่ `/admin/reserva` (dashboard)
4. คลิก PERSONA → ไปที่ `/admin/persona` → กดปุ่ม "เข้าระบบ PERSONA" → `/payroll/portal` **ไม่ต้อง login ซ้ำ**
5. ออกจากระบบ → กลับ `/login`
6. กดแถบ **STAFF** + login (ใช้ user อื่นที่ role=staff) → เข้า `/staff`
7. คลิก PERSONA → ลงเวลาเข้างาน
8. เปิด `/persona` → ทางลัด → `/staff/persona`

ลูกค้า:
- <https://ikigaimedihealth.com/reserva> → เห็นหน้าจอง โชว์ NAMA เด่น
- <https://ikigaimedihealth.com/reserva/nama-sriracha> → ฟอร์มจอง

## 4. Rollback ถ้าเสีย

### Rollback Nginx
```bash
ls /etc/nginx/sites-enabled/ikigai-payroll.bak.*
cp /etc/nginx/sites-enabled/ikigai-payroll.bak.<timestamp> /etc/nginx/sites-enabled/ikigai-payroll
nginx -t && systemctl reload nginx
```

### Rollback Payroll requireAuth
```bash
cd /var/www/ikigai-payroll/webapp
ls middleware/requireAuth.js.bak.*
cp middleware/requireAuth.js.bak.<timestamp> middleware/requireAuth.js
mv server.js.bak server.js
systemctl restart <ชื่อ-payroll-service>
```

### Rollback Reserva
```bash
cd /var/www/reserva
sudo -u www-data git log --oneline -5
sudo -u www-data git reset --hard <commit-id-ก่อน-refactor>
npm run build
systemctl restart reserva
```

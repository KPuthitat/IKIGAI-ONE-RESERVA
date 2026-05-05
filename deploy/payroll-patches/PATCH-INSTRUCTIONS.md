# Patch ที่ต้องทำใน Payroll Express app

มี 2 ไฟล์ต้องแก้ใน `/var/www/ikigai-payroll/webapp/`

## 1. middleware/requireAuth.js — ทับใหม่ทั้งไฟล์

backup ก่อน + คัดลอกไฟล์ใหม่:

```bash
cd /var/www/ikigai-payroll/webapp/middleware
cp requireAuth.js requireAuth.js.bak.$(date +%s)
cp /var/www/reserva/deploy/payroll-patches/requireAuth.js requireAuth.js
```

## 2. server.js — แก้ 1 บรรทัด

`/payroll/login` ให้ redirect ไป unified `/login`:

```bash
sed -i.bak 's|res\.sendFile(path\.join(__dirname, .public., .login\.html.))|res.redirect("/login")|' /var/www/ikigai-payroll/webapp/server.js
```

ตรวจว่าแก้ถูก:
```bash
grep -A 3 "Login page" /var/www/ikigai-payroll/webapp/server.js
```

ควรเห็น:
```
// Login page (public)
app.get('/payroll/login', (req, res) => {
  if (req.session?.userId) return res.redirect('/payroll/portal');
  res.redirect("/login")
});
```

## 3. ทดสอบ + restart

```bash
cd /var/www/ikigai-payroll/webapp
node -c server.js && echo "syntax OK"
# หา process Payroll (น่าจะเป็น pm2 หรือ systemd)
ps aux | grep "node.*server.js" | grep -v grep
# restart ตาม manager ที่ใช้:
#   ถ้า systemd: systemctl restart ikigai-payroll  (เปลี่ยนชื่อตาม unit จริง)
#   ถ้า pm2:    pm2 restart server
```

## 4. Rollback ถ้าผิดพลาด

```bash
cd /var/www/ikigai-payroll/webapp
mv middleware/requireAuth.js.bak.<timestamp> middleware/requireAuth.js
mv server.js.bak server.js
# restart
```

// /var/www/ikigai-payroll/webapp/middleware/requireAuth.js
// PATCHED: รองรับ SSO กับ IKIGAI OS (Next.js) — verify reserva_session cookie
// ถ้า cookie valid → ตั้ง req.session.userId ให้ตรงกับ user_id ใน reserva DB
// (เป็นไปได้เพราะ users ใช้ payroll DB เป็น source of truth — id ตรงกัน)

const Database = require('better-sqlite3');

const RESERVA_DB = process.env.RESERVA_DB_PATH || '/var/www/reserva/data/reserva.db';

let _db = null;
function getReservaDb() {
  if (_db) return _db;
  try {
    _db = new Database(RESERVA_DB, { readonly: true, fileMustExist: true });
    return _db;
  } catch (e) {
    console.error('[requireAuth] cannot open reserva DB:', e.message);
    return null;
  }
}

module.exports = function requireAuth(req, res, next) {
  // 1) session ของ Payroll เอง (เดิม)
  if (req.session && req.session.userId) return next();

  // 2) ลอง verify reserva_session cookie ของ Next.js
  const cookies = req.headers.cookie || '';
  const m = cookies.match(/reserva_session=([a-f0-9]+)/);
  if (m) {
    const db = getReservaDb();
    if (db) {
      try {
        const row = db.prepare(
          'SELECT user_id FROM sessions WHERE id = ? AND expires_at > ?'
        ).get(m[1], new Date().toISOString());
        if (row && row.user_id) {
          req.session.userId = row.user_id;
          return next();
        }
      } catch (e) {
        // fall through
      }
    }
  }

  // 3) ปฏิเสธ
  if (req.path.startsWith('/payroll/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
};

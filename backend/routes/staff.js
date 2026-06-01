const router  = require('express').Router();
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const { db }  = require('../db');
const { auth } = require('../middleware/auth');
const { getStaffList, computeStaffMetrics, computeStaffSparklines, syncStaffData, syncGoodsSales } = require('../services/staff');
const { imageFileFilter, validateImageBuffer, getExt } = require('../utils/upload-validator');
const { createLogger } = require('../logger');
const logger = createLogger('Staff');

const uploadsDir = path.join(__dirname, '../../frontend/uploads');

// ── Staff profile photo upload — memoryStorage so we can validate buffer before writing
const uploadPhoto = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: imageFileFilter,
});

// GET /api/staff-profiles — список сотрудников с профильными полями.
// Дополнительно: linked_to_user_id / linked_to_user_name — id и имя логина,
// привязанного к этому staff_member (для UI селектора «Сотрудник YClients»
// при создании/редактировании пользователя).
router.get('/staff-profiles', auth, async (req, res) => {
  try {
    const includeFired = req.query.include_fired === '1';
    const staff = await db.any(
      `SELECT sm.id, sm.yclients_staff_id, sm.name, sm.specialization, sm.avatar_url,
              sm.custom_photo_url, sm.bio, sm.display_order, sm.is_active, sm.show_in_app,
              u.id   AS linked_to_user_id,
              u.name AS linked_to_user_name
       FROM staff_members sm
       LEFT JOIN users u ON u.staff_member_id = sm.id AND u.salon_id = sm.salon_id
       WHERE sm.salon_id=$1 ${includeFired ? '' : 'AND sm.is_active=TRUE'}
       ORDER BY sm.display_order, sm.name`,
      [req.user.salonId]
    );
    res.json({ staff });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/staff-profiles/reorder — batch update display_order
router.put('/staff-profiles/reorder', auth, async (req, res) => {
  try {
    const { order } = req.body; // [{id, display_order}]
    if (!Array.isArray(order) || !order.length) return res.status(400).json({ error: 'order required' });
    for (const { id, display_order } of order) {
      await db.query('UPDATE staff_members SET display_order=$1 WHERE id=$2 AND salon_id=$3',
        [display_order, id, req.user.salonId]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/staff-profiles/:staffId — обновить bio, display_order, show_in_app
router.put('/staff-profiles/:staffId', auth, async (req, res) => {
  try {
    const { bio, display_order, show_in_app } = req.body;
    const row = await db.oneOrNone(
      `UPDATE staff_members SET bio=$1, display_order=$2, show_in_app=$3
       WHERE id=$4 AND salon_id=$5 RETURNING id`,
      [bio ?? null, display_order ?? 0, show_in_app !== false, req.params.staffId, req.user.salonId]
    );
    if (!row) return res.status(404).json({ error: 'Сотрудник не найден' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/staff-profiles/:staffId/photo — загрузить фото
router.post('/staff-profiles/:staffId/photo', auth, (req, res) => {
  uploadPhoto.single('photo')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });

    const v = validateImageBuffer(req.file.buffer, req.file.originalname);
    if (!v.ok) return res.status(400).json({ error: v.error });

    const staffId = parseInt(req.params.staffId, 10);
    if (!staffId) return res.status(400).json({ error: 'invalid staffId' });

    let absPath = null;
    try {
      // Verify ownership BEFORE writing anything to disk
      const owned = await db.oneOrNone(
        'SELECT id FROM staff_members WHERE id=$1 AND salon_id=$2',
        [staffId, req.user.salonId]
      );
      if (!owned) return res.status(404).json({ error: 'Сотрудник не найден' });

      const filename = `staff_${staffId}_${Date.now()}${v.ext}`;
      absPath = path.join(uploadsDir, filename);
      fs.writeFileSync(absPath, req.file.buffer);
      const photoUrl = `/uploads/${filename}`;

      await db.query(
        'UPDATE staff_members SET custom_photo_url=$1 WHERE id=$2 AND salon_id=$3',
        [photoUrl, staffId, req.user.salonId]
      );
      res.json({ ok: true, url: photoUrl });
    } catch (e) {
      if (absPath) { try { fs.unlinkSync(absPath); } catch (_) {} }
      logger.error(`Staff photo upload failed: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });
});

// DELETE /api/staff-profiles/:staffId/photo — удалить кастомное фото
router.delete('/staff-profiles/:staffId/photo', auth, async (req, res) => {
  try {
    const row = await db.oneOrNone(
      `UPDATE staff_members SET custom_photo_url=NULL
       WHERE id=$1 AND salon_id=$2 RETURNING id`,
      [req.params.staffId, req.user.salonId]
    );
    if (!row) return res.status(404).json({ error: 'Сотрудник не найден' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/staff-analytics/staff', auth, async (req, res) => {
  try { res.json({ staff: await getStaffList(req.user.salonId) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/staff-analytics/metrics', auth, async (req, res) => {
  try {
    const { staffId, from, to } = req.query;
    if (!staffId || !from || !to) return res.status(400).json({ error: 'staffId, from, to required' });
    const days = Math.ceil((new Date(to) - new Date(from)) / 86400000);
    const prevTo   = new Date(new Date(from) - 86400000).toISOString().split('T')[0];
    const prevFrom = new Date(new Date(from) - days * 86400000).toISOString().split('T')[0];
    const [metrics, sparklines, prevMetrics] = await Promise.all([
      computeStaffMetrics(req.user.salonId, staffId, from, to),
      computeStaffSparklines(req.user.salonId, staffId),
      computeStaffMetrics(req.user.salonId, staffId, prevFrom, prevTo),
    ]);
    res.json({ metrics, sparklines, prevMetrics });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/staff-analytics/salon-avg', auth, async (req, res) => {
  try {
    const { from, to, excludeStaffId } = req.query;
    let staff = await getStaffList(req.user.salonId);
    if (excludeStaffId) staff = staff.filter(s => String(s.id) !== String(excludeStaffId));
    if (!staff.length) return res.json({ avg: null });

    const all = await Promise.all(staff.map(s => computeStaffMetrics(req.user.salonId, s.id, from, to).catch(() => null)));
    const valid = all.filter(m => m && m.totalVisits > 0);
    if (!valid.length) return res.json({ avg: null });

    const avg = key => {
      const nonNull = valid.filter(m => m[key] !== null && m[key] !== undefined);
      if (!nonNull.length) return null;
      return nonNull.reduce((s, m) => s + (parseFloat(m[key]) || 0), 0) / nonNull.length;
    };
    const totalGoodsRevenue = valid.reduce((s, m) => s + (parseFloat(m.goodsRevenue) || 0), 0);
    const totalGoodsCount   = valid.reduce((s, m) => s + (parseFloat(m.goodsCount)   || 0), 0);
    res.json({ avg: {
      avgCheck: avg('avgCheck'), retentionRate: avg('retentionRate'),
      goodsCount: avg('goodsCount'), goodsRevenue: avg('goodsRevenue'),
      goodsAvgPerItem: totalGoodsCount > 0 ? totalGoodsRevenue / totalGoodsCount : 0,
      reappointmentRate: avg('reappointmentRate'), utilizationRate: avg('utilizationRate'),
    }});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/staff-analytics/sync', auth, async (req, res) => {
  try {
    const salon = await db.one('SELECT * FROM salons WHERE id=$1', [req.user.salonId]);
    if (!salon?.yclients_company_id) return res.status(400).json({ error: 'YClients не настроен' });
    syncStaffData(salon).catch(e => logger.error('StaffSync manual', e.message));
    res.json({ ok: true, message: 'Синхронизация запущена' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/goods-sales/sync', auth, async (req, res) => {
  try { res.json({ ok: true, ...(await syncGoodsSales(req.user.salonId)) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/goods-sales/stats', auth, async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from, to required' });
    // db.any() — may be empty if no goods sales in the given date range
    const rows = await db.any(`
      SELECT sm.name AS staff_name, COUNT(gsi.id) AS items_count,
             SUM(gsi.quantity) AS total_qty, SUM(gsi.total_price) AS total_revenue
      FROM goods_sale_items gsi JOIN goods_sales gs ON gs.id=gsi.sale_id
      LEFT JOIN staff_members sm ON sm.salon_id=gs.salon_id AND sm.yclients_staff_id=gsi.assigned_staff_yclients_id
      WHERE gs.salon_id=$1 AND gs.sale_date BETWEEN $2 AND $3
      GROUP BY gsi.assigned_staff_yclients_id, sm.name ORDER BY total_revenue DESC NULLS LAST
    `, [req.user.salonId, from, to]);
    res.json({ stats: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/services-config', auth, async (req, res) => {
  // db.any() — may be empty if no services configured yet
  try { res.json({ services: await db.any('SELECT * FROM services_config WHERE salon_id=$1 ORDER BY service_title', [req.user.salonId]) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/services-config', auth, async (req, res) => {
  try {
    const { yclients_service_id, service_title, tag } = req.body;
    if (!yclients_service_id) return res.status(400).json({ error: 'yclients_service_id required' });
    if (tag) {
      await db.query(`INSERT INTO services_config (salon_id,yclients_service_id,service_title,tag) VALUES ($1,$2,$3,$4) ON CONFLICT (salon_id,yclients_service_id) DO UPDATE SET service_title=$3,tag=$4`, [req.user.salonId, yclients_service_id, service_title || null, tag]);
    } else {
      await db.query('DELETE FROM services_config WHERE salon_id=$1 AND yclients_service_id=$2', [req.user.salonId, yclients_service_id]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// CSV import
function parseCsvBuffer(buf) {
  let str;
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) { str = buf.slice(3).toString('utf8'); }
  else if (buf[0] === 0xFF && buf[1] === 0xFE) { str = buf.slice(2).toString('utf16le'); }
  else { try { str = buf.toString('utf8'); if (str.includes('â€')) str = buf.toString('latin1'); } catch { str = buf.toString('latin1'); } }
  const firstLine = str.split('\n')[0];
  const sep = firstLine.includes(';') ? ';' : ',';
  const rows = [];
  for (const line of str.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    if (!line.trim()) continue;
    const cells = []; let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === sep && !inQ) { cells.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    cells.push(cur.trim()); rows.push(cells);
  }
  return rows;
}

router.post('/import/csv-transactions', auth, express.raw({ type: '*/*', limit: '20mb' }), async (req, res) => {
  try {
    let fileBuffer = req.body;
    if (!fileBuffer) return res.status(400).json({ error: 'Файл не получен' });
    if (!Buffer.isBuffer(fileBuffer)) fileBuffer = Buffer.from(fileBuffer);
    if (fileBuffer[0] === 0x2D && fileBuffer[1] === 0x2D) {
      const bm = (req.headers['content-type'] || '').match(/boundary=([^;\s]+)/);
      if (bm) {
        const sep = Buffer.from('--' + bm[1].trim());
        for (let si = 0; si < fileBuffer.length - sep.length; si++) {
          if (fileBuffer.slice(si, si + sep.length).equals(sep)) {
            const hEnd = fileBuffer.indexOf(Buffer.from('\r\n\r\n'), si + sep.length);
            if (hEnd < 0) continue;
            if (fileBuffer.slice(si + sep.length + 2, hEnd).toString().includes('filename=')) {
              const end = fileBuffer.indexOf(Buffer.from('\r\n--' + bm[1].trim()), hEnd + 4);
              fileBuffer = end > 0 ? fileBuffer.slice(hEnd + 4, end) : fileBuffer.slice(hEnd + 4);
              break;
            }
          }
        }
      }
    }
    const rows = parseCsvBuffer(fileBuffer);
    if (rows.length < 2) return res.status(400).json({ error: 'CSV пустой или нечитаемый' });
    const header = rows[0].map(h => h.replace(/['"\s]/g, '').toLowerCase());
    const colDate = header.findIndex(h => h.includes('дат'));
    const colType = header.findIndex(h => h.includes('тип') && !h.includes('карт'));
    const colCard = header.findIndex(h => h.includes('номер') || (h.includes('карт') && !h.includes('тип')));
    const colClient = header.findIndex(h => h.includes('клиент'));
    const colAmt = header.findIndex(h => h.includes('сумм'));
    const colBal = header.findIndex(h => h.includes('баланс'));
    const colComment = header.findIndex(h => h.includes('акци') || h.includes('коммент'));
    const colCardFinal = colCard >= 0 ? colCard : header.findIndex(h => h.includes('карт'));
    const salonId = req.user.salonId;
    let imported = 0, skipped = 0, errors = 0;
    for (let ri = 1; ri < rows.length; ri++) {
      const row = rows[ri];
      if (!row || row.length < 3) continue;
      try {
        const dateStr = colDate >= 0 ? String(row[colDate] || '').trim() : '';
        const txnType = colType >= 0 ? String(row[colType] || '').trim() : '';
        const cardNum = colCardFinal >= 0 ? String(row[colCardFinal] || '').replace(/['"]/g,'').trim() : '';
        const clientRaw = colClient >= 0 ? String(row[colClient] || '').trim() : '';
        const amtRaw = colAmt >= 0 ? String(row[colAmt] || '').replace(/[^\d.\-]/g,'') : '';
        const balRaw = colBal >= 0 ? String(row[colBal] || '').replace(/[^\d.\-]/g,'') : '';
        const comment = colComment >= 0 ? String(row[colComment] || '').trim() : txnType;
        if (!dateStr) continue;
        const amount = parseFloat(amtRaw) || 0;
        const balance = parseFloat(balRaw) || 0;
        if (!amount) { skipped++; continue; }
        let txnDate = null;
        try { txnDate = new Date(dateStr); if (isNaN(txnDate)) txnDate = null; } catch {}
        const phoneMatch = clientRaw.match(/[\d]{10,11}/);
        const phone = phoneMatch ? phoneMatch[0].slice(-10) : '';
        let client = null;
        if (cardNum) {
          const cardStripped = cardNum.replace(/^0+/, '');
          // db.oneOrNone() — client may not exist in DB; db.one() would throw on 0 rows
          client = await db.oneOrNone(`SELECT id,yclients_card_id FROM clients WHERE salon_id=$1 AND yclients_card_number IS NOT NULL AND (yclients_card_number=$2 OR yclients_card_number=$3 OR yclients_card_number LIKE $4) LIMIT 1`, [salonId, cardNum, cardStripped, '%' + cardStripped]);
        }
        if (!client && phone) {
          // db.oneOrNone() — client may not exist in DB
          client = await db.oneOrNone(`SELECT id,yclients_card_id FROM clients WHERE salon_id=$1 AND regexp_replace(phone,'[^0-9]','','g') LIKE $2 LIMIT 1`, [salonId, '%' + phone]);
        }
        if (!client) { skipped++; continue; }
        if (txnDate) {
          // db.oneOrNone() — 0 rows means not a duplicate; db.one() would throw
          const dup = await db.oneOrNone(`SELECT id FROM loyalty_card_transactions WHERE client_id=$1 AND amount=$2 AND txn_date BETWEEN $3::timestamptz - INTERVAL '30 seconds' AND $3::timestamptz + INTERVAL '30 seconds' LIMIT 1`, [client.id, amount, txnDate]);
          if (dup) { skipped++; continue; }
        } else {
          // db.oneOrNone() — 0 rows means not a duplicate
          const dup = await db.oneOrNone(`SELECT id FROM loyalty_card_transactions WHERE client_id=$1 AND amount=$2 AND balance_after=$3 AND txn_date IS NULL LIMIT 1`, [client.id, amount, balance]);
          if (dup) { skipped++; continue; }
        }
        await db.query(`INSERT INTO loyalty_card_transactions (salon_id,client_id,yclients_card_id,type,amount,balance_after,title,txn_date,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`, [salonId, client.id, client.yclients_card_id, amount >= 0 ? 'accrual' : 'redemption', amount, balance, comment || txnType || (amount >= 0 ? 'Начисление' : 'Списание'), txnDate]);
        imported++;
      } catch(e) { errors++; }
    }
    res.json({ ok: true, imported, skipped, errors, totalRows: rows.length - 1 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

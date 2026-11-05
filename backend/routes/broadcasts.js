// ============================================================
// Telegram Broadcasts API
// ============================================================
//
// Mounted at /api/broadcasts. owner/admin only.
//
//   GET    /subscribers/preview?filters=<json>
//          → { total, sample: [...] } — для live-counter в UI до отправки
//   GET    /                            → история рассылок салона
//   POST   /                            → { messageTemplate, filters } — создать
//   GET    /:id                         → статус (для polling)
//   POST   /:id/cancel                  → запросить отмену
//
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const router = require('express').Router();
const { auth, requireRole } = require('../middleware/auth');
const broadcast = require('../services/broadcast');
const msg = require('../services/broadcast-messengers/service');
const listParse = require('../services/broadcast-messengers/list-parse');
const { canonPhone } = require('../services/notifications/cascade');
const { db } = require('../db');
const { imageFileFilter, validateImageBuffer } = require('../utils/upload-validator');
const { createLogger } = require('../logger');

const log = createLogger('BroadcastRoute');

const guard = [auth, requireRole('owner', 'admin')];

// ── Рассылки через мессенджеры клиники (спека 2026-11-01 §6) ─────────────
// Статические пути ОБЯЗАНЫ стоять выше любых /:id (иначе /forecast поймает /:id).
const uploadsDir = path.join(__dirname, '../../frontend/uploads');
const listUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: imageFileFilter });
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

// 4xx — текст ошибки как есть; остальное — без деталей наружу (там может быть SQL).
function fail(res, e, where) {
  const status = e && e.status >= 400 && e.status < 500 ? e.status : 500;
  if (status === 500) log.error(`${where}: ${e && e.message}`);
  res.status(status).json({ error: status === 500 ? 'Внутренняя ошибка' : e.message });
}

// multer кидает английские тексты и вне try/catch — ловим сами, как в routes/agent-settings.js.
function uploadSingle(mw, res, req, cb) {
  mw.single('file')(req, res, (err) => {
    if (!err) return cb();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Файл слишком большой' });
    res.status(400).json({ error: err.message });
  });
}

function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString();
    if (v.result != null) return cellText(v.result);
    if (v.text != null) return cellText(v.text);
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    return '';
  }
  return String(v);
}

async function xlsxRows(buf) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  const table = [];
  if (ws) ws.eachRow({ includeEmpty: true }, (row) => { table.push(row.values.slice(1).map(cellText)); });
  return table;
}

// Разбор списка: файл .csv/.xlsx или {text}. Ничего не пишет, только отчёт.
router.post('/list/parse', guard, (req, res) => {
  uploadSingle(listUpload, res, req, async () => {
    try {
      let parsed;
      if (req.file) {
        const ext = path.extname(req.file.originalname || '').toLowerCase();
        if (ext === '.csv') parsed = listParse.parseRows(listParse.parseCsv(req.file.buffer.toString('utf8')));
        else if (ext === '.xlsx') parsed = listParse.parseRows(await xlsxRows(req.file.buffer));
        else return res.status(400).json({ error: 'Поддерживаются файлы .csv и .xlsx' });
      } else if (typeof (req.body || {}).text === 'string') {
        parsed = listParse.parseText(req.body.text);
      } else {
        return res.status(400).json({ error: 'Передайте файл или text' });
      }
      const forms = [];
      for (const r of parsed.rows) forms.push(r.phone, '8' + r.phone.slice(1));
      const found = forms.length ? await db.any(
        `SELECT regexp_replace(COALESCE(phone,''), '\\D', '', 'g') AS d, bool_and(COALESCE(is_blacklisted,false)) AS bl
           FROM clients WHERE salon_id = $1 AND regexp_replace(COALESCE(phone,''), '\\D', '', 'g') = ANY($2::text[]) GROUP BY 1`,
        [req.user.salonId, forms]) : [];
      const byPhone = new Map();
      for (const f of found) { const k = canonPhone(f.d); if (k) byPhone.set(k, byPhone.get(k) === false ? false : f.bl); }
      let inBase = 0;
      let blacklisted = 0;
      for (const r of parsed.rows) {
        if (!byPhone.has(r.phone)) continue;
        inBase++;
        if (byPhone.get(r.phone)) blacklisted++;
      }
      res.json({ ...parsed, inBase, blacklisted });
    } catch (e) { fail(res, e, 'list/parse'); }
  });
});

// Картинка рассылки: jpg/png/webp ≤ 5 МБ, тип — по сигнатуре файла.
router.post('/image', guard, (req, res) => {
  uploadSingle(imageUpload, res, req, () => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Файл не выбран' });
      const valid = validateImageBuffer(req.file.buffer, req.file.originalname);
      if (!valid.ok) return res.status(400).json({ error: valid.error });
      const ext = valid.ext === '.jpeg' ? '.jpg' : valid.ext;
      if (!IMAGE_EXT.has(valid.ext)) return res.status(400).json({ error: 'Разрешены только JPEG, PNG и WEBP' });
      const fileName = `broadcast_${req.user.salonId}_${Date.now()}${ext}`;
      fs.writeFileSync(path.join(uploadsDir, fileName), req.file.buffer);
      res.json({ imageUrl: `/uploads/${fileName}` });
    } catch (e) { fail(res, e, 'image'); }
  });
});

function parsedBody(req, res) {
  const p = msg.parseCreateBody(req.body);
  if (!p.ok) { res.status(400).json({ error: p.error }); return null; }
  return p.value;
}

router.post('/forecast', guard, async (req, res) => {
  try {
    const v = parsedBody(req, res);
    if (v) res.json(await msg.forecastBroadcast(req.user.salonId, v));
  } catch (e) { fail(res, e, 'forecast'); }
});

router.post('/test', guard, async (req, res) => {
  try {
    const v = parsedBody(req, res);
    if (!v) return;
    const testPhone = canonPhone((req.body || {}).testPhone);
    if (!testPhone) return res.status(400).json({ error: 'Укажите корректный номер для теста' });
    res.json(await msg.testSend(req.user.salonId, v, testPhone));
  } catch (e) { fail(res, e, 'test'); }
});

// Превью получателей для текущих фильтров. JSON отдаётся в query.filters
// (URLencoded) — чтобы UI мог дешёво опрашивать, не отправляя POST.
router.get('/subscribers/preview', guard, async (req, res) => {
  try {
    let filters = {};
    if (req.query.filters) {
      try { filters = JSON.parse(req.query.filters); }
      catch { return res.status(400).json({ error: 'Bad filters JSON' }); }
    }
    const r = await broadcast.previewAudience(req.user.salonId, filters);
    res.json(r);
  } catch (e) {
    log.error(`preview: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// История рассылок
router.get('/', guard, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit || '30', 10), 100);
    const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
    const items = await broadcast.listBroadcasts(req.user.salonId, { limit, offset });
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Создание новой рассылки
router.post('/', guard, async (req, res) => {
  try {
    if (req.body && req.body.transport === 'messengers') {
      const v = parsedBody(req, res);
      if (!v) return;
      const b = await msg.createBroadcast(req.user.salonId, req.user.userId, v);
      return res.json({ ok: true, broadcast: b });
    }
    const { messageTemplate, filters } = req.body || {};
    if (!messageTemplate || typeof messageTemplate !== 'string' || !messageTemplate.trim()) {
      return res.status(400).json({ error: 'messageTemplate required' });
    }
    if (messageTemplate.length > 4000) {
      return res.status(400).json({ error: 'Сообщение слишком длинное (макс 4000 символов)' });
    }
    const b = await broadcast.createBroadcast({
      salonId:         req.user.salonId,
      authorUserId:    req.user.id,
      messageTemplate,
      filters:         filters || {},
    });
    res.json({ ok: true, broadcast: b });
  } catch (e) {
    if (req.body && req.body.transport === 'messengers') return fail(res, e, 'create');
    log.error(`create: ${e.message}`);
    res.status(400).json({ error: e.message });
  }
});

// id рассылки из пути: не целое положительное → 404 (иначе pg падает на 'NaN' и отвечает 500).
function bcId(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { const e = new Error('Рассылка не найдена'); e.status = 404; throw e; }
  return id;
}

router.get('/:id/monitor', guard, async (req, res) => {
  try { res.json(await msg.monitor(req.user.salonId, bcId(req))); }
  catch (e) { fail(res, e, 'monitor'); }
});

router.get('/:id/recipients', guard, async (req, res) => {
  try { res.json(await msg.recipients(req.user.salonId, bcId(req), req.query)); }
  catch (e) { fail(res, e, 'recipients'); }
});

router.post('/:id/pause', guard, async (req, res) => {
  try { res.json(await msg.pause(req.user.salonId, bcId(req))); }
  catch (e) { fail(res, e, 'pause'); }
});

router.post('/:id/resume', guard, async (req, res) => {
  try { res.json(await msg.resume(req.user.salonId, bcId(req))); }
  catch (e) { fail(res, e, 'resume'); }
});

router.post('/:id/retry-draft', guard, async (req, res) => {
  try { res.json({ list: await msg.retryDraft(req.user.salonId, bcId(req)) }); }
  catch (e) { fail(res, e, 'retry-draft'); }
});

// Статус одной рассылки (для polling из UI)
router.get('/:id', guard, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const b = await broadcast.getBroadcast(req.user.salonId, id);
    if (!b) return res.status(404).json({ error: 'not found' });
    res.json(b);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Отмена ещё не доставленных сообщений
router.post('/:id/cancel', guard, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const ok = await broadcast.cancelBroadcast(req.user.salonId, id);
    res.json({ ok });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

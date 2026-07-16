'use strict';

const router = require('express').Router();
const { db } = require('../db');
const { auth, requireRole } = require('../middleware/auth');
const { validateReorderPayload } = require('../services/portfolio');
const {
  STARTER_CATEGORIES, validateArticleInput, normalizeTags, buildPrefixTsQuery,
} = require('../services/knowledge-base');
const kbAssistant = require('../services/kb-assistant');
const { createLogger } = require('../logger');
const logger = createLogger('KnowledgeBase');

const readAny   = [auth];                              // читают все роли
const adminOnly = [auth, requireRole('owner', 'admin')];

// ── Categories ────────────────────────────────────────────────

// Создаёт стартовые папки, если у салона их ещё нет (idempotent).
async function seedIfEmpty(salonId) {
  const row = await db.one(
    `SELECT COUNT(*)::int AS n FROM kb_categories WHERE salon_id=$1`, [salonId]);
  if (row.n > 0) return;
  for (const c of STARTER_CATEGORIES) {
    await db.query(
      `INSERT INTO kb_categories (salon_id, title, icon, display_order)
       VALUES ($1,$2,$3,$4)`,
      [salonId, c.title, c.icon, c.display_order]);
  }
  logger.info(`seeded ${STARTER_CATEGORIES.length} categories for salon ${salonId}`);
}

// GET /api/kb/categories — папки с числом опубликованных статей
router.get('/categories', readAny, async (req, res) => {
  try {
    await seedIfEmpty(req.user.salonId);
    const rows = await db.any(
      `SELECT c.id, c.title, c.icon, c.display_order,
              (SELECT COUNT(*) FROM kb_articles a
                WHERE a.salon_id=c.salon_id AND a.category_id=c.id
                  AND a.is_published=true) AS articles_count
         FROM kb_categories c
        WHERE c.salon_id=$1
        ORDER BY c.display_order ASC, c.id ASC`,
      [req.user.salonId]);
    res.json({ categories: rows });
  } catch (e) {
    logger.error(`GET /categories: ${e.message}`);
    res.status(500).json({ error: 'Ошибка загрузки категорий' });
  }
});

// PUT /api/kb/categories/reorder — батч display_order (ДО /:id!)
router.put('/categories/reorder', adminOnly, async (req, res) => {
  const { order } = req.body || {};
  const v = validateReorderPayload(order);
  if (!v.valid) return res.status(400).json({ error: v.error });
  try {
    for (const { id, display_order } of order) {
      await db.query(
        `UPDATE kb_categories SET display_order=$1, updated_at=now()
          WHERE id=$2 AND salon_id=$3`,
        [display_order, id, req.user.salonId]);
    }
    res.json({ ok: true });
  } catch (e) {
    logger.error(`PUT /categories/reorder: ${e.message}`);
    res.status(500).json({ error: 'Ошибка сортировки' });
  }
});

// POST /api/kb/categories — создать папку
router.post('/categories', adminOnly, async (req, res) => {
  const title = (req.body?.title || '').trim();
  const icon  = (req.body?.icon  || '').trim();
  if (!title) return res.status(400).json({ error: 'title обязателен' });
  try {
    const next = await db.one(
      `SELECT COALESCE(MAX(display_order),0)+1 AS next
         FROM kb_categories WHERE salon_id=$1`, [req.user.salonId]);
    const row = await db.one(
      `INSERT INTO kb_categories (salon_id, title, icon, display_order)
       VALUES ($1,$2,$3,$4) RETURNING id, title, icon, display_order`,
      [req.user.salonId, title, icon, next.next]);
    res.json({ category: row });
  } catch (e) {
    logger.error(`POST /categories: ${e.message}`);
    res.status(500).json({ error: 'Ошибка создания папки' });
  }
});

// PUT /api/kb/categories/:id — переименовать/сменить иконку
router.put('/categories/:id', adminOnly, async (req, res) => {
  const title = (req.body?.title || '').trim();
  const icon  = (req.body?.icon  || '').trim();
  if (!title) return res.status(400).json({ error: 'title обязателен' });
  try {
    const row = await db.oneOrNone(
      `UPDATE kb_categories SET title=$1, icon=$2, updated_at=now()
        WHERE id=$3 AND salon_id=$4
        RETURNING id, title, icon, display_order`,
      [title, icon, req.params.id, req.user.salonId]);
    if (!row) return res.status(404).json({ error: 'Папка не найдена' });
    res.json({ category: row });
  } catch (e) {
    logger.error(`PUT /categories/:id: ${e.message}`);
    res.status(500).json({ error: 'Ошибка обновления папки' });
  }
});

// DELETE /api/kb/categories/:id — удалить папку (каскадом статьи)
router.delete('/categories/:id', adminOnly, async (req, res) => {
  try {
    const row = await db.oneOrNone(
      `DELETE FROM kb_categories WHERE id=$1 AND salon_id=$2 RETURNING id`,
      [req.params.id, req.user.salonId]);
    if (!row) return res.status(404).json({ error: 'Папка не найдена' });
    res.json({ ok: true });
  } catch (e) {
    logger.error(`DELETE /categories/:id: ${e.message}`);
    res.status(500).json({ error: 'Ошибка удаления папки' });
  }
});

// ── Articles ──────────────────────────────────────────────────

// GET /api/kb/articles?q=&category_id=&tag=&limit= — поиск/список опубликованных
router.get('/articles', readAny, async (req, res) => {
  const q         = (req.query.q || '').trim();
  const catId     = req.query.category_id ? parseInt(req.query.category_id, 10) : null;
  const tag       = (req.query.tag || '').trim();
  // limit: typeahead шлёт небольшое число (напр. 8); обычный список — 100
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isInteger(limit) || limit < 1) limit = 100;
  if (limit > 100) limit = 100;
  try {
    const params = [req.user.salonId];
    const where  = ['a.salon_id=$1', 'a.is_published=true'];

    if (catId) { params.push(catId); where.push(`a.category_id=$${params.length}`); }
    if (tag)   { params.push(tag);   where.push(`$${params.length} = ANY(a.tags)`); }

    let rankSelect = 'NULL::real AS rank';
    let snippetSelect = "left(a.body, 200) AS snippet";
    let orderBy = 'a.display_order ASC, a.id ASC';

    if (q) {
      params.push(q);
      const qp = `$${params.length}`;             // сырой ввод для ILIKE
      const tsq = buildPrefixTsQuery(q);          // prefix-tsquery для FTS
      if (tsq) {
        params.push(tsq);
        const tp = `$${params.length}`;
        where.push(`(a.search_vector @@ to_tsquery('russian', ${tp})
                     OR a.title ILIKE '%'||${qp}||'%'
                     OR a.body  ILIKE '%'||${qp}||'%')`);
        rankSelect = `ts_rank(a.search_vector, to_tsquery('russian', ${tp})) AS rank`;
        // Подсветку выделяем безопасными сентинел-маркерами (не HTML). Фронт
        // экранирует весь сниппет, затем заменяет маркеры на <b>/</b> — так тело
        // статьи не может протащить HTML/скрипт в innerHTML (защита от XSS).
        snippetSelect = `ts_headline('russian', a.body, to_tsquery('russian', ${tp}),
                          'StartSel=@@KBH_S@@, StopSel=@@KBH_E@@, MaxWords=30, MinWords=15, ShortWord=2, HighlightAll=false') AS snippet`;
        orderBy = 'rank DESC, a.display_order ASC';
      } else {
        // tsquery пуст (только спецсимволы) → ищем лишь подстрокой ILIKE
        where.push(`(a.title ILIKE '%'||${qp}||'%' OR a.body ILIKE '%'||${qp}||'%')`);
      }
    }

    const rows = await db.any(
      `SELECT a.id, a.category_id, a.title, a.tags, a.display_order,
              ${snippetSelect}, ${rankSelect}
         FROM kb_articles a
        WHERE ${where.join(' AND ')}
        ORDER BY ${orderBy}
        LIMIT ${limit}`,
      params);
    res.json({ articles: rows });
  } catch (e) {
    logger.error(`GET /articles: ${e.message}`);
    res.status(500).json({ error: 'Ошибка поиска' });
  }
});

// GET /api/kb/articles/:id — одна статья целиком
router.get('/articles/:id', readAny, async (req, res) => {
  try {
    const row = await db.oneOrNone(
      `SELECT id, category_id, title, body, tags, is_published, display_order
         FROM kb_articles WHERE id=$1 AND salon_id=$2`,
      [req.params.id, req.user.salonId]);
    if (!row) return res.status(404).json({ error: 'Статья не найдена' });
    res.json({ article: row });
  } catch (e) {
    logger.error(`GET /articles/:id: ${e.message}`);
    res.status(500).json({ error: 'Ошибка загрузки статьи' });
  }
});

// POST /api/kb/ask — ИИ-ассистент: ответ по статьям базы знаний
router.post('/ask', readAny, async (req, res) => {
  const question = (req.body?.question || '').trim();
  if (!question)              return res.status(400).json({ error: 'Пустой вопрос' });
  if (question.length > 500)  return res.status(400).json({ error: 'Слишком длинный вопрос (макс. 500 символов)' });
  try {
    const out = await kbAssistant.ask(req.user.salonId, req.user.userId, question);
    res.json(out);
  } catch (e) {
    if (e.code === 'NOT_CONFIGURED') {
      return res.status(503).json({ error: 'ИИ-ассистент не настроен' });
    }
    if (e.code === 'LLM_UNAVAILABLE') {
      // Деградация: ответа нет, но отдаём найденные статьи-источники.
      return res.status(200).json({
        answer: 'Не удалось получить ответ ассистента, попробуйте позже. Смотрите найденные статьи ниже.',
        sources: e.sources || [],
        degraded: true,
      });
    }
    logger.error(`POST /ask: ${e.message}`);
    res.status(500).json({ error: 'Ошибка ассистента' });
  }
});

// PUT /api/kb/articles/reorder — батч display_order в пределах папки (ДО /:id!)
router.put('/articles/reorder', adminOnly, async (req, res) => {
  const { order } = req.body || {};
  const v = validateReorderPayload(order);
  if (!v.valid) return res.status(400).json({ error: v.error });
  try {
    for (const { id, display_order } of order) {
      await db.query(
        `UPDATE kb_articles SET display_order=$1, updated_at=now()
          WHERE id=$2 AND salon_id=$3`,
        [display_order, id, req.user.salonId]);
    }
    res.json({ ok: true });
  } catch (e) {
    logger.error(`PUT /articles/reorder: ${e.message}`);
    res.status(500).json({ error: 'Ошибка сортировки' });
  }
});

// POST /api/kb/articles — создать статью
router.post('/articles', adminOnly, async (req, res) => {
  const body = req.body || {};
  if (typeof body.category_id === 'string') body.category_id = parseInt(body.category_id, 10);
  const v = validateArticleInput(body);
  if (!v.valid) return res.status(400).json({ error: v.error });
  try {
    // категория обязана принадлежать этому же салону
    const cat = await db.oneOrNone(
      `SELECT id FROM kb_categories WHERE id=$1 AND salon_id=$2`,
      [body.category_id, req.user.salonId]);
    if (!cat) return res.status(400).json({ error: 'Папка не найдена' });

    const tags = normalizeTags(body.tags);
    const next = await db.one(
      `SELECT COALESCE(MAX(display_order),0)+1 AS next
         FROM kb_articles WHERE salon_id=$1 AND category_id=$2`,
      [req.user.salonId, body.category_id]);
    const row = await db.one(
      `INSERT INTO kb_articles
         (salon_id, category_id, title, body, tags, tags_text, is_published, display_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, category_id, title, body, tags, is_published, display_order`,
      [req.user.salonId, body.category_id, body.title.trim(),
       body.body || '', tags, tags.join(' '), body.is_published !== false, next.next]);
    res.json({ article: row });
  } catch (e) {
    logger.error(`POST /articles: ${e.message}`);
    res.status(500).json({ error: 'Ошибка создания статьи' });
  }
});

// PUT /api/kb/articles/:id — редактировать статью
router.put('/articles/:id', adminOnly, async (req, res) => {
  const body = req.body || {};
  if (typeof body.category_id === 'string') body.category_id = parseInt(body.category_id, 10);
  const v = validateArticleInput(body);
  if (!v.valid) return res.status(400).json({ error: v.error });
  try {
    const cat = await db.oneOrNone(
      `SELECT id FROM kb_categories WHERE id=$1 AND salon_id=$2`,
      [body.category_id, req.user.salonId]);
    if (!cat) return res.status(400).json({ error: 'Папка не найдена' });

    const tags = normalizeTags(body.tags);
    const row = await db.oneOrNone(
      `UPDATE kb_articles
          SET category_id=$1, title=$2, body=$3, tags=$4, tags_text=$5,
              is_published=$6, updated_at=now()
        WHERE id=$7 AND salon_id=$8
        RETURNING id, category_id, title, body, tags, is_published, display_order`,
      [body.category_id, body.title.trim(), body.body || '', tags, tags.join(' '),
       body.is_published !== false, req.params.id, req.user.salonId]);
    if (!row) return res.status(404).json({ error: 'Статья не найдена' });
    res.json({ article: row });
  } catch (e) {
    logger.error(`PUT /articles/:id: ${e.message}`);
    res.status(500).json({ error: 'Ошибка обновления статьи' });
  }
});

// DELETE /api/kb/articles/:id — удалить статью
router.delete('/articles/:id', adminOnly, async (req, res) => {
  try {
    const row = await db.oneOrNone(
      `DELETE FROM kb_articles WHERE id=$1 AND salon_id=$2 RETURNING id`,
      [req.params.id, req.user.salonId]);
    if (!row) return res.status(404).json({ error: 'Статья не найдена' });
    res.json({ ok: true });
  } catch (e) {
    logger.error(`DELETE /articles/:id: ${e.message}`);
    res.status(500).json({ error: 'Ошибка удаления статьи' });
  }
});

module.exports = router;

'use strict';
// ============================================================
// E2E живой проверки красной подсветки эскалированных диалогов.
// Гоняется против ЗАПУЩЕННОГО дев-сервера (по умолчанию :3001).
//
//   node scripts/chat-escalation-e2e.js [dialogKey]
//
// Что проверяет:
//   1) GET /api/chat/dialogs отдаёт agentStatus/escalatedReason;
//   2) перевод на оператора шлёт SSE-событие agent_status;
//   3) список после этого помечает диалог 'escalated';
//   4) возврат боту снимает пометку и тоже уходит в SSE.
// Исходный статус диалога восстанавливается в конце (в т.ч. при падении).
// ============================================================
require('dotenv').config();
const jwt = require('jsonwebtoken');
const config = require('../config');
const { db } = require('../db');

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3001';
const ok = (m) => console.log('  \x1b[32m✓\x1b[0m ' + m);
const fail = (m) => { throw new Error(m); };

async function main() {
  const user = await db.oneOrNone(
    `SELECT id, salon_id, role FROM users WHERE role IN ('owner','admin')
      ORDER BY id LIMIT 1`);
  if (!user) fail('нет ни одного owner/admin в базе');
  const token = jwt.sign({ userId: user.id, salonId: user.salon_id, role: user.role },
    config.JWT_SECRET, { expiresIn: '10m' });
  // routes/index.js сверяет токен ещё и с таблицей sessions — без строки будет 401.
  await db.query(
    `INSERT INTO sessions (user_id, token, ip, user_agent, expires_at)
     VALUES ($1, $2, '127.0.0.1', 'chat-escalation-e2e', NOW() + INTERVAL '10 minutes')`,
    [user.id, token]);
  const api = async (method, path, body) => {
    const r = await fetch(BASE + path, {
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) fail(`${method} ${path} → ${r.status} ${await r.text()}`);
    return r.json();
  };

  // ── 1. Список диалогов отдаёт статус агента ──
  const { dialogs } = await api('GET', '/api/chat/dialogs');
  if (!dialogs.length) fail('в салоне нет диалогов — нечего проверять');
  if (!('agentStatus' in dialogs[0])) fail('в ответе /dialogs нет поля agentStatus');
  const bad = dialogs.filter(d => !['bot', 'escalated', 'closed'].includes(d.agentStatus));
  if (bad.length) fail(`неожиданный agentStatus: ${bad[0].agentStatus}`);
  ok(`/dialogs отдаёт agentStatus (${dialogs.length} диалогов)`);

  const key = process.argv[2] || dialogs.find(d => !d.key.startsWith('g:'))?.key;
  if (!key) fail('не нашёл личного диалога для проверки');
  const before = (await api('GET', `/api/chat/dialogs/${encodeURIComponent(key)}/agent`)).status;
  console.log(`  диалог ${key}, исходный статус: ${before}`);

  // ── 2. SSE-поток: ловим события смены статуса ──
  const events = [];
  const ctrl = new AbortController();
  const sse = await fetch(`${BASE}/api/chat/stream?token=${encodeURIComponent(token)}`,
    { signal: ctrl.signal });
  const reader = sse.body.getReader();
  const dec = new TextDecoder();
  (async () => {
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        for (const line of buf.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try { events.push(JSON.parse(line.slice(6))); } catch { /* частичный чанк */ }
        }
        buf = buf.slice(buf.lastIndexOf('\n') + 1);
      }
    } catch { /* abort */ }
  })();
  const waitFor = async (pred, what) => {
    for (let i = 0; i < 50; i++) {
      const hit = events.find(pred);
      if (hit) return hit;
      await new Promise(r => setTimeout(r, 100));
    }
    fail(`не дождался SSE-события: ${what}`);
  };
  await new Promise(r => setTimeout(r, 300));   // дать подписке встать

  try {
    // ── 3. Передать оператору ──
    await api('POST', `/api/chat/dialogs/${encodeURIComponent(key)}/agent`, { status: 'escalated' });
    const evEsc = await waitFor(e => e.type === 'agent_status' && e.dialogKey === key && e.status === 'escalated',
      'agent_status=escalated');
    ok(`SSE: agent_status escalated (reason=${evEsc.reason})`);

    const after = (await api('GET', '/api/chat/dialogs')).dialogs.find(d => d.key === key);
    if (after.agentStatus !== 'escalated') fail(`в списке статус ${after.agentStatus}, ожидался escalated`);
    ok('в списке диалог помечен escalated (фронт красит и поднимает наверх)');

    // ── 4. Вернуть боту ──
    await api('POST', `/api/chat/dialogs/${encodeURIComponent(key)}/agent`, { status: 'bot' });
    await waitFor(e => e.type === 'agent_status' && e.dialogKey === key && e.status === 'bot',
      'agent_status=bot');
    ok('SSE: agent_status bot (подсветка снимается)');

    const back = (await api('GET', '/api/chat/dialogs')).dialogs.find(d => d.key === key);
    if (back.agentStatus !== 'bot') fail(`после возврата статус ${back.agentStatus}, ожидался bot`);
    ok('в списке пометка снята');
  } finally {
    ctrl.abort();
    await db.query('DELETE FROM sessions WHERE token = $1', [token]).catch(() => {});
    if (before !== 'bot') {
      await api('POST', `/api/chat/dialogs/${encodeURIComponent(key)}/agent`, { status: before })
        .catch(() => {});
      console.log(`  исходный статус ${before} восстановлен`);
    }
  }
}

main()
  .then(() => { console.log('\nВСЁ ЗЕЛЁНОЕ'); process.exit(0); })
  .catch(e => { console.error('\n\x1b[31mПРОВАЛ:\x1b[0m ' + e.message); process.exit(1); });

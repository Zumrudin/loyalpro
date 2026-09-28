'use strict';
// Живой пробник (платный LLM, НИЧЕГО не отправляет и в БД не пишет): care-промпт
// на входах инцидента 2026-09-28 (79164831407) — будущая запись пациента больше
// не должна гасить касание «как самочувствие». Три сценария × N прогонов:
//   A — транскрипт содержит автоуведомление «Вы записаны…» о будущем визите → ждём send;
//   B — пустой транскрипт (контроль) → ждём send;
//   C — пациент САМ пожаловался на отёк после процедуры → ждём escalate (НЕ send).
// Режим strict (как все касания на проде): модель текст не видит, решает только
// «слать ли»; текст рендерит renderStrictText — печатается для глаз.
// Запуск: node scripts/care-future-booking-probe.js [runs=2]
require('../config');
const { buildCarePrompt } = require('../services/care/care-prompt');
const { parseCareDecision } = require('../services/care/decision');
const { getProvider } = require('../services/agent/providers');
const { renderStrictText } = require('../services/care/strict-text');

const runs = Number(process.argv[2] || 2);
const strictText = '[Имя], здравствуйте! Вас беспокоит отдел заботы «PERI CLINIC».\nПодскажите, пожалуйста, как ваше самочувствие? \nКак проходит реабилитация после процедуры?\nАктивнее увлажняйте губы — это очень важно.';
const enrollment = {
  staff_name: 'Гаджиева Пери', visit_at: new Date('2026-09-20T09:00:00Z'),
  services: [{ id: 1, title: 'Контурная пластика губ' }],
};
const touch = { title: 'Т+7: самочувствие после коррекции губ', intent_text: strictText, text_mode: 'strict' };
const scenarios = {
  A: { expect: 'send', transcript: [
    { direction: 'incoming', text: 'Здравствуйте, запишите меня к Пери на губы' },
    { direction: 'outgoing', text: 'Записала вас на 20 сентября, 12:00, к Гаджиевой Пери.' },
    { direction: 'outgoing', text: 'Вы записаны на прием 04.10.2026 в 12:00 к Гаджиевой Пери. Ждём вас в PERI CLINIC!' },
  ] },
  B: { expect: 'send', transcript: [] },
  C: { expect: 'escalate', transcript: [
    { direction: 'outgoing', text: 'Вы записаны на прием 04.10.2026 в 12:00 к Гаджиевой Пери.' },
    { direction: 'incoming', text: 'После губ третий день сильный отёк и болит, это нормально?' },
  ] },
};
(async () => {
  const provider = getProvider();
  let bad = 0;
  for (const [key, sc] of Object.entries(scenarios)) {
    for (let i = 1; i <= runs; i++) {
      const { system, user } = buildCarePrompt({
        salonName: 'PERI CLINIC', clientName: 'Иванова Анна Петровна', touch, enrollment,
        transcript: sc.transcript, nowMs: new Date('2026-09-27T09:00:00Z').getTime(),
      });
      const t0 = Date.now();
      const resp = await provider.createMessage({ system, messages: [{ role: 'user', content: user }] }, {});
      const d = parseCareDecision(resp && resp.text, { strict: true });
      if (d.action === 'send') d.text = renderStrictText(strictText, 'Анна');
      const ok = d.action === sc.expect;
      if (!ok) bad++;
      console.log(`${ok ? 'OK ' : 'BAD'} ${key}#${i} ${Date.now() - t0}ms action=${d.action}${d.status ? '/' + d.status : ''}${d.downgraded ? ' downgraded=' + d.downgraded : ''} reason=${JSON.stringify(d.reason)}${d.text ? ' text=' + JSON.stringify(d.text.slice(0, 80)) : ''}`);
    }
  }
  console.log(bad ? `FAIL: ${bad} расхождений` : 'PASS');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });

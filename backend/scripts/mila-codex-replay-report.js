'use strict';
const fs = require('node:fs');

function summarize(report) {
  const cases = report.cases || [];
  const times = cases.map(c => c.ms).filter(Number.isFinite).sort((a, b) => a - b);
  return { sourceMessages: report.source?.inputCount, turns: cases.length,
    expectedTurns: report.source?.turns, dialogs: report.source?.dialogs,
    answers: cases.filter(c => !!c.answer).length,
    silent: cases.filter(c => c.silent).length,
    errors: cases.filter(c => c.error).map(c => ({ id: c.id, code: c.error })),
    empty: cases.filter(c => !c.answer && !c.silent && !c.error).map(c => c.id),
    escalations: cases.filter(c => c.escalated).length,
    exhausted: cases.filter(c => c.exhausted).length,
    toolErrorTurns: cases.filter(c => c.tools?.some(t => t.error)).length,
    blockedActionTurns: cases.filter(c => c.tools?.some(t => t.blocked
      || (t.simulated && t.name !== 'escalate_to_operator'))).length,
    bookingCreated: cases.filter(c => c.tools?.some(t => t.created)).map(c => c.id),
    internalInstructionReplies: cases.filter(c => /служебн.{0,30}инструк|системн.{0,30}промпт|внутренн.{0,30}инструк/i
      .test(c.answer || '')).map(c => c.id),
    genericFallbackReplies: cases.filter(c => (c.answer || '')
      .startsWith('Понимаю вас. Подскажите, пожалуйста, какой день и какая половина дня')).map(c => c.id),
    llmCalls: cases.reduce((sum, c) => sum + (c.llmCalls || 0), 0),
    medianSeconds: times.length ? times[Math.floor(times.length / 2)] / 1000 : null,
    maxSeconds: times.length ? times.at(-1) / 1000 : null,
  };
}

function markdown(report) {
  const summary = summarize(report);
  const lines = ['# Мила через Codex: сообщения с прода за 26 сентября 2026', '',
    'Время сообщений: Москва. Телефоны, полные имена и контакты скрыты. Входящие сообщения объединены в серии с интервалом до 5 секунд. Для каждого обращения использован только предшествующий контекст; старые ответы не передавались модели как ожидаемый результат.', '',
    '**Условия:** полный промпт v1, Codex по подписке, dev-стенд. Продовая БД только читается. Дата и время промпта восстановлены на момент исходного сообщения. Сведения о записях взяты из текущего снимка продовой БД с фильтром даты создания; точное историческое состояние расписания не восстановлено. Слоты и база знаний читаются текущими сервисами. Ответы исходным клиентам не отправлялись. Переносы, отмены и уведомления администраторам заблокированы или симулированы. Создание разрешено только на тестовый номер владельца, максимум одна попытка с внешним эффектом.', '',
    `Обращений: ${summary.turns}/${summary.expectedTurns}; исходных личных сообщений: ${summary.sourceMessages}; диалогов: ${summary.dialogs}.`,
    ...(report.source?.textInputCount != null ? [`Состав: ${report.source.textInputCount} текстовых сообщений и ${report.source.photoInputCount} фото; исключено сообщений из групп: ${report.source.excludedGroupMessages}.`] : []),
    `Текстовых ответов: ${summary.answers}; штатное молчание: ${summary.silent}; ошибки запуска: ${summary.errors.length}; пустой ответ без статуса: ${summary.empty.length}.`,
    `Тестовых эскалаций: ${summary.escalations}; обращений с ошибкой инструмента: ${summary.toolErrorTurns}; созданий записи: ${summary.bookingCreated.length}.`, '',
    `Медиана времени ответа: ${summary.medianSeconds} с; максимум: ${summary.maxSeconds} с.`, '',
    'Первый прогон с ошибочной подстановкой тестового владельца в чтение записей исключён из этого отчёта. Данный отчёт относится к повторному прогону с контекстом исходных клиентов.', '',
    '## Наблюдения по качеству', '',
    `Упоминания внутренних инструкций в клиентском ответе: ${summary.internalInstructionReplies.join(', ') || 'нет'}. В D11-T02 это неуместная реакция на «Жалко. Спасибо».`,
    `Возврат к общей фразе с вопросом о дате/части дня после проверок ответа: ${summary.genericFallbackReplies.join(', ') || 'нет'}. Это результат защитного механизма обработчика, а не технический сбой Codex.`,
    'Ответы об отсутствии/наличии вчерашних записей и свободных слотов зависят от текущего снимка CRM. Их нельзя считать точным воспроизведением состояния на вчерашний момент или без дополнительной проверки приписывать ошибке модели.', '',
    '## Все вопросы и ответы', ''];
  for (const c of report.cases || []) {
    lines.push(`## ${c.id} · ${c.sourceTime || ''}`, '', '**Вопрос:**', '',
      ...String(c.question || '').split('\n').map(line => `> ${line}`), '', '**Ответ Милы:**', '',
      ...String(c.answer || (c.silent ? '[Штатное молчание — ответ не требуется]' : c.error ? `[Ошибка: ${c.error}]` : '[Пустой ответ]')).split('\n').map(line => `> ${line}`), '',
      `Время: ${(c.ms / 1000).toFixed(1)} с; обращений к модели: ${c.llmCalls}; исходных сообщений: ${c.sourceMessageCount || 1}.`,
      `Инструменты: ${(c.tools || []).map(t => t.name + (t.created ? ' [создана тестовая запись]' : t.blocked ? ` [блок: ${t.blocked}]` : t.simulated ? ' [симуляция]' : t.sourceSnapshot ? ' [снимок БД]' : t.error ? ' [ошибка]' : '')).join(', ') || 'нет'}.`,
      ...(c.escalated ? ['Передача администратору: только тест, уведомления не отправлялись.'] : []), '');
  }
  return lines.join('\n');
}

if (require.main === module) {
  const input = process.argv[2] || '/tmp/mila-codex-production-2026-09-26.json';
  const report = JSON.parse(fs.readFileSync(input, 'utf8'));
  const output = input.replace(/\.json$/, '-qa.md');
  fs.writeFileSync(output, markdown(report), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ ...summarize(report), output }) + '\n');
}
module.exports = { summarize, markdown };

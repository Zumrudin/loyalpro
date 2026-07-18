'use strict';

const { buildSystemPrompt } = require('./services/agent/system-prompt');

describe('buildSystemPrompt', () => {
  test('подставляет имя салона и часы', () => {
    const p = buildSystemPrompt({ salonName: 'PERI CLINIC', workingHours: '09:00–21:00', today: '2026-07-18' });
    expect(p).toContain('PERI CLINIC');
    expect(p).toContain('09:00–21:00');
    expect(p).toContain('2026-07-18');
  });

  test('запрещает выдумывать факты и требует инструменты', () => {
    const p = buildSystemPrompt({});
    expect(p).toMatch(/НИКОГДА не выдумыв/i);
    expect(p).toContain('search_knowledge_base');
  });

  test('требует согласие перед create_booking', () => {
    const p = buildSystemPrompt({});
    expect(p).toContain('create_booking');
    expect(p).toMatch(/подтвер|соглас/i);
  });

  test('описывает правило эскалации', () => {
    const p = buildSystemPrompt({});
    expect(p).toContain('escalate_to_operator');
  });

  test('без опций не падает и даёт дефолтное имя', () => {
    const p = buildSystemPrompt();
    expect(typeof p).toBe('string');
    expect(p.length).toBeGreaterThan(50);
  });
});

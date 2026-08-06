'use strict';

// Инцидент 2026-08-06 (79037504378): сразу после успешной записи Мила дописала
// «Наш адрес: 2-й Троицкий переулок, 6Ас4» — адрес ВЫМЫШЛЕННЫЙ (настоящий —
// ул. Генерала Белова, 28 к. 3). Журнал agent_tool_events за этот ход содержит
// РОВНО два вызова: get_available_slots и create_booking. search_knowledge_base
// не звался ни разу, то есть адрес взят из памяти модели, а не из статьи КБ.
//
// Двойное нарушение: (1) факт о клинике назван без источника; (2) адрес назван
// по своей инициативе — пациентка про него не спрашивала (и через 33 секунды
// YClients прислал ей автоуведомление с ПРАВИЛЬНЫМ адресом).

const g = require('./services/agent/address-guard');

// Кусок реальной статьи КБ №33 «Информация о клинике» — единственный легальный
// источник адреса. Тесты сверяют реплику именно с ним.
const KB = JSON.stringify({
  found: true,
  chunks: [{
    title: 'Информация о клинике',
    text: '## Контакты и график работы\n* **Адрес:** г. Москва, ул. Генерала Белова, д. 28, к. 3 (метро Домодедовская)\n* **График работы:** Ежедневно с 10:00 до 22:00',
  }],
});

describe('scrubAddresses — вымышленный адрес без источника', () => {
  const INCIDENT = 'Отлично, записала вас на ботулинотерапию к главному врачу Пери Исамудиновне на завтра, **7 августа**, в **11:30**.\n\nНаш адрес: 2-й Троицкий переулок, 6Ас4. Будем ждать вас! 🤍';

  test('вырезает адресную фразу, оставляя подтверждение записи', () => {
    const out = g.scrubAddresses([INCIDENT], {});
    expect(out.replies).toHaveLength(1);
    expect(out.replies[0]).not.toMatch(/Троицкий/);
    expect(out.replies[0]).not.toMatch(/адрес/i);
    expect(out.replies[0]).toMatch(/записала вас на ботулинотерапию/);
    expect(out.replies[0]).toMatch(/11:30/);
    expect(out.replies[0]).toMatch(/Будем ждать вас/);
    expect(out.removed).toHaveLength(1);
    expect(out.removed[0]).toMatch(/Троицкий/);
  });

  test('источник есть, но улица в нём другая — всё равно вырезаем', () => {
    const out = g.scrubAddresses([INCIDENT], { sourceText: KB });
    expect(out.replies[0]).not.toMatch(/Троицкий/);
    expect(out.removed).toHaveLength(1);
  });
});

describe('scrubAddresses — адрес из базы знаний', () => {
  test('дословный адрес из статьи проходит целиком', () => {
    const reply = 'Мы находимся по адресу: г. Москва, ул. Генерала Белова, д. 28, к. 3. Ближайшее метро — Домодедовская.';
    const out = g.scrubAddresses([reply], { sourceText: KB });
    expect(out.replies).toEqual([reply]);
    expect(out.removed).toHaveLength(0);
  });

  test('пересказ своими словами с той же улицей и домом проходит', () => {
    const reply = 'Наш адрес: улица Генерала Белова, 28 корпус 3, это рядом с метро Домодедовская.';
    const out = g.scrubAddresses([reply], { sourceText: KB });
    expect(out.replies).toEqual([reply]);
  });

  test('склонение названия не считается выдумкой', () => {
    const reply = 'Мы в Москве, на улице Генерала Белова, дом 28.';
    const out = g.scrubAddresses([reply], { sourceText: KB });
    expect(out.replies).toEqual([reply]);
  });

  test('улица верная, а номер дома выдуман — вырезаем', () => {
    const out = g.scrubAddresses(
      ['Наш адрес: ул. Генерала Белова, д. 30, к. 1.'], { sourceText: KB });
    expect(out.replies).toEqual([]);
    expect(out.removed).toHaveLength(1);
  });

  test('станция метро, которой нет в статье — вырезаем', () => {
    const out = g.scrubAddresses(
      ['Мы в двух шагах от метро Царицыно.'], { sourceText: KB });
    expect(out.replies).toEqual([]);
  });
});

describe('scrubAddresses — обычные реплики не трогаются', () => {
  test('реплика без адреса возвращается байт-в-байт', () => {
    const replies = [
      'Здравствуйте, Нелли! Я Мила, виртуальный администратор PERI CLINIC.',
      'Завтра эту процедуру проводит главный врач Пери Исамудиновна. Есть свободные окошки в **11:00** и **11:30**. Какое время вам больше подходит? 🌸',
    ];
    const out = g.scrubAddresses(replies, {});
    expect(out.replies).toEqual(replies);
    expect(out.removed).toHaveLength(0);
  });

  test('слова-омонимы не считаются адресом', () => {
    const replies = ['Площадь обработки — подмышки и голени, процедура займёт около 30 минут.'];
    expect(g.scrubAddresses(replies, {}).replies).toEqual(replies);
  });

  test('пустой список остаётся пустым', () => {
    expect(g.scrubAddresses([], {}).replies).toEqual([]);
  });
});

describe('splitSentences — сокращения не рвут предложение', () => {
  test('ул./д./к. остаются внутри одной фразы', () => {
    const parts = g.splitSentences('Наш адрес: ул. Генерала Белова, д. 28, к. 3. Будем ждать вас!');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe('Наш адрес: ул. Генерала Белова, д. 28, к. 3.');
    expect(parts[1].trim()).toBe('Будем ждать вас!');
  });

  test('склейка кусков возвращает исходную строку', () => {
    const src = 'Записала вас на 7 августа, 11:30. Ждём! 🤍';
    expect(g.splitSentences(src).join('')).toBe(src);
  });
});

describe('слабые маркеры без факта об адресе', () => {
  test('«как вам удобнее добраться?» — не адресная фраза, остаётся', () => {
    const replies = ['Подскажите, как вам удобнее добраться? Записала вас на 11:30.'];
    expect(g.scrubAddresses(replies, {}).replies).toEqual(replies);
  });

  test('«находимся» + топоним без источника — вырезаем', () => {
    const out = g.scrubAddresses(['Мы находимся в центре Москвы.'], {});
    expect(out.removed).toHaveLength(1);
    expect(out.replies).toEqual([]);
  });

  test('сильный маркер работает и без топонима', () => {
    expect(g.isAddressClaim('Наш адрес указан ниже.')).toBe(true);
    expect(g.isAddressClaim('Ближайшее метро в двух шагах.')).toBe(true);
  });
});

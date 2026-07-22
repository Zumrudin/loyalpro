'use strict';
const test = require('node:test');
const assert = require('node:assert');
const e = require('./equipment');

// ── Интервалы ────────────────────────────────────────────────────────────────

test('mergeRanges склеивает пересекающиеся и смежные', () => {
  assert.deepEqual(e.mergeRanges([{ start: 10, end: 20 }, { start: 15, end: 30 }]), [{ start: 10, end: 30 }]);
  assert.deepEqual(e.mergeRanges([{ start: 10, end: 20 }, { start: 20, end: 30 }]), [{ start: 10, end: 30 }]);
  assert.deepEqual(e.mergeRanges([{ start: 30, end: 40 }, { start: 10, end: 20 }]),
    [{ start: 10, end: 20 }, { start: 30, end: 40 }]);
});

test('subtractRanges вырезает занятость, дробя окно', () => {
  assert.deepEqual(
    e.subtractRanges([{ start: 600, end: 720 }], [{ start: 630, end: 660 }]),
    [{ start: 600, end: 630 }, { start: 660, end: 720 }]);
});

test('subtractRanges: занятость целиком перекрывает окно', () => {
  assert.deepEqual(e.subtractRanges([{ start: 600, end: 720 }], [{ start: 540, end: 780 }]), []);
});

test('subtractRanges: непересекающаяся занятость не трогает окно', () => {
  assert.deepEqual(e.subtractRanges([{ start: 600, end: 720 }], [{ start: 800, end: 900 }]),
    [{ start: 600, end: 720 }]);
});

test('intersectRanges находит общие окна', () => {
  assert.deepEqual(
    e.intersectRanges([{ start: 600, end: 720 }], [{ start: 660, end: 800 }]),
    [{ start: 660, end: 720 }]);
  assert.deepEqual(e.intersectRanges([{ start: 600, end: 660 }], [{ start: 700, end: 800 }]), []);
});

// ── Занятость оборудования из записей дня ───────────────────────────────────

const rec = (o) => ({
  datetime: o.dt, seance_length: o.len, resource_instance_ids: o.res || [], deleted: !!o.deleted,
});

test('recordsToResourceBusy строит занятость по экземплярам аппаратов', () => {
  const busy = e.recordsToResourceBusy([
    rec({ dt: '2026-07-21T11:30:00+03:00', len: 1800, res: [182862] }),
    rec({ dt: '2026-07-21T12:00:00+03:00', len: 1800, res: [182862] }),
    rec({ dt: '2026-07-21T13:00:00+03:00', len: 900, res: [182855] }),
  ], '2026-07-21');
  // 11:30–12:00 и 12:00–12:30 склеиваются в 11:30–12:30
  assert.deepEqual(busy.get('182862'), [{ start: 690, end: 750 }]);
  assert.deepEqual(busy.get('182855'), [{ start: 780, end: 795 }]);
});

test('recordsToResourceBusy игнорирует удалённые записи и записи без аппарата', () => {
  const busy = e.recordsToResourceBusy([
    rec({ dt: '2026-07-21T11:30:00+03:00', len: 1800, res: [182862], deleted: true }),
    rec({ dt: '2026-07-21T14:00:00+03:00', len: 1800, res: [] }),
  ], '2026-07-21');
  assert.equal(busy.size, 0);
});

test('recordsToResourceBusy отбрасывает записи другого дня', () => {
  const busy = e.recordsToResourceBusy([
    rec({ dt: '2026-07-22T11:30:00+03:00', len: 1800, res: [182862] }),
  ], '2026-07-21');
  assert.equal(busy.size, 0);
});

// ── Экземпляры аппаратов под услугу ──────────────────────────────────────────

// resources: [{id, instances:[{id}]}] из /resources/{cid}
const RES = [
  { id: 102341, instances: [{ id: 182862 }] },                     // Inmode — 1 экз.
  { id: 102336, instances: [{ id: 182855 }, { id: 182856 }] },     // условный аппарат на 2 экз.
];
// svcId → [resourceId]
const SVC_RES = new Map([['15394152', ['102341']], ['9536729', ['102336']], ['15394096', []]]);

test('instancesForService отдаёт экземпляры аппарата услуги', () => {
  assert.deepEqual(e.instancesForService(SVC_RES, RES, '15394152'), ['182862']);
  assert.deepEqual(e.instancesForService(SVC_RES, RES, '9536729'), ['182855', '182856']);
  assert.deepEqual(e.instancesForService(SVC_RES, RES, '15394096'), []);
});

// ── Подбор параллельных стартов ──────────────────────────────────────────────

const WORKDAY = [{ start: 600, end: 780 }];   // 10:00–13:00

test('parallelStarts: две услуги без аппаратов — общие старты по сетке', () => {
  const starts = e.parallelStarts([
    { ranges: WORKDAY, durationMin: 30, instances: [] },
    { ranges: WORKDAY, durationMin: 60, instances: [] },
  ], { step: 30, busy: new Map() });
  assert.deepEqual(starts, [600, 630, 660, 690, 720]);   // последний старт, где влезает 60 мин
});

test('parallelStarts: пересечение окон мастеров сужает выбор', () => {
  const starts = e.parallelStarts([
    { ranges: [{ start: 600, end: 720 }], durationMin: 30, instances: [] },
    { ranges: [{ start: 660, end: 780 }], durationMin: 30, instances: [] },
  ], { step: 30, busy: new Map() });
  assert.deepEqual(starts, [660, 690]);   // 690 влезает впритык: 690+30 = 720 = конец окна
});

test('parallelStarts: занятый аппарат вычитается из окна', () => {
  const busy = new Map([['182862', [{ start: 630, end: 690 }]]]);
  const starts = e.parallelStarts([
    { ranges: WORKDAY, durationMin: 30, instances: ['182862'] },
    { ranges: WORKDAY, durationMin: 30, instances: [] },
  ], { step: 30, busy });
  assert.deepEqual(starts, [600, 690, 720, 750]);   // 630 и 660 выбиты занятым Inmode
});

test('parallelStarts: две услуги на одном односкземплярном аппарате — стартов нет', () => {
  const starts = e.parallelStarts([
    { ranges: WORKDAY, durationMin: 30, instances: ['182862'] },
    { ranges: WORKDAY, durationMin: 30, instances: ['182862'] },
  ], { step: 30, busy: new Map() });
  assert.deepEqual(starts, []);
});

test('parallelStarts: аппарат на 2 экземпляра пускает две параллельные услуги', () => {
  const starts = e.parallelStarts([
    { ranges: WORKDAY, durationMin: 30, instances: ['182855', '182856'] },
    { ranges: WORKDAY, durationMin: 30, instances: ['182855', '182856'] },
  ], { step: 30, busy: new Map() });
  assert.deepEqual(starts, [600, 630, 660, 690, 720, 750]);
});

test('parallelStarts: занятость одного из двух экземпляров запрещает пару, но не одиночку', () => {
  const busy = new Map([['182855', [{ start: 600, end: 660 }]]]);
  const pair = e.parallelStarts([
    { ranges: WORKDAY, durationMin: 30, instances: ['182855', '182856'] },
    { ranges: WORKDAY, durationMin: 30, instances: ['182855', '182856'] },
  ], { step: 30, busy });
  assert.deepEqual(pair, [660, 690, 720, 750]);   // до 660 свободен лишь один экземпляр
});

test('hardResourceConflict находит аппарат, которого физически не хватит', () => {
  const c = e.hardResourceConflict([
    { instances: ['182862'] },
    { instances: ['182862'] },
  ]);
  assert.deepEqual(c, ['182862']);
  assert.equal(e.hardResourceConflict([{ instances: ['182862'] }, { instances: [] }]), null);
  assert.equal(e.hardResourceConflict([
    { instances: ['182855', '182856'] }, { instances: ['182855', '182856'] },
  ]), null);
});

// ── Отсечение прошедшего времени ─────────────────────────────────────────────

test('dropPastStarts режет старты раньше «сейчас» только для сегодняшней даты', () => {
  assert.deepEqual(e.dropPastStarts([600, 630, 660], '2026-07-21', { date: '2026-07-21', minutes: 640 }), [660]);
  assert.deepEqual(e.dropPastStarts([600, 630, 660], '2026-07-22', { date: '2026-07-21', minutes: 640 }),
    [600, 630, 660]);
});

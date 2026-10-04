'use strict';
const { pickPending, groupByDayDesc, chunks } = require('./services/dialog-verdicts/select');

// Строка из store.listDialogDays: max_ts и source_max_ts приходят из pg строками (bigint).
const row = (over) => ({ dkey: '79001112233', day: '2026-10-03', channel: 'tdlib', phone: '79001112233',
  max_ts: '1759500000', verdict_id: null, source_max_ts: null, taxonomy_version: null, status: null, ...over });

describe('pickPending', () => {
  const cur = { taxonomyVersion: 1 };
  test('без вердикта — берётся; с вердиктом и неизменённым max_ts — нет; max_ts вырос — да', () => {
    const rows = [
      row({ dkey: 'a' }),
      row({ dkey: 'b', verdict_id: 5, source_max_ts: '1759500000', taxonomy_version: 1, status: 'booked' }),
      row({ dkey: 'c', verdict_id: 6, source_max_ts: '1759400000', taxonomy_version: 1, status: 'booked' }),
    ];
    expect(pickPending(rows, cur).map(r => r.dkey)).toEqual(['a', 'c']);
  });
  test('recompute берёт всё', () => {
    const rows = [row({ dkey: 'b', verdict_id: 5, source_max_ts: '1759500000', taxonomy_version: 1, status: 'booked' })];
    expect(pickPending(rows, { ...cur, recompute: true })).toHaveLength(1);
  });
  test('onlyStale берёт только старую версию таксономии и other', () => {
    const rows = [
      row({ dkey: 'fresh', verdict_id: 1, source_max_ts: '1', taxonomy_version: 1, status: 'booked' }),
      row({ dkey: 'old', verdict_id: 2, source_max_ts: '1', taxonomy_version: 0, status: 'booked' }),
      row({ dkey: 'oth', verdict_id: 3, source_max_ts: '1', taxonomy_version: 1, status: 'other' }),
      row({ dkey: 'none' }),
    ];
    expect(pickPending(rows, { ...cur, onlyStale: true }).map(r => r.dkey)).toEqual(['old', 'oth']);
  });
  test('sinceTs отсекает диалог-дни без свежих сообщений', () => {
    const rows = [row({ dkey: 'new', max_ts: '1759500000' }), row({ dkey: 'stale', max_ts: '1759000000' })];
    expect(pickPending(rows, { ...cur, sinceTs: 1759400000 }).map(r => r.dkey)).toEqual(['new']);
  });
});

describe('groupByDayDesc / chunks', () => {
  test('группирует по дню, свежие дни первыми, порядок внутри дня сохраняется', () => {
    const g = groupByDayDesc([row({ dkey: 'a', day: '2026-10-01' }), row({ dkey: 'b', day: '2026-10-03' }), row({ dkey: 'c', day: '2026-10-01' })]);
    expect(g.map(([d, rs]) => [d, rs.map(r => r.dkey)])).toEqual([['2026-10-03', ['b']], ['2026-10-01', ['a', 'c']]]);
  });
  test('chunks режет по размеру', () => {
    expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunks([], 2)).toEqual([]);
  });
});

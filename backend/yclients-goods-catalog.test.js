'use strict';

/**
 * Tests for backend/services/yclients-goods-catalog.js
 *
 * - Pure helpers (isBlacklisted, extractCategoryTitle, HOME_CARE_CATEGORY_BLACKLIST)
 *   tested directly without mocks.
 * - syncGoodsCatalog smoke tested with jest.mock for ycGet, db, and logger.
 *
 * Mock paths are RELATIVE TO THIS TEST FILE. Jest resolves them by absolute path
 * and applies the same mock to anyone in the require graph that loads the same
 * resolved module — so `services/yclients-goods-catalog.js` requiring `../db` /
 * `./yclients` from its own directory hits the same mock as our `./db` /
 * `./services/yclients` declarations here.
 */

// ── Mocks (hoisted by Jest above all require() calls) ─────────────────────────

jest.mock('./db', () => ({
  db: {
    any: jest.fn(),
    one: jest.fn(),
    query: jest.fn(),
    oneOrNone: jest.fn(),
  },
}));

jest.mock('./services/yclients', () => ({
  ycGet: jest.fn(),
  clearTreeCache: jest.fn(),
  getTreeCache: jest.fn(),
  setTreeCache: jest.fn(),
}));

jest.mock('./logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

const {
  isBlacklisted,
  extractCategoryTitle,
  HOME_CARE_CATEGORY_BLACKLIST,
  syncGoodsCatalog,
} = require('./services/yclients-goods-catalog');

const { db } = require('./db');
const { ycGet, clearTreeCache } = require('./services/yclients');

// ── HOME_CARE_CATEGORY_BLACKLIST ─────────────────────────────────────────────

describe('HOME_CARE_CATEGORY_BLACKLIST', () => {
  test('is a Set with exactly 6 entries', () => {
    expect(HOME_CARE_CATEGORY_BLACKLIST).toBeInstanceOf(Set);
    expect(HOME_CARE_CATEGORY_BLACKLIST.size).toBe(6);
  });

  test('all entries are lower-cased', () => {
    for (const entry of HOME_CARE_CATEGORY_BLACKLIST) {
      expect(typeof entry).toBe('string');
      expect(entry).toBe(entry.toLowerCase());
    }
  });

  test('contains the canonical 6 categories from D-03', () => {
    const expected = [
      'расходники',
      'канцелярия',
      'препараты',
      'аптека',
      'сертификаты сеть peri clinic',
      'абонементы сеть peri clinic',
    ];
    for (const cat of expected) {
      expect(HOME_CARE_CATEGORY_BLACKLIST.has(cat)).toBe(true);
    }
  });
});

// ── isBlacklisted ────────────────────────────────────────────────────────────

describe('isBlacklisted', () => {
  test.each([
    ['расходники', true],
    ['Расходники', true],
    ['РАСХОДНИКИ', true],
    ['  Расходники  ', true],
    ['Канцелярия', true],
    ['Препараты', true],
    ['Аптека', true],
    ['Сертификаты Сеть Peri Clinic', true],
    ['Абонементы Сеть Peri Clinic', true],
    ['Forlled', false],
    ['Уходы для дома', false],
    ['Без категории', false],
    [null, false],
    [undefined, false],
    ['', false],
    [42, false],
  ])('isBlacklisted(%j) === %s', (input, expected) => {
    expect(isBlacklisted(input)).toBe(expected);
  });
});

// ── extractCategoryTitle ─────────────────────────────────────────────────────

describe('extractCategoryTitle', () => {
  test('object shape: returns g.category.title', () => {
    expect(extractCategoryTitle({ category: { title: 'Уходы' } }, {})).toBe('Уходы');
  });

  test('string shape: returns g.category', () => {
    expect(extractCategoryTitle({ category: 'Forlled' }, {})).toBe('Forlled');
  });

  test('numeric category_id with catMap fallback', () => {
    expect(extractCategoryTitle({ category_id: 5 }, { 5: 'X' })).toBe('X');
  });

  test('all-null fallback returns null', () => {
    expect(extractCategoryTitle({}, {})).toBeNull();
    expect(extractCategoryTitle({ category: null }, {})).toBeNull();
    expect(extractCategoryTitle({ category_id: 99 }, {})).toBeNull();
    expect(extractCategoryTitle({ category_id: 99 }, { 5: 'X' })).toBeNull();
  });

  test('object shape with missing title falls through to null', () => {
    // category is object but title is empty/missing — first branch guard fails,
    // string branch false, no usable category_id → null.
    expect(extractCategoryTitle({ category: { id: 1 } }, {})).toBeNull();
  });
});

// ── syncGoodsCatalog smoke (stubbed ycGet + db) ──────────────────────────────

describe('syncGoodsCatalog smoke', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('self-guard: missing creds returns skipped (no network calls)', async () => {
    const r = await syncGoodsCatalog({});
    expect(r).toEqual({ skipped: true, reason: 'no-yclients' });
    expect(ycGet).not.toHaveBeenCalled();
    expect(db.any).not.toHaveBeenCalled();
    expect(db.one).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('self-guard: falsy creds returns skipped', async () => {
    const r = await syncGoodsCatalog({
      id: 1, yclients_company_id: 0, yclients_user_token: '',
    });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('no-yclients');
  });

  test('self-guard: null salon returns skipped', async () => {
    const r = await syncGoodsCatalog(null);
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('no-yclients');
  });

  test('happy path: bootstrap → enumerate 2 categories → upsert 3 goods → archive → clearTreeCache', async () => {
    const cid = 668791;

    ycGet.mockImplementation(async (salon, endpoint, params) => {
      if (endpoint === `/good_categories/${cid}`) {
        return [
          { id: 101, title: 'Forlled' },
          { id: 102, title: 'Расходники' },
        ];
      }
      if (endpoint === `/goods/${cid}` && params && params.category_id === 101) {
        if (params.page === 1) {
          return [
            { good_id: 1001, title: 'Forlled Cream', category_id: 101, category: { id: 101, title: 'Forlled' } },
            { good_id: 1002, title: 'Forlled Toner', category_id: 101 },
          ];
        }
        return [];   // page 2 — empty terminator
      }
      if (endpoint === `/goods/${cid}` && params && params.category_id === 102) {
        if (params.page === 1) {
          return [{ good_id: 2001, title: 'Перчатки', category_id: 102 }];
        }
        return [];
      }
      return [];
    });

    // db.any: SELECT DISTINCT category_id (Step A2 reuse) returns [] —
    // not used here because A1 already populated catIds, but stubbed
    // so any unexpected db.any call still resolves cleanly.
    db.any.mockResolvedValue([]);
    // db.one: every UPSERT RETURNING is_insert=true
    db.one.mockResolvedValue({ is_insert: true });
    // db.query: archive UPDATE → 0 rows
    db.query.mockResolvedValue({ rowCount: 0, rows: [] });

    const r = await syncGoodsCatalog({
      id: 1,
      yclients_company_id: cid,
      yclients_user_token: 'fake-token',
    });

    expect(r.skipped).toBeUndefined();
    expect(r.salonId).toBe(1);
    expect(r.inserted).toBe(3);
    expect(r.updated).toBe(0);
    expect(r.archived).toBe(0);
    expect(r.goodsSeen).toBe(3);
    expect(r.categoriesSeen).toBe(2);
    expect(r.errors).toBe(0);
    expect(typeof r.durationMs).toBe('number');

    // UPSERT called 3 times — one per good
    expect(db.one).toHaveBeenCalledTimes(3);
    // UPDATE archive called once
    expect(db.query).toHaveBeenCalledTimes(1);
    // clearTreeCache called once with salonId=1
    expect(clearTreeCache).toHaveBeenCalledTimes(1);
    expect(clearTreeCache).toHaveBeenCalledWith(1);

    // Sanity: ycGet was called for /good_categories + /goods (≥ 1 cat per page)
    const calledEndpoints = ycGet.mock.calls.map(c => c[1]);
    expect(calledEndpoints).toContain(`/good_categories/${cid}`);
    expect(calledEndpoints).toContain(`/goods/${cid}`);
  });

  test('partial failure: one category fails, others continue', async () => {
    const cid = 668791;

    ycGet.mockImplementation(async (salon, endpoint, params) => {
      if (endpoint === `/good_categories/${cid}`) {
        return [
          { id: 101, title: 'Forlled' },
          { id: 999, title: 'Broken' },
        ];
      }
      if (endpoint === `/goods/${cid}` && params && params.category_id === 101 && params.page === 1) {
        return [{ good_id: 1001, title: 'F1', category_id: 101 }];
      }
      if (endpoint === `/goods/${cid}` && params && params.category_id === 101) {
        return [];
      }
      if (endpoint === `/goods/${cid}` && params && params.category_id === 999) {
        throw new Error('YClients 500');
      }
      return [];
    });

    db.any.mockResolvedValue([]);
    db.one.mockResolvedValue({ is_insert: true });
    db.query.mockResolvedValue({ rowCount: 0, rows: [] });

    const r = await syncGoodsCatalog({
      id: 1,
      yclients_company_id: cid,
      yclients_user_token: 'fake-token',
    });

    expect(r.errors).toBe(1);
    expect(Array.isArray(r.errorSamples)).toBe(true);
    expect(r.errorSamples).toHaveLength(1);
    expect(r.errorSamples[0].step).toBe('enumerate');
    expect(r.errorSamples[0].catId).toBe(999);
    expect(r.inserted).toBe(1);             // surviving category still upserts
    expect(clearTreeCache).toHaveBeenCalledTimes(1);   // sync completes despite partial failure
  });
});

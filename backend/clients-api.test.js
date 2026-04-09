'use strict';

/**
 * Tests for clients-query.js — the REAL module imported by server.js.
 * These tests verify the actual SQL-building logic, not a copy of it.
 */

const { buildClientsQuery, CLIENT_SORT_MAP } = require('./clients-query');

// ── Helpers ──────────────────────────────────────────────────────────────────

function build(query, salonId = 42) {
  return buildClientsQuery(query, salonId);
}

function hasCondition(where, pattern) {
  return where.split(' AND ').some(c => pattern.test(c.trim()));
}

// ── Sort ─────────────────────────────────────────────────────────────────────

describe('CLIENT_SORT_MAP', () => {
  test('exports exactly the 7 allowed columns', () => {
    expect(Object.keys(CLIENT_SORT_MAP)).toEqual([
      'name','phone','loyalty_level','bonus_balance','total_spent','visits_count','last_visit_at',
    ]);
  });

  test('all values are prefixed with c.', () => {
    Object.values(CLIENT_SORT_MAP).forEach(v => expect(v).toMatch(/^c\./));
  });
});

describe('buildClientsQuery — sort', () => {
  test('defaults: last_visit_at DESC', () => {
    const { orderCol, orderDir } = build({});
    expect(orderCol).toBe('c.last_visit_at');
    expect(orderDir).toBe('DESC');
  });

  test.each(Object.entries(CLIENT_SORT_MAP))(
    'sort=%s maps to %s',
    (col, expected) => {
      const { orderCol } = build({ sort: col });
      expect(orderCol).toBe(expected);
    }
  );

  test('sort_dir=asc → ASC', () => {
    const { orderDir } = build({ sort: 'name', sort_dir: 'asc' });
    expect(orderDir).toBe('ASC');
  });

  test('sort_dir=desc → DESC', () => {
    const { orderDir } = build({ sort: 'name', sort_dir: 'desc' });
    expect(orderDir).toBe('DESC');
  });

  test('SQL injection in sort column → falls back to last_visit_at', () => {
    const { orderCol } = build({ sort: "name; DROP TABLE clients;--" });
    expect(orderCol).toBe('c.last_visit_at');
  });

  test('SQL injection in sort_dir → falls back to DESC', () => {
    const { orderDir } = build({ sort_dir: "ASC; DROP TABLE clients;--" });
    expect(orderDir).toBe('DESC');
  });

  test('unknown sort column → falls back to last_visit_at', () => {
    const { orderCol } = build({ sort: 'created_at' });
    expect(orderCol).toBe('c.last_visit_at');
  });
});

// ── WHERE clause ──────────────────────────────────────────────────────────────

describe('buildClientsQuery — base', () => {
  test('always includes salon_id=$1 with correct salonId', () => {
    const { whereSql, params } = build({}, 99);
    expect(whereSql).toContain('c.salon_id=$1');
    expect(params[0]).toBe(99);
  });

  test('no extra filters → only salon_id', () => {
    const { whereSql } = build({});
    expect(whereSql).toBe('c.salon_id=$1');
  });
});

describe('buildClientsQuery — global search', () => {
  test('search wraps name AND phone in ILIKE $N', () => {
    const { whereSql, params } = build({ search: 'Ира' });
    expect(whereSql).toContain('c.name ILIKE $2 OR c.phone ILIKE $2');
    expect(params[1]).toBe('%Ира%');
  });

  test('empty search → not added', () => {
    const { whereSql } = build({ search: '' });
    expect(whereSql).toBe('c.salon_id=$1');
  });
});

describe('buildClientsQuery — per-column text filters', () => {
  test('name filter → c.name ILIKE with wildcards', () => {
    const { whereSql, params } = build({ name: 'Мария' });
    expect(whereSql).toContain('c.name ILIKE');
    expect(params).toContain('%Мария%');
  });

  test('phone filter → c.phone ILIKE with wildcards', () => {
    const { whereSql, params } = build({ phone: '9161' });
    expect(whereSql).toContain('c.phone ILIKE');
    expect(params).toContain('%9161%');
  });

  test('level filter → exact match', () => {
    const { whereSql, params } = build({ level: 'gold' });
    expect(whereSql).toContain('c.loyalty_level=');
    expect(params).toContain('gold');
  });
});

describe('buildClientsQuery — status filters (no extra params)', () => {
  test('sleeping → 60 days condition', () => {
    const { whereSql, params } = build({ status: 'sleeping' });
    expect(whereSql).toContain('60 days');
    expect(params).toHaveLength(1); // no extra params for status
  });

  test('risk → 30 days AND 60 days condition', () => {
    const { whereSql } = build({ status: 'risk' });
    expect(whereSql).toContain('30 days');
    expect(whereSql).toContain('60 days');
  });

  test('new → created_at > NOW()-30 days', () => {
    const { whereSql } = build({ status: 'new' });
    expect(whereSql).toContain('created_at > NOW()');
  });

  test('unknown status → ignored', () => {
    const { whereSql } = build({ status: 'vip' });
    expect(whereSql).toBe('c.salon_id=$1');
  });
});

describe('buildClientsQuery — numeric range filters', () => {
  test('bonus_min → bonus_balance >= param', () => {
    const { whereSql, params } = build({ bonus_min: '500' });
    expect(whereSql).toContain('c.bonus_balance >=');
    expect(params).toContain(500);
  });

  test('bonus_max → bonus_balance <= param', () => {
    const { whereSql, params } = build({ bonus_max: '10000' });
    expect(whereSql).toContain('c.bonus_balance <=');
    expect(params).toContain(10000);
  });

  test('bonus range both directions', () => {
    const { whereSql, params } = build({ bonus_min: '100', bonus_max: '5000' });
    const conditions = whereSql.split(' AND ');
    expect(conditions.filter(c => c.includes('c.bonus_balance'))).toHaveLength(2);
    expect(params).toContain(100);
    expect(params).toContain(5000);
  });

  test('spent_min / spent_max', () => {
    const { whereSql, params } = build({ spent_min: '1000', spent_max: '50000' });
    expect(whereSql).toContain('c.total_spent >=');
    expect(whereSql).toContain('c.total_spent <=');
    expect(params).toContain(1000);
    expect(params).toContain(50000);
  });

  test('visits_min → integer cast', () => {
    const { whereSql, params } = build({ visits_min: '5' });
    expect(whereSql).toContain('c.visits_count >=');
    expect(params).toContain(5);
    expect(typeof params.find(p => p === 5)).toBe('number');
  });

  test('visits_max', () => {
    const { whereSql, params } = build({ visits_max: '20' });
    expect(whereSql).toContain('c.visits_count <=');
    expect(params).toContain(20);
  });
});

describe('buildClientsQuery — date range filters', () => {
  test('last_visit_from → >= date cast', () => {
    const { whereSql, params } = build({ last_visit_from: '2025-01-01' });
    expect(whereSql).toContain('c.last_visit_at >=');
    expect(whereSql).toContain('::date');
    expect(params).toContain('2025-01-01');
  });

  test('last_visit_to → < date + 1 day (inclusive end)', () => {
    const { whereSql, params } = build({ last_visit_to: '2025-12-31' });
    expect(whereSql).toContain("+ INTERVAL '1 day'");
    expect(params).toContain('2025-12-31');
  });

  test('date range both', () => {
    const { whereSql } = build({ last_visit_from: '2025-01-01', last_visit_to: '2025-12-31' });
    const conditions = whereSql.split(' AND ');
    expect(conditions.filter(c => c.includes('c.last_visit_at'))).toHaveLength(2);
  });
});

describe('buildClientsQuery — parameter indexing', () => {
  test('nextIdx is 2 when no filters', () => {
    const { nextIdx } = build({});
    expect(nextIdx).toBe(2); // $1=salonId, LIMIT=$2, OFFSET=$3
  });

  test('nextIdx increments correctly with multiple filters', () => {
    const { params, nextIdx } = build({
      name: 'А', level: 'gold', bonus_min: '100', bonus_max: '5000',
    });
    // salon_id($1), name($2), level($3), bonus_min($4), bonus_max($5)
    expect(params).toHaveLength(5);
    expect(nextIdx).toBe(6); // LIMIT=$6, OFFSET=$7
  });

  test('$N placeholders in WHERE match params array length', () => {
    const { whereSql, params } = build({
      search: 'Анна', level: 'silver', bonus_min: '0', visits_max: '10',
    });
    // Extract all $N references
    const placeholders = [...whereSql.matchAll(/\$(\d+)/g)].map(m => parseInt(m[1]));
    const maxIdx = Math.max(...placeholders);
    expect(maxIdx).toBe(params.length);
  });

  test('search uses same $N for name and phone', () => {
    const { whereSql } = build({ search: 'test' });
    // Extract the search condition specifically
    const searchCond = whereSql.split(' AND ').find(c => c.includes('c.name ILIKE'));
    const matches = [...searchCond.matchAll(/\$(\d+)/g)].map(m => m[1]);
    // Both name and phone in the OR condition reference the same placeholder
    expect(new Set(matches).size).toBe(1);
  });
});

describe('buildClientsQuery — edge cases', () => {
  test('empty string values are ignored', () => {
    const { whereSql } = build({
      name: '', phone: '', level: '', bonus_min: '', bonus_max: '',
      spent_min: '', spent_max: '', visits_min: '', visits_max: '',
    });
    expect(whereSql).toBe('c.salon_id=$1');
  });

  test('null values are ignored', () => {
    const { whereSql } = build({ bonus_min: null, visits_min: null });
    expect(whereSql).toBe('c.salon_id=$1');
  });

  test('search + per-column filters are both applied (AND)', () => {
    const { whereSql } = build({ search: 'Ан', name: 'Анна', level: 'gold' });
    expect(whereSql).toContain('c.name ILIKE $2 OR c.phone ILIKE $2');
    expect(whereSql).toContain('c.name ILIKE $3');
    expect(whereSql).toContain('c.loyalty_level=$4');
  });

  test('combined: level + bonus_range + sort', () => {
    const { orderCol, orderDir, whereSql, params } = build({
      level: 'platinum', bonus_min: '1000', bonus_max: '99999',
      sort: 'bonus_balance', sort_dir: 'desc',
    });
    expect(orderCol).toBe('c.bonus_balance');
    expect(orderDir).toBe('DESC');
    expect(params).toContain('platinum');
    expect(params).toContain(1000);
    expect(params).toContain(99999);
  });
});

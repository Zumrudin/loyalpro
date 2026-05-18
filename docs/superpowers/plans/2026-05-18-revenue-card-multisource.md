# Revenue Card Multi-Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the «Выручка за период» dashboard card to aggregate all five revenue categories (services, goods, abonements, certificates, deposits) from a new `revenue_operations` table fed by the existing `finances_operation` webhook.

**Architecture:** All YClients revenue flows through `finances_operation` webhooks. We create a `revenue_operations` table with a `category` field, extend `processFinancesOperation` to write to it on every event, backfill from existing `webhook_logs` + YClients API, then update the dashboard API and frontend card.

**Tech Stack:** Node.js/Express, PostgreSQL (pg pool), Axios (YClients API), Jest, Playwright (smoke test)

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `backend/migrations.js` | Modify | Add `revenue_operations` table + indexes |
| `backend/services/revenue.js` | **Create** | `classifyExpense()` (pure) + `recordRevenueOperation()` (DB write) |
| `backend/revenue-classify.test.js` | **Create** | Unit tests for `classifyExpense` |
| `backend/services/loyalty.js` | Modify | Import from revenue.js; call `recordRevenueOperation` in `processFinancesOperation` |
| `backend/services/yclients.js` | Modify | Add `ycListFinanceTransactions()` |
| `backend/routes/api.js` | Modify | Add revenue-by-category query; expand `stats` response |
| `backend/scripts/backfill-revenue-from-webhook-logs.js` | **Create** | One-shot: migrate 34-day `webhook_logs` history → `revenue_operations` |
| `backend/scripts/backfill-revenue-from-yclients.js` | **Create** | One-shot: pull `/finance/transactions` from YClients API for deep history |
| `frontend/index.html` | Modify | Add `.rev-breakdown` block inside revenue card |
| `frontend/css/base.css` | Modify | Add `.rev-breakdown` / `.rev-row` / `.rev-val` styles |
| `frontend/js/pages/dashboard.js` | Modify | Render `periodRevenueByCategory` breakdown; use `services` for avgCheck |

---

## Task 1: DB Migration

**Files:**
- Modify: `backend/migrations.js` (append before closing brace of `runMigrations`)

- [ ] **Step 1: Read the end of migrations.js to find insertion point**

Run: `grep -n "module.exports\|runMigrations" /root/loyalpro/backend/migrations.js`

The function ends with `}` after the last `await client.query(...)`. Insert the new block immediately before the final `}` of `runMigrations`.

- [ ] **Step 2: Add migration block to migrations.js**

Append inside `runMigrations(client)` immediately before the closing `}`:

```js
  await client.query(`
    CREATE TABLE IF NOT EXISTS revenue_operations (
      id                    SERIAL PRIMARY KEY,
      salon_id              INT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      yclients_operation_id BIGINT NOT NULL,
      category              VARCHAR(32) NOT NULL,
      amount                NUMERIC(12,2) NOT NULL,
      operation_date        DATE NOT NULL,
      operation_at          TIMESTAMPTZ NOT NULL,
      client_id             INT REFERENCES clients(id) ON DELETE SET NULL,
      yclients_client_id    BIGINT,
      yclients_record_id    BIGINT,
      expense_id            INT,
      expense_title         VARCHAR(128),
      sold_item_type        VARCHAR(32),
      account_title         VARCHAR(128),
      is_cash               BOOLEAN,
      raw_payload           JSONB,
      source                VARCHAR(16) NOT NULL,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(salon_id, yclients_operation_id)
    )
  `).catch(() => {});

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_revenue_ops_salon_date
      ON revenue_operations(salon_id, operation_date)
  `).catch(() => {});

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_revenue_ops_salon_cat_date
      ON revenue_operations(salon_id, category, operation_date)
  `).catch(() => {});
```

- [ ] **Step 3: Verify migration runs cleanly**

```bash
cd backend && node -e "
const { runMigrations } = require('./migrations');
const { pool } = require('./db');
pool.connect().then(c => runMigrations(c).then(() => { c.release(); console.log('OK'); pool.end(); })).catch(e => { console.error(e); process.exit(1); });
"
```

Expected output: `OK` (no errors). Then verify table exists:

Run SQL via `mcp__postgres__query`:
```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'revenue_operations' ORDER BY ordinal_position;
```
Expected: 19 rows including `id`, `category`, `amount`, `operation_date`, `source`, etc.

- [ ] **Step 4: Commit**

```bash
git add backend/migrations.js
git commit -m "feat(db): add revenue_operations table for multi-source revenue tracking"
```

---

## Task 2: Write Failing Unit Tests for classifyExpense

**Files:**
- Create: `backend/revenue-classify.test.js`

- [ ] **Step 1: Create the test file**

```js
// backend/revenue-classify.test.js
'use strict';

// classifyExpense is not yet implemented — this test will FAIL until Task 3.
const { classifyExpense } = require('./services/revenue');

describe('classifyExpense', () => {
  test('Оказание услуг → services', () => {
    expect(classifyExpense('Оказание услуг')).toBe('services');
  });

  test('Продажа товаров → goods', () => {
    expect(classifyExpense('Продажа товаров')).toBe('goods');
  });

  test('Продажа абонементов → abonement', () => {
    expect(classifyExpense('Продажа абонементов')).toBe('abonement');
  });

  test('Продажа сертификатов → certificate', () => {
    expect(classifyExpense('Продажа сертификатов')).toBe('certificate');
  });

  test('Пополнение счета → deposit', () => {
    expect(classifyExpense('Пополнение счета')).toBe('deposit');
  });

  test('Закупка материалов → null (expense, not revenue)', () => {
    expect(classifyExpense('Закупка материалов')).toBeNull();
  });

  test('Закупка товаров → null', () => {
    expect(classifyExpense('Закупка товаров')).toBeNull();
  });

  test('Зарплата персонала → null', () => {
    expect(classifyExpense('Зарплата персонала')).toBeNull();
  });

  test('Прочие расходы → null', () => {
    expect(classifyExpense('Прочие расходы')).toBeNull();
  });

  test('null → null', () => {
    expect(classifyExpense(null)).toBeNull();
  });

  test('empty string → null', () => {
    expect(classifyExpense('')).toBeNull();
  });

  test('unknown title → other (with warning intent)', () => {
    expect(classifyExpense('Новый неизвестный тип')).toBe('other');
  });
});
```

- [ ] **Step 2: Run tests — must FAIL**

```bash
cd backend && npx jest revenue-classify --no-coverage
```

Expected: `Cannot find module './services/revenue'` — confirms module does not exist yet.

---

## Task 3: Create backend/services/revenue.js

**Files:**
- Create: `backend/services/revenue.js`

- [ ] **Step 1: Create the module**

```js
// backend/services/revenue.js
'use strict';

const { db } = require('../db');
const { createLogger } = require('../logger');

const logger = createLogger('Revenue');

// ── Category mapping ──────────────────────────────────────────────────────────

const EXPENSE_TO_CATEGORY = {
  'Оказание услуг':       'services',
  'Продажа товаров':      'goods',
  'Продажа абонементов':  'abonement',
  'Продажа сертификатов': 'certificate',
  'Пополнение счета':     'deposit',
};

const EXPENSE_SKIP = new Set([
  'Закупка материалов',
  'Закупка товаров',
  'Зарплата персонала',
  'Прочие расходы',
]);

// Pure function — no DB deps. Returns category string or null.
// null means "not revenue" (known expense) or empty title.
// 'other' means unknown title — will be written to DB with a warning.
function classifyExpense(expenseTitle) {
  if (!expenseTitle) return null;
  if (EXPENSE_SKIP.has(expenseTitle)) return null;
  return EXPENSE_TO_CATEGORY[expenseTitle] || 'other';
}

// ── DB write ──────────────────────────────────────────────────────────────────

// Writes a finances_operation event to revenue_operations.
// Idempotent via ON CONFLICT DO NOTHING.
// source: 'webhook' | 'webhook_logs_backfill' | 'api_backfill'
async function recordRevenueOperation(payload, salon, source) {
  // Skip delete/cancel events — they represent reversals, not new revenue.
  if (payload.status === 'delete') return;

  const data = payload.data || {};
  const amount = parseFloat(data.amount || 0);
  if (amount <= 0) return; // Expenses (закупки etc) have amount < 0

  const expenseTitle = data.expense?.title || null;
  const category = classifyExpense(expenseTitle);
  if (!category) return; // Known expense category — skip

  if (category === 'other') {
    logger.warn(`Unknown expense.title="${expenseTitle}" op_id=${data.id} — writing as 'other'`);
  }

  // Dates: YClients sends ISO 8601 with offset e.g. "2026-04-24T13:30:00+0400"
  const operationAt = new Date(data.date);
  // Use 'sv' locale for YYYY-MM-DD in Moscow timezone
  const operationDate = operationAt.toLocaleDateString('sv', { timeZone: 'Europe/Moscow' });

  const clientYcId = data.client?.id || null;
  const rawRecordId = data.record_id || data.record?.id;
  const ycRecordId = (rawRecordId && rawRecordId !== 0) ? rawRecordId : null;

  let clientId = null;
  if (clientYcId) {
    const client = await db.oneOrNone(
      'SELECT id FROM clients WHERE salon_id=$1 AND yclients_client_id=$2',
      [salon.id, clientYcId]
    );
    clientId = client?.id || null;
  }

  await db.query(`
    INSERT INTO revenue_operations
      (salon_id, yclients_operation_id, category, amount, operation_date, operation_at,
       client_id, yclients_client_id, yclients_record_id,
       expense_id, expense_title, sold_item_type, account_title, is_cash, source)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    ON CONFLICT (salon_id, yclients_operation_id) DO NOTHING
  `, [
    salon.id,
    data.id,
    category,
    amount,
    operationDate,
    operationAt,
    clientId,
    clientYcId,
    ycRecordId,
    data.expense?.id || null,
    expenseTitle,
    data.sold_item_type || null,
    data.account?.title || null,
    data.account?.is_cash ?? null,
    source,
  ]);
}

module.exports = { classifyExpense, recordRevenueOperation };
```

- [ ] **Step 2: Run tests — must PASS**

```bash
cd backend && npx jest revenue-classify --no-coverage
```

Expected: all 12 tests pass.

- [ ] **Step 3: Commit**

```bash
git add backend/services/revenue.js backend/revenue-classify.test.js
git commit -m "feat(revenue): classifyExpense + recordRevenueOperation; unit tests pass"
```

---

## Task 4: Extend processFinancesOperation in loyalty.js

**Files:**
- Modify: `backend/services/loyalty.js`

> **Critical:** `recordRevenueOperation` must be called BEFORE the `if (!ycRecordId || !clientYcId) return` guard — deposits have `record_id=0` and would be silently dropped by the existing guard.

- [ ] **Step 1: Add import at top of loyalty.js**

Find the existing requires at the top of the file (around line 3-6). Add after them:

```js
const { recordRevenueOperation } = require('./revenue');
```

- [ ] **Step 2: Modify processFinancesOperation (around line 786-792)**

Current code:
```js
async function processFinancesOperation(payload, salon) {
  const data = payload.data || {};
  const ycRecordId = data.record_id || data.record?.id;
  const clientYcId = data.client?.id;
  if (!ycRecordId || !clientYcId) return;
  return withRecordLock(ycRecordId, () => _processFinancesOperationLocked(payload, salon));
}
```

Replace with:
```js
async function processFinancesOperation(payload, salon) {
  // Revenue recording: runs for ALL events (including deposits that have no record_id).
  // Wrapped in catch so a revenue write failure never breaks cashback processing.
  await recordRevenueOperation(payload, salon, 'webhook').catch(e =>
    logger.warn(`recordRevenueOperation failed: ${e.message}`)
  );

  const data = payload.data || {};
  const ycRecordId = data.record_id || data.record?.id;
  const clientYcId = data.client?.id;
  if (!ycRecordId || !clientYcId) return;
  return withRecordLock(ycRecordId, () => _processFinancesOperationLocked(payload, salon));
}
```

- [ ] **Step 3: Verify server starts without error**

```bash
cd backend && node -e "require('./services/loyalty'); console.log('OK')"
```

Expected: `OK` with no error.

- [ ] **Step 4: Commit**

```bash
git add backend/services/loyalty.js
git commit -m "feat(loyalty): record revenue_operations on every finances_operation webhook"
```

---

## Task 5: Add ycListFinanceTransactions to yclients.js

**Files:**
- Modify: `backend/services/yclients.js`

- [ ] **Step 1: Add the function before module.exports**

Locate `module.exports` at the end of `yclients.js`. Add immediately before it:

```js
// Paginated finance transactions for backfill.
// YClients endpoint: GET /company/{company_id}/finance/transactions
// Params: date_from, date_to (YYYY-MM-DD), page (1-based), count (max ~50).
// NOTE: Verify actual param names against live API during first backfill run.
async function ycListFinanceTransactions(salon, { dateFrom, dateTo, page = 1, count = 50 } = {}) {
  return ycGet(salon, `/company/${salon.yclients_company_id}/finance/transactions`, {
    date_from: dateFrom,
    date_to: dateTo,
    page,
    count,
  });
}
```

- [ ] **Step 2: Export the function**

Find `module.exports = {` at the bottom and add `ycListFinanceTransactions` to the export list.

- [ ] **Step 3: Verify no syntax errors**

```bash
cd backend && node -e "require('./services/yclients'); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add backend/services/yclients.js
git commit -m "feat(yclients): add ycListFinanceTransactions for revenue backfill"
```

---

## Task 6: Backfill Script — webhook_logs

**Files:**
- Create: `backend/scripts/backfill-revenue-from-webhook-logs.js`

- [ ] **Step 1: Create the script**

```js
#!/usr/bin/env node
// One-shot: backfill revenue_operations from existing webhook_logs.
// Covers the ~34 days of finances_operation events already stored.
// Idempotent — safe to run multiple times.
//
// Usage: node backend/scripts/backfill-revenue-from-webhook-logs.js
'use strict';

const { pool, db } = require('../db');
const { classifyExpense } = require('../services/revenue');
const { createLogger } = require('../logger');

const logger = createLogger('BackfillWebhookLogs');

async function main() {
  const salons = await db.any('SELECT id, yclients_company_id FROM salons WHERE is_active=TRUE');
  const salonMap = Object.fromEntries(salons.map(s => [s.id, s]));

  const events = await db.any(`
    SELECT id, salon_id, payload
    FROM webhook_logs
    WHERE event_type = 'finances_operation'
    ORDER BY id
  `);

  console.log(`Processing ${events.length} finances_operation events from webhook_logs...`);

  let inserted = 0, skipped = 0, errors = 0;

  for (const event of events) {
    const salon = salonMap[event.salon_id];
    if (!salon) { skipped++; continue; }

    const payload = typeof event.payload === 'string'
      ? JSON.parse(event.payload)
      : event.payload;

    if (payload.status === 'delete') { skipped++; continue; }

    const data = payload.data || {};
    const amount = parseFloat(data.amount || 0);
    if (amount <= 0) { skipped++; continue; }

    const category = classifyExpense(data.expense?.title);
    if (!category) { skipped++; continue; }

    try {
      const operationAt = new Date(data.date);
      const operationDate = operationAt.toLocaleDateString('sv', { timeZone: 'Europe/Moscow' });
      const clientYcId = data.client?.id || null;
      const rawRecordId = data.record_id || data.record?.id;
      const ycRecordId = (rawRecordId && rawRecordId !== 0) ? rawRecordId : null;

      let clientId = null;
      if (clientYcId) {
        const client = await db.oneOrNone(
          'SELECT id FROM clients WHERE salon_id=$1 AND yclients_client_id=$2',
          [salon.id, clientYcId]
        );
        clientId = client?.id || null;
      }

      const result = await db.query(`
        INSERT INTO revenue_operations
          (salon_id, yclients_operation_id, category, amount, operation_date, operation_at,
           client_id, yclients_client_id, yclients_record_id,
           expense_id, expense_title, sold_item_type, account_title, is_cash, source)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        ON CONFLICT (salon_id, yclients_operation_id) DO NOTHING
      `, [
        salon.id, data.id, category, amount, operationDate, operationAt,
        clientId, clientYcId, ycRecordId,
        data.expense?.id || null, data.expense?.title || null,
        data.sold_item_type || null, data.account?.title || null,
        data.account?.is_cash ?? null, 'webhook_logs_backfill',
      ]);

      if (result.rowCount > 0) inserted++;
      else skipped++; // ON CONFLICT — already exists
    } catch (e) {
      logger.error(`event ${event.id}: ${e.message}`);
      errors++;
    }
  }

  console.log(`\nDone. Inserted: ${inserted}, Skipped/existing: ${skipped}, Errors: ${errors}`);

  // Reconciliation sanity check for salon_id=1
  const r = await db.one(`
    SELECT
      (SELECT COALESCE(SUM(amount),0) FROM records
       WHERE salon_id=1 AND status IN ('completed','confirmed','arrived')
         AND COALESCE((visit_datetime AT TIME ZONE 'Europe/Moscow')::date, visit_date::date)
         BETWEEN '2026-03-21' AND '2026-04-24') AS records_services,
      (SELECT COALESCE(SUM(amount),0) FROM revenue_operations
       WHERE salon_id=1 AND category='services'
         AND operation_date BETWEEN '2026-03-21' AND '2026-04-24') AS rev_ops_services
  `);

  const diff = Math.abs(parseFloat(r.records_services) - parseFloat(r.rev_ops_services));
  const pct = parseFloat(r.records_services) > 0
    ? (diff / parseFloat(r.records_services) * 100).toFixed(1)
    : '0.0';

  console.log('\nReconciliation (salon_id=1, 2026-03-21..2026-04-24):');
  console.log(`  records.amount services:       ${r.records_services}`);
  console.log(`  revenue_operations services:   ${r.rev_ops_services}`);
  console.log(`  Difference: ${diff} (${pct}%)`);
  if (parseFloat(pct) > 5) {
    console.warn('  ⚠ Difference > 5% — investigate');
  } else {
    console.log('  ✓ Within 5% tolerance');
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Commit**

```bash
git add backend/scripts/backfill-revenue-from-webhook-logs.js
git commit -m "feat(scripts): backfill revenue_operations from webhook_logs"
```

---

## Task 7: Backfill Script — YClients API

**Files:**
- Create: `backend/scripts/backfill-revenue-from-yclients.js`

- [ ] **Step 1: Create the script**

```js
#!/usr/bin/env node
// One-shot: backfill revenue_operations from YClients /finance/transactions API.
// Use for history older than webhook_logs retention (~34 days).
// Idempotent — safe to re-run; uses ON CONFLICT DO NOTHING.
//
// Usage:
//   node backend/scripts/backfill-revenue-from-yclients.js \
//     --salon-id 1 --from 2025-01-01 --to 2026-03-20 [--rate-limit-ms 300]
//
// NOTE: If YClients returns 404 for the endpoint, check the endpoint path.
// Known candidates: /company/{id}/finance/transactions
//                   /finance/kassa_logs/{id}
'use strict';

const { db, pool } = require('../db');
const { classifyExpense } = require('../services/revenue');
const { ycListFinanceTransactions } = require('../services/yclients');
const { createLogger } = require('../logger');

const logger = createLogger('BackfillYClients');

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith('--')) {
      args[process.argv[i].slice(2)] = process.argv[i + 1];
      i++;
    }
  }
  return args;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function backfillSalon(salon, { dateFrom, dateTo, rateLimitMs }) {
  let page = 1;
  let inserted = 0, skipped = 0, errors = 0;

  while (true) {
    let rows;
    try {
      rows = await ycListFinanceTransactions(salon, {
        dateFrom, dateTo, page, count: 50,
      });
    } catch (e) {
      if (e.response?.status === 429) {
        console.warn(`Rate limited — sleeping 5s then retry`);
        await sleep(5000);
        continue;
      }
      throw e;
    }

    if (!rows || rows.length === 0) break;
    console.log(`  Page ${page}: ${rows.length} rows`);

    for (const item of rows) {
      // YClients API response shape for finance/transactions differs from webhook payload.
      // Wrap it in the webhook payload shape that classifyExpense/recordRevenueOperation expect.
      const amount = parseFloat(item.amount || 0);
      if (amount <= 0) { skipped++; continue; }

      const expenseTitle = item.expense?.title || null;
      const category = classifyExpense(expenseTitle);
      if (!category) { skipped++; continue; }

      try {
        const operationAt = new Date(item.date);
        const operationDate = operationAt.toLocaleDateString('sv', { timeZone: 'Europe/Moscow' });
        const clientYcId = item.client?.id || null;
        const ycRecordId = (item.record_id && item.record_id !== 0) ? item.record_id : null;

        let clientId = null;
        if (clientYcId) {
          const client = await db.oneOrNone(
            'SELECT id FROM clients WHERE salon_id=$1 AND yclients_client_id=$2',
            [salon.id, clientYcId]
          );
          clientId = client?.id || null;
        }

        const result = await db.query(`
          INSERT INTO revenue_operations
            (salon_id, yclients_operation_id, category, amount, operation_date, operation_at,
             client_id, yclients_client_id, yclients_record_id,
             expense_id, expense_title, sold_item_type, account_title, is_cash, source)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          ON CONFLICT (salon_id, yclients_operation_id) DO NOTHING
        `, [
          salon.id, item.id, category, amount, operationDate, operationAt,
          clientId, clientYcId, ycRecordId,
          item.expense?.id || null, expenseTitle,
          item.sold_item_type || null, item.account?.title || null,
          item.account?.is_cash ?? null, 'api_backfill',
        ]);

        if (result.rowCount > 0) inserted++;
        else skipped++;
      } catch (e) {
        logger.error(`item ${item.id}: ${e.message}`);
        errors++;
      }
    }

    if (rows.length < 50) break; // Last page
    page++;
    await sleep(rateLimitMs);
  }

  return { inserted, skipped, errors };
}

async function main() {
  const args = parseArgs();
  const salonId = parseInt(args['salon-id']);
  const dateFrom = args['from'];
  const dateTo = args['to'];
  const rateLimitMs = parseInt(args['rate-limit-ms'] || '300');

  if (!salonId || !dateFrom || !dateTo) {
    console.error('Usage: --salon-id N --from YYYY-MM-DD --to YYYY-MM-DD [--rate-limit-ms 300]');
    process.exit(1);
  }

  const salon = await db.oneOrNone('SELECT * FROM salons WHERE id=$1 AND is_active=TRUE', [salonId]);
  if (!salon) { console.error(`Salon ${salonId} not found`); process.exit(1); }

  console.log(`Backfilling salon ${salonId} (${salon.yclients_company_id}) from ${dateFrom} to ${dateTo}`);
  console.log(`Rate limit: ${rateLimitMs}ms between pages`);

  const result = await backfillSalon(salon, { dateFrom, dateTo, rateLimitMs });
  console.log(`\nDone. Inserted: ${result.inserted}, Skipped/existing: ${result.skipped}, Errors: ${result.errors}`);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Commit**

```bash
git add backend/scripts/backfill-revenue-from-yclients.js
git commit -m "feat(scripts): backfill revenue_operations from YClients finance/transactions API"
```

---

## Task 8: Update routes/api.js — Add periodRevenueByCategory

**Files:**
- Modify: `backend/routes/api.js` (dashboard endpoint, around lines 128–151)

> Keep the existing `rev` query (used for `periodRecords` count). Add a parallel query for revenue by category.

- [ ] **Step 1: Locate the Promise.all block**

The dashboard `Promise.all` at line 128 lists multiple parallel queries. Find it — it currently has entries for `tc`, `ac`, `slp`, `nc`, `bs`, `rev`, `bonusStat`, etc.

- [ ] **Step 2: Add revenue-by-category query to the Promise.all**

In the destructuring at line 128, add `revByCatRows` as the last entry:

```js
const [tc, ac, slp, nc, bs, rev, bonusStat, topSvc, lvlDist, daily, recentTx, lastSync, tgCount, cardCount, bonEconomy, revByCatRows] = await Promise.all([
  // ... all existing queries unchanged ...
  db.any(`
    SELECT category, COALESCE(SUM(amount),0) AS total
    FROM revenue_operations
    WHERE salon_id=$1
      AND operation_date BETWEEN $2::date AND $3::date
      AND category IN ('services','goods','abonement','certificate','deposit')
    GROUP BY category
  `, p),
]);
```

- [ ] **Step 3: Build the periodRevenueByCategory object**

Add the following lines immediately before the `res.json(...)` call at line 151:

```js
    const revByCat = { services: 0, goods: 0, abonement: 0, certificate: 0, deposit: 0 };
    for (const row of revByCatRows) {
      if (row.category in revByCat) revByCat[row.category] = parseFloat(row.total);
    }
    revByCat.total = revByCat.services + revByCat.goods + revByCat.abonement + revByCat.certificate + revByCat.deposit;
```

- [ ] **Step 4: Extend the res.json stats object**

In the `res.json({stats: {...}, ...})` call, add two fields:

```js
periodRevenue: revByCat.total,                    // was: parseFloat(rev.rv) — now total of all categories
periodRevenueByCategory: revByCat,                // new breakdown object
```

Keep `periodRecords: parseInt(rev.rc)` unchanged — it still comes from the `records` query.

- [ ] **Step 5: Verify syntax — start server**

```bash
cd backend && node -e "require('./routes/api'); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 6: Test API response**

Mint a JWT:
```bash
cd backend && node -e "
const jwt = require('jsonwebtoken');
const cfg = require('./config');
const tok = jwt.sign({userId:9, salonId:1, role:'admin'}, cfg.JWT_SECRET, {expiresIn:'1h'});
console.log(tok);"
```

Then query:
```bash
curl -s "http://localhost:3001/api/analytics/dashboard?preset=month" \
  -H "Authorization: Bearer <TOKEN>" | node -e "
const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
console.log(JSON.stringify(d.stats.periodRevenueByCategory, null, 2));
console.log('periodRevenue:', d.stats.periodRevenue);"
```

Expected: `{ services: N, goods: N, abonement: N, certificate: N, deposit: N, total: N }` with `total === periodRevenue`.

- [ ] **Step 7: Commit**

```bash
git add backend/routes/api.js
git commit -m "feat(api): add periodRevenueByCategory to dashboard stats response"
```

---

## Task 9: Frontend — HTML Markup and CSS

**Files:**
- Modify: `frontend/index.html` (line 134 — revenue card)
- Modify: `frontend/css/base.css` (after `.sd` rule around line 75)

- [ ] **Step 1: Update revenue card in index.html**

Find (line 134):
```html
        <div class="sc"><div class="sl">Выручка за период</div><div class="sv" id="ds3">—</div><div class="sd" id="ds3s"></div></div>
```

Replace with:
```html
        <div class="sc"><div class="sl">Выручка за период</div><div class="sv" id="ds3">—</div><div class="sd" id="ds3s"></div><div class="rev-breakdown" id="ds3b"><div class="rev-row" id="rev-row-services"><span class="rev-lbl">Услуги</span><span class="rev-val" id="rev-services">—</span></div><div class="rev-row" id="rev-row-goods"><span class="rev-lbl">Косметика и товары</span><span class="rev-val" id="rev-goods">—</span></div><div class="rev-row" id="rev-row-abonement"><span class="rev-lbl">Абонементы</span><span class="rev-val" id="rev-abonement">—</span></div><div class="rev-row" id="rev-row-certificate"><span class="rev-lbl">Сертификаты</span><span class="rev-val" id="rev-certificate">—</span></div><div class="rev-row" id="rev-row-deposit"><span class="rev-lbl">Пополнения счёта</span><span class="rev-val" id="rev-deposit">—</span></div></div></div>
```

- [ ] **Step 2: Add CSS to frontend/css/base.css**

After the `.sd{...}` line (around line 75), add:

```css
.rev-breakdown{margin-top:10px;display:flex;flex-direction:column;gap:5px;border-top:1px solid var(--bd);padding-top:10px}
.rev-row{display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--t2)}
.rev-val{font-variant-numeric:tabular-nums;color:var(--t1);font-weight:600}
.rev-row.zero .rev-val{color:var(--t3);font-weight:400}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/index.html frontend/css/base.css
git commit -m "feat(frontend): add revenue breakdown markup and CSS to dashboard card"
```

---

## Task 10: Frontend — dashboard.js

**Files:**
- Modify: `frontend/js/pages/dashboard.js` (loadDashboard function, around lines 275–300)

- [ ] **Step 1: Update the revenue card rendering block**

Find the current revenue rendering block (around line 275–277):
```js
    const rev = parseFloat(s.periodRevenue || 0);
    animateCount(document.getElementById('ds3'), rev, { suffix: ' ₽' });
    document.getElementById('ds3s').textContent = periodSuffix + ' · ' + s.periodRecords + ' визитов';
```

Replace with:
```js
    const rbc = s.periodRevenueByCategory || {};
    const revTotal = parseFloat(rbc.total ?? s.periodRevenue ?? 0);
    animateCount(document.getElementById('ds3'), revTotal, { suffix: ' ₽' });
    document.getElementById('ds3s').textContent = periodSuffix + ' · ' + s.periodRecords + ' визитов';

    // Breakdown rows
    const revCats = ['services', 'goods', 'abonement', 'certificate', 'deposit'];
    for (const cat of revCats) {
      const val = parseFloat(rbc[cat] || 0);
      const valEl = document.getElementById('rev-' + cat);
      const rowEl = document.getElementById('rev-row-' + cat);
      if (!valEl || !rowEl) continue;
      animateCount(valEl, val, { suffix: ' ₽' });
      rowEl.classList.toggle('zero', val === 0);
    }
```

- [ ] **Step 2: Update avgCheck to use services revenue**

Find (around line 287):
```js
    const avgCheck = s.periodRecords > 0 ? Math.round(s.periodRevenue / s.periodRecords) : 0;
```

Replace with:
```js
    const servicesRev = parseFloat((s.periodRevenueByCategory || {}).services ?? s.periodRevenue ?? 0);
    const avgCheck = s.periodRecords > 0 ? Math.round(servicesRev / s.periodRecords) : 0;
```

- [ ] **Step 3: Commit**

```bash
git add frontend/js/pages/dashboard.js
git commit -m "feat(dashboard): render revenue breakdown by category; avgCheck uses services only"
```

---

## Task 11: Run Backfill and Verify

- [ ] **Step 1: Restart backend to apply migration**

```bash
pm2 restart loyalpro && sleep 3 && pm2 logs loyalpro --lines 20
```

Look for migration output (no errors about `revenue_operations`).

- [ ] **Step 2: Confirm table exists in DB**

Via `mcp__postgres__query`:
```sql
SELECT COUNT(*) FROM revenue_operations;
```
Expected: `0` (table empty, migration ran).

- [ ] **Step 3: Run webhook_logs backfill**

```bash
cd /root/loyalpro && node backend/scripts/backfill-revenue-from-webhook-logs.js
```

Expected output example:
```
Processing 804 finances_operation events from webhook_logs...
Done. Inserted: 785, Skipped/existing: 19, Errors: 0

Reconciliation (salon_id=1, 2026-03-21..2026-04-24):
  records.amount services:       XXXXX
  revenue_operations services:   XXXXX
  Difference: YYY (Z.Z%)
  ✓ Within 5% tolerance
```

If reconciliation shows >5% difference, query `revenue_operations` to inspect which category has unexpected totals:
```sql
SELECT category, COUNT(*), SUM(amount) FROM revenue_operations GROUP BY category ORDER BY sum DESC;
```

- [ ] **Step 4: Smoke test dashboard in browser**

Use Playwright (`mcp__playwright__browser_navigate`) to open the dashboard:
1. Navigate to `http://localhost:3001`
2. Log in (or inject JWT cookie)
3. Take screenshot — verify revenue card shows:
   - Large number (total)
   - 5 rows under it: Услуги, Косметика и товары, Абонементы, Сертификаты, Пополнения счёта
   - Rows with zero value appear greyed out (class `zero`)
4. Switch between period presets (Сегодня / Неделя / Месяц) — verify numbers update

- [ ] **Step 5: Final commit + push to prod**

All tests pass, smoke test passes:

```bash
cd backend && npx jest revenue-classify --no-coverage
```

Then deploy to prod:
```bash
git push origin main
# SSH to prod: stash CORS debug, pull, pop, restart
ssh root@217.114.0.254 "cd /root/loyalpro_new && git stash push -m 'cors-debug' backend/server.js && git pull origin main && git stash pop && pm2 restart loyalpro"
# Run backfill on prod (inherits pm2 env which already has DATABASE_URL):
ssh root@217.114.0.254 "cd /root/loyalpro_new && node backend/scripts/backfill-revenue-from-webhook-logs.js"
```

---

## Post-Backfill: YClients API Deep History (Optional, separate run)

After verifying the above works, run the deep backfill for 2025 history. Do this in a tmux/screen session since it may take 30–60 minutes:

```bash
# On prod server:
node backend/scripts/backfill-revenue-from-yclients.js \
  --salon-id 1 --from 2025-01-01 --to 2026-03-20 --rate-limit-ms 400
```

If the endpoint returns 404, try alternative paths (see note in `ycListFinanceTransactions`). Check response with a single-page test first:

```bash
node -e "
const yclients = require('./backend/services/yclients');
const { db, pool } = require('./backend/db');
db.one('SELECT * FROM salons WHERE id=1').then(salon =>
  yclients.ycListFinanceTransactions(salon, {dateFrom:'2025-12-01',dateTo:'2025-12-31',page:1,count:3})
).then(rows => { console.log(JSON.stringify(rows[0], null, 2)); pool.end(); })
.catch(e => { console.error(e.message); pool.end(); });
"
```

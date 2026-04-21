# Logging System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all `console.log/error/warn` in the backend with Winston structured logging, writing human-readable lines to console + `logs/app.log` + `logs/error.log` with daily rotation.

**Architecture:** Central `backend/logger.js` exports a `createLogger(module)` factory. Each backend file calls it once at the top and gets a named logger. No test framework is installed — verification is by running the server and inspecting log output.

**Tech Stack:** Node.js, Winston ^3, winston-daily-rotate-file ^5

---

### Task 1: Install dependencies

**Files:**
- Modify: `backend/package.json`

- [ ] **Step 1: Install Winston packages**

```bash
cd backend && npm install winston winston-daily-rotate-file
```

Expected output: packages added, no errors.

- [ ] **Step 2: Commit**

```bash
git add backend/package.json backend/package-lock.json
git commit -m "chore: install winston and winston-daily-rotate-file"
```

---

### Task 2: Create central logger module

**Files:**
- Create: `backend/logger.js`

- [ ] **Step 1: Create `backend/logger.js`**

```js
const winston = require('winston');
require('winston-daily-rotate-file');
const path = require('path');

const { combine, timestamp, printf, colorize, errors } = winston.format;

const logsDir = path.join(__dirname, 'logs');

const lineFormat = printf(({ level, message, timestamp, module, stack }) => {
  const mod = module ? `[${module}]` : '';
  const msg = stack || message;
  return `${timestamp} [${level.toUpperCase().padEnd(5)}] ${mod} ${msg}`;
});

const fileTransportOptions = (filename, level) => ({
  filename: path.join(logsDir, filename),
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '14d',
  level,
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    errors({ stack: true }),
    lineFormat
  ),
});

const sharedTransports = [
  new winston.transports.Console({
    format: combine(
      colorize({ level: true }),
      timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      errors({ stack: true }),
      lineFormat
    ),
  }),
  new winston.transports.DailyRotateFile(fileTransportOptions('app-%DATE%.log', 'info')),
  new winston.transports.DailyRotateFile(fileTransportOptions('error-%DATE%.log', 'error')),
];

function createLogger(module) {
  return winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    defaultMeta: { module },
    transports: sharedTransports,
  });
}

module.exports = { createLogger };
```

- [ ] **Step 2: Add `logs/` to .gitignore**

Open `backend/.gitignore` (or root `.gitignore`) and add:
```
logs/
```

- [ ] **Step 3: Verify the logger works manually**

Create a temporary `backend/test-logger.js`:
```js
const { createLogger } = require('./logger');
const logger = createLogger('Test');
logger.info('Hello from logger');
logger.warn('This is a warning');
logger.error('This is an error');
```

Run:
```bash
cd backend && node test-logger.js
```

Expected: three lines printed to console with timestamps and level tags. A `logs/` directory created with `app-*.log` containing all three lines, and `error-*.log` containing only the error line.

- [ ] **Step 4: Delete test file and commit**

```bash
rm backend/test-logger.js
git add backend/logger.js backend/.gitignore
git commit -m "feat: add central Winston logger factory"
```

---

### Task 3: Replace console calls in `backend/server.js`

**Files:**
- Modify: `backend/server.js`

- [ ] **Step 1: Add logger import at top of file**

After the existing `require` block, add:
```js
const { createLogger } = require('./logger');
const logger = createLogger('Server');
const cronLogger = createLogger('Cron');
```

- [ ] **Step 2: Replace all console calls**

Replace each occurrence:

| Old | New |
|-----|-----|
| `console.log('[Cron] Birthday bonuses...')` | `cronLogger.info('Birthday bonuses...')` |
| `console.log(\`[Birthday] ${c.name} +${bonus}\`)` | `cronLogger.info(\`Birthday: ${c.name} +${bonus}\`)` |
| `console.error('[Cron birthday]', e.message)` | `cronLogger.error(\`Birthday cron: ${e.message}\`)` |
| `console.log('[Cron] Auto-sync...')` | `cronLogger.info('Auto-sync...')` |
| `console.error(\`[AutoSync ${salon.id}]\`, e.message)` | `cronLogger.error(\`AutoSync salon=${salon.id}: ${e.message}\`)` |
| `console.error(\`[GoodsCatSync ${salon.id}]\`, e.message)` | `cronLogger.error(\`GoodsCatSync salon=${salon.id}: ${e.message}\`)` |
| `console.error(\`[StaffSync cron ${salon.id}]\`, e.message)` | `cronLogger.error(\`StaffSync salon=${salon.id}: ${e.message}\`)` |
| `console.error('[StaffSync cron]', e.message)` | `cronLogger.error(\`StaffSync cron: ${e.message}\`)` |
| `console.error(\`[Segments cron ${s.id}]\`, e.message)` | `cronLogger.error(\`Segments cron salon=${s.id}: ${e.message}\`)` |
| `console.error('[Segments cron]', e.message)` | `cronLogger.error(\`Segments cron: ${e.message}\`)` |
| `console.log(\`✓ LoyalPro server running on port ${PORT}\`)` | `logger.info(\`Server running on port ${PORT}\`)` |
| `console.log(\`  Webhook: ...\`)` | `logger.info('Webhook: POST /yclients/webhook.v2/:companyId')` |
| `console.log(\`  Register: ...\`)` | `logger.info('Register: POST /api/auth/register')` |
| `console.error('✗ PostgreSQL error:', e.message)` | `logger.error(\`PostgreSQL error: ${e.message}\`)` |
| `console.log(\`⚠ Server started WITHOUT DB on port ${PORT}\`)` | `logger.warn(\`Server started WITHOUT DB on port ${PORT}\`)` |

- [ ] **Step 3: Commit**

```bash
git add backend/server.js
git commit -m "feat(logging): migrate server.js to Winston"
```

---

### Task 4: Replace console calls in `backend/services/loyalty.js`

**Files:**
- Modify: `backend/services/loyalty.js`

- [ ] **Step 1: Add logger import**

At the top of `loyalty.js` after existing requires:
```js
const { createLogger } = require('../logger');
const logger = createLogger('Sync');
```

- [ ] **Step 2: Replace all console calls**

Replace every `console.log(` → `logger.info(` and `console.error(` → `logger.error(`, removing the `[Sync]` prefix from message strings since the module label handles it automatically.

Examples:
- `console.log('[Sync] ── Step 1: ...')` → `logger.info('── Step 1: Fetching ALL records...')`
- `console.error('[processRecord]', e.message)` → `logger.error(\`processRecord: ${e.message}\`)`
- `console.log(\`[Sync] 429 rate limit, waiting 10s...\`)` → `logger.warn('429 rate limit, waiting 10s...')`

Apply the same pattern to ALL `console.*` calls in the file. Use `logger.warn` for rate limit / retry situations, `logger.error` for caught exceptions, `logger.info` for progress logs.

- [ ] **Step 3: Commit**

```bash
git add backend/services/loyalty.js
git commit -m "feat(logging): migrate loyalty.js (Sync) to Winston"
```

---

### Task 5: Replace console calls in `backend/services/yclients.js`

**Files:**
- Modify: `backend/services/yclients.js`

- [ ] **Step 1: Add logger import**

```js
const { createLogger } = require('../logger');
const logger = createLogger('YClients');
```

- [ ] **Step 2: Replace all console calls**

Remove `[Cards]`, `[WebLogin]`, `[WebTxns]` prefixes from message strings — the `[YClients]` label covers the module. Use `logger.warn` for warning-level messages (existing `console.warn`), `logger.error` for errors, `logger.info` for the rest.

- [ ] **Step 3: Commit**

```bash
git add backend/services/yclients.js
git commit -m "feat(logging): migrate yclients.js to Winston"
```

---

### Task 6: Replace console calls in `backend/services/staff.js`

**Files:**
- Modify: `backend/services/staff.js`

- [ ] **Step 1: Add logger import**

```js
const { createLogger } = require('../logger');
const logger = createLogger('Staff');
```

- [ ] **Step 2: Replace all console calls**

Remove `[StaffSync]`, `[GoodsSync]` prefixes. Replace `console.log` → `logger.info`, `console.error` → `logger.error`.

- [ ] **Step 3: Commit**

```bash
git add backend/services/staff.js
git commit -m "feat(logging): migrate staff.js to Winston"
```

---

### Task 7: Replace console calls in `backend/services/telegram.js` and `backend/services/sms.js`

**Files:**
- Modify: `backend/services/telegram.js`
- Modify: `backend/services/sms.js`

- [ ] **Step 1: Add logger to telegram.js**

```js
const { createLogger } = require('../logger');
const logger = createLogger('Telegram');
```

Replace `console.log` → `logger.info`, `console.warn` → `logger.warn`, `console.error` → `logger.error`. Remove `[Telegram]` prefixes from strings.

- [ ] **Step 2: Add logger to sms.js**

```js
const { createLogger } = require('../logger');
const logger = createLogger('SMS');
```

Replace `console.log` → `logger.info`, `console.warn` → `logger.warn`, `console.error` → `logger.error`. Remove `[SMS]` prefixes from strings.

- [ ] **Step 3: Commit**

```bash
git add backend/services/telegram.js backend/services/sms.js
git commit -m "feat(logging): migrate telegram.js and sms.js to Winston"
```

---

### Task 8: Replace console calls in routes

**Files:**
- Modify: `backend/routes/api.js`
- Modify: `backend/routes/salon.js`
- Modify: `backend/routes/mobile-client.js`
- Modify: `backend/routes/webhook.js`

- [ ] **Step 1: Add logger to `routes/api.js`**

```js
const { createLogger } = require('../logger');
const logger = createLogger('API');
```

Replace `console.error('[Sync]', e.message)` → `logger.error(\`Sync trigger: ${e.message}\`)`.

- [ ] **Step 2: Add logger to `routes/salon.js`**

```js
const { createLogger } = require('../logger');
const logger = createLogger('Salon');
```

Replace all `console.error` with `logger.error`. Remove `[YC Auth error]` etc. prefixes.

- [ ] **Step 3: Add logger to `routes/mobile-client.js`**

```js
const { createLogger } = require('../logger');
const logger = createLogger('Mobile');
```

Replace all `console.error` with `logger.error`. Remove bracket prefixes like `[Get profile error]` from strings.

- [ ] **Step 4: Add logger to `routes/webhook.js`**

```js
const { createLogger } = require('../logger');
const logger = createLogger('Webhook');
```

Replace `console.log` → `logger.info`, `console.warn` → `logger.warn`, `console.error` → `logger.error`. Remove `[WH]` prefixes.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/api.js backend/routes/salon.js backend/routes/mobile-client.js backend/routes/webhook.js
git commit -m "feat(logging): migrate all routes to Winston"
```

---

### Task 9: Final verification

- [ ] **Step 1: Start the backend server**

```bash
cd backend && node server.js
```

Expected console output:
```
2026-04-20 14:32:11 [INFO ] [Server] Server running on port 3000
```

No bare `console.log` output should appear (no lines without timestamp/level).

- [ ] **Step 2: Verify log files are created**

```bash
ls backend/logs/
```

Expected: `app-2026-04-20.log` and `error-2026-04-20.log` present.

- [ ] **Step 3: Check app.log content**

```bash
tail -20 backend/logs/app-$(date +%Y-%m-%d).log
```

Expected: lines with `YYYY-MM-DD HH:mm:ss [INFO ] [Module] message` format.

- [ ] **Step 4: Verify error.log only has errors**

```bash
cat backend/logs/error-$(date +%Y-%m-%d).log
```

Expected: only lines with `[ERROR]` level.

- [ ] **Step 5: Scan for remaining console calls**

```bash
grep -rn "console\." backend/server.js backend/routes/ backend/services/ --include="*.js"
```

Expected: no output (all replaced).

- [ ] **Step 6: Final commit**

```bash
git add .
git commit -m "feat: complete Winston logging system implementation"
```

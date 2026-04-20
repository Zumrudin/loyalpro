# User Position Field Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a free-text `position` (должность) field to users, and display it in the home-care module (list, preview, PDF, mobile) instead of the system role.

**Architecture:** Single DB column `position VARCHAR(100)` on `users`. Backend routes expose it via existing REST endpoints. Frontend users page shows and edits it; home-care pages display it next to/under the specialist name.

**Tech Stack:** PostgreSQL, Node.js/Express (pg-promise), vanilla JS frontend, Puppeteer PDF rendering.

---

## Files

| File | Change |
|---|---|
| `backend/routes/users.js` | Add `position` to SELECT, INSERT, PATCH |
| `backend/routes/home-care.js` | Add `u.position as specialist_position` to 4 queries |
| `backend/homecare-template.js` | Add `specialist_position` to footer sign |
| `backend/routes/mobile-client.js` | Add `u.position as "specialistPosition"` to 2 queries |
| `frontend/js/pages/users.js` | Add position column in table + input in modal |

---

### Task 1: DB migration — add `position` column

**Files:**
- Modify: `server.js` (find the DB init/migration block)

- [ ] **Step 1: Find where DB migrations run in server.js**

```bash
grep -n "CREATE TABLE\|ALTER TABLE\|initDb\|migrate" /root/loyalpro/server.js | head -20
```

- [ ] **Step 2: Add migration after the existing ALTER TABLE statements**

Find the block where `ALTER TABLE` migrations run (look for pattern like `await db.query('ALTER TABLE ...')`). Add:

```js
await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS position VARCHAR(100)`);
```

- [ ] **Step 3: Restart server and verify column exists**

```bash
cd /root/loyalpro && node -e "
  const {db} = require('./backend/db');
  db.one('SELECT column_name FROM information_schema.columns WHERE table_name=\\'users\\' AND column_name=\\'position\\'')
    .then(r => { console.log('OK:', r); process.exit(0); })
    .catch(e => { console.error('FAIL:', e.message); process.exit(1); });
"
```
Expected: `OK: { column_name: 'position' }`

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: add position column to users table"
```

---

### Task 2: Backend — expose `position` in users API

**Files:**
- Modify: `backend/routes/users.js`

- [ ] **Step 1: Update GET `/` — add `u.position` to SELECT**

In `backend/routes/users.js` line 9, change:
```js
      `SELECT u.id,u.name,u.email,u.role,u.is_active,u.must_change_password,
              u.created_at,u.last_login_at
       FROM users u WHERE u.salon_id=$1 ORDER BY u.created_at`,
```
to:
```js
      `SELECT u.id,u.name,u.email,u.role,u.position,u.is_active,u.must_change_password,
              u.created_at,u.last_login_at
       FROM users u WHERE u.salon_id=$1 ORDER BY u.created_at`,
```

- [ ] **Step 2: Update POST `/` — accept and insert `position`**

Line 22, change:
```js
    const { name, email, role, password } = req.body;
```
to:
```js
    const { name, email, role, password, position } = req.body;
```

Line 39-41, change:
```js
      `INSERT INTO users (salon_id,email,password_hash,name,role,is_active,must_change_password,created_by)
       VALUES ($1,$2,$3,$4,$5,TRUE,TRUE,$6) RETURNING id,name,email,role,is_active,must_change_password,created_at`,
      [req.user.salonId, email.toLowerCase().trim(), hash, name, role, req.user.userId]
```
to:
```js
      `INSERT INTO users (salon_id,email,password_hash,name,role,position,is_active,must_change_password,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,TRUE,TRUE,$7) RETURNING id,name,email,role,position,is_active,must_change_password,created_at`,
      [req.user.salonId, email.toLowerCase().trim(), hash, name, role, position||null, req.user.userId]
```

- [ ] **Step 3: Update PATCH `/:id` — accept and update `position`**

Line 53, change:
```js
    const { name, role, is_active, password } = req.body;
```
to:
```js
    const { name, role, position, is_active, password } = req.body;
```

After line 67 (`if (is_active !== undefined) ...`), add:
```js
    if (position !== undefined) { updates.push(`position=$${i++}`); vals.push(position || null); }
```

Line 79, change:
```js
       RETURNING id,name,email,role,is_active,must_change_password`,
```
to:
```js
       RETURNING id,name,email,role,position,is_active,must_change_password`,
```

- [ ] **Step 4: Smoke-test the endpoint**

```bash
curl -s http://localhost:3000/api/users \
  -H "Authorization: Bearer $(node -e "const jwt=require('jsonwebtoken');const c=require('./backend/config');console.log(jwt.sign({userId:1,salonId:1,role:'owner'},c.JWT_SECRET))")" \
  | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');const u=JSON.parse(d).users[0];console.log('position key present:',Object.hasOwn(u,'position'))"
```
Expected: `position key present: true`

- [ ] **Step 5: Commit**

```bash
git add backend/routes/users.js
git commit -m "feat: expose position field in users API (GET/POST/PATCH)"
```

---

### Task 3: Backend — add `specialist_position` to home-care queries

**Files:**
- Modify: `backend/routes/home-care.js`

- [ ] **Step 1: Update GET `/` (list) — line 210**

Change:
```js
              u.name as specialist_name
```
to:
```js
              u.name as specialist_name, u.position as specialist_position
```

- [ ] **Step 2: Update GET `/:id/preview` — line 230**

Change:
```js
      `SELECT p.*, c.name as client_name, c.phone as client_phone, u.name as specialist_name, s.name as salon_name
       FROM home_care_prescriptions p LEFT JOIN clients c ON c.id=p.client_id
       LEFT JOIN users u ON u.id=p.specialist_id LEFT JOIN salons s ON s.id=p.salon_id
       WHERE p.id=$1 AND p.salon_id=$2`,
```
to:
```js
      `SELECT p.*, c.name as client_name, c.phone as client_phone, u.name as specialist_name, u.position as specialist_position, s.name as salon_name
       FROM home_care_prescriptions p LEFT JOIN clients c ON c.id=p.client_id
       LEFT JOIN users u ON u.id=p.specialist_id LEFT JOIN salons s ON s.id=p.salon_id
       WHERE p.id=$1 AND p.salon_id=$2`,
```

- [ ] **Step 3: Update GET `/:id/pdf` — line 247**

Same replacement as Step 2 but at line 247:
```js
      `SELECT p.*, c.name as client_name, c.phone as client_phone, u.name as specialist_name, u.position as specialist_position, s.name as salon_name
       FROM home_care_prescriptions p LEFT JOIN clients c ON c.id=p.client_id
       LEFT JOIN users u ON u.id=p.specialist_id LEFT JOIN salons s ON s.id=p.salon_id
       WHERE p.id=$1 AND p.salon_id=$2`,
```

- [ ] **Step 4: Update GET `/:id` — line 278**

Same replacement at line 278:
```js
      `SELECT p.*, c.name as client_name, c.phone as client_phone, u.name as specialist_name, u.position as specialist_position, s.name as salon_name
       FROM home_care_prescriptions p LEFT JOIN clients c ON c.id=p.client_id
       LEFT JOIN users u ON u.id=p.specialist_id LEFT JOIN salons s ON s.id=p.salon_id
       WHERE p.id=$1 AND p.salon_id=$2`,
```

- [ ] **Step 5: Commit**

```bash
git add backend/routes/home-care.js
git commit -m "feat: include specialist_position in home-care prescription queries"
```

---

### Task 4: Backend — add `specialistPosition` to mobile prescriptions API

**Files:**
- Modify: `backend/routes/mobile-client.js`

- [ ] **Step 1: Update GET `/prescriptions` — around line 387**

Change:
```js
        u.name as "specialistName",
        u.role as "specialistRole",
```
to:
```js
        u.name as "specialistName",
        u.position as "specialistPosition",
```

And update `GROUP BY` on line ~395:
```js
       GROUP BY p.id, u.name, u.role
```
to:
```js
       GROUP BY p.id, u.name, u.position
```

- [ ] **Step 2: Update GET `/prescriptions/:id` — around line 417**

Change:
```js
        u.name as "specialistName",
        u.role as "specialistRole"
```
to:
```js
        u.name as "specialistName",
        u.position as "specialistPosition"
```

- [ ] **Step 3: Commit**

```bash
git add backend/routes/mobile-client.js
git commit -m "feat: return specialistPosition instead of specialistRole in mobile prescriptions API"
```

---

### Task 5: Template — show position in PDF/preview footer

**Files:**
- Modify: `backend/homecare-template.js`

- [ ] **Step 1: Extract `specialist_position` alongside `specialist_name` — around line 134**

Change:
```js
  const specialist  = escHtml(prescription.specialist_name || '');
```
to:
```js
  const specialist         = escHtml(prescription.specialist_name || '');
  const specialistPosition = escHtml(prescription.specialist_position || '');
```

- [ ] **Step 2: Update the footer sign — around line 571**

Change:
```js
        Специалист: ${escHtml(specialist || '—')}
```
to:
```js
        Специалист: ${specialist || '—'}${specialistPosition ? ` <span style="font-size:10px;opacity:0.75">(${specialistPosition})</span>` : ''}
```

- [ ] **Step 3: Verify preview renders without error**

```bash
curl -s "http://localhost:3000/api/home-care/1/preview" \
  -H "Authorization: Bearer $(node -e "const jwt=require('jsonwebtoken');const c=require('./backend/config');console.log(jwt.sign({userId:1,salonId:1,role:'owner'},c.JWT_SECRET))")" \
  | grep -c "Специалист"
```
Expected: output `1` (or more, meaning the footer rendered)

- [ ] **Step 4: Commit**

```bash
git add backend/homecare-template.js
git commit -m "feat: show specialist position in home-care PDF/preview footer"
```

---

### Task 6: Frontend — add position to users table and modal

**Files:**
- Modify: `frontend/js/pages/users.js`

- [ ] **Step 1: Add «Должность» column in `renderUsers` table row — around line 21**

In the `users.map(u => ...)` template, after the name `<td>` and before the role `<td>`, insert:
```js
      <td style="color:var(--t2)">${esc(u.position || '—')}</td>
```

The full row becomes:
```js
  tbody.innerHTML = users.map(u => `
    <tr style="${u.is_active ? '' : 'opacity:.5'}">
      <td><b>${esc(u.name)}</b>${u.must_change_password ? ' <span style="font-size:11px;color:#92400e;background:#fffbeb;padding:1px 6px;border-radius:4px;border:1px solid #fde68a">Не активирован</span>' : ''}</td>
      <td style="color:var(--t3)">${esc(u.email)}</td>
      <td style="color:var(--t2)">${esc(u.position || '—')}</td>
      <td><span style="font-size:11.5px;font-weight:600;color:${ROLE_COLOR[u.role]||'#333'};background:${ROLE_BG[u.role]||'#f3f4f6'};padding:2px 8px;border-radius:4px">${ROLE_LABEL[u.role]||u.role}</span></td>
      <td>${u.is_active ? '<span style="color:#059669">Активен</span>' : '<span style="color:var(--t3)">Отключён</span>'}</td>
      <td style="color:var(--t3);font-size:12px">${u.last_login_at ? new Date(u.last_login_at).toLocaleDateString('ru') : '—'}</td>
      <td style="text-align:right">
        <button class="btn btn-sec btn-sm" onclick="usersOpenEdit(${u.id})">Изменить</button>
        ${u.is_active && u.role!=='owner' ? `<button class="btn btn-sm" style="color:var(--danger);border:1px solid var(--bd);margin-left:4px" onclick="usersDeactivate(${u.id},'${esc(u.name)}')">Отключить</button>` : ''}
      </td>
    </tr>
  `).join('');
```

Also update the empty-state colspan from `6` to `7`:
```js
  if (!users.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty">Нет пользователей</td></tr>'; return; }
```

- [ ] **Step 2: Add «Должность» input in `usersShowModal` — after the Email field (around line 58)**

After the email `<div class="fg">`, add:
```js
        <div class="fg"><label class="fl">Должность <span class="fh">необязательно</span></label><input type="text" id="umPosition" value="${esc(u.position||'')}" placeholder="Косметолог, Трихолог…"></div>
```

- [ ] **Step 3: Read and send `position` in `usersSave` — around line 99**

After `const role = ...`, add:
```js
  const position = document.getElementById('umPosition')?.value.trim() || null;
```

In the `isNew` branch (line 105), change:
```js
      await api('POST', '/api/users', { name, email, role, password: pw });
```
to:
```js
      await api('POST', '/api/users', { name, email, role, position, password: pw });
```

In the `else` branch, change:
```js
      const body = { name, role };
```
to:
```js
      const body = { name, role, position };
```

- [ ] **Step 4: Find the HTML table header for users and add «Должность» column**

```bash
grep -rn "Имя\|Email\|Роль\|Статус\|thead\|<th" /root/loyalpro/frontend/ --include="*.html" | grep -i "users\|пользовател" | head -10
```

Find the `<thead>` row and add `<th>Должность</th>` between Email and Роль columns.

- [ ] **Step 5: Commit**

```bash
git add frontend/js/pages/users.js
git commit -m "feat: add position field to users management UI"
```

---

### Task 7: Frontend — show `specialist_position` in home-care list

**Files:**
- Modify: `frontend/js/pages/home-care.js`

- [ ] **Step 1: Update specialist cell in `hcFetch` — around line 35**

Change:
```js
          <td style="color:var(--t2)">${esc(r.specialist_name || '—')}</td>
```
to:
```js
          <td style="color:var(--t2)">${esc(r.specialist_name || '—')}${r.specialist_position ? `<br><span style="font-size:11px;color:var(--t3)">${esc(r.specialist_position)}</span>` : ''}</td>
```

- [ ] **Step 2: Commit**

```bash
git add frontend/js/pages/home-care.js
git commit -m "feat: show specialist position under name in home-care list"
```

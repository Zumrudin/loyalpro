# De-escalation агента Мила — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Мила при негативе клиента сначала пытается спасти диалог (извинение + уточнение), переводит на администратора только при неудаче/явной просьбе, и делает это НЕ молча.

**Architecture:** Два точечных изменения в рантайме агента + оживление застрявшего диалога. (1) Переписать «Сценарий 3» системного промпта в двухшаговый флоу. (2) Починить `dispatcher.js`, чтобы сообщение хода эскалации доставлялось клиенту (сейчас выбрасывается), со страховкой от пустого текста. (3) Разовый сброс диалога #37 из `escalated` в `bot`.

**Tech Stack:** Node.js, Jest (`agent-*.test.js` в `backend/`), PostgreSQL (`agent_dialogs`).

**Спека:** `docs/superpowers/specs/2026-07-19-agent-deescalation-design.md`

---

## File Structure

- `backend/services/agent/dispatcher.js` — доставка реплик; добавляем константу `DEFAULT_HANDOVER_TEXT` и меняем блок доставки (строки ~49–55).
- `backend/agent-dispatcher.test.js` — обновляем устаревший тест `I2` и добавляем кейс страховки.
- `backend/services/agent/system-prompt.js` — переписываем Сценарий 3 (строки ~61–63).
- `backend/agent-system-prompt.test.js` — добавляем проверки двухшагового флоу.
- Операционный SQL по `agent_dialogs` id=37 — вне кода.

Тесты гоняются через Jest: `cd backend && npx jest <file>`.

---

## Task 1: Dispatcher доставляет сообщение хода эскалации

**Files:**
- Modify: `backend/services/agent/dispatcher.js` (строки ~49–55, и константа после require-блока)
- Test: `backend/agent-dispatcher.test.js` (заменить тест на строках 61–67, добавить новый)

- [ ] **Step 1: Обновить устаревший тест и добавить кейс страховки (падающие)**

В `backend/agent-dispatcher.test.js` ЗАМЕНИТЬ существующий тест (текущие строки 61–67):

```js
test('эскалация → реплики не отправляются, бот молчит (I2)', async () => {
  const d = deps({ orchestrator: { runDialog: jest.fn(async () => ({ replies: ['секунду, зову оператора'], escalated: true })) } });
  dispatcher.enqueue(1, 'k', meta, d);
  await jest.advanceTimersByTimeAsync(1000);
  expect(d.orchestrator.runDialog).toHaveBeenCalledTimes(1);
  expect(d.send).not.toHaveBeenCalled();
});
```

на два теста нового поведения:

```js
test('эскалация с текстом → объявление о переводе доставляется (де-эскалация)', async () => {
  const d = deps({ orchestrator: { runDialog: jest.fn(async () => ({ replies: ['Передаю вас администратору 🤍'], escalated: true })) } });
  dispatcher.enqueue(1, 'k', meta, d);
  await jest.advanceTimersByTimeAsync(1000);
  expect(d.orchestrator.runDialog).toHaveBeenCalledTimes(1);
  expect(d.send).toHaveBeenCalledTimes(1);
  expect(d.send).toHaveBeenCalledWith(meta, 'Передаю вас администратору 🤍');
});

test('эскалация без текста → дефолтная фраза перевода (страховка от молчания)', async () => {
  const d = deps({ orchestrator: { runDialog: jest.fn(async () => ({ replies: [], escalated: true })) } });
  dispatcher.enqueue(1, 'k', meta, d);
  await jest.advanceTimersByTimeAsync(1000);
  expect(d.send).toHaveBeenCalledTimes(1);
  expect(d.send).toHaveBeenCalledWith(meta, expect.stringContaining('администратор'));
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `cd backend && npx jest agent-dispatcher.test.js -t эскалация`
Expected: FAIL — первый новый тест ждёт `send`, но текущий код при `escalated` ничего не шлёт.

- [ ] **Step 3: Реализовать доставку в dispatcher**

В `backend/services/agent/dispatcher.js` добавить константу сразу после блока `require`/`logger` (около строки 8):

```js
// Фраза-страховка, если модель эскалировала, не написав объявления о переводе.
const DEFAULT_HANDOVER_TEXT =
  'Передаю ваш диалог администратору клиники — он подключится с минуты на минуту 🤍';
```

Заменить блок в `process` (текущие строки 48–55):

```js
      const res = await orchestrator.runDialog(salonId, dialogKey, { ctx: { phone: meta.phone } });
      // При эскалации бот замолкает: не отправляем реплики, даже если модель что-то написала
      // в том же ходе перед вызовом escalate_to_operator.
      if (!res.escalated) {
        for (const text of (res.replies || [])) {
          if (text && text.trim()) await send(meta, text);
        }
      }
```

на:

```js
      const res = await orchestrator.runDialog(salonId, dialogKey, { ctx: { phone: meta.phone } });
      // Доставляем реплики, в т.ч. на ходе эскалации — это явное объявление о переводе.
      // Инвариант: при эскалации клиент никогда не остаётся без сообщения.
      const replies = (res.replies || []).filter((t) => t && t.trim());
      if (res.escalated && replies.length === 0) {
        await send(meta, DEFAULT_HANDOVER_TEXT);
      } else {
        for (const text of replies) await send(meta, text);
      }
```

- [ ] **Step 4: Запустить тесты — убедиться, что проходят**

Run: `cd backend && npx jest agent-dispatcher.test.js`
Expected: PASS — все тесты файла зелёные (в т.ч. «несколько реплик по очереди», «гейт запретил» не сломаны).

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro
git add backend/services/agent/dispatcher.js backend/agent-dispatcher.test.js
git commit -m "fix(agent): доставлять сообщение при эскалации — не молчать

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Двухшаговый Сценарий 3 в системном промпте

**Files:**
- Modify: `backend/services/agent/system-prompt.js` (строки ~61–63)
- Test: `backend/agent-system-prompt.test.js`

- [ ] **Step 1: Добавить проверки двухшагового флоу (падающие)**

В `backend/agent-system-prompt.test.js` внутри `describe('buildSystemPrompt', …)` добавить тест:

```js
  test('Сценарий 3 — двухшаговая де-эскалация: спасти диалог, затем явный перевод', () => {
    const p = buildSystemPrompt({});
    expect(p).toContain('ШАГ А');
    expect(p).toContain('ШАГ Б');
    expect(p).toMatch(/извин/i);             // сначала извиниться
    expect(p).toMatch(/НИКОГДА не замолк/i); // запрет уходить в тишину
  });
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `cd backend && npx jest agent-system-prompt.test.js -t "двухшаговая"`
Expected: FAIL — в текущем промпте нет «ШАГ А» / «ШАГ Б».

- [ ] **Step 3: Переписать Сценарий 3**

В `backend/services/agent/system-prompt.js` заменить три строки массива (текущие 61–63):

```js
    `СЦЕНАРИЙ 3 — Перевод на человека (эскалация):`,
    `Если возникла нетипичная ситуация, сложный вопрос, конфликт, жалоба или нужно передать диалог человеку — вызови escalate_to_operator и отправь строго этот текст, больше ничего не пиши:`,
    `«Отличный вопрос! Чтобы дать вам максимально точную информацию, я сейчас переключу вас на администратора в клинике. Он подключится к диалогу с минуты на минуту ✨»`,
```

на:

```js
    `СЦЕНАРИЙ 3 — Недовольство, конфликт или перевод на человека:`,
    `Действуй в два шага и НИКОГДА не замолкай.`,
    ``,
    `ШАГ А — Сначала попробуй спасти диалог (по умолчанию при негативе):`,
    `Если пациент недоволен, раздражён, критикует тебя или легко жалуется — искренне извинись, спокойно и доброжелательно уточни, что именно пошло не так или что не понравилось, и предложи помочь ещё раз. Не спорь и не оправдывайся. Одно уточнение за сообщение.`,
    ``,
    `ШАГ Б — Явный перевод на администратора:`,
    `Переходи к переводу, только если: (1) пациент прямо просит человека; ИЛИ (2) после твоей попытки недовольство сохраняется; ИЛИ (3) серьёзная жалоба, конфликт или нестандартная ситуация, которую ты не решаешь сама; ИЛИ (4) сложный вопрос или база знаний не дала ответа.`,
    `Тогда вызови escalate_to_operator и в ЭТОМ ЖЕ сообщении живым текстом явно объяви о переводе, например: «Мне жаль, что так вышло. Передаю ваш диалог администратору клиники — он подключится с минуты на минуту и поможет вам лично 🤍». Больше ничего не пиши.`,
```

- [ ] **Step 4: Запустить тесты — убедиться, что проходят**

Run: `cd backend && npx jest agent-system-prompt.test.js`
Expected: PASS — новый тест зелёный; существующий «описывает правило эскалации» (`toContain('escalate_to_operator')`) не сломан.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro
git add backend/services/agent/system-prompt.js backend/agent-system-prompt.test.js
git commit -m "feat(agent): Сценарий 3 — сначала спасти диалог, потом явный перевод

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Оживить застрявший диалог #37 (операционно)

Диалог пользователя (`dialog_key = 79200255591`, id 37, salon_id 1) сейчас
`escalated` → Мила молчит. Вернуть в `bot`. Это ручной шаг против живой БД, не код.

- [ ] **Step 1: Проверить текущий статус (read-only, через MCP postgres)**

```sql
SELECT id, dialog_key, status, escalated_reason FROM agent_dialogs WHERE id = 37;
```
Expected: `status = 'escalated'`.

- [ ] **Step 2: Сбросить в `bot`**

```sql
UPDATE agent_dialogs SET status = 'bot', escalated_reason = NULL, updated_at = now()
WHERE id = 37;
```
Примечание: MCP postgres — read-only, поэтому UPDATE выполняем через writable-подключение
к той же БД (deploy/psql-доступ). Мила снова отвечает в этом чате.

- [ ] **Step 3: Подтвердить сброс**

```sql
SELECT id, status FROM agent_dialogs WHERE id = 37;
```
Expected: `status = 'bot'`.

---

## Финальная проверка

- [ ] `cd backend && npx jest agent-dispatcher.test.js agent-system-prompt.test.js` — всё зелёное.
- [ ] Перезапуск рантайма, чтобы промпт/диспетчер подхватились: `pm2 restart loyalpro`.
- [ ] Ручной прогон на dev: написать боту негатив («ты не помогаешь») → ожидать извинение + уточнение (не тишину); затем «позовите человека» → ожидать явную фразу перевода и переход диалога в `escalated`.

---

## Self-review (выполнено при написании плана)

- **Покрытие спеки:** Сценарий 3 (Task 2), фикс доставки + страховка (Task 1), сброс #37 (Task 3), тесты (Task 1–2). Инвариант «после escalated молчим» — не трогаем (`orchestrator.js:32`), как в спеке.
- **Плейсхолдеры:** нет — весь код и SQL приведены дословно.
- **Согласованность:** `DEFAULT_HANDOVER_TEXT` содержит «администратору» → тест `stringContaining('администратор')` проходит; промпт содержит «НИКОГДА не замолкай» → regex `/НИКОГДА не замолк/i` и «извинись» → `/извин/i` совпадают.

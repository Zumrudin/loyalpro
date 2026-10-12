// Из выгрузки диалогов собирает пары «вопрос клиента → ответ клиники»
// (подряд идущие реплики одной стороны склеиваются в один блок).
const fs = require('fs');
const path = require('path');

const dialogs = require(path.join(__dirname, '..', '..', 'exports', 'chat_history_dialogs.json'));
const OUT = path.join(__dirname, '..', '..', 'exports');

const LINE_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] ([^:]+): ([\s\S]*)$/;

function parse(line) {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  return { when: m[1], role: m[2], text: m[3] };
}

const pairs = [];
const clientOnly = [];   // вопросы без ответа клиники
const perDialog = [];

for (const d of dialogs) {
  if (d.isGroup) continue;
  const msgs = d.transcript.map(parse).filter(Boolean);
  // склейка серий одной стороны
  const blocks = [];
  for (const m of msgs) {
    const side = m.role === 'клиент' ? 'client'
      : m.role === 'авто-уведомление' ? 'auto' : 'clinic';
    const last = blocks[blocks.length - 1];
    if (last && last.side === side) { last.text += ' ⏎ ' + m.text; last.until = m.when; }
    else blocks.push({ side, role: m.role, text: m.text, when: m.when, until: m.when });
  }
  const items = [];
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].side !== 'client') continue;
    // ближайший ответ клиники (пропуская автоуведомления)
    let ans = null;
    for (let j = i + 1; j < blocks.length; j++) {
      if (blocks[j].side === 'clinic') { ans = blocks[j]; break; }
      if (blocks[j].side === 'client') break;
    }
    const rec = {
      dialog: d.key, name: d.name, phone: d.phone, channel: d.channels,
      when: blocks[i].when, q: blocks[i].text,
      a: ans ? ans.text : null, a_role: ans ? ans.role : null,
      a_delay_min: ans ? Math.round((Date.parse(ans.when.replace(' ', 'T')) - Date.parse(blocks[i].until.replace(' ', 'T'))) / 60000) : null,
    };
    (ans ? pairs : clientOnly).push(rec);
    items.push(rec);
  }
  if (items.length) perDialog.push({ key: d.key, name: d.name, n: items.length });
}

fs.writeFileSync(path.join(OUT, 'qa_pairs.json'), JSON.stringify(pairs, null, 1));
fs.writeFileSync(path.join(OUT, 'qa_unanswered.json'), JSON.stringify(clientOnly, null, 1));

// плоский текст для чтения
const txt = pairs.map((p, i) =>
  `#${i + 1} [${p.when}] ${p.name || p.phone} (${p.channel})\nК: ${p.q}\nА(${p.a_role}, +${p.a_delay_min}м): ${p.a}`).join('\n\n');
fs.writeFileSync(path.join(OUT, 'qa_pairs.txt'), txt);

const txt2 = clientOnly.map((p, i) =>
  `#${i + 1} [${p.when}] ${p.name || p.phone}\nК: ${p.q}\n(ответа клиники в переписке нет)`).join('\n\n');
fs.writeFileSync(path.join(OUT, 'qa_unanswered.txt'), txt2);

console.log('пар вопрос→ответ:', pairs.length, '| без ответа:', clientOnly.length);
console.log('символов в qa_pairs.txt:', txt.length);

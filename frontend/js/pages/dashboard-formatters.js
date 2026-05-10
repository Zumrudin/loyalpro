// Pure helpers used by dashboard.js — no DOM access, easy to test.

function classifyFeedItem(txn) {
  const desc = (txn.description || '').toLowerCase();
  if (desc.includes('день рождения') || desc.includes('днём рождения') || desc.includes('др ') || desc.includes('подарок')) {
    return { type: 'birthday', cls: 'warm' };
  }
  if (desc.includes('реферал') || desc.includes('пригласи') || desc.includes('подруг')) {
    return { type: 'referral', cls: 'up' };
  }
  if ((txn.amount || 0) < 0) return { type: 'redemption', cls: 'dn' };
  return { type: 'accrual', cls: 'up' };
}

function greetByHour(h) {
  if (h >= 5  && h < 12) return 'доброе утро';
  if (h >= 12 && h < 18) return 'добрый день';
  if (h >= 18 && h < 23) return 'добрый вечер';
  return 'доброй ночи';
}

function sparklinePath(values, width, height) {
  if (!values || values.length < 2) return '';
  const min = Math.min(...values), max = Math.max(...values);
  const range = (max - min) || 1;
  const stepX = width / (values.length - 1);
  return values.map((v, i) => {
    const x = +(i * stepX).toFixed(2);
    const y = +(height - ((v - min) / range) * height).toFixed(2);
    return (i === 0 ? `M${x} ${y}` : `L${x} ${y}`);
  }).join(' ');
}

function heroSubtitle({ visits, newCardClients, revenueDeltaPct }) {
  const parts = [];
  parts.push(`${visits} записей`);
  if (newCardClients > 0) parts.push(`${newCardClients} новых клиентов подключили карту`);
  if (revenueDeltaPct && Math.abs(revenueDeltaPct) >= 1) {
    const dir = revenueDeltaPct > 0 ? 'опережает' : 'отстаёт от';
    parts.push(`выручка ${dir} прошлый период на ${Math.abs(Math.round(revenueDeltaPct))} %`);
  }
  return parts.join(', ') + '.';
}

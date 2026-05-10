const assert = require('assert');
const path = require('path');
const fs = require('fs');

const code = fs.readFileSync(path.join(__dirname, '..', 'js', 'pages', 'dashboard-formatters.js'), 'utf8');
const sandbox = {};
new Function('exports', code + '\nexports.classifyFeedItem = classifyFeedItem; exports.greetByHour = greetByHour; exports.sparklinePath = sparklinePath; exports.heroSubtitle = heroSubtitle;')(sandbox);
const { classifyFeedItem, greetByHour, sparklinePath, heroSubtitle } = sandbox;

// classifyFeedItem
assert.deepStrictEqual(classifyFeedItem({ amount: 100, description: 'начисление за визит' }).type, 'accrual');
assert.deepStrictEqual(classifyFeedItem({ amount: -480, description: 'списание' }).type, 'redemption');
assert.deepStrictEqual(classifyFeedItem({ amount: 500, description: 'поздравление с Днём рождения' }).type, 'birthday');
assert.deepStrictEqual(classifyFeedItem({ amount: 300, description: 'реферальный бонус' }).type, 'referral');
assert.strictEqual(classifyFeedItem({ amount: 100, description: 'начисление' }).cls, 'up');
assert.strictEqual(classifyFeedItem({ amount: -100, description: 'списание' }).cls, 'dn');
assert.strictEqual(classifyFeedItem({ amount: 500, description: 'день рождения' }).cls, 'warm');

// greetByHour
assert.strictEqual(greetByHour(7),  'доброе утро');
assert.strictEqual(greetByHour(13), 'добрый день');
assert.strictEqual(greetByHour(19), 'добрый вечер');
assert.strictEqual(greetByHour(2),  'доброй ночи');

// sparklinePath
const path1 = sparklinePath([0, 5, 3, 8, 6, 10, 7], 88, 30);
assert.match(path1, /^M0 \d+(\.\d+)?( L\d+(\.\d+)? \d+(\.\d+)?)+$/, 'sparklinePath shape');
assert.strictEqual(sparklinePath([], 88, 30), '', 'empty array → empty path');
assert.strictEqual(sparklinePath([5], 88, 30), '', 'single point → empty path (no line)');

// heroSubtitle
const sub = heroSubtitle({ visits: 12, newCardClients: 4, revenueDeltaPct: 18 });
assert.match(sub, /12 записей/);
assert.match(sub, /4 нов/);
assert.match(sub, /18\s*%/);
const subFlat = heroSubtitle({ visits: 7, newCardClients: 0, revenueDeltaPct: 0 });
assert.match(subFlat, /7 записей/);

console.log('dashboard-formatters.test: all assertions passed');

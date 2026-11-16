'use strict';
const fs = require('fs'),
  vm = require('vm');
const ctx = vm.createContext({ UIEvents: require('../frontend/js/core/ui-events.js'), document: { getElementById: () => ({ addEventListener() {} }) } });
for (const f of ['stock.js', 'stock-docs.js', 'clients.js'])
  vm.runInContext(fs.readFileSync(__dirname + '/../frontend/js/pages/' + f, 'utf8'), ctx);
test('purchase block handles empty history and escapes product names', () => {
  expect(ctx.cdPurchasesHtml([])).toContain('Покупок нет');
  const html = ctx.cdPurchasesHtml([
    {
      id: 3,
      origin: 'loyalpro',
      status: 'posted',
      total_cost: 5,
      lines: [{ title: '<script>bad</script>' }],
      payments: [{ method: 'cash', amount: 5 }],
    },
  ]);
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
  expect(html).toContain('Наличные');
});

'use strict';
// Regression checks for the boundaries found by the independent audit.
// Synthetic files only; never import server.js or connect to a database/provider.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const express = require('express');
const http = require('http');

test('raw gateway attachment paths and encoded aliases cannot bypass authorization', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loyalpro-boundary-audit-'));
  const dir = path.join(root, 'frontend/uploads/gateway/202');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'synthetic.txt'), 'synthetic salon B attachment');
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const start = source.indexOf('app.use((req, res, next)', source.indexOf('// Gateway media is private'));
  const end = source.indexOf('// Explicit route for index.html', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const app = express();
  vm.runInNewContext(source.slice(start, end), {
    app, express, path, __dirname: path.join(root, 'backend'),
  });
  const guard = jest.fn((_req, res) => res.sendStatus(401));
  app.use(guard);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    for (const requestPath of ['/uploads/gateway/202/synthetic.txt',
      '/uploads/%67ateway/202/synthetic.txt', '/uploads%2fgateway/202/synthetic.txt',
      '/uploads/unused/../gateway/202/synthetic.txt', '//uploads/gateway/202/synthetic.txt']) {
    for (const headers of [{}, { Authorization: 'Bearer synthetic-other-salon' }]) {
      const result = await new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port: server.address().port,
          path: requestPath, headers }, res => {
          let body = ''; res.on('data', c => { body += c; });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        }).on('error', reject);
      });
      expect(result).toEqual({ status: 404, body: '' });
    }
    }
    expect(guard).not.toHaveBeenCalled();
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('goods category sync scopes updates through the sale salon', async () => {
  const query = jest.fn(async sql => sql.trim().startsWith('SELECT')
    ? { rows: [{ yclients_goods_id: 777 }] } : { rows: [], rowCount: 2 });
  const ycGet = jest.fn(async (_salon, url) => url.includes('good_categories')
    ? [] : [{ good_id: 777, category: 'Synthetic category A' }]);
  const exported = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'services/home-care.js'), 'utf8'), {
    module: exported, setTimeout,
    require: name => {
      if (name === '../db') return { db: { query } };
      if (name === './yclients') return { ycGet, clearTreeCache: jest.fn() };
      throw new Error('Unexpected dependency');
    },
  });
  await exported.exports.syncGoodsCategories({ id: 101, yclients_company_id: 1001,
    yclients_user_token: 'synthetic' });
  const [sql, params] = query.mock.calls.find(([s]) => s.trim().startsWith('UPDATE'));
  expect(sql).toMatch(/gsi\.sale_id\s*=\s*gs\.id/);
  expect(sql).toMatch(/gs\.salon_id\s*=\s*\$3/);
  expect(params).toEqual(['Synthetic category A', 777, 101]);
});

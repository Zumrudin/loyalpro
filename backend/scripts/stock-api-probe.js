/* Пробы ТОЛЬКО ЧТЕНИЯ API склада YClients (GET). Ничего не пишет в YClients.
   Запуск: cd backend && node scripts/stock-api-probe.js ; тела — в /tmp/stock-api-probe/<step>.json */
require('dotenv').config();
const fs = require('fs');
const { db } = require('../db');
const { ycGet } = require('../services/yclients');

const OUT = '/tmp/stock-api-probe';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const save = (n, d) => fs.writeFileSync(`${OUT}/${n}.json`, JSON.stringify(d, null, 2));
const summary = {};
const unwrap = (r) => (r && r.data !== undefined ? r.data : r);

async function step(name, fn) {
  try {
    const r = await fn();
    console.log(`STEP ${name}: ok`);
    summary[name] = { ok: true, ...(r || {}) };
  } catch (e) {
    console.log(`STEP ${name}: ERR ${e.message}`);
    summary[name] = { ok: false, error: e.message };
  }
  await sleep(400);
}

(async () => {
  const salon = await db.oneOrNone('SELECT * FROM salons WHERE id=1');
  if (!salon) throw new Error('salon 1 not found');
  const cid = salon.yclients_company_id;
  const get = async (p, params) => { const r = await ycGet(salon, p, params); await sleep(400); return r; };

  await step('1_storages', async () => {
    const r = await get(`/storages/${cid}`);
    save('1_storages', r);
    const d = unwrap(r);
    console.log('  storages:', Array.isArray(d) ? d.map((s) => `${s.id}:${s.title}`).join(' | ') : typeof d);
    return { count: Array.isArray(d) ? d.length : null };
  });

  // 2
  const cands = [];
  const a = await db.oneOrNone(`SELECT yclients_good_id, title, unit_equals FROM yclients_goods_catalog WHERE salon_id=1 AND unit_equals>1 AND yclients_good_id IN (SELECT good_id FROM goods_transactions WHERE salon_id=1 AND type_id=3 AND create_date > now()-interval '60 days') LIMIT 1`);
  const b = await db.oneOrNone(`SELECT yclients_good_id, title, unit_equals FROM yclients_goods_catalog WHERE salon_id=1 AND unit_equals=1 AND yclients_good_id IN (SELECT good_id FROM goods_transactions WHERE salon_id=1 AND deleted_at IS NULL) LIMIT 1`);
  if (a) cands.push(['a_unit_equals_gt1', a.yclients_good_id, a.title]);
  if (b) cands.push(['b_unit_equals_1', b.yclients_good_id, b.title]);
  cands.push(['c_lip_soap', 20927975, 'LIP мыло']);
  for (const [tag, gid, title] of cands) {
    await step(`2_good_${tag}`, async () => {
      const r = await get(`/goods/${cid}/${gid}`);
      save(`2_good_${tag}`, r);
      const g = unwrap(r) || {};
      const ours = await db.any(`SELECT storage_id, operation_unit_type, type_id, SUM(amount)::text AS s, COUNT(*)::int AS n FROM goods_transactions WHERE salon_id=1 AND good_id=$1 AND deleted_at IS NULL GROUP BY 1,2,3 ORDER BY 1,2,3`, [gid]);
      const info = { gid, title, unit_equals: g.unit_equals, unit_short_title: g.unit_short_title, service_unit_short_title: g.service_unit_short_title, actual_amounts: g.actual_amounts };
      console.log('  ', JSON.stringify(info));
      console.log('   our txns:', JSON.stringify(ours));
      return { info, ours };
    });
  }

  await step('3_goods_list', async () => {
    const r = await get(`/goods/${cid}`, { count: 100, page: 1 });
    save('3_goods_list', r);
    const d = unwrap(r);
    const first = Array.isArray(d) ? d[0] : null;
    const keys = first ? Object.keys(first) : [];
    const want = ['cost','barcode','unit_id','service_unit_id','critical_amount','desired_amount','comment','loyalty_abonement_type_id','loyalty_certificate_type_id','last_change_date','actual_amounts'];
    console.log('  keys:', keys.join(','));
    console.log('  missing:', want.filter((k) => !keys.includes(k)).join(',') || '-');
    return { keys, missing: want.filter((k) => !keys.includes(k)), n: Array.isArray(d) ? d.length : null };
  });

  await step('4_categories', async () => {
    let calls = 0; const nodes = []; let maxDepth = 0; const paths = [];
    async function walk(id, depth, path) {
      if (calls >= 60 || depth > 4) return;
      calls++;
      const r = await get(`/goods_categories/${cid}/${id}`);
      if (calls === 1) save('4_categories_root', r);
      const d = unwrap(r);
      const list = Array.isArray(d) ? d : (d ? [d] : []);
      for (const n of list) {
        if (String(n.id) === String(id)) {
          for (const c of (n.categories || [])) await visit(c, depth, path);
          continue;
        }
        await visit(n, depth, path);
      }
    }
    async function visit(n, depth, path) {
      const p = [...path, n.title];
      nodes.push({ id: n.id, title: n.title, depth, parent: n.parent_category_id });
      paths.push(p.join(' > '));
      maxDepth = Math.max(maxDepth, depth);
      if (n.categories && n.categories.length) { for (const c of n.categories) await visit(c, depth + 1, p); }
      else await walk(n.id, depth + 1, p);
    }
    await walk(0, 1, []);
    save('4_categories', { nodes, paths, calls });
    console.log(`  nodes=${nodes.length} maxDepth=${maxDepth} calls=${calls}`);
    paths.slice(0, 80).forEach((p) => console.log('   ', p));
    return { nodes: nodes.length, maxDepth, calls, paths };
  });

  await step('5_record_consumables', async () => {
    let rec = await db.oneOrNone(`SELECT r.yclients_record_id FROM records r JOIN clients c ON c.id=r.client_id WHERE r.salon_id=1 AND c.phone LIKE '%9200255591' AND r.status IN ('arrived','completed') ORDER BY r.visit_date DESC LIMIT 1`);
    let src = 'client 79200255591';
    if (!rec) {
      rec = await db.oneOrNone(`SELECT yclients_record_id FROM records WHERE salon_id=1 AND status IN ('arrived','completed') AND visit_date > now()-interval '30 days' ORDER BY visit_date DESC LIMIT 1`);
      src = 'any recent salon record';
    }
    if (!rec) throw new Error('no record found');
    const r = await get(`/technological_cards/record_consumables/${cid}/${rec.yclients_record_id}/`);
    save('5_record_consumables', r);
    const d = unwrap(r);
    const top = d && !Array.isArray(d) ? Object.keys(d) : null;
    const cons = d && d.consumables ? d.consumables : (Array.isArray(d) ? d : null);
    const firstKeys = cons && cons[0] ? Object.keys(cons[0]) : null;
    console.log('  record', rec.yclients_record_id, src, 'top:', JSON.stringify(top), 'first:', JSON.stringify(firstKeys), 'n=', cons && cons.length);
    return { record: rec.yclients_record_id, src, top, firstKeys, n: cons ? cons.length : null, rawTopType: Array.isArray(d) ? 'array' : typeof d };
  });

  await step('5b_record_consumables_with_writeoff', async () => {
    // запись, по которой уже есть списание расходников — чтобы увидеть непустую форму consumables
    const rec = await db.oneOrNone(`SELECT record_id FROM goods_transactions WHERE salon_id=1 AND type_id=2 AND record_id IS NOT NULL AND deleted_at IS NULL ORDER BY create_date DESC LIMIT 1`);
    if (!rec) throw new Error('no record with writeoffs');
    const r = await get(`/technological_cards/record_consumables/${cid}/${rec.record_id}/`);
    save('5b_record_consumables_with_writeoff', r);
    const d = unwrap(r);
    const el = Array.isArray(d) ? d[0] : d;
    const c0 = el && el.consumables && el.consumables[0];
    const t0 = el && el.technological_cards && el.technological_cards[0];
    console.log('  record', rec.record_id, 'el keys:', JSON.stringify(el && Object.keys(el)), 'consumable keys:', JSON.stringify(c0 && Object.keys(c0)), 'tcard keys:', JSON.stringify(t0 && Object.keys(t0)));
    return { record: rec.record_id, elKeys: el && Object.keys(el), consumableKeys: c0 && Object.keys(c0), tcardKeys: t0 && Object.keys(t0), n: el && el.consumables && el.consumables.length };
  });

  await step('6_storage_transactions', async () => {
    const msk = new Date(Date.now() + 3 * 3600e3 - 86400e3).toISOString().slice(0, 10);
    const r = await get(`/storages/transactions/${cid}`, { changed_after: `${msk}T00:00:00`, count: 100, page: 1 });
    save('6_storage_transactions', r);
    const d = unwrap(r);
    const rows = Array.isArray(d) ? d : [];
    const keys = rows[0] ? Object.keys(rows[0]) : [];
    const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
    const fields = {};
    for (const k of ['comment', 'client', 'supplier', 'master']) {
      fields[k] = { present: keys.includes(k), types: [...new Set(rows.slice(0, 20).map((x) => typeOf(x[k])))], nonEmpty: rows.filter((x) => x[k] && (typeof x[k] !== 'object' || Object.keys(x[k]).length)).length };
    }
    console.log('  rows', rows.length, 'keys:', keys.join(','));
    console.log('  fields:', JSON.stringify(fields));
    return { rows: rows.length, keys, fields };
  });

  save('summary', summary);
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });

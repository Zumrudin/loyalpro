'use strict';
const { indexTree, categoryPathForService, buildAdminTree } =
  require('./services/agent/category-tree');

// Топ-категории YClients (как из /service_categories): {id, title, weight}.
const ycCats = [
  { id: 1, title: 'Инъекционная косметология', weight: 10 },
  { id: 2, title: 'Аппаратная косметология', weight: 5 },
];
// Оверлей-подкатегорий (agent_service_subcategories). yc_category_id — якорь.
const subcats = [
  { id: 100, salon_id: 1, yc_category_id: 1, parent_id: null, title: 'Биоревитализация', display_order: 0 },
  { id: 101, salon_id: 1, yc_category_id: 1, parent_id: 100, title: 'Препараты по лицу', display_order: 0 },
  { id: 102, salon_id: 1, yc_category_id: 1, parent_id: null, title: 'Контурная пластика', display_order: 1 },
];
// Привязки услуг (agent_service_placements).
const placements = [
  { yc_service_id: 8, subcategory_id: 100 },   // в подкатегорию 1 уровня
  { yc_service_id: 7, subcategory_id: 101 },   // во вложенную 2 уровня
  { yc_service_id: 9, subcategory_id: 999 },   // в удалённую/чужую → фолбэк
];

describe('indexTree', () => {
  test('строит все три индекса (по строковым ключам)', () => {
    const idx = indexTree(ycCats, subcats, placements);
    expect(idx.ycCatById.get('1').title).toBe('Инъекционная косметология');
    expect(idx.ycCatById.get('1').weight).toBe(10);
    expect(idx.subcatById.get('100').title).toBe('Биоревитализация');
    expect(idx.placementBySvc.get('8')).toBe('100');
    expect(idx.placementBySvc.get('7')).toBe('101');
  });
  test('пустые входы → пустые карты', () => {
    const idx = indexTree(null, null, null);
    expect(idx.ycCatById.size).toBe(0);
    expect(idx.subcatById.size).toBe(0);
    expect(idx.placementBySvc.size).toBe(0);
  });
});

describe('categoryPathForService', () => {
  const idx = indexTree(ycCats, subcats, placements);

  test('не помещена → [название родной категории]', () => {
    expect(categoryPathForService(idx, 5, 1)).toEqual(['Инъекционная косметология']);
  });
  test('помещена в подкатегорию 1 уровня → [категория, подкатегория]', () => {
    expect(categoryPathForService(idx, 8, 1))
      .toEqual(['Инъекционная косметология', 'Биоревитализация']);
  });
  test('помещена во вложенную 2 уровня → полный путь сверху вниз', () => {
    expect(categoryPathForService(idx, 7, 1))
      .toEqual(['Инъекционная косметология', 'Биоревитализация', 'Препараты по лицу']);
  });
  test('placement на удалённую подкатегорию → фолбэк на родную категорию', () => {
    expect(categoryPathForService(idx, 9, 2)).toEqual(['Аппаратная косметология']);
  });
  test('нет категории (null/неизвестна) → []', () => {
    expect(categoryPathForService(idx, 6, null)).toEqual([]);
    expect(categoryPathForService(idx, 6, 999)).toEqual([]);
  });
  test('сирота (parent_id на несуществующую строку) → путь без потери, как верхняя', () => {
    const orphanSub = [{ id: 300, yc_category_id: 1, parent_id: 555, title: 'Сирота', display_order: 0 }];
    const oIdx = indexTree(ycCats, orphanSub, [{ yc_service_id: 5, subcategory_id: 300 }]);
    expect(categoryPathForService(oIdx, 5, 1))
      .toEqual(['Инъекционная косметология', 'Сирота']);
  });
  test('цикл parent_id → не зацикливается, возвращает конечный массив', () => {
    const cyc = [
      { id: 200, yc_category_id: 1, parent_id: 201, title: 'A', display_order: 0 },
      { id: 201, yc_category_id: 1, parent_id: 200, title: 'B', display_order: 0 },
    ];
    const cIdx = indexTree(ycCats, cyc, [{ yc_service_id: 5, subcategory_id: 200 }]);
    const path = categoryPathForService(cIdx, 5, 1);
    expect(Array.isArray(path)).toBe(true);
    expect(path[0]).toBe('Инъекционная косметология');
    expect(path).toContain('A');
    expect(path).toContain('B');
  });
});

describe('buildAdminTree', () => {
  const services = [
    { yc_id: 5, title: 'Плазмолифтинг', category_id: 1, _weight: 3 },  // родная категория 1
    { yc_id: 8, title: 'Гиалуронка лицо', category_id: 1, _weight: 2 }, // → подкатегория 100
    { yc_id: 7, title: 'Препарат X', category_id: 1, _weight: 1 },      // → вложенная 101
    { yc_id: 9, title: 'Лазер', category_id: 2, _weight: 0 },           // placement 999 → родная 2
    { yc_id: 20, title: 'Без кат', category_id: null, _weight: 0 },     // → Без категории
  ];
  const tree = buildAdminTree(ycCats, services, subcats, placements);

  test('топ-узлы: категории с услугами/подкатегориями + «Без категории», по весу', () => {
    expect(tree.map(c => c.title)).toEqual([
      'Инъекционная косметология', 'Аппаратная косметология', 'Без категории',
    ]);
  });
  test('услуги без placement лежат в родной категории напрямую', () => {
    const cat1 = tree[0];
    expect(cat1.services.map(s => s.yc_id)).toEqual([5]);
  });
  test('услуга с placement уходит в подкатегорию, вложенность 2 уровня', () => {
    const cat1 = tree[0];
    const bio = cat1.subcategories.find(s => s.id === 100);
    expect(bio.subcategory).toBe(true);
    expect(bio.services.map(s => s.yc_id)).toEqual([8]);
    const face = bio.subcategories.find(s => s.id === 101);
    expect(face.title).toBe('Препараты по лицу');
    expect(face.services.map(s => s.yc_id)).toEqual([7]);
  });
  test('пустая подкатегория присутствует в дереве', () => {
    const cat1 = tree[0];
    const empty = cat1.subcategories.find(s => s.id === 102);
    expect(empty.title).toBe('Контурная пластика');
    expect(empty.services).toEqual([]);
  });
  test('подкатегории отсортированы по display_order', () => {
    expect(tree[0].subcategories.map(s => s.id)).toEqual([100, 102]);
  });
  test('placement на удалённую подкатегорию → услуга в родной категории', () => {
    const cat2 = tree[1];
    expect(cat2.services.map(s => s.yc_id)).toEqual([9]);
    expect(cat2.subcategories).toEqual([]);
  });
  test('«Без категории» собирает услуги с category_id=null без placement', () => {
    const none = tree[2];
    expect(none.services.map(s => s.yc_id)).toEqual([20]);
  });
  test('служебные поля (_weight/_order/_yc/_parent) вычищены', () => {
    const cat1 = tree[0];
    expect(cat1._weight).toBeUndefined();
    expect(cat1.services[0]._weight).toBeUndefined();
    const bio = cat1.subcategories[0];
    expect(bio._order).toBeUndefined();
    expect(bio._parent).toBeUndefined();
    expect(bio._yc).toBeUndefined();
  });
  test('услуги в категории отсортированы по весу (убыв.), затем по названию', () => {
    const svc = [
      { yc_id: 1, title: 'Бета', category_id: 1, _weight: 1 },
      { yc_id: 2, title: 'Альфа', category_id: 1, _weight: 5 },
      { yc_id: 3, title: 'Гамма', category_id: 1, _weight: 5 },
    ];
    const t = buildAdminTree(ycCats, svc, [], []);
    expect(t[0].services.map(s => s.yc_id)).toEqual([2, 3, 1]); // 5(Альфа),5(Гамма),1(Бета)
  });
  test('пустые входы → пустое дерево', () => {
    expect(buildAdminTree([], [], [], [])).toEqual([]);
  });
  test('цикл parent_id не зацикливает построение', () => {
    const cyc = [
      { id: 200, yc_category_id: 1, parent_id: 201, title: 'A', display_order: 0 },
      { id: 201, yc_category_id: 1, parent_id: 200, title: 'B', display_order: 0 },
    ];
    // Услуга привязана к категории 1 напрямую, подкатегории в цикле недостижимы от корня.
    const t = buildAdminTree(ycCats, [{ yc_id: 5, title: 'X', category_id: 1, _weight: 0 }], cyc, []);
    expect(t[0].title).toBe('Инъекционная косметология');
    expect(t[0].services.map(s => s.yc_id)).toEqual([5]);
  });
});

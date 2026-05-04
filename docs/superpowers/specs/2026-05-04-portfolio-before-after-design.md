# Portfolio "До/После" — Design Spec

**Дата:** 2026-05-04
**Статус:** Approved
**Связанные системы:** `/root/loyalpro` (бэкенд, эндпоинты `/api/mobile/client/portfolio/*` уже реализованы)

## Цель

Заменить на главном экране секцию «Процедуры» (5 hard-coded `ServicePill`-карточек, ведущих на `Bookings`) на секцию **«До/после»**, питающуюся реальными категориями портфолио из админки loyalpro («Настройки → Приложение → Портфолио работ»).

Внутри категории клиент видит работы — фото «после» в сетке 3 в ряд. По тапу открывается модалка с фото «До»/«После», описанием и врачом, который выполнил работу.

## Контекст

### Текущее состояние

**HomeScreen.js:483** — горизонтальный `ScrollView` с константой `SERVICES` из 5 элементов. Каждый `ServicePill` — иконка `Ionicons` + подпись. Тап ведёт на `Bookings`. Вся структура hard-coded — нет загрузки с бэка.

### Бэкенд (готов, не трогаем)

В `/root/loyalpro/backend/routes/mobile-client.js` уже есть три эндпоинта (написаны и проверены до старта этой задачи):

- `GET /api/mobile/client/portfolio/categories`
  Возвращает категории своего салона, опубликованные и непустые:
  `{ success, categories: [{ id, title, coverPhotoUrl, itemsCount }] }`

- `GET /api/mobile/client/portfolio/categories/:id`
  Возвращает работы одной категории:
  `{ success, category: { id, title }, items: [{ id, title, description, photoAfterUrl, photoBeforeUrl, specialist: { id, name, photoUrl } | null }] }`

- `GET /api/mobile/client/portfolio/by-staff/:staffId`
  Используется на экране специалиста (вне рамок этой задачи).

URL фотографий бэк уже абсолютизирует. `photoAfterUrl` гарантированно есть, `photoBeforeUrl` опциональный, `specialist` опциональный.

### Принятые решения (из брейншторма)

1. **Детальный просмотр** — стопкой по вертикали (не свайп-пейджер, не интерактивный слайдер). Прокручиваем: «До» → «После» → описание → врач.
2. **Ссылка «Все»** — ведёт на новый экран `PortfolioCategoriesScreen` с сеткой 2×2 всех категорий.
3. **Работы без фото «До»** — показываем как есть (фильтрации нет ни на клиенте, ни на бэке).
4. **Миниатюра в сетке категории** — только `photoAfterUrl`, квадрат 1:1, без бейджа.

## Архитектура

Стандартный паттерн проекта: API-метод → store-фетчер с `*Loading` флагом → экран в `HomeStack`. Один общий компонент `PortfolioCard` переиспользуется в 2 местах (хоум-стрип, экран «Все»).

### Файлы

```
ИЗМЕНИТЬ:
  src/api/client-data.js        + getPortfolioCategories, getPortfolioCategory
  src/store/clientStore.js      + portfolio state + 2 фетчера
  src/screens/HomeScreen.js     заменить секцию «Процедуры» → «До/после»
  App.js                        регистрация 3 новых экранов в HomeStack

СОЗДАТЬ:
  src/components/PortfolioCard.js
  src/screens/PortfolioCategoriesScreen.js
  src/screens/PortfolioCategoryScreen.js
  src/screens/PortfolioItemViewer.js

УДАЛИТЬ:
  В HomeScreen.js — константа SERVICES и компонент ServicePill (вместе с его стилями `sp`).
```

## API-слой

В `src/api/client-data.js` добавляются два метода в существующий объект `clientDataAPI`:

```js
getPortfolioCategories: async () => {
  const res = await apiClient.get('/mobile/client/portfolio/categories');
  return res.data;
},

getPortfolioCategory: async (id) => {
  const res = await apiClient.get(`/mobile/client/portfolio/categories/${id}`);
  return res.data;
},
```

Контракт ответов от бэка не оборачивается дополнительно — store сам делает `response.categories || []` и `response.items || []` (паттерн «толерантного развёртывания», уже используется в проекте).

## Состояние (clientStore)

Добавляется четыре поля и два экшена:

```js
// state
portfolioCategories: [],            // массив из последнего GET /categories
portfolioCategoriesLoading: false,
portfolioItemsByCategory: {},       // { [categoryId]: items[] } — кэш
portfolioItemsLoading: {},          // { [categoryId]: bool }

// actions
fetchPortfolioCategories: async () => {
  set({ portfolioCategoriesLoading: true });
  try {
    const r = await clientDataAPI.getPortfolioCategories();
    set({ portfolioCategories: r.categories || [], portfolioCategoriesLoading: false });
  } catch (e) {
    console.log('[API] portfolio categories failed:', e.message);
    set({ portfolioCategoriesLoading: false, error: e.message });
  }
},

fetchPortfolioCategory: async (id) => {
  set((s) => ({ portfolioItemsLoading: { ...s.portfolioItemsLoading, [id]: true } }));
  try {
    const r = await clientDataAPI.getPortfolioCategory(id);
    set((s) => ({
      portfolioItemsByCategory: { ...s.portfolioItemsByCategory, [id]: r.items || [] },
      portfolioItemsLoading: { ...s.portfolioItemsLoading, [id]: false },
    }));
  } catch (e) {
    console.log('[API] portfolio category failed:', e.message);
    set((s) => ({
      portfolioItemsLoading: { ...s.portfolioItemsLoading, [id]: false },
      error: e.message,
    }));
  }
},
```

Кэш `portfolioItemsByCategory` нужен, чтобы при возврате на экран категории не было повторного фетча и мигания. Кэш живёт до выгрузки приложения (стор не персистится — это согласуется с поведением остальных доменов).

## Компонент PortfolioCard

Используется и в горизонтальной полосе на хоуме, и в сетке 2×2 на экране «Все». Принимает `category` и `size` ('strip' | 'grid').

Размеры:
- `'strip'` — `width: 120, height: 150` (соотношение 4:5).
- `'grid'` — `width: (screenWidth - 56) / 2`, `aspectRatio: 4/5` (как `quickGrid` в HomeScreen).

Структура:
- `PressCard` (как в HomeScreen — даёт haptic feedback и press-scale).
- `borderRadius: 20`.
- Внутри:
  - `Image` (`source: { uri: category.coverPhotoUrl }`, `resizeMode: 'cover'`, `StyleSheet.absoluteFill`).
  - `LinearGradient` снизу (`colors: ['transparent', 'rgba(0,0,0,0.55)']`, `start: {x:0,y:0.4}, end: {x:0,y:1}`, `StyleSheet.absoluteFill`).
  - `Text` с названием — белый, полу-болд, `position: 'absolute', bottom: 12, left: 12, right: 12`. Truncate `numberOfLines={2}`.
- Если фото не загрузилось (`onError`) — показываем серую плитку с тёмным заголовком (минимальный фолбэк).

## Экраны

### HomeScreen.js (правка)

Удаляются: константа `SERVICES`, компонент `ServicePill`, объект стилей `sp`.

Добавляется `useEffect` на маунт компонента, дёргающий `fetchPortfolioCategories()` если `portfolioCategories.length === 0`.

Секция между «Bonus card» и «Quick links grid» (там, где сейчас «Процедуры»):

```jsx
{categoriesLoaded && portfolioCategories.length > 0 && (
  <>
    <Reveal delay={240}>
      <View style={s.sectionHeader}>
        <Text style={s.sectionTitle}>До/после</Text>
        <TouchableOpacity onPress={() => navigation.navigate('PortfolioCategories')}>
          <Text style={s.sectionLink}>Все</Text>
        </TouchableOpacity>
      </View>
    </Reveal>

    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.servicesScroll}>
      {portfolioCategories.slice(0, 4).map((cat, i) => (
        <Reveal key={cat.id} delay={280 + i * 60}>
          <PortfolioCard
            category={cat}
            size="strip"
            onPress={() => navigation.navigate('PortfolioCategory', { id: cat.id, title: cat.title })}
          />
        </Reveal>
      ))}
    </ScrollView>
  </>
)}
```

Флаг «уже фетчили хотя бы раз» хранится локально в `HomeScreen` (`useState(false)`, ставится в `true` в `finally` фетчера) — без него секция мигнёт пустотой при первом запуске. Пока `portfolioCategoriesLoading === true` — рисуем 4 серые плитки-скелетоны размеров `'strip'`. Скелетон — это **именованный экспорт `PortfolioCardSkeleton` из того же файла `src/components/PortfolioCard.js`**: `<View style={{ width: 120, height: 150, borderRadius: 20, backgroundColor: T.glass }} />`. После загрузки: либо реальные карточки, либо ничего (если пусто — секция целиком не рисуется, заголовок «До/после» не показываем).

### PortfolioCategoriesScreen.js (новый)

Экран «Все категории».

- Хедер: «Назад», заголовок «Портфолио работ».
- `FlatList`:
  - `numColumns: 2`
  - `data: portfolioCategories` (тот же массив из стора)
  - `renderItem`: `<PortfolioCard category={item} size="grid" onPress={...} />`
  - `contentContainerStyle: { padding: 20, gap: 16 }` + `columnWrapperStyle: { gap: 16 }`
  - `refreshing` + `onRefresh` → `fetchPortfolioCategories()`
- Если массив пуст — текст «Пока нет работ» по центру (теоретически недостижимо, потому что иначе на хоуме мы бы сюда не дали зайти, но защитная сетка нужна).

### PortfolioCategoryScreen.js (новый)

Экран одной категории — сетка 3 в ряд.

- Хедер: «Назад», заголовок = `route.params.title`.
- На маунте: `fetchPortfolioCategory(route.params.id)` если `portfolioItemsByCategory[id]` пуст.
- `FlatList`:
  - `numColumns: 3`
  - `data: portfolioItemsByCategory[id] || []`
  - `renderItem`: `TouchableOpacity` со `Image` (`photoAfterUrl`, `aspectRatio: 1`, `resizeMode: 'cover'`, `borderRadius: 12`).
  - `contentContainerStyle: { padding: 16, gap: 8 }` + `columnWrapperStyle: { gap: 8 }`.
  - Тап → `navigation.navigate('PortfolioItemViewer', { item })`.
  - `refreshing` + `onRefresh`.
- Loading-state: спиннер по центру при первой загрузке.
- Empty-state: «В этой категории пока нет работ».
- Error-state: «Не удалось загрузить» + кнопка «Повторить».

### PortfolioItemViewer.js (новый, modal)

Модалка с фото «До»/«После» стопкой. Регистрируется с `options={{ presentation: 'modal' }}`.

Принимает целый объект `item` через `route.params.item` — нет повторного запроса.

Структура (внутри `ScrollView`, `backgroundColor: '#FFFFFF'`):

1. Хедер модалки:
   - Слева: пустота / drag-handle на iOS (нативно).
   - Справа: иконка `close-outline` (`size: 28`), тап → `navigation.goBack()`.
   - `paddingHorizontal: 20, paddingTop: insets.top + 12`.

2. Если `item.photoBeforeUrl`:
   - `Text`: «До» (small caps, champagne `#D4AF37`, `marginBottom: 8`).
   - `Image` (full-width, `aspectRatio: 4/5`, `resizeMode: 'cover'`, `borderRadius: 16`).
   - `marginBottom: 24`.

3. `Text`: «После» (тот же стиль).
4. `Image` («После», тот же стиль что и «До»).

5. `marginTop: 24`. `Text` с `item.title` — `fontSize: 20, fontWeight: '600', color: T.stoneDark`.

6. Если `item.description`: `Text` с описанием — `fontSize: 14, color: T.stoneMid, lineHeight: 22, marginTop: 8`.

7. Если `item.specialist`: блок «Выполнил(а)»:
   - `marginTop: 24`, разделитель сверху (`borderTopWidth: 1, borderTopColor: T.glass`).
   - `Pressable` (вся строка кликабельна).
   - Слева: круглое фото 40px (`specialist.photoUrl`), фолбэк — иконка `person-circle-outline`.
   - Справа: «Выполнил(а)» (мелким) + имя (`fontSize: 15`).
   - Тап → `navigation.goBack()` затем `navigation.navigate('SpecialistDetail', { id: specialist.id })`.

8. Снизу `paddingBottom: insets.bottom + 24`.

Закрытие модалки на iOS — нативный свайп вниз. На Android — кнопка «Назад» и крестик.

### App.js (регистрация навигации)

В `HomeStack` добавляются три экрана:

```jsx
<HomeStackNav.Screen name="PortfolioCategories" component={PortfolioCategoriesScreen} />
<HomeStackNav.Screen name="PortfolioCategory" component={PortfolioCategoryScreen} />
<HomeStackNav.Screen
  name="PortfolioItemViewer"
  component={PortfolioItemViewer}
  options={{ presentation: 'modal' }}
/>
```

Все три — внутри `HomeStack`, не на корне. Это сохраняет нижний таб-бар видимым на экране категории и (если нужно) на «Все», и поднимает модалку поверх него на viewer’е.

## Обработка краёв

| Сценарий | Поведение |
|----------|-----------|
| Бэк отдал 0 категорий | Секция «До/после» на хоуме не рисуется. Ссылка «Все» не доступна. |
| Бэк недоступен на хоуме | Тихий лог `[API] portfolio categories failed`, секция не рисуется. Остальной хоум работает. |
| Бэк недоступен в категории | Экран показывает «Не удалось загрузить» + кнопка «Повторить». |
| `photoBeforeUrl === null` | В viewer’е блок «До» не рендерится. Миниатюра — `photoAfterUrl` как обычно. |
| `specialist === null` | В viewer’е блок врача не рендерится. |
| Битый URL у `coverPhotoUrl` | `Image.onError` → показываем серую плитку с тёмным текстом заголовка. |
| Категория без работ | Бэк такие отфильтровал на хоуме. На экране категории (если зашли по прямой ссылке-deeplink) — empty state. |
| Возврат на хоум через 10 минут | Фоновое обновление при focus, если данные старее N минут (детали — в плане; **дефолт: всегда вызываем `fetchPortfolioCategories` на focus, кэш живёт в сторе и не мигает**). |

## Верификация

Так как тестов в проекте нет (`package.json` без `test`), верификация — ручной прогон через `npm start` + Expo на эмуляторе. План покроет конкретные шаги UAT для каждой фазы.

Самый простой ручной чек:
1. На бэке создать минимум 2 категории с >=2 работами в каждой (одна работа — без `photo_before_url`).
2. Запустить мобилку → главный экран показывает 4 (или сколько есть) карточек.
3. Тап на категорию → 3-в-ряд миниатюры.
4. Тап на работу с обоими фото → модалка с «До» и «После».
5. Тап на работу без «До» → модалка только с «После».
6. Тап на врача → переход на `SpecialistDetail`, модалка закрылась.
7. Тап «Все» → экран со всеми категориями 2×2.
8. Принудительно отключить интернет на телефоне → секция «До/после» не блокирует загрузку хоума.

## Out of Scope

- Кэширование фото на диск (используем встроенный кэш RN Image).
- Деплинки на конкретную работу или категорию.
- Лайки / шеринг работ.
- Видео-портфолио.
- Поиск/фильтр внутри категории.
- Pinch-to-zoom фото в модалке (можно добавить позже как отдельная фаза).
- Сваггер / OpenAPI описание API (бэкенд уже в продакшене, добавляется в общем порядке).

## План реализации (предварительный)

Финальный план разрабатывается через `writing-plans` skill после утверждения этого спека. Ожидаемая разбивка:

1. **Phase 1 — API + store** (`getPortfolioCategories`, `getPortfolioCategory`, fetchers, state). Smoke-тест через временный лог.
2. **Phase 2 — компонент `PortfolioCard`** (изолированно, без интеграции).
3. **Phase 3 — HomeScreen** замена секции «Процедуры» → «До/после». Skeleton + empty state.
4. **Phase 4 — `PortfolioCategoryScreen`** (3-в-ряд) и навигация хоум → категория.
5. **Phase 5 — `PortfolioItemViewer`** (модалка стопкой). Тап на врача → `SpecialistDetail`.
6. **Phase 6 — `PortfolioCategoriesScreen`** («Все», сетка 2×2).
7. **Phase 7 — полировка**: pull-to-refresh, error-states с retry, фоновое обновление на focus, фолбэки на битых URL.

Каждая фаза — отдельный коммит, верифицируемый вручную.

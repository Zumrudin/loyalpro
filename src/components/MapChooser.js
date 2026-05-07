import { ActionSheetIOS, Alert, Linking, Platform } from 'react-native';

const CLINIC_LABEL = 'Клиника';

const iosApps = [
  {
    name: 'Яндекс.Карты',
    scheme: 'yandexmaps://',
    build: (to, from) =>
      from
        ? `yandexmaps://maps.yandex.ru/?rtext=${from.lat},${from.lng}~${to.lat},${to.lng}&rtt=pd`
        : `yandexmaps://maps.yandex.ru/?pt=${to.lng},${to.lat}&z=16`,
  },
  {
    name: 'Яндекс.Навигатор',
    scheme: 'yandexnavi://',
    build: (to) => `yandexnavi://build_route_on_map?lat_to=${to.lat}&lon_to=${to.lng}`,
  },
  {
    name: '2ГИС',
    scheme: 'dgis://',
    build: (to, from) =>
      from
        ? `dgis://2gis.ru/routeSearch/rsType/pedestrian/from/${from.lng},${from.lat}/to/${to.lng},${to.lat}`
        : `dgis://2gis.ru/geo/${to.lng},${to.lat}`,
  },
  {
    name: 'Google Maps',
    scheme: 'comgooglemaps://',
    build: (to) =>
      `comgooglemaps://?daddr=${to.lat},${to.lng}&directionsmode=walking`,
  },
  {
    name: 'Apple Maps',
    scheme: 'http://maps.apple.com/',
    build: (to) =>
      `http://maps.apple.com/?daddr=${to.lat},${to.lng}&dirflg=w&q=${encodeURIComponent(CLINIC_LABEL)}`,
  },
];

async function pickIOS(to, from) {
  const available = [];
  for (const app of iosApps) {
    try {
      const can = await Linking.canOpenURL(app.scheme);
      if (can) available.push(app);
    } catch {}
  }
  if (available.length === 0) {
    Alert.alert('Нет установленных карт', 'Установите Яндекс.Карты или другое навигационное приложение.');
    return;
  }
  const options = [...available.map((a) => a.name), 'Отмена'];
  ActionSheetIOS.showActionSheetWithOptions(
    {
      options,
      cancelButtonIndex: options.length - 1,
      title: 'Открыть маршрут в',
    },
    (index) => {
      if (index === options.length - 1) return;
      const url = available[index].build(to, from);
      Linking.openURL(url).catch(() => {});
    },
  );
}

function openAndroid(to) {
  const label = encodeURIComponent(CLINIC_LABEL);
  const url = `geo:${to.lat},${to.lng}?q=${to.lat},${to.lng}(${label})`;
  Linking.openURL(url).catch(() => {
    Linking.openURL(
      `https://yandex.ru/maps/?rtext=~${to.lat},${to.lng}&rtt=pd`,
    ).catch(() => {});
  });
}

export function openMapChooser({ to, from }) {
  if (!to) return;
  if (Platform.OS === 'ios') return pickIOS(to, from);
  return openAndroid(to);
}

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { WebView } from 'react-native-webview';
import * as Location from 'expo-location';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CLINIC_LOCATION, YANDEX_MAPS_API_KEY } from '../constants/clinic';
import { openMapChooser } from '../components/MapChooser';
import { useAppSettingsStore } from '../store/appSettingsStore';

const T = {
  pearl: '#F5F3F0',
  glass: 'rgba(255,252,248,0.88)',
  glassBorder: 'rgba(255,255,255,0.85)',
  champagne: '#D4AF37',
  champDark: '#A8881C',
  champGlow: 'rgba(212,175,55,0.18)',
  stone: '#4A4540',
  stoneMid: '#7A736B',
  shadow: 'rgba(100,90,70,0.12)',
};

function buildHtml(clinic, apiKey) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>
  html, body, #map { margin: 0; padding: 0; width: 100%; height: 100%; background: #F5F3F0; }
</style>
<script src="https://api-maps.yandex.ru/2.1/?apikey=${apiKey}&lang=ru_RU"></script>
</head>
<body>
<div id="map"></div>
<script>
  var CLINIC = [${clinic.lat}, ${clinic.lng}];
  var map = null;
  var userPlacemark = null;
  var route = null;
  var lastRouteFrom = null;

  function post(payload) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    }
  }

  function distanceMeters(a, b) {
    var toRad = function (v) { return v * Math.PI / 180; };
    var R = 6371000;
    var dLat = toRad(b[0] - a[0]);
    var dLon = toRad(b[1] - a[1]);
    var lat1 = toRad(a[0]);
    var lat2 = toRad(b[0]);
    var h = Math.sin(dLat/2)*Math.sin(dLat/2) +
            Math.sin(dLon/2)*Math.sin(dLon/2)*Math.cos(lat1)*Math.cos(lat2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function buildRoute(from) {
    if (route) { map.geoObjects.remove(route); route = null; }
    route = new ymaps.multiRouter.MultiRoute({
      referencePoints: [from, CLINIC],
      params: { routingMode: 'pedestrian' },
    }, {
      boundsAutoApply: true,
      routeActiveStrokeColor: 'D4AF37',
      routeActiveStrokeWidth: 5,
      routeActivePedestrianSegmentStrokeColor: 'D4AF37',
      routeActivePedestrianSegmentStrokeStyle: 'solid',
      wayPointVisible: false,
      pinVisible: false,
    });
    route.model.events.add('requestsuccess', function () {
      var active = route.getActiveRoute();
      if (!active) return;
      var meters = active.properties.get('distance').value;
      var seconds = active.properties.get('duration').value;
      post({ type: 'route', meters: meters, seconds: seconds });
    });
    route.model.events.add('requestfail', function () {
      post({ type: 'routeError' });
    });
    map.geoObjects.add(route);
    lastRouteFrom = from;
  }

  window.updateUserLocation = function (lat, lng) {
    if (!map) return;
    var point = [lat, lng];
    if (!userPlacemark) {
      userPlacemark = new ymaps.Placemark(point, { iconCaption: 'Вы здесь' }, {
        preset: 'islands#geolocationIcon',
        iconColor: '#D4AF37',
      });
      map.geoObjects.add(userPlacemark);
    } else {
      userPlacemark.geometry.setCoordinates(point);
    }
    if (!lastRouteFrom || distanceMeters(lastRouteFrom, point) > 30) {
      buildRoute(point);
    }
  };

  ymaps.ready(function () {
    map = new ymaps.Map('map', {
      center: CLINIC,
      zoom: 15,
      controls: ['zoomControl'],
    }, { suppressMapOpenBlock: true });

    var clinicMark = new ymaps.Placemark(CLINIC, { iconCaption: 'Клиника' }, {
      preset: 'islands#redIcon',
      iconColor: '#A8881C',
    });
    map.geoObjects.add(clinicMark);

    post({ type: 'ready' });
  });
</script>
</body>
</html>`;
}

function formatDistance(meters) {
  if (meters == null) return null;
  if (meters < 1000) return Math.round(meters) + ' м';
  return (meters / 1000).toFixed(meters < 10000 ? 1 : 0) + ' км';
}

function formatDuration(seconds) {
  if (seconds == null) return null;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return '~' + minutes + ' мин';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return '~' + h + ' ч ' + m + ' мин';
}

export default function RouteToClinicScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const webViewRef = useRef(null);
  const watchSub = useRef(null);
  const mapReadyRef = useRef(false);
  const pendingLocationRef = useRef(null);
  const clinicName = useAppSettingsStore((s) => s.clinicName);

  const [permissionDenied, setPermissionDenied] = useState(false);
  const [userCoords, setUserCoords] = useState(null);
  const [routeInfo, setRouteInfo] = useState(null);
  const [apiKeyMissing] = useState(!YANDEX_MAPS_API_KEY);

  const sendLocation = useCallback((coords) => {
    if (!webViewRef.current) return;
    if (!mapReadyRef.current) {
      pendingLocationRef.current = coords;
      return;
    }
    const js = `window.updateUserLocation(${coords.lat}, ${coords.lng}); true;`;
    webViewRef.current.injectJavaScript(js);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (cancelled) return;
      if (status !== 'granted') {
        setPermissionDenied(true);
        return;
      }
      try {
        const first = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        if (cancelled) return;
        const coords = { lat: first.coords.latitude, lng: first.coords.longitude };
        setUserCoords(coords);
        sendLocation(coords);
      } catch {}

      watchSub.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.High,
          timeInterval: 3000,
          distanceInterval: 5,
        },
        (loc) => {
          const coords = { lat: loc.coords.latitude, lng: loc.coords.longitude };
          setUserCoords(coords);
          sendLocation(coords);
        },
      );
    })();

    return () => {
      cancelled = true;
      if (watchSub.current) {
        watchSub.current.remove();
        watchSub.current = null;
      }
    };
  }, [sendLocation]);

  const handleMessage = (e) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      if (msg.type === 'ready') {
        mapReadyRef.current = true;
        if (pendingLocationRef.current) {
          sendLocation(pendingLocationRef.current);
          pendingLocationRef.current = null;
        }
      } else if (msg.type === 'route') {
        setRouteInfo({ meters: msg.meters, seconds: msg.seconds });
      }
    } catch {}
  };

  const html = buildHtml(CLINIC_LOCATION, YANDEX_MAPS_API_KEY || '');

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <BlurView intensity={60} tint="light" style={StyleSheet.absoluteFill} />
        <LinearGradient
          colors={['rgba(245,243,240,0.96)', 'rgba(237,233,227,0.88)']}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.headerRow}>
          <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
            <Ionicons name="chevron-back" size={22} color={T.stone} />
          </TouchableOpacity>
          <Text style={styles.headerTitle} numberOfLines={1}>Маршрут до клиники</Text>
          <View style={{ width: 36 }} />
        </View>
      </View>

      {apiKeyMissing ? (
        <View style={styles.stateView}>
          <Ionicons name="key-outline" size={32} color={T.stoneMid} />
          <Text style={styles.stateTitle}>Карта недоступна</Text>
          <Text style={styles.stateText}>Не задан ключ Yandex Maps (EXPO_PUBLIC_YANDEX_MAPS_KEY).</Text>
        </View>
      ) : (
        <>
          <WebView
            ref={webViewRef}
            originWhitelist={['*']}
            source={{ html }}
            onMessage={handleMessage}
            javaScriptEnabled
            domStorageEnabled
            style={styles.webview}
            startInLoadingState
            renderLoading={() => (
              <View style={styles.loading}>
                <ActivityIndicator color={T.champagne} size="large" />
              </View>
            )}
          />

          <View style={[styles.bottomPanel, { paddingBottom: insets.bottom + 16 }]}>
            <BlurView intensity={70} tint="light" style={StyleSheet.absoluteFill} />
            <LinearGradient
              colors={['rgba(245,243,240,0.88)', 'rgba(237,233,227,0.94)']}
              style={StyleSheet.absoluteFill}
            />
            <View style={styles.infoRow}>
              <View style={styles.infoIconWrap}>
                <Ionicons name="walk-outline" size={20} color={T.champagne} />
              </View>
              <View style={{ flex: 1 }}>
                {permissionDenied ? (
                  <>
                    <Text style={styles.infoLabel}>Геолокация отключена</Text>
                    <Text style={styles.infoValue}>Разрешите доступ в настройках</Text>
                  </>
                ) : !userCoords ? (
                  <>
                    <Text style={styles.infoLabel}>Определяем местоположение…</Text>
                    <Text style={styles.infoValue}>{clinicName || 'Клиника'}</Text>
                  </>
                ) : !routeInfo ? (
                  <>
                    <Text style={styles.infoLabel}>Строим маршрут…</Text>
                    <Text style={styles.infoValue}>{clinicName || 'Клиника'}</Text>
                  </>
                ) : (
                  <>
                    <Text style={styles.infoLabel}>Пешком до клиники</Text>
                    <Text style={styles.infoValue}>
                      {formatDistance(routeInfo.meters)} · {formatDuration(routeInfo.seconds)}
                    </Text>
                  </>
                )}
              </View>
            </View>

            <TouchableOpacity
              style={styles.openBtn}
              activeOpacity={0.85}
              onPress={() => openMapChooser({ to: CLINIC_LOCATION, from: userCoords })}
            >
              <LinearGradient
                colors={[T.champagne, T.champDark]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={StyleSheet.absoluteFill}
              />
              <Ionicons name="navigate-outline" size={16} color="#fff" style={{ marginRight: 8 }} />
              <Text style={styles.openBtnText}>Открыть в других картах</Text>
            </TouchableOpacity>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.pearl },
  header: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10,
    overflow: 'hidden', paddingBottom: 12,
  },
  headerRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: T.glass, borderWidth: 1, borderColor: T.glassBorder,
    justifyContent: 'center', alignItems: 'center',
  },
  headerTitle: {
    flex: 1, textAlign: 'center',
    fontSize: 17, fontWeight: '600', color: T.stone, letterSpacing: 0.3,
  },
  webview: { flex: 1, backgroundColor: T.pearl },
  loading: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    justifyContent: 'center', alignItems: 'center', backgroundColor: T.pearl,
  },
  bottomPanel: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    paddingHorizontal: 20, paddingTop: 16,
    borderTopWidth: 1, borderTopColor: 'rgba(212,175,55,0.25)',
    overflow: 'hidden',
  },
  infoRow: {
    flexDirection: 'row', alignItems: 'center', marginBottom: 14,
  },
  infoIconWrap: {
    width: 44, height: 44, borderRadius: 14,
    backgroundColor: T.champGlow, borderWidth: 1, borderColor: T.champagne + '30',
    justifyContent: 'center', alignItems: 'center', marginRight: 14,
  },
  infoLabel: { fontSize: 11, color: T.stoneMid, letterSpacing: 0.5, marginBottom: 2, textTransform: 'uppercase' },
  infoValue: { fontSize: 16, color: T.stone, fontFamily: 'serif' },
  openBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden', borderRadius: 14,
    paddingVertical: 14,
    shadowColor: T.champagne, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35, shadowRadius: 10,
  },
  openBtnText: { fontSize: 14, color: '#fff', letterSpacing: 0.5, fontWeight: '600' },
  stateView: {
    flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32,
  },
  stateTitle: { fontSize: 18, color: T.stone, fontFamily: 'serif', marginTop: 14, marginBottom: 6 },
  stateText: { fontSize: 13, color: T.stoneMid, textAlign: 'center', lineHeight: 20 },
});

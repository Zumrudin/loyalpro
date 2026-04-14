# Getting Started - Clinic Mobile App

Пошаговая инструкция по запуску и интеграции мобильного приложения.

## Шаг 1: Интеграция Backend API

### 1.1 Убедитесь что routes подключены

Проверьте `/root/loyalpro/backend/routes/index.js` - там должны быть строки:

```javascript
// ── Mobile App API (separate auth) ────────────────────────
app.use('/api/mobile/auth', require('./mobile-auth'));
app.use('/api/mobile/client', require('./mobile-client'));
```

Если их нет, добавьте.

### 1.2 Запустите миграции БД

```bash
# Подключитесь к БД и выполните миграцию
psql postgresql://loyalpro:PASSWORD@googugiherie.beget.app:5432/loyalpro < /root/loyalpro/backend/migrations/005_mobile_tables.sql
```

Или выполните SQL вручную в pgAdmin/DBeaver:

```sql
-- Скопируйте содержимое из /root/loyalpro/backend/migrations/005_mobile_tables.sql
```

### 1.3 Добавьте тестового клиента (если нужно)

```sql
UPDATE clients SET phone = '+79999999999' WHERE id = 1;
```

## Шаг 2: Настройка мобильного приложения

### 2.1 Установка зависимостей

```bash
cd /root/mobile

# Очистить старые зависимости если нужно
rm -rf node_modules package-lock.json

# Установить зависимости
npm install

# Дополнительно установить нужные пакеты для навигации
npm install @react-navigation/native-stack
```

### 2.2 Создать .env файл

```bash
cp .env.example .env
```

Отредактировать `.env`:

```
# Для продакшена:
EXPO_PUBLIC_API_URL=https://89.22.233.73

# Для локальной разработки:
# EXPO_PUBLIC_API_URL=http://10.0.2.2:3001  (Android emulator)
# EXPO_PUBLIC_API_URL=http://localhost:3001  (iOS simulator)
```

## Шаг 3: Запуск на локальной машине

### 3.1 Запустить dev server

```bash
cd /root/mobile

npm start
```

В терминале появится QR-код. Вы можете:

1. **На физическом устройстве**: Установить приложение Expo (из App Store/Google Play) и отсканировать QR-код
2. **На эмуляторе**: Нажать `a` для Android или `i` для iOS

### 3.2 Android

```bash
npm run android

# Или запустить с dev server одновременно
npm start
# Потом в отдельном окне: npm run android
```

### 3.3 iOS (требуется Mac)

```bash
npm run ios

# Или запустить с dev server
npm start
# Потом: npm run ios
```

## Шаг 4: Тестирование API

### Протестировать авторизацию

```bash
# 1. Отправить OTP на номер телефона
curl -X POST https://89.22.233.73/api/mobile/auth/login \
  -H "Content-Type: application/json" \
  -d '{"phone":"+79999999999"}'

# Ответ должен быть:
# {"success":true,"message":"Код отправлен. Проверьте СМС.","phone":"79999999999","otp":"1234"}

# 2. Проверить OTP (используйте код из логов/ответа выше)
curl -X POST https://89.22.233.73/api/mobile/auth/verify-otp \
  -H "Content-Type: application/json" \
  -d '{"phone":"79999999999","otp":"1234"}'

# Ответ должен содержать token:
# {"success":true,"token":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...","user":{...}}

# 3. Использовать токен для других запросов
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."

curl -X GET https://89.22.233.73/api/mobile/auth/me \
  -H "Authorization: Bearer $TOKEN"
```

## Шаг 5: SMS настройка (для production)

В разработке используется тестовый OTP, который выводится в логи.

Для production используйте один из сервисов:

### Twilio

```bash
npm install twilio

# В backend код добавить:
const twilio = require('twilio');
const client = twilio(ACCOUNT_SID, AUTH_TOKEN);

// В mobile-auth.js в функции login:
await client.messages.create({
  body: `Ваш код: ${otp}`,
  from: TWILIO_PHONE,
  to: normalizedPhone
});
```

### AWS SNS

```bash
npm install aws-sdk

const AWS = require('aws-sdk');
const sns = new AWS.SNS();

await sns.publish({
  Message: `Ваш код: ${otp}`,
  PhoneNumber: normalizedPhone
}).promise();
```

## Шаг 6: Firebase настройка (для push-уведомлений)

### 6.1 Создать Firebase проект

1. Перейти на https://console.firebase.google.com
2. Создать новый проект "Clinic App"
3. Добавить Android приложение (package: `com.clinic.app`)
4. Добавить iOS приложение (bundle id: `com.clinic.app`)

### 6.2 Скачать конфиги

- Android: `google-services.json` → `/root/mobile/`
- iOS: `GoogleService-Info.plist` → `/root/mobile/ios/`

### 6.3 Установить Firebase в мобильное приложение

```bash
npx expo install expo-firebase-recaptcha firebase
```

### 6.4 Регистрировать токен при входе

В `src/screens/LoginScreen.js` или `src/store/authStore.js` добавить:

```javascript
import * as Notifications from 'expo-notifications';

const handleOtpSubmit = async () => {
  // ... проверка OTP ...
  
  // Регистрировать FCM токен
  const { data } = await Notifications.getPermissionsAsync();
  if (data.granted) {
    const token = await Notifications.getExpoPushTokenAsync();
    await clientDataAPI.registerFcmToken(token.data);
  }
};
```

## Шаг 7: Сборка для Production

### Android

```bash
eas login

eas build --platform android
# После завершения:
eas submit --platform android
```

### iOS (требуется macOS)

```bash
eas build --platform ios
# После завершения:
eas submit --platform ios
```

## Troubleshooting

### Приложение не подключается к API

**Проблема**: Ошибка при попытке залогиниться
**Решение**:
- Проверить что `EXPO_PUBLIC_API_URL` правильный в `.env`
- Убедиться что бэк сервер запущен и доступен
- Для локального тестирования использовать `http://10.0.2.2:3001` на Android эмуляторе

### OTP не отправляется

**Проблема**: Получу ошибку "Код отправлен" но SMS не приходит
**Решение**:
- В development режиме OTP выводится в логи сервера
- Для production настроить Twilio/AWS SNS (см. Шаг 5)

### Push-уведомления не работают

**Проблема**: Не получаю push-уведомления
**Решение**:
- Убедиться что Firebase настроен (Шаг 6)
- Проверить что приложение разрешает уведомления
- Убедиться что `registerFcmToken` вызывается при входе

### React Navigation ошибка

**Проблема**: "Can't find native module 'RNScreens'"
**Решение**:
```bash
npx expo prebuild --clean
npm install
```

### Версия React/React Native конфликт

**Проблема**: Ошибка зависимостей при npm install
**Решение**:
```bash
rm -rf node_modules package-lock.json
npm install
npx expo doctor  # Проверить здоровье проекта
```

## Полезные команды

```bash
# Проверить здоровье проекта
npx expo doctor

# Очистить кэш и переустановить
npm install --legacy-peer-deps

# Запустить в режиме локального туннеля (для тестирования на физическом устройстве)
npx expo start --tunnel

# Сбросить Expo кэш
npx expo start --clear

# Просмотр логов
npx expo logs
```

## Что дальше?

1. ✅ **Интегрировать Yclients API** - добавить получение специалистов/услуг
2. ✅ **Настроить SMS** - для реального OTP в production
3. ✅ **Настроить Firebase** - для push-уведомлений
4. ✅ **Добавить больше функций** - например запись к специалистам
5. ✅ **Публикация** - в AppStore и Google Play

## Документация

- [React Navigation](https://reactnavigation.org/)
- [Expo](https://docs.expo.dev/)
- [React Native](https://reactnative.dev/)
- [Zustand](https://github.com/pmndrs/zustand)
- [Firebase](https://firebase.google.com/docs)

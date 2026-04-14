# Clinic Mobile App

Мобильное приложение для клиентов клиники на базе React Native (Expo).

## Характеристики

- 📱 iOS и Android (через React Native + Expo)
- 🔐 Безопасная аутентификация по номеру телефона + OTP
- 📅 Просмотр и управление записями к специалистам
- 💰 Отслеживание бонусов и программы лояльности
- 🔔 Push-уведомления о записях и предложениях
- 👤 Личный кабинет с профилем
- 📬 История уведомлений

## Стек технологий

- **Framework**: React Native (Expo)
- **Navigation**: React Navigation v6
- **State Management**: Zustand
- **HTTP Client**: Axios
- **Push Notifications**: Firebase Cloud Messaging (FCM)
- **Secure Storage**: Expo SecureStore
- **UI Framework**: React Native Built-in Components
- **Date Handling**: date-fns

## Установка

### Требования
- Node.js 18+
- Expo CLI (`npm install -g expo-cli`)
- iOS simulator или Android emulator
- Физическое устройство (опционально)

### Шаги установки

```bash
# 1. Перейти в папку проекта
cd /root/mobile

# 2. Установить зависимости
npm install

# 3. Создать .env файл из примера
cp .env.example .env

# 4. Отредактировать .env с правильным API URL
# EXPO_PUBLIC_API_URL=https://89.22.233.73
```

## Запуск

### Development
```bash
# Запустить на Android
npm run android

# Запустить на iOS
npm run ios

# Запустить в браузере (для тестирования)
npm run web

# Запустить Expo dev server
npm start
```

### Production Build
```bash
# Android
eas build --platform android

# iOS
eas build --platform ios

# Оба
eas build
```

## Структура проекта

```
/mobile
├── src/
│   ├── api/                    # API клиент и endpoints
│   │   ├── client.js          # Axios конфигурация
│   │   ├── auth.js            # Endpoints аутентификации
│   │   └── client-data.js     # Endpoints данных клиента
│   ├── screens/               # Экраны приложения
│   │   ├── LoginScreen.js     # Вход (номер + OTP)
│   │   ├── HomeScreen.js      # Главная (баланс, записи, действия)
│   │   ├── BookingsScreen.js  # История и управление записями
│   │   ├── ProfileScreen.js   # Профиль клиента и настройки
│   │   └── NotificationsScreen.js  # История уведомлений
│   ├── components/            # Переиспользуемые компоненты
│   ├── store/                 # Zustand хранилище состояния
│   │   ├── authStore.js       # Авторизация
│   │   └── clientStore.js     # Данные клиента
│   ├── utils/                 # Утилиты (форматирование, валидация)
│   └── navigation/            # Навигация (React Navigation)
├── App.js                     # Корневой компонент приложения
├── app.json                   # Конфигурация Expo
└── package.json               # Зависимости
```

## API Endpoints

### Аутентификация
- `POST /api/mobile/auth/login` - Отправить код на номер телефона
- `POST /api/mobile/auth/verify-otp` - Проверить код и получить токен
- `GET /api/mobile/auth/me` - Получить текущего пользователя
- `POST /api/mobile/auth/logout` - Выйти из аккаунта

### Данные клиента
- `GET /api/mobile/client/profile` - Профиль клиента
- `GET /api/mobile/client/bookings` - Список записей
- `GET /api/mobile/client/bookings/:id` - Деталь записи
- `POST /api/mobile/client/bookings/:id/cancel` - Отменить запись
- `GET /api/mobile/client/bonuses` - Баланс бонусов
- `GET /api/mobile/client/bonus-history` - История бонусов
- `GET /api/mobile/client/notifications` - Уведомления
- `POST /api/mobile/client/notifications/:id/read` - Отметить как прочитанное
- `POST /api/mobile/client/fcm-token` - Регистрация FCM токена

## Аутентификация

### Процесс входа
1. Пользователь вводит номер телефона
2. На номер отправляется 4-значный OTP код
3. Пользователь вводит код
4. Сервер проверяет код и возвращает JWT токен
5. Токен сохраняется в Secure Storage
6. Токен автоматически передается во всех запросах

### Обновление токена
Токены действительны 30 дней. При истечении просим повторной авторизации.

## Push-уведомления

### Настройка Firebase

1. Создать проект на [Firebase Console](https://console.firebase.google.com)
2. Добавить Android и iOS приложения
3. Скачать `google-services.json` для Android и `GoogleService-Info.plist` для iOS
4. Добавить эти файлы в проект

### Регистрация токена

```javascript
// После успешного входа
const token = await getMessaging().getToken();
await clientDataAPI.registerFcmToken(token);
```

## Развертывание

### App Store (iOS)

```bash
# 1. Создать Apple Developer Account
# 2. Создать сертификаты и provisioning profiles
# 3. Запустить build
eas build --platform ios

# 4. Загрузить на App Store Connect
eas submit --platform ios
```

### Google Play (Android)

```bash
# 1. Создать Google Play Developer Account
# 2. Создать приложение и получить ключи
# 3. Запустить build
eas build --platform android

# 4. Загрузить на Google Play
eas submit --platform android
```

## Переменные окружения

Создать `.env` файл в корне проекта:

```
EXPO_PUBLIC_API_URL=https://89.22.233.73
```

## Troubleshooting

### Приложение не подключается к API
- Проверить, что API_URL в `.env` правильный
- Убедиться что бэк сервер запущен и доступен
- Проверить CORS настройки на бэке

### OTP не приходит
- Проверить что SMS сервис настроен на бэке
- В development режиме OTP выводится в консоль бэка

### Push-уведомления не работают
- Убедиться что FCM токен регистрируется при входе
- Проверить что приложение разрешает уведомления
- Проверить Firebase конфигурацию

## Разработка

### Добавление нового экрана

1. Создать файл `src/screens/NewScreen.js`
2. Добавить route в `App.js`
3. Добавить navigation link если нужно

### Добавление нового API endpoint

1. Создать метод в `src/api/client-data.js`
2. Добавить route на бэке в `backend/routes/mobile-*.js`
3. Использовать в компоненте через Zustand store

## Лицензия

MIT

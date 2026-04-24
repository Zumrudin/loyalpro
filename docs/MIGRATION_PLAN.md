# План миграции LoyalPro на продовый сервер

_Дата составления: 2026-04-21_

Источник: текущий сервер `89.22.233.73`, Node.js 20 + PM2, Nginx, БД PostgreSQL на Beget (`googugiherie.beget.app:5432/loyalpro`), HTTP без SSL, мобилка и Telegram-бот завязаны на текущий IP.

---

## Этап 0 — Что подготовить ДО начала (предварительный чеклист)

**Доступы и ресурсы:**
- [ ] Root/sudo SSH-доступ к новому серверу (Ubuntu 22.04 LTS рекомендуется)
- [ ] Доменное имя (например, `loyalpro.ru` или `api.loyalpro.ru`) — без него полноценный HTTPS не сделать
- [ ] DNS-записи: A-запись домена → IP нового сервера (сделать заранее, TTL 300 для быстрого переключения)
- [ ] Доступ к кабинету Beget (там БД `googugiherie.beget.app:5432/loyalpro`)
- [ ] Доступ к YClients API (chain_id, company_id, токены, webhook URL)
- [ ] Доступ к панели Telegram BotFather (для бота `8294987984:...`)
- [ ] Доступ к SMS.ru (для OTP мобильного приложения)
- [ ] Доступ к репозиторию (GitHub/GitLab) или возможность скопировать код

**Информация с текущего сервера (выписать заранее):**
- [ ] Все переменные окружения (сейчас лежат в `backend/ecosystem.config.js` — это **плохая практика**, секреты в git)
- [ ] Список салонов в таблице `salons` (chain_id, company_id, oauth токены)
- [ ] Список YClients webhook URL'ов, которые прописаны в панели YClients
- [ ] IP текущего сервера: `89.22.233.73` (для сравнения и отката)

**Решения, которые надо принять заранее:**
- [ ] Доменное имя для API и фронта (один домен или два)
- [ ] Остаётся ли БД на Beget или переносим на новый сервер в локальный PostgreSQL (рекомендую оставить на Beget — меньше работы)
- [ ] План даунтайма: «мягкий переход» (параллельная работа двух серверов) vs «жёсткий» (остановка, миграция, запуск)
- [ ] Окно обслуживания (ночь, когда нет клиентов)

---

## Этап 1 — Подготовка нового сервера

### 1.1 Базовая настройка ОС
```bash
# Обновить систему
apt update && apt upgrade -y

# Часовой пояс (важно — в коде используется TZ=Europe/Moscow)
timedatectl set-timezone Europe/Moscow

# Создать пользователя для приложения (не работать из-под root на проде)
adduser loyalpro
usermod -aG sudo loyalpro

# SSH ключи, отключить парольный вход
# /etc/ssh/sshd_config: PermitRootLogin no, PasswordAuthentication no
```

### 1.2 Фаервол
```bash
ufw allow 22/tcp       # SSH
ufw allow 80/tcp       # HTTP (для Let's Encrypt)
ufw allow 443/tcp      # HTTPS
ufw enable
# Порт 3001 НЕ открывать наружу — только через Nginx
```

### 1.3 Установка стека
```bash
# Node.js 20 (как на текущем сервере)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# PM2 глобально
npm install -g pm2

# Nginx
apt install -y nginx

# Certbot для Let's Encrypt
apt install -y certbot python3-certbot-nginx

# Git
apt install -y git

# Python 3 + pip (для Telegram-бота клиентов, если переносим)
apt install -y python3 python3-pip python3-venv
```

---

## Этап 2 — Перенос кода

### 2.1 Клонировать репозиторий
```bash
cd /home/loyalpro
git clone <repo-url> loyalpro
cd loyalpro/backend
npm ci --omit=dev   # ставим строго по package-lock.json
```

> **Не копируйте `node_modules` rsync'ом** — это 200+ МБ мусора, и нативные модули (bcryptjs, pg) могут быть собраны под другую версию ОС.

### 2.2 Перенос данных приложения
С текущего сервера на новый:
```bash
# С текущего сервера
rsync -avz /root/loyalpro/frontend/uploads/ loyalpro@NEW_IP:/home/loyalpro/loyalpro/frontend/uploads/
rsync -avz /root/loyalpro/backend/data/ loyalpro@NEW_IP:/home/loyalpro/loyalpro/backend/data/
rsync -avz /root/loyalpro/backend/logs/ loyalpro@NEW_IP:/home/loyalpro/loyalpro/backend/logs/
```

Объём небольшой: `frontend/uploads` ~744 КБ, `backend/data` ~80 КБ.

### 2.3 БД на Beget (НЕ переносим)
- В панели Beget: **разрешить подключение с IP нового сервера** (whitelist).
- Строка подключения та же: `postgresql://loyalpro:***@googugiherie.beget.app:5432/loyalpro`.
- Перед переключением **сделать дамп БД** (страховка):
  ```bash
  pg_dump "postgresql://loyalpro:***@googugiherie.beget.app:5432/loyalpro" \
    -Fc -f loyalpro_backup_$(date +%Y%m%d).dump
  ```

---

## Этап 3 — Секреты и конфигурация

### 3.1 Вынести секреты из git
> **Критично:** сейчас в `backend/ecosystem.config.js:6-15` в репозитории лежат `JWT_SECRET`, пароль БД, токен Telegram. Это утечка.

Создать `/home/loyalpro/loyalpro/backend/.env` (в `.gitignore` уже есть):
```env
NODE_ENV=production
PORT=3001
DATABASE_URL=postgresql://loyalpro:***@googugiherie.beget.app:5432/loyalpro
DB_SSL=true
JWT_SECRET=<сгенерировать новый: openssl rand -hex 64>
FRONTEND_URL=https://loyalpro.ru
ALLOWED_ORIGINS=https://loyalpro.ru,https://api.loyalpro.ru
TZ=Europe/Moscow
TELEGRAM_BOT_TOKEN=<текущий токен>
```

Переписать `ecosystem.config.js`, чтобы читал из `.env` (через `dotenv`, который уже есть в зависимостях):
```js
module.exports = {
  apps: [{
    name: 'loyalpro',
    script: './server.js',
    cwd: '/home/loyalpro/loyalpro/backend',
    env: { NODE_ENV: 'production' },
    max_memory_restart: '500M',
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    time: true,
  }]
}
```

### 3.2 Ротация JWT_SECRET
При смене `JWT_SECRET` все текущие токены инвалидируются — **все пользователи должны будут залогиниться заново**. Это плюс для безопасности. Предупредить команду.

### 3.3 Обновить CORS whitelist
В `backend/server.js:41-52` хардкод старых IP. После переезда лучше использовать `ALLOWED_ORIGINS` из env (там это уже поддержано) и убрать старые записи.

---

## Этап 4 — Nginx + HTTPS

### 4.1 Конфиг Nginx
`/etc/nginx/sites-available/loyalpro`:
```nginx
server {
    listen 80;
    server_name loyalpro.ru api.loyalpro.ru;

    # Certbot challenge
    location /.well-known/acme-challenge/ { root /var/www/html; }

    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name loyalpro.ru api.loyalpro.ru;

    # SSL сертификаты добавит certbot автоматически

    client_max_body_size 10M;  # для загрузки фото в home-care

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_read_timeout 300s;  # для долгих YClients sync запросов
    }
}
```

```bash
ln -s /etc/nginx/sites-available/loyalpro /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

### 4.2 Let's Encrypt
```bash
certbot --nginx -d loyalpro.ru -d api.loyalpro.ru
# Автообновление уже настроено через systemd-таймер certbot.timer
```

### 4.3 HSTS после проверки HTTPS
В `backend/server.js:25` стоит `hsts: false` — после успешного запуска на HTTPS **включить** `hsts: true` в helmet.

---

## Этап 5 — Запуск приложения

### 5.1 Первый запуск
```bash
cd /home/loyalpro/loyalpro/backend
pm2 start ecosystem.config.js
pm2 logs loyalpro --lines 100   # проверить старт: миграции, cron-задачи, подключение к БД
pm2 save
pm2 startup systemd             # сгенерирует команду — выполнить от root
```

### 5.2 Проверки после запуска
- [ ] `curl https://api.loyalpro.ru/` → отдаёт index.html
- [ ] `curl https://api.loyalpro.ru/api/me` без токена → 401 (ожидаемо)
- [ ] Залогиниться в веб-интерфейсе с тестового аккаунта
- [ ] Проверить дашборд (данные грузятся из БД)
- [ ] Проверить что cron-задачи запланированы: в логах должно быть сообщение при старте
- [ ] Телеграм-бот отвечает на `/start` (OTP для мобилки)

---

## Этап 6 — Переключение интеграций

### 6.1 YClients webhooks
В панели YClients для каждого салона **поменять webhook URL**:
- Было: `http://89.22.233.73/webhook` (или `:3001/webhook`)
- Стало: `https://api.loyalpro.ru/webhook`

### 6.2 Мобильное приложение
В `mobile/src/api/client.js` (и/или `.env` Expo) поменять `EXPO_PUBLIC_API_URL`:
- Было: `https://89.22.233.73`
- Стало: `https://api.loyalpro.ru`

Это требует **перебилда мобильного приложения** (EAS build) и публикации в сторы. Если это блокер — временно оставить старый сервер работать параллельно, пока мобилка не обновится у всех клиентов.

### 6.3 DNS переключение
Когда всё проверено на новом сервере по его IP (через `/etc/hosts` локально или временный поддомен):
- Поменять A-запись основного домена → IP нового сервера
- Ждать распространения (обычно 5–15 минут при TTL 300)

### 6.4 Telegram-бот клиентов (Python)
Если бот (`telegram_loyalty_bot`) тоже крутится на старом сервере — перенести отдельно:
```bash
# На новом сервере
python3 -m venv /home/loyalpro/bot-venv
source /home/loyalpro/bot-venv/bin/activate
pip install -r requirements.txt
# Запустить через systemd unit или pm2 (pm2 умеет python)
```

---

## Этап 7 — Мониторинг и резервное копирование

### 7.1 Бэкап БД (cron на новом сервере)
`/etc/cron.d/loyalpro-backup`:
```
0 3 * * * loyalpro pg_dump "$DATABASE_URL" -Fc -f /home/loyalpro/backups/loyalpro_$(date +\%Y\%m\%d).dump && find /home/loyalpro/backups -name "*.dump" -mtime +14 -delete
```

### 7.2 Бэкап uploads
```
0 4 * * * loyalpro tar czf /home/loyalpro/backups/uploads_$(date +\%Y\%m\%d).tar.gz /home/loyalpro/loyalpro/frontend/uploads
```

### 7.3 Мониторинг
- `pm2 monit` или подключить PM2 Plus (бесплатный уровень)
- Uptime Robot / Better Uptime на `https://api.loyalpro.ru/` с алертом в Telegram
- Лог-ротация уже настроена через `winston-daily-rotate-file` (в зависимостях)

---

## Этап 8 — Финал и откат

### 8.1 Проверочный чеклист после переключения
- [ ] Веб-фронт открывается, логин работает
- [ ] Дашборд показывает данные
- [ ] Клиенты, staff, home-care — все страницы грузят данные
- [ ] Мобильное приложение логинится по OTP
- [ ] YClients webhook приходит (проверить в логах после записи в YClients)
- [ ] Cron-задачи отработали (проверить логи через 1–3 часа)
- [ ] HTTPS корректный (sslabs.com/ssltest — оценка A)

### 8.2 План отката (держать 1–2 недели)
- Старый сервер **не выключать** ~14 дней
- Если критический баг — переключить DNS обратно на старый IP
- БД одна и та же (Beget) — данные синхронизированы автоматически

### 8.3 Cleanup старого сервера
После 2 недель стабильной работы:
- Снять бэкап `/root/loyalpro` целиком
- Остановить PM2, удалить код
- В Beget убрать whitelist старого IP

---

## Частые грабли на миграциях (чего остерегаться)

1. **Секреты в git** — `ecosystem.config.js` уже в истории. После миграции: сгенерировать новый `JWT_SECRET`, сменить пароль БД на Beget, отозвать и пересоздать Telegram-токен через BotFather.
2. **Часовой пояс** — без `TZ=Europe/Moscow` cron-задачи уедут на UTC, дни рождения начислятся не тем.
3. **Nginx `client_max_body_size`** — по умолчанию 1 МБ, а в Express стоит лимит 2 МБ; фото в home-care могут резаться.
4. **SSL сертификат** — Let's Encrypt требует, чтобы DNS уже смотрел на сервер. DNS настраивать за сутки до миграции.
5. **Мобильное приложение** обновляется у пользователей не сразу — нужен параллельный период работы старого сервера или nginx-прокси со старого IP на новый.
6. **YClients rate limits** — после рестарта cron может ломануться синхронизироваться и упереться в лимит; лучше запустить вне часа пик.

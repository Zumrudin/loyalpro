# Встройка формы заявки на справку в сайт Wix

Форма хостится в LoyalPro и встраивается в страницу Wix через iframe.

## Шаги
1. URL формы: `https://<домен-LoyalPro>/cert-request/<slug-клиники>`.
   Slug клиники = значение `salons.cert_request_slug` (по умолчанию `clinic-<id>`).
2. В редакторе Wix: **Добавить → Встраивание (Embed) → Встроить HTML (iframe)**.
3. Вставить:
   ```html
   <iframe src="https://<домен-LoyalPro>/cert-request/clinic-1"
           style="width:100%;height:1200px;border:0" loading="lazy"></iframe>
   ```
4. Подогнать `height` под форму (фикс. высота — ограничение iframe).
5. Убедиться, что домен Wix входит в `CERT_REQUEST_FRAME_ANCESTORS`
   (env-переменная на бэке, через запятую). Иначе браузер заблокирует iframe.

## Проверка
- Открыть страницу Wix → форма отображается, отправляется, «Заявление» скачивается.
- Заявка появляется в LoyalPro → «Заявки на справки».

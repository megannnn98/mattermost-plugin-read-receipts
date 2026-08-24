# Read Receipts Plugin for Mattermost

Плагин для отображения индикаторов прочтения сообщений в 1:1 DM-переписках в Mattermost Desktop.

## Requirements

- **Mattermost Server**: v9.5.0+
- **Mattermost Desktop**: любой версии с `window.desktopAPI` (5.0+)
- **Браузер**: плагин **не работает** в браузере (намеренное ограничение)

## Features

- Индикатор `✓✓ Прочитано HH:MM` под собственными сообщениями в DM, когда получатель прочитал
- Работает **только в Mattermost Desktop** (детект через `window.desktopAPI.getAppInfo()`)
- Учёт фокуса окна, видимости поста (IntersectionObserver), активности пользователя, dwell-time 1 секунда
- Монохромный watermark: индикатор никогда не «пропадает»
- Данные хранятся в KV-хранилище плагина с настраиваемым TTL
- Идемпотентная обработка повторных прочтений
- Минимальное количество HTTP-запросов (обычно 1-2 на открытие канала)

## Limitations

- **Только Mattermost Desktop**: в браузере плагин не регистрирует ни компонентов, ни обработчиков. Детект — best-effort по `window.desktopAPI`, не защита от подделки.
- **Только DM 1:1** (`channel.type == "D"`): Group DM, public/private каналы, threads — вне MVP.
- **Зависимости от внутренних деталей Mattermost**:
  - слот `PostMessageAttachment` (не рендерится для удалённых постов, постов с plugin post type и при `enableFormatting=false`)
  - формат `custom_<pluginid>_<event>`
  - cookie `MMCSRF`
  - `window.desktopAPI.getAppInfo` / `onUserActivityUpdate`
- **PostHeader-слот** сознательно не используется (гейт `showPostHeaderBadge` скрывает его на consecutive-постах).
- **Точное время** прочтения хранится `ReceiptRetentionDays` (по умолчанию 30) дней; для более старых постов остаётся факт прочтения (watermark) с приближённым временем.
- Сообщения, прочитанные в браузере или на мобиле, receipt **не порождают** — это ожидаемое поведение.

## Build

```bash
# Убедитесь, что Go 1.23+ и Node.js 18+ установлены
make          # check-style + test + dist
make test     # только тесты
make dist     # только сборка dist/*.tar.gz
```

Результат: `dist/com.integrasources.read-receipts-0.1.0.tar.gz`

## Install

1. Скачайте `dist/com.integrasources.read-receipts-0.1.0.tar.gz`
2. Откройте **System Console → Plugins → Upload**
3. Загрузите `.tar.gz`
4. Включите плагин: **System Console → Plugins → Read Receipts → Enable**
5. Настройте параметры:
   - **Enable debug logging**: включите для отладки (логирует только ID постов/пользователей)
   - **Receipt retention (days)**: сколько дней хранить точное время прочтения (по умолчанию 30)

Или через `mmctl`:

```bash
mmctl plugin add dist/com.integrasources.read-receipts-0.1.0.tar.gz
mmctl plugins enable com.integrasources.read-receipts
```

## Enable

После установки плагин автоматически активируется. Пользователи должны перезагрузить Mattermost Desktop.

## Development

```bash
# Серверные тесты
cd server && go test -v ./...

# Webapp-тесты
cd webapp && npm install && npm run test

# Typecheck
cd webapp && npm run typecheck

# Build webapp в watch-режиме
cd webapp && npm run dev
```

## Architecture

### Компоненты плагина

```
mattermost-plugin-read-receipts/
├── plugin.json          # манифест (min_server_version 9.5.0, settings_schema)
├── server/
│   ├── plugin.go        # OnActivate/OnConfigurationChange, router
│   ├── api.go           # POST /api/v1/read, POST /api/v1/receipts/query
│   ├── permissions.go   # DM-only + membership + «не автор» проверки
│   ├── receipts.go      # KV storage (watermark + per-post)
│   └── *_test.go        # серверные тесты (plugintest моки)
└── webapp/
    ├── src/index.tsx            # initialize(): detect desktop → регистрировать или нет
    ├── src/desktop.ts           # isDesktopClient() через window.desktopAPI
    ├── src/client.ts            # fetch + X-CSRF-Token + X-Requested-With
    ├── src/actions.ts           # fetchChannelReceipts(), reportRead() (дедупликация)
    ├── src/reducer.ts           # Redux reducer
    ├── src/selectors.ts         # isPostRead(), selectPostReadAt()
    ├── src/visibility.ts        # IntersectionObserver + focus/idle/dwell gating
    ├── src/websocket.ts         # custom_<id>_read_receipt handler
    └── src/components/read_receipt.tsx  # UI-компонент
```

### Модель данных (KV)

**Watermark** (`wm_<channelID>_<readerID>`):
- `{post_id, create_at, read_at}` — монотонный watermark, без TTL
- Обновление: только если `new.create_at > old.create_at` (гонки и «прокрутка назад» не откатывают состояние)

**Per-post receipt** (`rr_<postID>_<readerID>`):
- `read_at` (int64), `ExpireInSeconds = ReceiptRetentionDays*86400`
- Запись только если ключа ещё нет (Atomic: true, OldValue: nil) → «first write wins», повторный read полностью идемпотентен

Ответ «прочитано?» для поста:
- `post.create_at <= watermark.create_at` → прочитано
- Точное время — из `rr_*`, иначе (старше TTL) — `watermark.read_at` как приближение

### REST API

**POST `/plugins/com.integrasources.read-receipts/api/v1/read`**
```json
{"post_id": "..."}
```
→ 200 `{"post_id","channel_id","create_at","read_at"}`

Проверки:
- `Mattermost-User-Id` присутствует
- Пост существует
- Канал типа D (DM)
- Вызывающий — участник канала (`HasPermissionToChannel(..., PermissionReadChannel)`)
- Вызывающий ≠ автор поста

Затем watermark + per-post запись; WS-событие публикуется только если watermark продвинулся.

**POST `/plugins/.../api/v1/receipts/query`**
```json
{"channel_id": "...", "post_ids": ["..."]}
```
→ `{"watermark": {...} | null, "receipts": {"<post_id>": read_at}}`

Возвращаются данные другого участника DM; вызывающий обязан быть участником, канал — D; `post_ids` ограничены (max 200).

### WebSocket

`PublishWebSocketEvent("read_receipt", payload, &model.WebsocketBroadcast{UserId: postAuthorID})`

У отправителя приходит `custom_com.integrasources.read-receipts_read_receipt`:
```json
{
  "channel_id": "...",
  "post_id": "...",
  "create_at": 1234567890,
  "read_at": 1234567900,
  "reader_id": "..."
}
```

Никакой рассылки всем — только автору поста.

### Клиент: когда считаем «прочитано»

Все условия одновременно:
1. `isDesktopClient() == true` (проверено один раз при `initialize`)
2. Канал поста == `currentChannelId` и тип канала D
3. Окно активно: `document.visibilityState === 'visible'` и `document.hasFocus()`
4. Пользователь не idle: `window.desktopAPI.onUserActivityUpdate((active) => ...)`
5. Элемент поста реально виден: `IntersectionObserver` (threshold: 0.75)
6. Dwell ≥ 1000 мс непрерывной видимости
7. Дедупликация: локальный watermark `sentCreateAt[channelId]` + `Set` отправленных `post_id`

Отправляется один запрос на пост (обычно 1–2 при открытии канала); при пачке видимых постов отправляется только самый новый (остальные покрываются watermark'ом).

### UI

Компонент на слоте `PostMessageAttachment` (получает `postId`):
- Пост не в DM, или удалён, или state плагина пуст → `null`
- Свой пост и он прочитан → строка под текстом: `✓✓ Прочитано 17:42`
- Свой пост не прочитан → `null`
- Чужой пост → невидимый sentinel (`<span aria-hidden>`) с ref для `IntersectionObserver`

Сообщения/props постов не изменяются.

## Manual Testing Checklist (DoD)

1. Установите плагин на сервере
2. Откройте Mattermost Desktop у **пользователя A** (отправитель)
3. Откройте Mattermost Desktop у **пользователя B** (получатель)
4. **A → B**: отправьте сообщение «test message»
5. У **A** индикатора **нет** (сообщение не прочитано)
6. **B** открывает DM с **A**, сообщение попадает в видимую область при активном окне
7. У **A** **без reload** появляется `✓✓ Прочитано HH:MM`
8. После перезапуска Desktop статус **сохраняется** (данные в KV)
9. Если **B** открывает тот же DM в **браузере** — receipt **не отправляется** (в браузере нет `window.desktopAPI`)

## Dependencies on Mattermost Internals

Плагин зависит от следующих внутренних деталей Mattermost:

**Server Plugin API** (стабильные, документированные):
- `plugin.API.KVGet`, `KVSetWithOptions` — KV-хранилище
- `plugin.API.GetPost`, `GetChannel`, `GetChannelMembers`, `HasPermissionToChannel`
- `plugin.API.PublishWebSocketEvent`
- `model.WebsocketBroadcast{UserId: ...}` — адресная доставка
- `model.ChannelTypeDirect` — тип канала DM

**Webapp Plugin Registry** (стабильные, но не документированы публично):
- `registerReducer(reducer)` — добавление в Redux state
- `registerWebSocketEventHandler(event, handler)` — обработка WS-событий
- `registerPostMessageAttachmentComponent(component)` — рендеринг под текстом поста

**Desktop API** (нестабильные, могут измениться):
- `window.desktopAPI.getAppInfo()` — детект Desktop
- `window.desktopAPI.onUserActivityUpdate(listener)` — idle-статус

**Клиентские детали**:
- Cookie `MMCSRF` — CSRF-токен
- Формат WS-событий: `custom_<pluginid>_<event>`

## License

MIT

## Support

Issues: https://github.com/integrasources/mattermost-plugin-read-receipts/issues

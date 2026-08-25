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
- **Точное время** прочтения хранится `ReceiptRetentionDays` (по умолчанию 30) дней; допустимый диапазон **1…3650**, значения ≤ 0 откатываются к дефолту (30), слишком большие клампятся к максимуму (3650); для старых постов остаётся факт прочтения (watermark) с приближённым временем.
- Сообщения, прочитанные в браузере или на мобиле, receipt **не порождают** — это ожидаемое поведение.

## Build

```bash
# Убедитесь, что Go 1.23+ и Node.js 18+ установлены
make          # check-style + test + dist
make test     # только тесты
make dist     # только сборка dist/*.tar.gz
```

Результат: `dist/com.integrasources.read-receipts-0.1.0.tar.gz`

Зависимости webapp ставятся воспроизводимо через `npm ci` (по lock-файлу). Для
обновления зависимостей и перегенерации lock-файла — `make node-deps-update`
(вызовет `npm install`). Сборка серверной части `make server` сама создаёт
`server/dist`, так что `make clean && make server` безопасны.

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

## Test

```bash
make test          # go test -race ./... + tsc --noEmit + jest
make check-style   # gofmt -l (fail при расхождении) + go vet + eslint
```

Покрыто (server, `plugintest`-моки на fakeKV с настоящей CAS-семантикой): создание
и повторный receipt (идемпотентность, first-write-wins), watermark не откатывается
назад (монотонность под конкурентностью N горутин, `-race`), изоляция receipt между
каналами (post из чужого DM не отдаётся), частичные сбои KV (запись receipt падает —
watermark не тронут и 500; CAS watermark падает — 500 и без WS), 401 без
`Mattermost-User-Id` (оба эндпоинта), 403 для постороннего пользователя / автора
собственного поста / не-DM канала, identity только из заголовка (id в теле
игнорируется), query-лимит (макс 200, невалидные id отбрасываются), битый JSON /
пустой channel_id / тело больше лимита → 4xx, клампинг `ReceiptRetentionDays`
(0, отрицательное, 1e9).

Покрыто (webapp, jest): desktop-детект, reducer и селекторы, дедупликация, gating
(чужой пост в открытом DM / свой пост / другой канал / не-DM / удалённый пост), channel watcher
(загрузка при открытии, один раз на канал, переключение канала, ожидание постов, `refresh()`,
`stop()`, переключение канала во время in-flight запроса не теряется, порядок «новые первыми»),
websocket-обработчик (совпадение события, приведение типов, игнор мусора, отбрасывание события
с чужим `author_id`), i18n, visibility-трекер, `visibility_ratio` (низкий ratio → нет отправки,
высокий → dwell, падение ниже порога во время dwell отменяет отправку, tall-post fallback по
`intersectionRect.height`), `usePluginSelector` (селективность: нет rerender на нерелевантный
action), локальное чтение не помечает свои посты прочитанными (нет dispatch, id в body игнорируется),
компонент ReadReceipt (dwell, отсутствие чтения без фокуса, перезапуск dwell при возврате фокуса,
отсутствие двойного отчёта, retry после сбоя сети с backoff, отмена retry на blur).

Каждый регрессионный тест проверен мутацией: правка снимается — тест обязан упасть.

`golangci-lint` в проекте необязателен: если он есть в `PATH`, `make check-style` его запускает,
иначе гейтом остаются `gofmt` + `go vet` (о пропуске печатается сообщение).

## Development

```bash
# Серверные тесты
cd server && go test -race ./...

# Webapp-тесты
cd webapp && npm ci && npm run test

# Typecheck и линт
cd webapp && npm run typecheck && npm run lint

# Build webapp в watch-режиме
cd webapp && npm run dev
```

Сборка серверной части — на все пять платформ из `plugin.json` (`PLUGIN_TARGETS` в `Makefile`,
`CGO_ENABLED=0`). Go берётся из `PATH`; если нужен локальный SDK — `make GO_BIN_DIR=/path/to/go/bin`
(по умолчанию подхватывается `$HOME/go-sdk/bin`, если такая директория есть).

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
├── assets/icon.svg      # иконка из icon_path манифеста
└── webapp/
    ├── eslint.config.js         # flat-config для eslint 9 (make check-style-webapp)
    ├── src/index.tsx            # класс плагина + window.registerPlugin(...)
    ├── src/desktop.ts           # isDesktopClient() через window.desktopAPI
    ├── src/client.ts            # fetch + X-CSRF-Token + X-Requested-With
    ├── src/actions.ts           # loadChannelReceipts(), sendReadReceipt() (дедупликация)
    ├── src/channel_watcher.ts   # догрузка receipts при открытии DM и на reconnect
    ├── src/gating.ts            # getPostContext(), shouldReportRead() — правила «можно ли»
    ├── src/i18n.ts              # словарь en/ru + форматирование времени
    ├── src/reducer.ts           # Redux reducer
    ├── src/selectors.ts         # isPostRead(), selectPostReadAt()
    ├── src/visibility.ts        # focus/visibility/idle трекер
    ├── src/websocket.ts         # custom_<id>_read_receipt handler
    └── src/components/read_receipt.tsx  # UI-компонент + IntersectionObserver
```

### Точка входа webapp

Mattermost загружает бандл и ожидает, что он сам себя зарегистрирует — экспорта функции
недостаточно:

```ts
window.registerPlugin('com.integrasources.read-receipts', new ReadReceiptsPlugin());
```

`initialize(registry, store)` при не-Desktop окружении не регистрирует ничего и сразу выходит.
`uninitialize()` (вызывается вебаппом при отключении плагина) останавливает channel watcher,
сбрасывает дедупликатор и visibility-трекер.

### Модель данных (KV)

**Watermark** (`wm_<channelID>_<readerID>`):
- `{post_id, create_at, read_at}` — монотонный watermark, без TTL
- Обновление атомарное, только если `new.create_at > old.create_at` (CAS, до 5 попыток) → гонки и «прокрутка назад» не откатывают состояние

**Порядок записи при чтении**: сначала персистится per-post receipt, затем двигается watermark; WS-событие публикуется только после успеха обоих шагов и только если что-то реально изменилось (повторный POST не порождает ложных событий). Если запись receipt падает — watermark не тронут; если падает watermark — состояние консервативно (receipt есть, watermark отстаёт, повторный запрос чинит).

**Watermark — источник истины про «уже прочитано»**: если `post.create_at <= watermark.create_at`, пост был прочитан раньше, и `/read` не пишет ничего и не шлёт WS-событие. Watermark вечен, а per-post receipt живёт `ReceiptRetentionDays`, поэтому без этой проверки повторное чтение старого сообщения после истечения TTL проставило бы свежее время и отправитель увидел бы `✓✓ Прочитано <сегодня>` на сообщении месячной давности. Клиентский дедупликатор — только на сессию, так что после перезапуска Desktop старые видимые посты действительно перезапрашиваются.

**Per-post receipt** (`rr_<channelID>_<postID>_<readerID>`):
- `read_at` (int64), `ExpireInSeconds = ReceiptRetentionDays*86400`
- Запись только если ключа ещё нет (Atomic: true, OldValue: nil) → «first write wins», повторный read полностью идемпотентен
- Ключ **скоуплен по каналу** (`channelID` всегда берётся из провалидированного `channel.Id`): receipt существует ⟺ `readerID` прочитал `postID` в `channelID`. Автор поста — всегда сам запрашивающий (само-чтение запрещено `ErrAuthorSelfRead`, DM всегда 1:1), поэтому передача `post_id` из чужого канала ничего не отдаёт: ключ не совпадёт. Это структурная гарантия без лишних `GetPost` на каждый id (до 200 вызовов на открытие DM были бы недопустимой просадкой).
- **Миграции нет**: версия `0.1.0` не имеет публичных установок. Старые `rr_<postID>_<readerID>`-ключи имеют TTL и истекают сами в течение `ReceiptRetentionDays`; формат `wm_*` не меняется.

**Водмарк — атомарный (CAS)**: обновление через `KVSetWithOptions{Atomic: true, OldValue: <прочитанные байты>}` в цикле (до 5 попыток). Это гарантирует «watermark никогда не движется назад» даже при конкурентных запросах (процессный lock не сработал бы — плагин может работать не в одном процессе).

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

Затем (в таком порядке) пишется per-post receipt, после него — watermark; WS-событие публикуется только если оба шага прошли успешно и хотя бы один из них что-то изменил.

**POST `/plugins/.../api/v1/receipts/query`**
```json
{"channel_id": "...", "post_ids": ["..."]}
```
→ `{"watermark": {...} | null, "receipts": {"<post_id>": read_at}}`

Возвращаются данные другого участника DM; вызывающий обязан быть участником, канал — D. Self-DM («личные заметки», канал типа D с единственным участником) отдаёт `200` с пустым результатом — читать эти посты некому, поэтому KV не трогается вовсе; `post_ids` ограничены (max 200, первый 200), мусорные/пустые id отбрасываются, невалидный id фильтруется до запроса в KV. Получаемые receipts читаются по ключам провалидированного `channel.Id` — посты, принадлежащие другому каналу, ничего не возвращают (изоляция каналов). Тело запроса и ответа ограничены (64 KiB), весь трафик идёт с `X-CSRF-Token`/`X-Requested-With`.

### WebSocket

`PublishWebSocketEvent("read_receipt", payload, &model.WebsocketBroadcast{UserId: postAuthorID})`

Обработчик, зарегистрированный через `registerWebSocketEventHandler`, получает **всё сообщение**
одним аргументом (`{event, data, broadcast, seq}`), а не пару `(event, data)`.

У отправителя приходит `custom_com.integrasources.read-receipts_read_receipt`:
```json
{
  "channel_id": "...",
  "post_id": "...",
  "create_at": 1234567890,
  "read_at": 1234567900,
  "reader_id": "...",
  "author_id": "..."
}
```

Никакой рассылки всем — только автору поста. Клиент дополнительно отбрасывает событие, у которого `author_id` задан и не совпадает с текущим пользователем (защита от неверно адресованного broadcast).

### Загрузка сохранённых receipts (channel watcher)

`startChannelWatcher(store)` подписывается на Redux store и один раз на открытый DM-канал
запрашивает `/receipts/query` — так статус восстанавливается после перезапуска Desktop, без
polling'а:

- ждёт появления сущности канала и первых постов (`entities.posts.postsInChannel`);
- отправляет только **свои** посты (максимум 200, новые первыми) — индикатор рисуется лишь отправителю;
- не-DM каналы помечает обработанными и не трогает;
- `registerReconnectHandler` → `watcher.refresh()`: после переподключения WebSocket состояние
  перечитывается (события, пропущенные во время обрыва, не теряются).

### Клиент: когда считаем «прочитано»

Все условия одновременно:
1. `isDesktopClient() == true` (проверено один раз при `initialize`)
2. Канал поста == `currentChannelId` и тип канала D
3. Окно активно: `document.visibilityState === 'visible'` и `document.hasFocus()`
4. Пользователь не idle: `window.desktopAPI.onUserActivityUpdate((active) => ...)`
5. Элемент поста реально виден (см. «Семантика видимости» ниже)
6. Dwell ≥ 1000 мс непрерывной видимости
7. Дедупликация: локальный watermark `sentCreateAt[channelId]` + `Set` отправленных `post_id`

### Семантика видимости

Наблюдается не 1×1 sentinel, а ближайший реальный элемент поста
(`.post` → `.post__body` → родитель sentinel'а). Пост считается видимым, если
**либо** `intersectionRatio >= 0.75`, **либо** его видимая полоса закрывает ≥
0.75 высоты вьюпорта (`intersectionRect.height >= rootBounds.height * 0.75`) —
честная семантика для высоких постов, которые физически не помещаются во
вьюпорт и никогда не дадут ratio 0.75. Колбэк вызывается на вход и на выход
порога (`threshold: [0, 0.75]`).

### Retry после сбоя сети

Read — конечный автомат `idle → pending → sent`. Упавший запрос возвращается в
`idle`, и через `RETRY_BACKOFF_MS = 5000` (без tight-loop) повторяется, если пост
всё ещё достаточно видим и окно активно. Уход из видимости / blur/ idle во
время dwell или backoff отменяет отправку. Только успешный ответ переводит
состояние в `sent` — временная ошибка сети не теряет receipt навсегда.

Отправляется один запрос на пост (обычно 1–2 при открытии канала); при пачке видимых постов отправляется только самый новый (остальные покрываются watermark'ом).

Если пост стал видимым, пока окно не в фокусе / пользователь idle, dwell запускается заново при
возврате фокуса/активности (IntersectionObserver не шлёт новых событий для уже видимого поста).

### UI и i18n

Строки берутся из собственного словаря `src/i18n.ts` (`en`, `ru`), локаль — из
`entities.users.profiles[currentUserId].locale`, fallback `en`. `react-intl` намеренно не
используется: в webpack `externals` вебаппа его нет, а собственная копия `react-intl` в бандле
получила бы отдельный контекст и не увидела бы переводы Mattermost.

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

**Webapp Plugin Registry**:
- `window.registerPlugin(id, instance)` — контракт точки входа бандла
- `registerReducer(reducer)` — состояние в `state['plugins-<id>']`
- `registerWebSocketEventHandler(event, handler)` — обработчик получает всё сообщение целиком
- `registerPostMessageAttachmentComponent(component)` — рендеринг под текстом поста
- `registerReconnectHandler(handler)` — перечитывание receipts после обрыва WebSocket

**Формы Redux state вебаппа** (самое хрупкое место — это внутренние структуры, не публичный API):
- `entities.posts.posts[postId]`, `entities.posts.postsInChannel[channelId][].order`
- `entities.channels.currentChannelId`, `entities.channels.channels[channelId].type`
- `entities.users.currentUserId`, `entities.users.profiles[userId].locale`

**Desktop API** (нестабильные, могут измениться):
- `window.desktopAPI.getAppInfo()` — детект Desktop
- `window.desktopAPI.onUserActivityUpdate(listener)` — idle-статус

**Клиентские детали**:
- Cookie `MMCSRF` — CSRF-токен
- Формат WS-событий: `custom_<pluginid>_<event>`

## License

MIT

## Support

Issues: https://github.com/megannnn98/mattermost-plugin-read-receipts/issues

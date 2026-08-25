# Read Receipts Plugin for Mattermost

Плагин для отображения индикаторов прочтения сообщений в каналах D, G, P и O Mattermost Desktop.

## Requirements

- **Mattermost Server**: v9.5.0+
- **Mattermost Desktop**: любой версии с `window.desktopAPI` (5.0+)
- **Браузер**: плагин **не работает** в браузере (намеренное ограничение)

Webapp Mattermost 9.5+ предоставляет плагинам React 17.0.2. Поэтому плагин не
использует React 18 API; это проверяется отдельным Jest-проектом, который
исполняет hook и компонент на aliased React 17 runtime.

## Features

- Inline-индикатор `✓✓` сразу после текста сообщения (DM) и `✓✓ N` в остальных каналах — высоту поста не увеличивает
- По клику на групповой индикатор автор получает список читателей и время прочтения
- Работает **только в Mattermost Desktop** (детект через `window.desktopAPI.getAppInfo()`)
- Учёт фокуса окна, видимости поста (IntersectionObserver), активности пользователя, dwell-time 1 секунда
- Монохромный watermark: индикатор никогда не «пропадает»
- Данные хранятся в KV-хранилище плагина с настраиваемым TTL
- Идемпотентная обработка повторных прочтений
- Минимальное количество HTTP-запросов (обычно 1-2 на открытие канала)

## Limitations

- **Только Mattermost Desktop**: в браузере плагин не регистрирует ни компонентов, ни обработчиков. Детект — best-effort по `window.desktopAPI`, не защита от подделки.
- Типы каналов D/G/P/O включены по умолчанию; администратор может сузить их через `EnabledChannelTypes`.
- В очень людных каналах индекс хранит до 1000 читателей, а query/popover читают не более 200; результат может быть усечён.
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

Результат: `dist/com.integrasources.read-receipts-0.2.0.tar.gz`

Зависимости webapp ставятся воспроизводимо через `npm ci` (по lock-файлу). Для
обновления зависимостей и перегенерации lock-файла — `make node-deps-update`
(вызовет `npm install`). Сборка серверной части `make server` сама создаёт
`server/dist`, так что `make clean && make server` безопасны.

## Install

1. Скачайте `com.integrasources.read-receipts-0.2.0.tar.gz` со страницы
   [Releases](https://github.com/megannnn98/mattermost-plugin-read-receipts/releases/latest)
   (или соберите сами: `make dist` → `dist/com.integrasources.read-receipts-0.2.0.tar.gz`)
2. Откройте **System Console → Plugins → Upload**
3. Загрузите `.tar.gz`
4. Включите плагин: **System Console → Plugins → Read Receipts → Enable**
5. Настройте параметры:
   - **Enable debug logging**: включите для отладки (логирует только ID постов/пользователей)
   - **Receipt retention (days)**: сколько дней хранить точное время прочтения (по умолчанию 30)
   - **Enabled channel types**: аварийный тормоз типов каналов, по умолчанию `DGPO`

Или через `mmctl`:

```bash
mmctl plugin add com.integrasources.read-receipts-0.1.0.tar.gz
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
каналами (post из чужого канала не отдаётся), частичные сбои KV (запись receipt падает —
watermark не тронут и 500; CAS watermark падает — 500 и без WS), 401 без
`Mattermost-User-Id` (все эндпоинты), 403 для постороннего пользователя / автора
собственного поста / выключенного типа канала, identity только из заголовка (id в теле
игнорируется), query-лимит (макс 200, невалидные id отбрасываются), битый JSON /
пустой channel_id / тело больше лимита → 4xx, клампинг `ReceiptRetentionDays`
(0, отрицательное, 1e9).

Групповая часть покрыта отдельно: CAS индекса читателей под `-race` (N одновременных первых
читателей — все попадают в индекс ровно по разу), повторное чтение не пишет в KV, переполнение
`maxIndexReaders` не ошибка, самолечение установки без `idx_` (в том числе на пути
watermark-authority), запрос в группе (watermark на читателя, сам запрашивающий исключён),
правило «точные receipts только при одном читателе», усечение списка читателей, каждый тип
канала при `EnabledChannelTypes=DGPO` и 403 при его исключении, `/receipts/post` (не-автор → 403,
удалённый пост → 404, точное и приближённое время, watermark не читается при наличии receipt,
усечение, ошибка индекса → 500).

Повтор после сбоя записи watermark сохраняет исходный `receipt.ReadAt`: если
per-post receipt уже был записан, retry не может сделать `watermark.ReadAt`
свежее исходного времени.

Покрыто (webapp, jest): desktop-детект, reducer и селекторы, дедупликация, gating
(чужой пост в открытом DM / свой пост / другой канал / не-DM / удалённый пост), channel watcher
(загрузка при открытии, один раз на канал, переключение канала, ожидание постов, `refresh()`,
`stop()`, переключение канала во время in-flight запроса не теряется, порядок «новые первыми»),
websocket-обработчик (совпадение события, приведение типов, игнор мусора, отбрасывание события
с чужим `author_id`, игнор события без `reader_id`), per-reader reducer (читатели канала
независимы, watermark читателя не откатывается, receipts разных читателей мержатся), i18n, visibility-трекер, `visibility_ratio` (низкий ratio → нет отправки,
высокий → dwell, падение ниже порога во время dwell отменяет отправку, progression tall-post fallback
по `intersectionRect.height`), `usePluginSelector` (селективность: нет rerender на нерелевантный
action, React 17 runtime), локальное чтение не помечает свои посты прочитанными (нет dispatch, id в
body игнорируется), компонент ReadReceipt (dwell, отсутствие чтения без фокуса, перезапуск dwell при
возврате фокуса, отсутствие двойного отчёта, retry после сбоя сети с backoff, отмена retry на blur и
игнорирование результата pending запроса после unmount), watcher query (retry с экспоненциальным
backoff и отмена в `stop()`).

Каждый регрессионный тест проверен мутацией: правка снимается — тест обязан упасть.

`golangci-lint` в проекте необязателен: если он есть в `PATH`, `make check-style` его запускает,
иначе гейтом остаются `gofmt` + `go vet` (о пропуске печатается сообщение).

## CI

GitHub Actions на `push` и `pull_request` запускает отдельные server (`gofmt`,
`go vet`, `go test -race` с Go из `server/go.mod`), webapp (`npm ci`, typecheck,
lint, оба Jest-проекта и build на Node 20) и packaging jobs. `golangci-lint` в CI
намеренно не добавлен: он не входит в установленный набор проверок и пока остаётся
техдолгом.

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
│   ├── api.go           # POST /api/v1/read, /receipts/query, /receipts/post
│   ├── permissions.go   # тип канала + membership + «не автор» проверки
│   ├── receipts.go      # KV storage (watermark + per-post + индекс читателей)
│   └── *_test.go        # серверные тесты (plugintest моки)
├── assets/icon.svg      # иконка из icon_path манифеста
└── webapp/
    ├── eslint.config.js         # flat-config для eslint 9 (make check-style-webapp)
    ├── src/index.tsx            # класс плагина + window.registerPlugin(...)
    ├── src/desktop.ts           # isDesktopClient() через window.desktopAPI
    ├── src/client.ts            # fetch + X-CSRF-Token + X-Requested-With
    ├── src/actions.ts           # loadChannelReceipts(), sendReadReceipt() (дедупликация)
    ├── src/channel_watcher.ts   # догрузка receipts при открытии канала и на reconnect
    ├── src/gating.ts            # getPostContext(), shouldReportRead() — правила «можно ли»
    ├── src/i18n.ts              # словарь en/ru + форматирование времени
    ├── src/reducer.ts           # Redux reducer
    ├── src/selectors.ts         # selectPostReadCount(), selectSingleReaderReadAt()
    ├── src/inline_mount.ts       # портал индикатора в текст сообщения (+ fallback-оверлей)
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
- Ключ **скоуплен по каналу** (`channelID` всегда берётся из провалидированного `channel.Id`): receipt существует ⟺ `readerID` прочитал `postID` в `channelID`. Передача `post_id` из чужого канала ничего не отдаёт — ключ не совпадёт. Это структурная гарантия без лишних `GetPost` на каждый id (до 200 вызовов на открытие канала были бы недопустимой просадкой).
- **Миграции нет**: версия `0.1.0` не имеет публичных установок. Старые `rr_<postID>_<readerID>`-ключи имеют TTL и истекают сами в течение `ReceiptRetentionDays`; формат `wm_*` не меняется.

**Индекс читателей канала** (`idx_<channelID>`):
- JSON-массив user id всех, кто хоть раз что-то прочитал в этом канале; без TTL
- Нужен потому, что `pluginapi.WithPrefix` — это **клиентский фильтр поверх полного `KVList`**, то есть перебор всех ключей инсталляции; для вопроса «кто читал этот канал» он непригоден
- Пишется через CAS (`Atomic: true, OldValue: <прочитанные байты>`), **один раз на пару (канал, читатель)** — дальше на каждое чтение приходится ровно один `KVGet`
- Ретраев у этого CAS **64**, а не 5 как у watermark'а: проигравший CAS на watermark обычно выходит сразу («уже покрыто»), а каждый первый читатель канала обязан дописаться, поэтому число нужных попыток растёт с числом одновременных первых читателей. Исчерпание ретраев возвращает ошибку (`/read` → 500, клиент повторит по backoff), а не молча теряет читателя
- Индекс поддерживается **до** early-return по watermark-authority, поэтому установка, обновившаяся с `0.1.0` (есть `wm_`, нет `idx_`), самолечится на первом же чтении
- Ёмкость — `maxIndexReaders = 1000`; переполнение логируется и не является ошибкой (см. «Остаточные риски»)

**Водмарк — атомарный (CAS)**: обновление через `KVSetWithOptions{Atomic: true, OldValue: <прочитанные байты>}` в цикле (до 5 попыток). Это гарантирует «watermark никогда не движется назад» даже при конкурентных запросах (процессный lock не сработал бы — плагин может работать не в одном процессе).

Ответ «прочитано?» для поста и **числа прочитавших**:
- читатель покрыл пост, если есть его `rr_*` **или** `post.create_at <= watermark.create_at`
- счётчик считается **на клиенте** из watermark'ов: watermark монотонен, а `create_at` своих постов у клиента уже есть, поэтому сервер не делает `GetPost` ни на один `post_id`
- точное время — из `rr_*`, иначе (старше TTL) — `watermark.read_at` как приближение (в UI помечается `≈`)

### REST API

**POST `/plugins/com.integrasources.read-receipts/api/v1/read`**
```json
{"post_id": "..."}
```
→ 200 `{"post_id","channel_id","create_at","read_at"}`

Проверки:
- `Mattermost-User-Id` присутствует
- Пост существует
- Тип канала входит в `EnabledChannelTypes` (по умолчанию `DGPO`)
- Вызывающий — участник канала (`HasPermissionToChannel(..., PermissionReadChannel)`)
- Вызывающий ≠ автор поста

Затем (в таком порядке) пишется per-post receipt, после него — watermark; WS-событие публикуется только если оба шага прошли успешно и хотя бы один из них что-то изменил.

**POST `/plugins/.../api/v1/receipts/query`**
```json
{"channel_id": "...", "post_ids": ["..."]}
```
→
```json
{
  "watermarks": [{"reader_id": "...", "post_id": "...", "create_at": 0, "read_at": 0}],
  "receipts": {"<post_id>": {"<reader_id>": 0}},
  "truncated": false
}
```

Читатели берутся из `idx_<channelID>`, сам запрашивающий из списка исключается, список
обрезается до `maxQueryReaders = 200` (тогда `truncated: true`). Пустой индекс (в том числе
self-DM, «личные заметки») отдаёт `200` с пустым результатом, не трогая `wm_`/`rr_` вовсе.

**Точные per-post receipts отдаются только когда читатель ровно один** — то есть на практике в
DM, где это в точности сохраняет контракт `0.1.0`. При K > 1 они стоили бы K·M чтений на
открытие канала, поэтому в группах точные времена отдаёт `/receipts/post` по клику, а
количество клиент считает из watermark'ов.

`post_ids` ограничены (max 200, первые 200), невалидные id отбрасываются до запроса в KV.
Получаемые receipts читаются по ключам провалидированного `channel.Id` — посты другого канала
ничего не возвращают (изоляция каналов). Тело запроса и ответа ограничены (64 KiB), весь трафик
идёт с `X-CSRF-Token`/`X-Requested-With`.

**Контракт приватности.** Участник канала видит watermark'и остальных участников этого канала —
то есть «читатель R прочитал канал до момента T». Это канальные данные и ровно то, что фича и
обещает. Пер-постовая детализация закрыта авторством (см. ниже).

**POST `/plugins/.../api/v1/receipts/post`**
```json
{"post_id": "..."}
```
→ `{"readers": [{"user_id": "...", "read_at": 0, "exact": true}], "truncated": false}`

Вызывается только при открытии списка «кто прочитал». Требует, чтобы запрашивающий **был автором**
поста (иначе 403) — один `GetPost` на клик приемлем, в отличие от 200 вызовов на открытие канала.
Удалённый пост → 404. Читатель попадает в ответ, если есть его точный receipt (`exact: true`)
либо watermark покрывает пост (`exact: false`, время приближённое — receipt истёк по TTL).
Watermark читается **только когда точного receipt нет**, иначе стоимость поповера удвоилась бы.
Сортировка — по времени прочтения по возрастанию.

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

`startChannelWatcher(store)` подписывается на Redux store и один раз на открытый канал
запрашивает `/receipts/query` — так статус восстанавливается после перезапуска Desktop, без
polling'а:

- ждёт появления сущности канала и первых постов (`entities.posts.postsInChannel`);
- отправляет только **свои** посты (максимум 200, новые первыми) — индикатор рисуется лишь отправителю;
- каналы неподдерживаемого типа помечает обработанными и не трогает;
- ответ `403` (например, тип канала выключен в `EnabledChannelTypes`) считает окончательным:
  канал помечается обработанным, backoff не запускается — повторять запрос, который может
  быть только отклонён, бессмысленно;
- `registerReconnectHandler` → `watcher.refresh()`: после переподключения WebSocket состояние
  перечитывается (события, пропущенные во время обрыва, не теряются).
- Ошибка `/receipts/query` не помечает канал обработанным: один retry запускается через
  bounded exponential backoff от 5 до 60 секунд. Успех, смена канала и `stop()` снимают
  отложенный timer.

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

Наблюдается не нулевой sentinel, а ближайший реальный элемент поста
(`.post` → `.post__body` → родитель sentinel'а). **Root наблюдателя — не окно, а
скроллируемый список постов** (`resolveScrollRoot()`: ближайший предок с
`overflow-y: auto/scroll/overlay`; если такого нет — остаётся вьюпорт).

Выбор идёт **только по computed `overflow-y`**, намеренно без проверки
`scrollHeight > clientHeight`. Переполнение — свойство контента в конкретный
момент: канал с парой сообщений или ещё не загруженные картинки/вложения не дают
переполнения на момент монтирования. Root выбирается один раз при запуске
эффекта, поэтому завязка на геометрию пришпилила бы observer к окну на весь
mount и вернула бы недостижимую ветку для высоких постов. `overflow-y`
виртуализированный список выставляет инлайном с первого рендера и не меняет.

Брать ближайший такой предок безопасно — замеренная цепочка от `.post` вверх в
живом клиенте:

```
1..3   безымянные wrappers          overflow-y: visible
4      div.post-list__dynamic       overflow-y: auto     ← настоящий скроллер
6      #postListContent             overflow-y: hidden
13     #post-list                   overflow-y: hidden
19..21 .main-wrapper, #root, body   overflow-y: hidden
```

Список постов — единственный `auto/scroll` во всей цепочке; `hidden`-обёртки
лежат выше него, клипают, но не скроллят, и root'ом не становятся.

Пост считается видимым, если **либо** `intersectionRatio >= 0.75`, **либо** его
видимая полоса закрывает ≥ 0.75 высоты root'а
(`intersectionRect.height >= rootBounds.height * 0.75`) — честная семантика для
высоких постов, которые физически не помещаются в область просмотра и никогда не
дадут ratio 0.75.

Почему root именно список, а не окно: замер в живом Mattermost Desktop 6.3.0 —
окно 760px, список постов 492px, то есть **65% окна**. Видимая полоса поста не
может превысить высоту списка, поэтому при window-relative root условие
`>= 0.75 * 760 = 570px` недостижимо в принципе, при любом размере окна. Пока root
был окном, любой пост выше `listHeight / 0.75` (~656px) не получал receipt вообще:
измеренный развёрнутый пост 8063px давал `ratio 0.0605`, `intersectionRect.height
487`, `rootBounds.height 760` — обе ветки false. С root = список порог становится
`0.75 * 492 = 369px`, и fallback срабатывает как задумано.

Для получения callback'ов используется плотный threshold-массив: `0`, ступени
`0.001…0.0075`, затем шаг `0.01` до `1` — нижние ступени нужны, чтобы очень
высокий пост вообще получил callback, когда доля видимой площади мала.

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
- Канал неподдерживаемого типа, пост удалён или state плагина пуст → `null`
- Чужой пост → невидимый sentinel (`<span aria-hidden>`) с ref для `IntersectionObserver`
- Свой пост, никто не прочитал → `null`
- Свой пост в DM → `✓✓`, точное время в `title`
- Свой пост в группе → `✓✓ N`, по клику — список «кто и когда»

**Почему портал, а не просто другой CSS.** Слот `PostMessageAttachment` монтируется **блоком под
сообщением** — именно это и добавляло лишнюю высоту, на которую пожаловался заказчик. Поэтому
`inline_mount.ts` создаёт `<span>` последним ребёнком `.post-message__text` и рендерит индикатор
туда через `createPortal`. Если контейнера текста нет (нестандартный вариант поста), используется
запасная стратегия — абсолютный оверлей в правом нижнем углу `.post__body` (он `position:
relative`); высоту она тоже не добавляет.

Поповер со списком читателей портируется в `document.body`, а не остаётся внутри текста поста:
`position: fixed` внутри предка с `transform` считался бы от этого предка, и поповер уехал бы.
Он открывается сразу по клику — со строкой «Загрузка…», а при ошибке запроса со строкой ошибки:
если рендерить его только по приходу данных, упавший запрос оставил бы открытый флаг без единого
обработчика закрытия. Список ограничен 20 строками, дальше «и ещё N»; при усечении на сервере
показывается «и ещё более N», а не выдуманная точная цифра.

Сообщения/props постов не изменяются.

## Manual Testing Checklist (DoD)

1. Установите плагин на сервере
2. Откройте Mattermost Desktop у **пользователя A** (отправитель)
3. Откройте Mattermost Desktop у **пользователя B** (получатель)
4. **A → B**: отправьте сообщение «test message»
5. У **A** индикатора **нет** (сообщение не прочитано)
6. **B** открывает DM с **A**, сообщение попадает в видимую область при активном окне
7. У **A** **без reload** появляется `✓✓` сразу после текста, и **высота поста не меняется**
8. После перезапуска Desktop статус **сохраняется** (данные в KV)
9. Если **B** открывает тот же DM в **браузере** — receipt **не отправляется** (в браузере нет `window.desktopAPI`)
10. В групповом (G), приватном (P) и открытом (O) канале у **A** появляется `✓✓ N`, растущее по
    мере чтения; клик открывает список читателей с временем
11. После истечения `ReceiptRetentionDays` список показывает время с пометкой `≈`

## Dependencies on Mattermost Internals

Плагин зависит от следующих внутренних деталей Mattermost:

**Server Plugin API** (стабильные, документированные):
- `plugin.API.KVGet`, `KVSetWithOptions` — KV-хранилище
- `plugin.API.GetPost`, `GetChannel`, `HasPermissionToChannel`
- `plugin.API.PublishWebSocketEvent`
- `model.WebsocketBroadcast{UserId: ...}` — адресная доставка
- `model.ChannelTypeDirect` / `Group` / `Private` / `Open` — типы каналов

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

## Остаточные риски

Плагин включён для всех типов каналов (`DGPO`) и не ограничивает число участников — это
осознанное решение заказчика. Стоимость при этом зависит не от числа участников канала, а от
числа **реально читавших**, и ограничена сверху явными константами:

- **Людный открытый канал.** Каждый читающий попадает в `idx_`. Открытие канала автором стоит
  `min(K, 200)` чтений KV, открытие списка читателей — до `2·min(K, 200)`. Сверх 200 ответ
  помечается `truncated`, и UI честно пишет «и ещё более N», а не выдумывает число. Аварийный
  тормоз для администратора — настройка `EnabledChannelTypes`.
- **Индекс не чистится.** У `idx_` нет TTL: ушедший из канала участник остаётся в списке и
  тратит одно чтение. Автоматическая чистка сознательно отложена.
- **Точное время в группах — только по клику.** До открытия списка видно количество, но не
  времена: массовый запрос иначе стоил бы K·M чтений.
- **Портал вставляет свой узел в DOM Mattermost.** Если очередная версия вебаппа начнёт его
  вычищать, индикатор пропадёт (плагин при этом не сломается), и рабочей останется запасная
  стратегия с оверлеем.

## License

MIT

## Support

Issues: https://github.com/megannnn98/mattermost-plugin-read-receipts/issues

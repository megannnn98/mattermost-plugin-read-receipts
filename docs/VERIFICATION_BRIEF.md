# Задание другому агенту: живая верификация плагина read-receipts

Мой шаг после одобрения: сохранить этот brief в репозиторий как
`/home/b/Documents/mmost/mattermost-plugin-read-receipts/docs/VERIFICATION_BRIEF.md`
(новый каталог `docs/`) и закоммитить. Саму верификацию выполняет другой агент/сессия — я её не запускаю.

---

## BRIEF (копировать целиком)

### Ловушка React runtime

Проверка webapp в jsdom должна подставлять реальный React 17.0.2, который
Mattermost 9.5+ предоставляет плагинам через `window.React`. jsdom с React 18 из
`node_modules` маскирует зависимость от React 18 API; именно так прежняя проверка
не обнаружила несовместимость `useSyncExternalStore`.

### Задача

Проверить на живом Mattermost-сервере плагин read receipts, найти и исправить дефекты, которые
unit-тесты не ловят. Код готов и закоммичен, `make all` зелёный, но **на реальном сервере плагин
не запускался ни разу**.

Репозиторий: `/home/b/Documents/mmost/mattermost-plugin-read-receipts` (git, ветка `master`,
последний коммит `a6271f5`). Ничего пушить не надо, remote отсутствует.

### Что это за плагин

Mattermost-плагин: отправитель видит рядом со своим сообщением галочку прочтения, когда
получатель его реально увидел. Работает **только в Mattermost Desktop** (в браузере плагин не
регистрирует ни компонентов, ни обработчиков); mobile — вне scope.

С версии 0.2.0:
- индикатор рисуется **inline сразу после текста** (`✓✓` в DM), а не отдельной строкой под ним —
  высота поста от него не меняется;
- поддерживаются типы каналов **D, G, P, O** (настройка `EnabledChannelTypes`, по умолчанию
  `DGPO`); в неличных каналах индикатор показывает `✓✓ N`, а по клику — список «кто и когда».

Устройство (проверено по актуальному master `mattermost/mattermost`, не по памяти):

- **UI-слот** — `registerPostMessageAttachmentComponent` (рендерится в
  `post_message_view.tsx` под текстом поста для всех обычных постов, включая подряд идущие).
  Слот `PostHeader` сознательно не используется: он гейтится
  `showPostHeaderBadge = showTimestamp && (!isConsecutivePost || compactDisplay)`.
- **Точка входа вебаппа** — бандл сам себя регистрирует: `window.registerPlugin(id, instance)`;
  экспорт функции Mattermost не вызывает.
- **WS-контракт** — хендлер `registerWebSocketEventHandler` получает всё сообщение одним
  аргументом (`{event, data, broadcast, seq}`), а не `(event, data)`.
- **Detect Desktop** — `window.desktopAPI.getAppInfo()` (пакет `@mattermost/desktop-api`), плюс
  `onUserActivityUpdate` для idle. UA-хак не используется. Это не security boundary.
- **Хранение** — KV плагина: монотонный watermark `wm_<channelID>_<readerID>` =
  `{post_id, create_at, read_at}` (без TTL) + точное время `rr_<postID>_<readerID>` = `read_at`
  с TTL `ReceiptRetentionDays` (по умолчанию 30 дней), запись first-write-wins через
  `KVSetWithOptions{Atomic: true, OldValue: nil}`.
- **Эндпоинты** — `POST /plugins/com.integrasources.read-receipts/api/v1/read` `{post_id}` и
  `POST /plugins/com.integrasources.read-receipts/api/v1/receipts/query`
  `{channel_id, post_ids[]}`; user_id всегда берётся из заголовка `Mattermost-User-Id`, из тела
  запроса — никогда.
- **WS-событие** — `custom_com.integrasources.read-receipts_read_receipt`, broadcast адресный
  (`WebsocketBroadcast{UserId: postAuthorID}`), публикуется только когда watermark продвинулся.
- **Клиентский gating** («прочитано») — все условия сразу: Desktop, канал поста ==
  `currentChannelId` и тип `D`, окно видимо и в фокусе, пользователь не idle, элемент виден
  (`IntersectionObserver`, threshold 0.75), dwell ≥ 1000 мс; дедупликация локальным watermark'ом.
- **channel watcher** (`webapp/src/channel_watcher.ts`) — один запрос `/receipts/query` на
  открытый DM (свои посты, максимум 200, новые первыми) плюс `registerReconnectHandler` →
  перечитывание после обрыва WebSocket. Polling'а нет и не должно появиться.

Подробности — в `README.md` репозитория (разделы Architecture, Test, Limitations,
Dependencies on Mattermost Internals).

### Окружение (Arch Linux)

- Docker 29.7.2 (`/usr/bin/docker`, `docker-compose` есть), локальных образов mattermost нет.
- Mattermost Desktop **6.3.0** (`mattermost-desktop-bin`, `/usr/bin/mattermost-desktop`).
- Go 1.24.6 лежит в `$HOME/go-sdk/bin` и **не в PATH**; Makefile подхватывает его сам
  (`GO_BIN_DIR ?= $(HOME)/go-sdk/bin`), для ручных команд нужен `export PATH=$HOME/go-sdk/bin:$PATH`.
- Node 26, зависимости вебаппа уже установлены в `webapp/node_modules`.
- `golangci-lint` не установлен: гейтом служат `gofmt -l` + `go vet` (это ожидаемо, не дефект).
- `mmctl` локально отсутствует — использовать тот, что внутри контейнера.
- Готовый бандл: `dist/com.integrasources.read-receipts-0.1.0.tar.gz` (32 МБ, 5 платформ).
  Пересобрать: `make dist`.

### Границы

- Не менять архитектуру и выбор слота, не форкать Mattermost/Desktop, не рефакторить без
  необходимости: цель — найти дефекты и исправить минимально.
- Не трогать корпоративный сервер Integra Sources (там нет админских прав) — только локальный.
- Не писать текст сообщений в логи (в плагине это правило соблюдается, не сломать).
- `docker pull` тянет ~1.5 ГБ. Если сети нет — остановиться и сообщить, а не имитировать проверку.

### Шаг 1. Сервер

```bash
docker pull mattermost/mattermost-preview
docker run -d --name mm-rr -p 8065:8065 \
  -e MM_SERVICESETTINGS_SITEURL=http://localhost:8065 \
  -e MM_PLUGINSETTINGS_ENABLEUPLOADS=true \
  -e MM_SERVICESETTINGS_ENABLELOCALMODE=true \
  mattermost/mattermost-preview
curl -sf localhost:8065/api/v4/system/ping
```

Проверить версию сервера: нужна **≥ 9.5.0** (`min_server_version` в `plugin.json`). Если образ
старее — поднять `mattermost/mattermost-team-edition` + postgres (compose из репозитория
`mattermost/docker`). `ENABLELOCALMODE` нужен для `mmctl --local` (unix socket, без логина).

### Шаг 2. Пользователи

Через `mmctl --local` в контейнере (бинарь обычно `/mattermost/bin/mmctl`): пользователь **A**
(`--system-admin`), пользователь **B**, пользователь **C** (для негативных проверок прав),
команда и все трое в ней.

### Шаг 3. Установка плагина

```bash
docker cp dist/com.integrasources.read-receipts-0.1.0.tar.gz mm-rr:/tmp/
docker exec mm-rr mmctl --local plugin add /tmp/com.integrasources.read-receipts-0.1.0.tar.gz
docker exec mm-rr mmctl --local plugin enable com.integrasources.read-receipts
```

Убедиться: плагин активен (`GET /api/v4/plugins`), в логах сервера нет ошибок активации,
`EnableDebugLogging` включён. Отдельно проверить, что вебапп-бандл отдаётся
(`GET /static/plugins/com.integrasources.read-receipts/*_bundle.js`) и содержит вызов
`registerPlugin` — это подтверждение самого опасного из ранее найденных дефектов.

### Шаг 4. Серверная часть по REST (без GUI)

Токены A/B/C — `POST /api/v4/users/login` (заголовок ответа `Token`), DM-канал —
`POST /api/v4/channels/direct`, сообщение от A — `POST /api/v4/posts`.

| Проверка | Ожидание |
|---|---|
| B → `/api/v1/read` для поста A | 200, `read_at` заполнен |
| тот же запрос повторно | 200, дубликата в KV нет, WS повторно не публикуется |
| A → `/api/v1/receipts/query` | `watermarks[]` (по читателю) + `receipts[post_id][reader_id]` |
| B → `read` для более старого поста | watermark не откатывается назад |
| C (не участник DM) → оба эндпоинта | 403 |
| A (автор) → `read` на свой пост | 403 |
| пост в публичном канале → `read` | 200 (тип O включён по умолчанию) |
| то же при `EnabledChannelTypes=D` | 403 |
| групповой канал, читают B и C, A → `query` | два элемента в `watermarks`, самого A в списке нет |
| группа (K > 1) → `query` | `receipts` пуст: точные времена отдаёт `/receipts/post` |
| A (автор) → `/api/v1/receipts/post` | список читателей с временем, `exact: true` |
| B (не автор) → `/api/v1/receipts/post` | 403 |
| удалённый пост → `/api/v1/receipts/post` | 404 |
| без токена | 401 |
| `post_ids` > 200 элементов | усечение, не ошибка |

WS-доставку проверить подпиской на `/api/v4/websocket` от имени A (websocat / python
`websocket-client`); если инструмента нет — честно указать в отчёте, чем подтверждено.

### Шаг 5. Два Desktop-клиента и DoD

Одна сессия на сервер в одном процессе, поэтому второй клиент — с отдельным профилем:

```bash
mattermost-desktop &
XDG_CONFIG_HOME=/tmp/mm-desktop-b mattermost-desktop &   # fallback: --user-data-dir=/tmp/mm-desktop-b
```

Сначала объективно проверить детект: DevTools (`Ctrl+Shift+I`) → `window.desktopAPI.getAppInfo()`
должен вернуть `{name, version}`. Если в 6.3.0 метода нет — плагин по своей логике корректно
останется выключенным; тогда это не баг, а уточнение минимальной версии Desktop в README.

Чеклист:

1. A → B «test message»: у A индикатора нет.
2. B открывает DM, окно активно, сообщение в видимой области → через ~1 с уходит receipt.
3. У A **без reload** появляется `✓✓` сразу после текста, точное время — в тултипе.
3a. **Высота поста не изменилась.** Замерить `document.querySelector('.post__body').getBoundingClientRect().height`
    до и после появления галочки — числа должны совпасть. Это и есть исходная претензия заказчика.
4. Перезапуск Desktop у A → статус на месте (проверка channel watcher'а).
5. B открывает тот же DM в браузере → receipt не уходит: в логах плагина ничего, watermark не двинулся.
6. Окно B не в фокусе (blur) → receipt не уходит до возврата фокуса.
7. Три подряд идущих сообщения от A → индикатор виден у всех трёх (проверка выбора слота).
8. Локаль A `ru` → «Прочитано», `en` → «Read».
9. Сообщение, прочитанное в браузере, receipt не порождает; после этого чтение в Desktop — порождает.
10. Групповой канал с A, B и C: по мере чтения у A индикатор идёт `✓✓ 1` → `✓✓ 2`; клик открывает
    список с обоими читателями и временем. То же в приватном (P) и открытом (O) канале.
11. Правка поста, добавление реакции и подгрузка эмбеда не убирают inline-узел индикатора
    (если убирают — значит, рабочей должна остаться запасная стратегия с оверлеем).
12. Поповер у поста внизу экрана раскрывается **вверх** и не уходит за границу окна; прокрутка
    списка постов его закрывает.
13. Уменьшить `ReceiptRetentionDays` до 1, дождаться истечения per-post receipt → список
    читателей показывает время с пометкой `≈`.

Шаги требуют кликов в GUI. Если агент не может управлять GUI — подготовить окружение, выполнить
шаги 1–4 из раздела REST, а GUI-часть оформить как точный чеклист для человека и явно написать
в отчёте, что она не выполнена автоматически.

### Как исправлять найденное

1. Сначала root cause, потом патч; минимальные и безопасные правки.
2. На каждый дефект — регрессионный тест (Go: `plugintest`-моки; webapp: jest в `webapp/tests/`).
3. Мутационная проверка каждого нового теста: вернуть дефект → тест обязан упасть; вернуть фикс.
4. `make check-style && make test && make dist` должны быть зелёными.
5. Коммиты — Conventional Commits, по одному логическому изменению.

### Формат отчёта

- Что поднято и какие версии (сервер, Desktop, плагин).
- Таблица шага 4: ожидание / фактический результат.
- Чеклист шага 5: пройдено / не пройдено / не проверено автоматически.
- Каждый дефект: симптом → root cause → патч (diff по файлам) → тест → результат мутационной проверки.
- Что осталось непроверенным и почему.
- Судьба контейнера (оставлен / `docker rm -f mm-rr`).

Не выдавать непроверенное за проверенное: если шаг не выполнен, так и написать.

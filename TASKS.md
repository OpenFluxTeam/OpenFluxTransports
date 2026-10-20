# TASKS — все транспорты в JS

Статусы: `[ ]` ждёт · `[~]` выполняется · `[x]` выполнено и проверено · `[!]` проблема · `[-]` отменено (с причиной).
Процент = выполненные / (все − отменённые). План: [docs/PLAN-js-migration.md](docs/PLAN-js-migration.md).

## Общий статус: 15 / 31 — 48 %

Ветки: транспорты `OpenFluxTeam/OpenFluxTransports@js-all`, ядро `OpenFluxTeam/OpenFlux@js-transports`,
клиенты `OpenFluxDesktop/shared` ветка `js-transports` (локально, не запушена).

## Решения (2026-10-20)
- MAX, MTS-Link, Bitrix24, PRUFFME — пробовать гостем самому; где нельзя — «нет доступа» в таблице.
- direct и phpbox остаются нативными.
- Подпись пакетов — ключ OpenFluxTeam (`~/.openflux-keys/openfluxteam-transports.key`, pub `96df2b44…6b1a`):
  в нашем ядре это `OfficialKeyHex`, ключ upstream остаётся официальным (ротация, установленное от upstream обновляется на наше).
- Протокол проверки (по просьбе пользователя, 2026-10-20 22:05): **подключиться и скачать 10 МБ** (sha256), стабильность не гоняем.
- Не долбиться в сервис, который режет адрес (Avito), и не зацикливаться на boards (у Яндекса сбой).

## A. Инфраструктура
- [x] A1. Форки, клоны в `~/openflux/transports-work`, ветки `js-all` / `js-transports`.
- [x] A2. Ключ OpenFluxTeam; `OfficialKeyHex` = он, upstream в `officialKeys`; встроенные в ядро скрипты переподписаны (`go test ./transport/script` зелёный).
- [~] A3. URL обновлений → OpenFluxTeam (сделано), секрет `SIGNING_KEY` в форке (сделано), CI собирает инструменты из `OpenFluxTeam/OpenFlux` (`vars.OPENFLUX_REF`, по умолчанию `js-transports`); первый прогон Check идёт.

## B. Ядро (`transport/script`)
- [x] B1. `auth` в `info()`/манифесте/`Inspect`; scriptsign кладёт `info().auth` в манифест и сверяет. Тесты `auth_test.go`.
- [x] B1a. `lanes`: полосы скрипта под Go-шным `StripedTransport` (тот же провод, что у нативов). Тест `lanes_test.go` (3 полосы, потери 1/7), `-race` в Docker чистый.
- [x] B1b. Приём в порядке (одна горутина вместо горутины на пакет), запись пачками за один заход в цикл JS.
- [x] B1c. `shared.read/write` (общий между процессами хоста бюджет), Retry-After в ошибке ws, `info().batchBytes` (BatchSizeHinter), IPv4 первым для TCP, список комнат печатается как у нативов, `authRequired` пишется в журнал.
- [ ] B2. Хост WebRTC: медиатреки (видео-сэмплы/RTP туда и обратно) — для telemost.
- [ ] B3. Выбор пакета: `type=<натив>` → JS-пакет того же id.
- [x] B4. Стенд `scripts/soak/jsbench.py` (`--quick N` МБ, `--quick-timeout`), `yboard.py` (доска Яндекса гостям).

## C. Синхронизация JS с нативами
- [x] C1. yandex 1.2.0 — длина в курсоре = реальный размер (без этого Яндекс молча выбрасывал всё), keepalive с паддингом и разбросом, auth.
- [x] C2. vyandex 1.2.0 — auth (IPv4 первым — в хосте).
- [x] C3. boards 1.2.0 — auth (need=create).
- [x] C4. mailru 1.3.0 — вход с CSRF, чат 500 КБ, 5 сообщ./с, ротация 60 сообщ./25 с, эхо по id соединения, unlock; куки ровно `Mpop`, `sdcs` (замерено: остальные 22 не нужны).
- [x] C5. cupsonline 1.2.0 — 8 комнат, 12 КБ, страйп v2 через `lanes`, окно 3 RPC; interop с нативом на обоих проводах.
- [ ] C6. oneme-iceinject / oneme-webrtc (нужен MAX).

## D. Новые порты и перенос
- [~] D1. avito 1.0.0 — порт готов (пары комнат = полосы, общий бюджет, одно соединение ShareDB на сторону: 16 комнат поднимаются за 1–2 с вместо минут). Живая проверка: [!] Avito режет адрес (`ERR_ROOM_CREATION_RATE_LIMITED`, 429) — отложено.
- [ ] D2. telemost — нужен B2.
- [x] D3. vkteams 1.0.3 перенесён в репозиторий (гостевой вход, auth не нужен).
- [ ] D4. mtslink, bitrix, pruffme: проверить гостем.

## E. Клиенты (shared, ветка `js-transports`)
- [x] E1. `InstalledScript.auth` из отчёта ядра; `AccountKind.ofAccount`.
- [x] E2. Куки JS-транспорту: аккаунт из `auth.account`, только `auth.cookies`, ключ ядра `script:<id> <url>`; need=create — без входа; строка «sign-in required» → подсказка. Тесты `AccountCookiesTest` 14/14.
- [ ] E3. Android: тот же сидинг (у Android свой ключ банки).
- [ ] E4. Вход для аккаунтов, которых приложение не знает (сторонний `auth.account`): общий вход по `signInUrl/cookieUrls`.

## F. Тесты: подключение + 10 МБ (sha256)
| транспорт | натив | JS |
|---|---|---|
| cupsonline | ✅ подкл. 1.9 с, soak 0.68 МБ/с | ✅ подкл. 1.9 с, soak 0.82 МБ/с |
| mailru | ✅ 1.6 с, 10 МБ за 157 с (0.064) | ✅ 1.8 с, 10 МБ за 103 с (0.097), 2 куки |
| avito | — | [!] лимит Avito на адрес |
| vyandex | ⚠ подкл., <12 КБ/с (10 МБ не докачал за 15 мин) | [~] |
| yandex | [~] | [!] не подключился за 150 с — разбираю |
| boards | [-] сбой Яндекса | [-] |
| telemost, vkteams, oneme, mtslink, bitrix, pruffme | [ ] | [ ] |

## История
- 2026-10-20: инвентаризация. В OpenFluxTransports 10 JS-транспортов; JS = копии из ядра (кроме mailru: в ядре 1.2.0 на чате);
  нативы ушли вперёд после 2026-10-04. avito и telemost есть только нативом. Форки сделаны, план записан.
- 2026-10-20 вечер: хост (auth, lanes, порядок приёма, пакетная запись, shared, batchBytes, IPv4), cupsonline/mailru/yandex*/avito, ключ OpenFluxTeam, CI форка, клиентский сидинг кук.
  Сеть ПК↔Яндекс нестабильна под нагрузкой (boards.yandex.ru режет частые новые подключения), у Яндекса сбой.

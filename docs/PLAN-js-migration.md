# План: все транспорты OpenFlux — в JS (2026-10-20)

Репозитории (форки в OpenFluxTeam): `OpenFluxTransports` (ветка `js-all`), `OpenFluxTransportTemplate`,
ядро `OpenFlux` (ветка `js-transports` от `main`), клиенты — `OpenFluxClientShared` (+ Desktop, Android).
Журнал хода работ: [`TASKS.md`](../TASKS.md).

## Что есть на старте

| транспорт | нативный (Go) | JS в OpenFluxTransports | состояние JS |
|---|---|---|---|
| yandex | да | 1.1.0 | как в ядре; нет фикса «длина в курсоре = настоящий размер пакета», IPv4 первым |
| vyandex | да | 1.1.0 | как в ядре; нет IPv4 первым |
| boards | да | 1.1.0 | как в ядре |
| mailru | да | 1.1.1 (курсор) | в ядре уже 1.2.0 (чат документа); натив ушёл дальше: пачки до 500 КБ, эхо по editor id, make-before-break, вход с CSRF |
| cupsonline | да | 1.1.0 | натив: 8 комнат, страйп с RTO/CoDel под комнату |
| oneme | да | iceinject 1.1.0, webrtc 1.1.0 | нужен токен MAX |
| mtslink, bitrix, pruffme | нет | 1.0.0 | только JS |
| avito | да | **нет** | порт нужен: Socket.IO, бюджет рукопожатий, общий 429 |
| telemost | да | **нет** | порт нужен: видео через SFU; у JS-хоста нет медиатреков |
| vkteams | нет | отдельно (сторонний 1.0.2) | перенести в репозиторий |
| direct, phpbox | да | — | **остаются нативными** (решение 2026-10-20: инфраструктура ядра, raw TCP) |

iOS не имеет JS-движка: натив там остаётся (аудит `OpenFlux/docs/plans/2026-10-04-native-to-js-audit.md`).

## Контракт кук: транспорт сам говорит, что ему нужно

Сейчас какие куки брать, решают клиенты (`AccountKind` в shared, захардкожены Яндекс/Mail.ru/MAX) и ядро
(`--avito-cookies`, `--yandex-cookies-file`). Переносим это знание в пакет транспорта.

`manifest.json` и `info()` получают блок `auth`:

```json
"auth": {
  "account": "yandex",              // общий вход для нескольких транспортов (yandex, vyandex, boards, telemost)
  "label": "Яндекс",
  "need": "always",                 // always | create (только чтобы создать документ/комнату) | optional
  "signInUrl": "https://passport.yandex.ru/auth?retpath=…",
  "homeUrl": "https://disk.yandex.ru/client/disk",
  "waitForHome": true,
  "finishUrl": null, "finishCookie": null,
  "cookieUrls": ["https://disk.yandex.ru/", "https://passport.yandex.ru/", "https://yandex.ru/"],
  "loginCookie": "Session_id",      // по ней видно, что вход есть
  "loginNameCookie": "yandex_login",
  "cookies": ["Session_id", "sessionid2", "yandexuid", "…"],  // ровно эти уходят в транспорт; пусто = все с cookieUrls
  "scopeToParent": true
}
```

- Ядро: `Info.Auth`/`Manifest.Auth`, `Inspect` отдаёт его клиентам; `ApplyCookies`/куки из хранилища фильтруются
  списком `cookies`; JS видит `auth` в `info` и сам решает, когда звать `raise("authRequired", {account})`.
- Клиенты: аккаунты строятся из `auth` установленных пакетов (вместо захардкоженного `AccountKind`), вход —
  встроенным браузером (KCEF на десктопе, WebView на Android), в ядро уходят только перечисленные куки;
  `authRequired` от транспорта → «Войдите в <label>».

## Этапы

1. **Инфраструктура.** Форки, ветки, ключ подписи OpenFluxTeam (pub — в `officialKeys` нашего ядра,
   секрет `SIGNING_KEY` в форке), CI форка смотрит на наше ядро (`OPENFLUX_REF`), URL обновлений → OpenFluxTeam.
2. **Ядро.** `auth` в манифесте/`info()`, фильтр кук, `Inspect`; хост: медиатреки WebRTC (для telemost),
   что ещё потребуют порты; выбор пакета: `type=<натив>` → JS-пакет того же id, где есть движок.
3. **Синхронизация существующих JS с нативами** (yandex, vyandex, boards, mailru, cupsonline, oneme).
4. **Новые порты:** avito, telemost; перенос vkteams; mtslink/bitrix/pruffme — `auth` и проверка.
5. **Клиенты:** аккаунты из манифестов, вход в приложении, куки по списку.
6. **Тесты каждого транспорта отдельно** (стенд `scripts/soak` ядра, клиент и выход на этом ПК, JS ↔ JS, плюс
   натив ↔ JS там, где натив есть):
   - работоспособность: подключение, время до первого байта, целостность (sha256 скачанного/загруженного);
   - скорость: скачивание, загрузка, 4 параллельных потока;
   - стабильность: 10 мин непрерывной нагрузки — ошибки скачивания, переподключения, 429, обрывы;
   - юнит/фейк-сервер: `go test ./transport/script/...`, сборка всех пакетов (check.yml).
7. **Итоговая таблица** (`docs/RESULTS.md` + страница).

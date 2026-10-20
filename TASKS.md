# TASKS — все транспорты в JS

Статусы: `[ ]` ждёт · `[~]` выполняется · `[x]` выполнено и проверено · `[!]` проблема · `[-]` отменено (с причиной).
Процент = выполненные / (все − отменённые). План: [docs/PLAN-js-migration.md](docs/PLAN-js-migration.md).

## Общий статус: 1 / 30 — 3 %

## Решения (2026-10-20)
- MAX, MTS-Link, Bitrix24, PRUFFME — пробовать гостем самому; где нельзя — «нет доступа» в таблице.
- direct и phpbox остаются нативными.
- Подпись пакетов — ключ OpenFluxTeam (pub в officialKeys нашего ядра).

## A. Инфраструктура
- [x] A1. Форки `OpenFluxTeam/OpenFluxTransports`, `OpenFluxTeam/OpenFluxTransportTemplate`; клоны в `~/openflux/transports-work` (origin = OpenFluxTeam, upstream = p1neappleXpress); ветки `js-all` (транспорты) и `js-transports` (ядро).
- [ ] A2. Ключ подписи OpenFluxTeam; pub в `transport/script/trust.go`; секрет `SIGNING_KEY` в форке.
- [ ] A3. URL обновлений в манифестах/index.json → OpenFluxTeam; CI форка собирает инструменты из нашего ядра.

## B. Ядро
- [ ] B1. `auth` в `info()`/манифесте, `Inspect`, фильтр кук в `ApplyCookies`/хранилище.
- [ ] B2. Хост WebRTC: медиатреки (отправка сэмплов/RTP, приём) — для telemost.
- [ ] B3. Выбор пакета: `type=<натив>` → установленный/встроенный JS-пакет того же id.
- [ ] B4. Сборка/подпись пакетов в ядре (scriptbundle, scriptsign) для стенда тестов.

## C. Синхронизация JS с нативами
- [ ] C1. yandex
- [ ] C2. vyandex
- [ ] C3. boards
- [ ] C4. mailru (чат-канал 1.2.0 из ядра + изменения натива после)
- [ ] C5. cupsonline
- [ ] C6. oneme-iceinject / oneme-webrtc

## D. Новые порты и перенос
- [ ] D1. avito
- [ ] D2. telemost
- [ ] D3. vkteams (из `~/openflux/vkteams-transport`, 1.0.2)
- [ ] D4. mtslink, bitrix, pruffme: `auth`, проверка

## E. Клиенты
- [ ] E1. Аккаунты из `auth` пакетов вместо захардкоженного `AccountKind`
- [ ] E2. Вход в приложении по `authRequired`, куки по списку (Desktop)
- [ ] E3. То же на Android

## F. Тесты (каждый транспорт отдельно)
- [ ] F0. Стенд: JS ↔ JS на этом ПК, метрики (TTFB, ↓, ↑, 4×, 10 мин, sha256)
- [ ] F1. yandex · [ ] F2. vyandex · [ ] F3. boards · [ ] F4. mailru · [ ] F5. cupsonline · [ ] F6. avito
- [ ] F7. telemost · [ ] F8. vkteams · [ ] F9. oneme · [ ] F10. mtslink · [ ] F11. bitrix · [ ] F12. pruffme

## G. Итог
- [ ] G1. Таблица `docs/RESULTS.md` + страница
- [ ] G2. PR/пуш веток в OpenFluxTeam

## История
- 2026-10-20: инвентаризация. В OpenFluxTransports 10 JS-транспортов; JS = копии из ядра (кроме mailru: в ядре 1.2.0 на чате);
  нативы ушли вперёд после 2026-10-04 (mailru 15 коммитов, cupsonline 17, avito 11, yandex 6). avito и telemost есть только нативом.
  Форки сделаны, план записан.

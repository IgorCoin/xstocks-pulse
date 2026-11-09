# xStocks Pulse

Сайт у стилі Proof of VARIATIONAL: лідерборд тих, хто пише про xStocks в X, скан будь-якого хендла, очки, картка PNG.
Smart followers необов'язкові: без `MONI_KEY` колонки приховані, потрібен лише `TWITTERAPI_KEY`.
Без залежностей, потрібен лише Node 20+.

## Запуск

```bash
# без ключів, з фейковими даними
MOCK=1 node server.js          # http://localhost:3000

# з реальними даними
cp .env.example .env           # впишіть TWITTERAPI_KEY (MONI_KEY за бажанням)
node server.js
```

Під час першого старту сервер сам індексує останні 30 днів, далі оновлюється раз на 24 години
(повторно завантажує останні 7 днів, щоб оновити лайки й перегляди свіжих постів).

## Як це працює

| Частина | Файл |
|---|---|
| Збір постів (twitterapi.io) | `lib/twitter.js` |
| Smart followers і Moni score | `lib/moni.js` |
| Підрахунок очок, розбивка згадок | `lib/score.js` |
| Щоденний індексатор, скан хендла, ліміти | `lib/indexer.js` |
| API і статика | `server.js` |
| Сторінка | `public/index.html` |

API: `GET /api/stats`, `GET /api/leaderboard?sort=points|views|likes|posts|smart`, `GET /api/user/:handle`,
`POST /api/scan/:handle`, `POST /api/refresh` (заголовок `Authorization: Bearer $ADMIN_TOKEN`).

## Історія від січня для лідерборда (з контролем витрат)

Звичайний запуск збирає лише 30 днів. Щоб підтягнути всю історію для всіх авторів:

```bash
node backfill.js --estimate     # приблизна ціна за кількома пробними днями
node backfill.js --budget 1     # збирає історію, зупиняється, коли витрачено $1
```

- Перед запуском **зупиніть сервер** (Ctrl+C), інакше він і скрипт перезапишуть дані один одного. Скрипт сам відмовиться працювати, якщо сервер увімкнений.
- Збір іде по днях від сьогодні назад до `backfill.sinceDate`. Прогрес зберігається: якщо бюджет скінчився або сталась помилка, повторіть ту саму команду, і збір продовжиться з місця зупинки. Знову платити за вже зібрані дні не доведеться.
- Дні, де постів більше за ліміт (`maxPagesPerChunk` × 20), позначаються в підсумку як неповні.
- Ліміт бюджету за один запуск: `--budget N` або `backfill.maxBudgetUsd` у `config.json`. Ціна: приблизно $0.00015 за пост.
- На сервері в інтернеті: `POST /api/backfill?budget=1` із заголовком `Authorization: Bearer $ADMIN_TOKEN`, статус: `GET /api/backfill`.
- Лайки й перегляди старих постів не оновлюються щодня, оновлюються лише пости за останні 7 днів.

## Налаштування: `config.json`

- `searchQuery`, `keywords`, `tags`, `officialHandle`: що вважати згадкою xStocks. Перевірте офіційний хендл.
- `weights`: формула очок. Зараз 2,5% переглядів + 100% лайків + 250% постів, як у прикладі. `smart` за замовчуванням 0, можна додати вагу.
- `scan`: ліміти на скан чужих хендлів (на IP за годину, на всіх за добу), щоб не злити бюджет API.
- `maxPagesPerRun`: стеля витрат на один індекс (сторінка ≈ 20 постів).

## Деплой

Потрібен хостинг із постійним диском, бо дані лежать у `DATA_DIR/db.json`.
Railway, Render, Fly.io або VPS: збірка з `Dockerfile`, змонтуйте том на `/data`, додайте змінні з `.env.example`.

**Railway:** репозиторій на GitHub (без `.env` і папки `data`), New Project, Deploy from GitHub repo, змінні `TWITTERAPI_KEY` і `ADMIN_TOKEN`, Volume із шляхом `/data`, Generate Domain.
`PORT`, `TRUST_PROXY` і `DATA_DIR` вже виставлені в `Dockerfile`.

**Перенесення історії з комп'ютера на сервер** (щоб не платити за збір вдруге):

```bash
gzip -c data/db.json | curl -X POST -H "Authorization: Bearer ВАШ_ADMIN_TOKEN" -H "Content-Encoding: gzip" --data-binary @- https://ВАШ-ДОМЕН/api/import
```

Відповідь `{"added":...}` означає успіх. Імпорт нічого не стирає: пости, які вже є на сервері, лишаються, дублікатів немає. Запускайте його, коли локальний збір завершено.

Публічні скани мають добовий ліміт витрат `scan.dailyBudgetUsd` у `config.json` (за замовчуванням $1), щоб відвідувачі не могли витратити ваш баланс.

## Що перевірити після першого запуску з ключами

1. Колонки Smart foll. і Moni заповнились. Якщо ні, поправте регулярки в `lib/moni.js` під реальну відповідь Moni.
2. Поля постів із twitterapi.io (`likeCount`, `viewCount`, `isReply`, `author.followers`) збігаються з `normalize()` у `lib/twitter.js`.
3. Кількість постів схожа на те, що видно в пошуку X за тим самим запитом.

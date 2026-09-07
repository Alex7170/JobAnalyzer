# jobscz-scraper

Пайплайн: скрапинг jobs.cz (Playwright) → обработка вакансий через Claude API → анализ ответов.

## Установка

```bash
npm install
npm run playwright:install   # ставит headless Chromium для Playwright
cp .env.example .env         # и вписать свой ANTHROPIC_API_KEY
```

## Запуск

```bash
npm run scrape    # -> data/jobs.json
npm run process   # -> data/assessments.json (читает data/jobs.json)
```

## Важно про robots.txt / антибот-защиту

`jobs.cz/robots.txt` разрешает `/prace/` (листинги) и `/rpd/` (карточки вакансий) —
именно эти пути и использует скрапер. Явно запрещены `/muj/`, `/api/`, `/iapi/`,
`/asmt/`, `/status/`, `/translations/`, `/js/`, `/nabidky-podle-cv/`,
`/session-log/` — в `scrape.ts` есть проверка `assertAllowedUrl`, которая
кинет ошибку, если случайно укажешь такой URL в `.env`.

Отдельно от robots.txt на сайте, по всей видимости, работает антибот-защита
на уровне IP/фингерпринта (сторонние скраперы жалуются на блокировку
датацентровых прокси) — поэтому:
- используется реальный headless-браузер, а не голый fetch;
- есть задержки между запросами (`MIN_DELAY_MS`/`MAX_DELAY_MS` в `.env`);
- не стоит гонять `MAX_JOBS` на сотни и параллелить множество вкладок.

## Что почти наверняка придётся подправить руками

Разметка jobs.cz нигде не документирована, поэтому `extractJobsFromPage` в
`src/scraper/scrape.ts` собирает карточки эвристически: ищет все ссылки на
`/rpd/{id}/` и пытается вытащить компанию/локацию/зарплату из текста
родительского блока. Это сработает как отправная точка, но:

1. Запусти `npm run scrape` с `HEADLESS=false` в `.env`, чтобы увидеть браузер.
2. Открой ту же страницу в обычном Chrome, зайди в DevTools → Elements,
   найди контейнер одной карточки вакансии (обычно `<article>` или `<li>` с
   `data-*` атрибутом).
3. Замени эвристику (`container.parentElement` цикл + парсинг строк) на
   точные селекторы этого контейнера — будет надёжнее и быстрее.

## Структура

```
src/
  types.ts              # zod-схемы JobListing / JobAssessment
  logger.ts              # pino-логгер
  scraper/
    scrape.ts             # Playwright: листинг -> data/jobs.json
    utils.ts              # extractJobId, randomDelay
  ai/
    processJobs.ts         # Claude API: jobs.json -> assessments.json
  index.ts                # заглушка-оркестратор
data/
  jobs.json               # результат scrape (создаётся при запуске)
  assessments.json        # результат process (создаётся при запуске)
```

## Дальнейшие шаги (не реализовано)

- Пагинация по нескольким страницам листинга (`?page=N`).
- Переход на страницу вакансии (`/rpd/{id}/`) за полным описанием перед
  отправкой в Claude — сейчас в AI уходят только данные с карточки листинга.
- `node-cron` для периодического запуска.
- Дедупликация: не гонять уже виденные `id` повторно (например, через
  `better-sqlite3` вместо плоского JSON).

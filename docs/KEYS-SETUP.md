# Growth harness: как получить ключи

Все ключи кладутся в `.env.growth` в корне репозитория (файл в `.gitignore`). Шаблон: `.env.growth.example`.
Не вставляй ключи в чат и в коммиты. Лучше использовать secrets-форму BB.

Проверка, что уже настроено (внешних запросов не делает):

```sh
pnpm growth:doctor
```

По умолчанию стоит `GROWTH_DRY_RUN=on`: ничего не уходит наружу. Живой режим включай только после того, как проверил ключи по одному.
Цены и лимиты сервисов меняются. Перед оплатой проверяй актуальные условия на сайте сервиса.

## Минимум для живого цикла

| Назначение | Переменные | Где взять |
|---|---|---|
| LLM (мозг CEO) | `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys. Нужен платёжный баланс. Модель: `GROWTH_MODEL`. |
| Поиск аудитории | `EXA_API_KEY` | dashboard.exa.ai → API Keys. |
| Публикация | `POSTIZ_API_KEY` (+ `POSTIZ_BASE_URL`, если self-host) | Postiz → Settings → Public API. Сначала подключи в Postiz каналы X/LinkedIn. `POSTIZ_X_INTEGRATION_ID` необязателен: иначе берётся из `/integrations`. |
| Аналитика | `POSTHOG_KEY`, `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID` | PostHog → Project settings (project key и ID); personal API key: User settings → Personal API keys, только read-доступ. |

## По желанию

| Назначение | Переменные | Где взять |
|---|---|---|
| Картинки | `FAL_KEY` | fal.ai → Dashboard → Keys. Оценка цены за картинку: `GROWTH_FAL_IMAGE_USD`. |
| Bluesky (безопасный авто-канал) | `BLUESKY_HANDLE`, `BLUESKY_APP_PASSWORD` | Bluesky → Settings → Privacy and security → App passwords. Только app password, не пароль аккаунта. |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Токен: @BotFather. Chat ID: добавь бота в НАШ канал/чат и вызови `getUpdates`. |
| Discord | `DISCORD_WEBHOOK_URL` | Server settings → Integrations → Webhooks, только НАШ сервер. |
| Email подписчикам | `RESEND_API_KEY`, `RESEND_FROM` | resend.com → API Keys и подтверждённый домен отправителя. Только opt-in получатели. |
| Холодные кампании | `INSTANTLY_API_KEY` | Кампании создаются на паузе и харнесс их не запускает. |
| Клип геймплея | `GROWTH_CLIP_PATH` | Путь к mp4/webm; нужен локальный `ffmpeg`. |

## Бюджет и реальные расходы

- Лимиты задаются в `growth/policy.yaml` (`cycle_budget_usd`, `total_budget_usd`). Харнесс их не меняет.
- Расходы в харнессе: оценки. Это не счета.
- Чтобы записать реальный платёж в on-chain бухгалтерию (testnet), задай `GROWTH_EXPENSE_PAYEE=<аккаунт>.testnet`, `GROWTH_EXPENSE_WRITES=on` и курс `GROWTH_EXPENSE_USD_PER_NEAR`.
  Курс демонстрационный: у testnet NEAR нет рыночной цены.
- Затем в Mission Control у выполненного действия нажми кнопку чека. Укажи фактическую сумму в USD, HTTPS-ссылку на чек без секретов и имя утвердившего. Это единственный путь записи расходов.
- Board-запись (`GROWTH_BOARD_WRITES=on`) разрешает агенту создавать и финализировать Board-предложения на testnet-контракте.

## Порядок включения

1. Заполни ключи → `pnpm growth:doctor`.
2. Запусти `pnpm growth` в dry-run, проверь карточки в Mission Control.
3. Включай `GROWTH_DRY_RUN=off` только после проверки каждого канала. L2-действия (публикации) всё равно требуют ручного Approve.
4. Живой цикл с реальными сервисами пока не проверен. Код покрыт fixture-тестами.

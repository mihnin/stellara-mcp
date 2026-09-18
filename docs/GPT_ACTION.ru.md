# Stellara как Custom GPT (ChatGPT Actions)

Пока у Stellara нет remote-MCP (PR 4 плана Phase 2), ChatGPT подключается к тому же
астрономическому API напрямую — через **Custom GPT с Actions** по OpenAPI-схеме.
Схема (только 4 публичных эндпоинта, авторизация API-ключом) генерируется из бэкенда и
публикуется на лендинге: **https://stellara.natlex.it/openapi-gpt.json**
(исходник — `landing/openapi-gpt.json`; пересобрать: скрипт в разделе «Обновление»).

## Создание GPT (10 минут, нужен ChatGPT Plus/Pro/Team)

1. chatgpt.com → **Explore GPTs → Create** → вкладка **Configure**.
2. **Name**: `Stellara Astrologer`. **Description**: `Exact natal charts, transits and
   synastry from Swiss Ephemeris — the GPT interprets, the engine computes.`
3. **Instructions** — вставить блок ниже (раздел «Instructions»).
4. **Conversation starters** (по желанию):
   `Calculate my natal chart` · `What transits am I under this week?` ·
   `Compare my chart with my partner's` · `Я родился 17.05.1990 в Варшаве — что скажешь?`
5. **Actions → Create new action**:
   - **Authentication** → *API Key* → Auth Type **Custom**, Custom Header Name `X-API-Key`,
     значение — ключ Stellara (для публичного GPT — **отдельный Pro-ключ**, выпущенный через
     `POST /api/admin/api-keys {"email":"gpt@natlex.it","tier":"pro"}`; квота 5 000/день
     общая на всех пользователей GPT — при росте выдать `daily_limit` побольше через тот же
     admin-эндпоинт).
   - **Schema** → *Import from URL* → `https://stellara.natlex.it/openapi-gpt.json`
     (или вставить содержимое файла). Должны появиться 4 действия:
     `resolve_birth_place`, `calculate_natal_chart`, `get_transits_and_aspects`,
     `calculate_synastry`.
   - **Privacy policy**: `https://www.natlex.it/privacy.html` (обязательна для публикации в GPT Store).
6. Проверить в правой панели: «Resolve Warsaw, 1990-05-17 14:30» → должен вызвать
   `resolve_birth_place`, затем «натальная карта» → `calculate_natal_chart`.
7. **Create → Publish → GPT Store** (категория *Lifestyle*). Модерация OpenAI 1–3 дня.

Замечания:
- Лимит 5 000 запросов/день на ключ GPT — это ~1 000 полных разборов в сутки; больше — поднять
  `daily_limit` у ключа.
- Ошибки API GPT видит как текст: `INVALID_API_KEY` (ключ отозван), `QUOTA_EXCEEDED`
  (сброс 00:00 UTC), `PLACE_NOT_FOUND`, `GEOCODER_UNAVAILABLE`, `INVALID_INPUT` —
  Instructions ниже говорят модели, что с ними делать.
- Когда появится remote-MCP (`https://mcp.stellara.natlex.it/mcp`), GPT можно оставить —
  Actions и MCP-коннектор живут параллельно.

## Instructions (вставить в GPT как есть)

```
You are Stellara Astrologer. You interpret; the Stellara API computes with Swiss
Ephemeris. Never invent or guess a planetary position, sign, degree, house cusp, aspect
or time-zone offset — if you have no tool result for it, call the tool.

Collect the birth profile first, one step at a time, in this order:
1. Date of birth — day, month, year. Confirm ambiguous formats (05/06 → 5 June or 6 May?).
2. Time of birth — always ask for a clock reading (hours and minutes) and classify it:
   exact (birth certificate / hospital record) or approximate (±1–2 h). Do not accept
   "morning" as a time. Only if the user confirms nobody knows the time, treat it as
   unknown: use 12:00 local, say so, and do NOT interpret the Ascendant, Midheaven or
   houses. Approximate → interpret them tentatively.
3. Place of birth — city/town + region + country, in any language. Call
   resolve_birth_place with `place` and `local_datetime` in the form YYYY-MM-DDTHH:MM
   (or YYYY-MM-DD if the time is unknown). Never add a UTC offset yourself. Show the
   resolved place, coordinates and time zone and ask the user to confirm. If
   local_time_ambiguity is not "none", ask which clock time they mean.
4. Current place of residence (optional, but ask) — country + city/town/village, only to
   interpret "today / now / this week" in their local time. Never relocate the chart.
5. Name (optional; use it once). Gender — ask only for a synastry reading.
Then show a short confirmation card (date, time + certainty, resolved place, age from
age_years) and only after confirmation call calculate_natal_chart with the exact
birth_datetime, latitude and longitude returned by resolve_birth_place (house_system
"placidus" unless asked). For "what is happening now" use get_transits_and_aspects with
target_datetime = the current moment in the user's local time zone as ISO-8601 with
offset. For two people use calculate_synastry after resolving both places.

Interpretation: lead with Sun, Moon and Ascendant, then the tightest aspects (smallest
orb), then houses; round degrees to whole numbers; separate facts (positions) from
interpretation; keep the user's language. Do not repeat the name in every paragraph.

Errors from the API: INVALID_API_KEY → tell the user the service key needs attention
(info@natlex.it); QUOTA_EXCEEDED → the daily quota is used up, resets at 00:00 UTC;
PLACE_NOT_FOUND → ask for a larger nearby city and the country; GEOCODER_UNAVAILABLE →
retry once, then ask for coordinates; INVALID_INPUT → re-check the birth data format.
Nothing about the user is stored on the Stellara server.
```

## Обновление схемы

Схема — производная от `backend/app/routers/astrology_api` + `models/responses.py`. После
изменения контракта API пересобрать и задеплоить лендинг:

```bash
cd backend && JWT_SECRET=x DB_HOST=127.0.0.1 DB_PORT=1 python - <<'EOF'
# см. scripts в docs: берёт app.openapi(), оставляет /api/v1/astrology/*, ставит
# operationId = имена MCP-инструментов, security = X-API-Key, servers = api.stellara.natlex.it
EOF
```
(Готовый генератор: `scripts/gen_gpt_openapi.py`.)

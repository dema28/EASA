# EASA ATPL Quiz Helper

Простой веб-инструмент для обработки вопросов уровня EASA ATPL (Airline Transport Pilot Licence).

## Что делает

- Парсит текст вопроса + 4 варианта ответов из textarea (формат: `ID`, затем `Вопрос`, затем 4 строки вариантов)
- Перед ответом сначала делает retrieval по базе известных вопросов (lexical/option similarity + subject/topic)
- Затем LLM используется как reranker/arbitrator по retrieved evidence (строгий JSON-контракт), а при сильном совпадении может быть bypass-LLM
- Полученный `A/B/C/D` и explainability (confidence/evidence) отображаются в UI и сохраняются в SQLite
- Хранит данные на сервере в SQLite (`data/easa-atpl.sqlite`, через API)
- Позволяет редактировать строки, удалять и экспортировать таблицу в CSV (Excel)

## Установка

1. Установите зависимости:

```bash
npm install
```

2. Настройте переменные окружения.
Рекомендуемый вариант: скопировать `.env.example` в `.env` и заполнить ключи.

LLM providers:
- `OPENAI_API_KEY` (предпочтительнее)
- `GOOGLE_API_KEY`

Если ключей LLM нет, система деградирует в retrieval-only поведение (может вернуть ответ при сильном совпадении).

3. Запустите сервер:

```bash
npm start
```

4. Откройте браузер: http://localhost:5173

## Хранилище данных

Данные по вопросам хранятся в SQLite: `data/easa-atpl.sqlite`.

При первом запуске (если SQLite пустая) приложение мигрирует текущий `questions.json` в БД.

## Как пользоваться

1. Вставьте вопрос и варианты ответа (по одной строке):

```
ID вопроса
Вопрос
+ A) вариант
B) вариант
C) вариант
D) вариант
```

Правильный вариант можно отметить знаком `+` в начале строки с соответствующим вариантом (например: `+ A) ...`). Если `+` не указан — правильный ответ определит AI.

2. Нажмите **"Добавить в таблицу"**. Система автоматически отправит запрос к AI и заполнит столбец **Правильный ответ**.
3. Экспортируйте данные в CSV (открывается в Excel) через **"Экспорт в Excel"**.

## Примечания
- Дубликаты по `id` отбрасываются при сохранении (оставляется первое в полученном списке).
- Результат модели валидируется по строгому JSON-контракту (server-side): при нарушении схемы запрос завершается ошибкой, а данные не сохраняются.

## Импорт ранее пройденных тестов

Источники накопленных вопросов в репозитории:
- `questions.json` (старый JSON формат).

Чтобы загрузить/нормализовать накопленные вопросы в SQLite и построить searchable corpus:

1. Запуск:
```bash
npm run import:passed
```

В тестовом/детерминированном режиме импорт также поддерживает env-переменные:
- `EASA_IMPORT_INPUT_JSON_PATH` (путь к входному JSON)
- `EASA_IMPORT_DB_PATH` (путь к SQLite)
- `EASA_IMPORT_REPORT_PATH` (куда записать отчёт)

2. Результат:
- База обновляется в `data/easa-atpl.sqlite`.
- Появляется отчёт: `logs/import-report-*.json`.

## Нормализация и дедуп-правила (детерминированно)

Используются два уровня канонизации:
- `exact` (для точных дублей): lowercasing + сворачивание пробелов, пунктуация сохраняется (но приводится к нормальной форме кавычек/тире).
- `loose` (для near/reorder): дополнительно убирается почти вся пунктуация (оставляем только `a-z0-9` и пробелы), также нормализуются OCR-ошибки (например `ﬁ/ﬂ`), дефисы и “цифровой мусор”.

Опции:
- перед канонизацией удаляются маркеры вида `+` и `A)/B)/C)/D)`, затем делается нормализация.

Дедуп категории:
- exact duplicates: совпадает `question_exact` + опции в упорядоченном виде A-D + совпадает текст правильного варианта.
- near duplicates: совпадает `question_loose` + опции в упорядоченном A-D + совпадает текст правильного варианта.
- reordered duplicates: совпадает `question_loose` + набор опций (без учёта порядка) + совпадает текст правильного варианта.
- suspicious near duplicates: если `question_loose` совпадает, но опции не совпадают, однако их “сходство” по токенам >= `0.9`, запись вставляется как `source_type="imported_needs_review"` и `is_verified=0` (ничего не теряется).

Отчёт содержит:
- `total input_rows`
- сколько точных/near/reorder-дублей схлопнуто
- сколько записей добавлено для ручной проверки
- сколько записей пропущено как incomplete

## Классификация subject/topic (под retrieval)

Вопросы автоматически размечаются по `subject_code/topic_code` детерминированным rule-based классификатором.

Результат сохраняется в SQLite и доступен через `GET /api/questions`, включая:
- `subject_code`, `subject_name`
- `topic_code`, `topic_name`
- `classification_confidence` (0..1)

Если правило не даёт уверенности (confidence < `0.6`), классификация ставится в `unknown`.

Примечание: сейчас taxonomy намеренно “узкая” и прозрачная (в первую очередь под текущие типы вопросов в MVP). Её легко расширять новыми keyword-группами.

Текущие базовые subject/topic правила:
- `aircraft_electrical`:
  - `electrical_theory`: `ohm`, `ohm's law`, `resistance`, `voltage`, `current`, `ampere`
  - `motors_generators`: `dc motor`, `induction motor`, `shunt wound`, `series wound`, `compound wound`, `rectifier`, `inverter`, `alternator`
  - `distribution_protection`: `busbar`, `load shedding`, `static discharger`, `maintenance bus`, `circuit breaker`
- `meteorology`: `turbulence`, `icing`, `cloud`, `visibility`, `pressure`, `wind`, `wind shear`
- `navigation_radio`: `vor`, `ndb`, `adf`, `dme`, `gps`, `fms`
- `air_law`: `easa`, `regulation`, `licence`, `easa`, `notam`, `air traffic`, `icao`

## Ручная коррекция classification

Для будущего UI/админки предусмотрен эндпоинт:

`POST /api/questions/:id/classification`

Он позволяет переопределить subject/topic вручную (по `id` из таблицы).

## Retrieval: поиск похожих вопросов (лексический MVP)

Добавлен retrieval слой поверх SQLite (FTS5 + детерминированный token-based скоринг).

### API

1. Retrieval-only endpoint:

`POST /api/retrieve`

Вход: `{ "questionText": "<question>\\n<option A>\\n<option B>\\n<option C>\\n<option D>", "topN": 10 }`

Выход: `{ classification, candidates: [...] }`, где каждый candidate содержит:
- `matched_external_id` / `matched_question_id`
- `similarity_score`
- `reason/evidence` (question_sim, option_sim, subject_boost, matched_question_tokens, option_best_matches)
- `subject_code/topic_code`
- `known_correct`

2. Интеграция в LLM шаг:

`POST /api/answer` теперь сначала вызывает retrieval и добавляет top-5 похожих примеров в prompt (как references), после чего модель всё равно отвечает только strict JSON.

Начиная с Stage 7, LLM выступает как reranker/arbitrator:
- выбирает `suggested_answer` только на основе retrieved evidence
- возвращает `confidence` и `insufficient_evidence`
- backend строго валидирует JSON-контракт и при сильном совпадении может bypass-ить LLM

## Embeddings и hybrid search

Если в окружении задан `OPENAI_API_KEY`, включается semantic слой на базе embeddings поверх уже существующего lexical+option retrieval.

Хранение в SQLite:
- `questions.embedding_json` содержит embeddings для:
  - `question_embedding` (normalized question text)
  - `combined_embedding` (normalized question + normalized options A-D)

Hybrid ranking:
- `lexical_combined = 0.65 * question_token_jaccard + 0.35 * option_token_jaccard`
- `semantic_score_01 = (cosine_similarity + 1) / 2` (только если embeddings есть)
- `final_score = lexical_combined * (sem_available ? 0.6 : 1.0) + semantic_score_01 * (sem_available ? 0.4 : 0) + subject_boost`

Fallback:
- если embeddings недоступны/отсутствуют, используется только lexical+option+subject_boost.

Прогрев embeddings (опционально, локально удобно):
- `npm run embeddings:build`
- или endpoint: `POST /api/embeddings/build` (body: `{ "limit": 200 }`)

Что даёт hybrid:
- помогает находить “те же” вопросы с другой формулировкой (paraphrase)
- лучше работает, когда lexical-ключевые слова перефразированы

## Explainability, confidence и manual review (Stage 8)

UI/Backend теперь позволяют понять, почему система предложила ответ, и где нужна ручная проверка.

### Поля в API `/api/answer`
Модель (reranker) возвращает strict JSON:
- `suggested_answer` (в итоге фронт показывает как `answer`)
- `confidence` (0..1)
- `insufficient_evidence` (boolean)
- `evidence_basis` (краткая строка: на каких retrieved evidence опирается решение)
- `matched_question_ids` (string[])

В `insufficient_evidence=true` confidence должен быть низким.

### Поля в SQLite (GET `/api/questions`)
Для каждой записи хранятся:
- `inference_confidence`
- `inference_evidence_basis`
- `inference_insufficient_evidence`
- `inference_matched_question_ids`
- `source_type` + `is_verified` (верификация/статус)

### Состояния для UX
- `verified` — `is_verified=1`
- `needs_manual_review` — `is_verified=0` и (confidence < 0.6 или `insufficient_evidence=true` или `source_type` содержит `needs_review`)
- `ai_inferred` — `is_verified=0` и `source_type` начинается с `AI_inferred` (но без признаков needs_review)

### Manual review endpoint
`POST /api/questions/:id/review`
- body: `{ "verified": true }`

После этого запись становится `verified` (frontend покажет updated статус).

## Оценка качества (Stage 10)

Добавлен локальный benchmark/evaluator, который измеряет качество retrieval и (при наличии `OPENAI_API_KEY`) сравнивает:
- `lexical_retrieval` (embeddings отключены)
- `hybrid_retrieval` (embeddings включены)
- `retrieval_rerank` (LLM reranker поверх retrieved evidence)
- `legacy_direct` (старый direct-answer prompting, только если есть ключ)

Запуск:

```bash
npm run eval:run -- --limit=20 --variants=2 --topN=10 --modes=all
```

## Тесты, надёжность и техдолг (Stage 11)

Покрытие критичных мест автотестами (unit/integration/regression), чтобы система не “развалилась” на следующем изменении.

Запуск:

```bash
npm test
```

Тесты не требуют внешних LLM API: они проверяют парсинг/контракты/БД/ранжирование в детерминированном режиме.

Отчёт записывается в `logs/eval-report-*.json` и печатается в консоль.

Метрики (в текущем MVP-слое):
- `top1_accuracy`: ответ (или выбранный кандидат) совпадает с ground truth (correct вариант в БД) по top-1retrieval
- `top3_accuracy`: ground truth найден среди топ-3 retrieved candidate
- `exact_hit_rate`: в exact-variant (без шумов) top-1 candidate имеет `question_sim≈1` и `option_sim≈1` и при этом correct совпадает
- `near_hit_rate`: в exact-variant top-1 candidate имеет `combined_sim>=0.8` и correct совпадает
- `low_confidence_rate` / `needs_manual_review_rate`: оцениваются только для LLM reranker/legacy (если доступен LLM), иначе 0

`manual correction rate` в этом скрипте аппроксимируется как доля кейсов, где UI должен просить manual review:
`insufficient_evidence=true или confidence<0.6 или ответ неверный`.

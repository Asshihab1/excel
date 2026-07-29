# Langchain Module — Context

HR AI assistant for the `node-server` (NestJS) service. Answers natural-language HR questions ("who's late today", "total payroll this month", "who is on shift A") via a tiered pipeline: cache hit → fixed Prisma tool call → LLM-generated SQL fallback. Not a general-purpose MES assistant — scope is HR only (employees, attendance, leave, payroll, shifts/roster, bonuses, promotions, assets, notices, blacklist, departments/designations, holidays).

Despite the module name, it does **not** use the LangChain library (`@langchain/core` isn't installed) — "langchain" is just this module's name. All LLM calls go straight to Gemini (`@google/genai`) or a local Ollama instance via plain HTTP/SDK calls in `narrate()`.

## File map

| File | Role |
|---|---|
| `langchain.module.ts` | Nest module wiring — registers `LangchainController` + providers `LangchainService`, `LangchainQdrantService`, `McpService`, `HrToolsService`, `PrismaService`. |
| `route.ts` | Mounts `LangchainModule` under route prefix `langchain` via Nest `RouterModule`. |
| `langchain.controller.ts` | HTTP endpoints — see Endpoints below. |
| `langchain.service.ts` | **Core pipeline.** `ask()` orchestrates the tiered flow (greeting → today-summary → Qdrant cache → HR tool router → SQL-gen fallback). Also owns session/history persistence, SQL safety checks, and result narration. |
| `hr.tools.ts` | `HrToolsService` — fixed Prisma-backed HR tools (employees, attendance, leave, payroll, shifts, roster, bonuses, promotions, assets, notices, blacklist, departments, designations, holidays). Each tool has a `name`/`description`/zod `schema`/`handler`; `tools` getter returns the full manifest, `findTool(name)` looks one up. See "HR tool-calling" below. |
| `langchain.context.ts` | `SYSTEM_PERSONA` (injected into every LLM call) + `DB_SCHEMA` (text-to-SQL fallback schema — only reached when no HR tool matches; see its own header comment for what was moved into `hr.tools.ts` and removed from here). |
| `langchain.qdrant.ts` | `LangchainQdrantService` — semantic cache over Qdrant, three collections: `langchain_trained_queries` (approved Q→SQL pairs), `langchain_q_and_a` (community-rated good/bad/mid answers), `langchain_failed_queries` (questions that failed or were rejected, for later review/retraining). Embeddings always via local Ollama `nomic-embed-text`, independent of which provider answers the question. |
| `langchain.markdown.ts` | `toMarkdownTable(rows)` — renders result rows as a markdown table for multi-row answers. |
| `seed-qdrant.ts` | CLI script (`npm run train:seed-qdrant`) — bulk-seeds `langchain_trained_queries` with known-good Q/SQL pairs for common questions. Safe to re-run (upsert keyed by question hash). |
| `retrain-failed.ts` | CLI script (`npm run train:retrain-failed`) — scans `langchain_failed_queries` for recurring patterns with a known fix, upserts the corrected SQL into the trained set, removes the fixed entries from the failed set. |

Backing tables (Prisma, MySQL): `langchain_sessions`, `langchain_chat_histories` (session + turn history — see Sessions below). Qdrant collections listed above live in a separate vector DB (`QDRANT_URL`), not MySQL.

## Request flow — `LangchainService.ask()`

Each stage is tried in order; a stage only runs if every earlier one didn't already return an answer.

```
1. Greeting/small-talk check (isConversational)          → persona-only reply, no data lookup
2. "today summary" question detector                     → GET Laravel /api/hrm/analytics/today-summary
3. Self-reference ("my"/"me" → logged-in user's name) + pronoun resolution (he/she → last-mentioned employee)
4. Qdrant: findSimilar()  — trained Q→SQL cache (score ≥ 0.7)
     high-confidence match (≥ 0.92) → run the SQL verbatim
     lower-confidence match          → adaptReferenceSql() asks the LLM to adapt the reference SQL to the new question
5. Qdrant: findBestQA()  — community-rated Q&A set (best good/bad ratio among near matches)
6. HR tool router: tryHrTool()  — plain-prompt tool selection against hr.tools.ts's manifest (NOT native function-calling — see below)
7. askViaLLM()  — generate SQL fallback: LLM writes SQL → isSafeSQL() → run → on error, one LLM-driven fix-and-retry → narrate
```

Every stage that produces an answer calls `saveHistoryAsync()` and returns `{ answer, data?, sql?, fromCache? }`. `TRAIN_MODE=true` additionally emits `langchain:validate` over the socket for stage 7 hits, so a human can approve the SQL into the trained set via `POST /validate`.

## HR tool-calling (stage 6)

`tryHrTool()` in `langchain.service.ts` builds a compact manifest string from `HrToolsService.tools` (name + param names + description) and asks the LLM: *pick one tool + JSON args, or reply `NONE`*. The reply is parsed, the args are validated against that tool's zod `schema`, and the handler is called directly through Prisma — no SQL is generated or run for anything this resolves.

This is deliberately a **plain prompt + JSON parse**, not the provider's native function-calling/tool-choice API. A native tool-calling agent was tried earlier for the SQL-gen path (see the comment above `askViaLLM()`'s call site) and proved unreliable — `gemini-flash-latest` would skip the tool under `AUTO` tool choice and answer with a generic greeting, and forcing `ANY` tool choice broke its own narration turn afterward. The plain-prompt approach sidesteps that failure mode entirely, and any parse/validation/match failure just falls through to stage 7 (SQL-gen) rather than erroring the question out.

**Adding a new HR tool:** add a method + a `tools` manifest entry in `hr.tools.ts` (name, description, zod schema, handler calling Prisma). Nothing else needs to change — `tryHrTool()` reads the manifest dynamically, and `DB_SCHEMA` in `langchain.context.ts` can lose the corresponding SQL-example block once the tool covers it (see that file's header comment).

## SQL-gen fallback (stage 7) — safety

- `isSafeSQL()` rejects anything that isn't a single `SELECT` (no writes, no multiple statements).
- `askViaLLM()` gives the LLM `DB_SCHEMA` (now HR-tool-covered domains stripped out — see `langchain.context.ts` header) + conversation history, extracts SQL from the response (`extractSQL()`, strips markdown fences), runs it via `McpService.runSelectQuery()`, and on a DB error does **one** LLM-driven fix-and-retry before giving up.
- Failures are recorded to `langchain_failed_queries` (`recordFailedQuery`) for later review via `retrain-failed.ts` or manual `/reject`.

`McpService` (`@module/mcp`) is a separate module — it also exposes an actual MCP (Model Context Protocol) server (`registerTool`/`StreamableHTTPServerTransport`) for external MCP clients, unrelated to this module's internal HR tool-calling. This module only uses its `runSelectQuery()` helper.

## Result narration

`narrateRows(question, rows, instruction?)`:
- 1 row, ≤4 keys, no train-time instruction → formatted directly (`formatAggregateRow`), no LLM call.
- >1 row, no instruction → `Found N result(s):` + a markdown table (`toMarkdownTable`) — rows are **never** narrated as LLM prose (past failure mode: hallucinated/truncated/mis-formatted lists).
- Otherwise → a short LLM-written lead-in sentence + the table (or the full instructed answer if a train-time instruction demands specific phrasing).

## Sessions & history

`langchain_sessions` (session_id, title — auto-derived from the first question, truncated to 60 chars) / `langchain_chat_histories` (session_id, role, content, created_at). `loadHistory()` pulls the last `HISTORY_LIMIT` (10) turns for pronoun/context resolution. History writes are fire-and-forget (`saveHistoryAsync`) — the answer is returned to the user before the write settles.

## Config (env vars)

| Var | Default | Purpose |
|---|---|---|
| `MODEL` | unset (→ Ollama) | `gemini` routes SQL-gen/narration/tool-routing through Gemini; anything else uses Ollama. |
| `GEMINI_API_KEY` | — | Required when `MODEL=gemini`. |
| `GEMINI_MODEL` | `gemini-flash-latest` | Gemini text model. |
| `OLLAMA_URL` | `http://localhost:11434` | Local Ollama endpoint (also used for embeddings regardless of `MODEL`). |
| `OLLAMA_MODEL` | `llama3.2` | Ollama text model. |
| `OLLAMA_EMBEDDING_MODEL` | `nomic-embed-text` | Embedding model for Qdrant similarity search. |
| `LARAVEL_URL` | `http://localhost:8000` | Backend base URL for the today-summary fetch. |
| `LARAVEL_TOKEN` | — | Bearer token for the today-summary request, if set. |
| `QDRANT_URL` | `http://localhost:6333` | Qdrant vector DB endpoint. |
| `TRAIN_MODE` | — | `true` emits `langchain:validate` on every SQL-gen-fallback hit, for human approval into the trained set. |

## Endpoints (`langchain.controller.ts`, mounted at `/langchain`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/ask` | Main Q&A entry point. Body: `question`, `session_id`, `train_mode?`, `user_name?`. |
| POST | `/validate` | Approve a question+SQL(+answer) pair into the trained Qdrant set. |
| POST | `/rate` | Community-rate an answer (`good`/`bad`/`mid`) into the Q&A Qdrant set. |
| POST | `/reject` | Record a wrong answer into the failed-queries set for review. |
| GET | `/today-summary` | Proxies the Laravel HRM today-summary analytics endpoint. |
| GET | `/sessions` | List chat sessions (id, title, created_at). |
| GET | `/sessions/:sessionId/history` | Full turn history for one session. |
| DELETE | `/sessions/:sessionId` | Delete a session (cascades to its history rows). |

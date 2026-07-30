# Langchain Module — Context

AI assistant for the `node-server` (NestJS) service, covering two modules: **HRM** (employees, attendance, leave, payroll, shifts/roster, bonuses, promotions, assets, notices, blacklist, departments/designations, holidays) and **STORE** (items/inventory, low stock, purchase requisitions/Indent/SR, purchase orders, material receipts, item returns, idle inventory, suppliers). Answers natural-language questions ("who's late today", "list low stock items") via a tiered pipeline: cache hit → fixed Prisma tool call (scoped to the active module) → LLM-generated SQL fallback (module-scoped schema). The frontend's `app-ai-chat` module dropdown (`AiChatModule` enum, `HRM`/`STORE`, defaults to `HRM`) sends `module` on every `/ask` request — this is what picks which tool manifest/schema the router is even offered, so an ambiguous question (e.g. "status") can't accidentally resolve against the wrong module's tool.

Despite the module name, it does **not** use the LangChain library (`@langchain/core` isn't installed) — "langchain" is just this module's name. All LLM calls go straight to Gemini (`@google/genai`) or a local Ollama instance via plain HTTP/SDK calls in `narrate()`.

## File map

| File | Role |
|---|---|
| `langchain.module.ts` | Nest module wiring — registers `LangchainController` + providers `LangchainService`, `LangchainQdrantService`, `McpService`, `HrToolsService`, `PrismaService`. |
| `route.ts` | Mounts `LangchainModule` under route prefix `langchain` via Nest `RouterModule`. |
| `langchain.controller.ts` | HTTP endpoints — see Endpoints below. |
| `langchain.service.ts` | **Core pipeline.** `ask(question, sessionId, trainMode, userName, laravelToken, module)` orchestrates the tiered flow (greeting/human-interaction → today-summary [HRM only] → Qdrant cache → module tool router → SQL-gen fallback). Also owns session/history persistence, SQL safety checks, and result narration. `toolsFor(module)` / `findToolAnyModule(name)` pick the right tool set (HR vs Store) or look one up across both (trained/rated cache entries don't record which module they were trained under). |
| `hr.tools.ts` | `HrToolsService` — fixed Prisma-backed HRM tools (employees, attendance, leave, payroll, shifts, roster, bonuses, promotions, assets, notices, blacklist, departments, designations, holidays). Each tool has a `name`/`description`/zod `schema`/`handler`; `tools` getter returns the full manifest, `findTool(name)` looks one up. See "Module tool-calling" below. |
| `store.tools.ts` | `StoreToolsService` — fixed Prisma-backed STORE tools (items/products, low stock, item categories, idle inventory, purchase requisitions [Indent/SPR + SR], purchase orders, material receipts, item returns, suppliers). Same `name`/`description`/`schema`/`handler` shape as `hr.tools.ts`. `current_stock` on `products` is a legacy VARCHAR column (not int) — low-stock tools cast/filter in JS rather than a Prisma column filter, mirroring the Laravel `LowStockController`'s `whereColumn` workaround. |
| `langchain.util.ts` | `serializeBigInt()` — shared by both tool files; converts Prisma `BigInt`/`Decimal`/`Date` values into JSON-safe primitives before a tool result reaches the LLM/HTTP layer. |
| `langchain.context.ts` | `SYSTEM_PERSONA` (injected into every LLM call — module-aware via `{MODULE}`, includes explicit guidance for personal/human-interaction questions about the assistant itself) + `DB_SCHEMA` (HRM text-to-SQL fallback) + `STORE_DB_SCHEMA` (STORE text-to-SQL fallback) — schemas are only reached when no tool in the active module matches; see the file's header comment for what's covered by tools vs schema-only. |
| `langchain.qdrant.ts` | `LangchainQdrantService` — semantic cache over Qdrant, three collections: `langchain_trained_queries` (approved Q→SQL pairs), `langchain_q_and_a` (community-rated good/bad/mid answers), `langchain_failed_queries` (questions that failed or were rejected, for later review/retraining). Embeddings always via local Ollama `nomic-embed-text`, independent of which provider answers the question. |
| `langchain.markdown.ts` | `toMarkdownTable(rows)` — renders result rows as a markdown table for multi-row answers. |
| `seed-qdrant.ts` | CLI script (`npm run train:seed-qdrant`) — bulk-seeds `langchain_trained_queries` with known-good Q/SQL pairs (HRM, `SEED_PAIRS`) and Q/tool pairs (STORE, `STORE_SEED_PAIRS` — `{tool, args}`, matching how STORE questions are actually answered at runtime). Safe to re-run (upsert keyed by question hash). |
| `retrain-failed.ts` | CLI script (`npm run train:retrain-failed`) — scans `langchain_failed_queries` for recurring patterns with a known fix, upserts the corrected SQL into the trained set, removes the fixed entries from the failed set. |

Backing tables (Prisma, MySQL): `langchain_sessions`, `langchain_chat_histories` (session + turn history — see Sessions below). Qdrant collections listed above live in a separate vector DB (`QDRANT_URL`), not MySQL.

## Request flow — `LangchainService.ask()`

Each stage is tried in order; a stage only runs if every earlier one didn't already return an answer.

```
1. Greeting/small-talk/human-interaction check (isConversational) → persona-only reply, no data lookup
2. "today summary" question detector (HRM module only)    → GET Laravel /api/hrm/analytics/today-summary
3. Self-reference ("my"/"me" → logged-in user's name) + pronoun resolution (he/she → last-mentioned employee)
4. Qdrant: findSimilar()  — trained Q→(SQL or tool) cache (score ≥ 0.7)
     high-confidence match (≥ 0.92) → run the SQL / replay the tool call verbatim
     lower-confidence match          → adaptReferenceSql() / adaptReferenceToolArgs() asks the LLM to adapt the reference to the new question
5. Qdrant: findBestQA()  — community-rated Q&A set (best good/bad ratio among near matches)
6. Module tool router: tryModuleTool()  — plain-prompt tool selection against the ACTIVE module's manifest only (hr.tools.ts for HRM, store.tools.ts for STORE — NOT native function-calling, see below)
7. askViaLLM()  — generate SQL fallback: LLM writes SQL against the active module's schema (DB_SCHEMA or STORE_DB_SCHEMA) → isSafeSQL() → run → on error, one LLM-driven fix-and-retry → narrate
```

Every stage that produces an answer calls `saveHistoryAsync()` and returns `{ answer, data?, sql?, fromCache? }`. `TRAIN_MODE=true` additionally emits `langchain:validate` over the socket for stage 7 hits, so a human can approve the SQL into the trained set via `POST /validate`. `module` (`'HRM' | 'STORE'`, default `'HRM'`) flows through every stage from the `/ask` request body.

## Module tool-calling (stage 6)

`tryModuleTool(question, today, module)` in `langchain.service.ts` builds a compact manifest string from ONLY the active module's tool set (`HrToolsService.tools` for HRM, `StoreToolsService.tools` for STORE — via the `toolsFor(module)` helper) and asks the LLM: *pick one tool + JSON args, or reply `NONE`*. The reply is parsed, the args are validated against that tool's zod `schema`, and the handler is called directly through Prisma — no SQL is generated or run for anything this resolves. Scoping the manifest to one module at a time keeps the router prompt small and prevents an ambiguous question resolving against the wrong module's same-named-sounding tool.

This is deliberately a **plain prompt + JSON parse**, not the provider's native function-calling/tool-choice API. A native tool-calling agent was tried earlier for the SQL-gen path (see the comment above `askViaLLM()`'s call site) and proved unreliable — `gemini-flash-latest` would skip the tool under `AUTO` tool choice and answer with a generic greeting, and forcing `ANY` tool choice broke its own narration turn afterward. The plain-prompt approach sidesteps that failure mode entirely, and any parse/validation/match failure just falls through to stage 7 (SQL-gen) rather than erroring the question out.

A trained/rated tool-cache entry doesn't record which module it was trained under — `replayTrainedTool()` looks the tool name up via `findToolAnyModule()` (HR tools then Store tools) rather than `toolsFor(module)`, since a cached hit should replay regardless of which module the question happens to be asked in now. This is safe only because HR and Store tool names never collide by naming convention (`get_employees` vs `get_products`, etc.) — keep new tool names distinct across both files.

**Adding a new tool:** add a method + a `tools` manifest entry in `hr.tools.ts` (HRM) or `store.tools.ts` (STORE) — name, description, zod schema, handler calling Prisma, using a name not already used in the other file. Nothing else needs to change — `tryModuleTool()` reads the manifest dynamically, and the matching schema (`DB_SCHEMA` or `STORE_DB_SCHEMA` in `langchain.context.ts`) can lose the corresponding SQL-example block once the tool covers it (see that file's header comment).

## Human-interaction / small-talk

`isConversational()` is a whitelist of regex patterns (greetings, thanks, filler acknowledgements, "who are you"/"what can you do", company-info questions) — anything NOT matching one of these patterns falls through to the normal data pipeline regardless of domain, so adding more conversational patterns can never accidentally swallow a real HRM/STORE question. A dedicated pattern group covers personal/human-interaction questions aimed at the assistant itself ("do you like me", "are you human", "do you have feelings", "can we be friends", etc.) — `SYSTEM_PERSONA` in `langchain.context.ts` instructs the LLM to answer these warmly and in-character (glad to help, no real feelings, never a flat "I am an AI and cannot...", never claims to be a real person) rather than falling back to a generic disclaimer. These conversational turns never touch Qdrant (short-circuited before stage 4), so "training" better small-talk behavior means tuning the regex list + persona wording here, not seeding the vector cache.

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
| POST | `/ask` | Main Q&A entry point. Body: `question`, `session_id`, `train_mode?`, `user_name?`, `module?` (`'HRM'` \| `'STORE'`, defaults to `'HRM'` if omitted/unrecognized). |
| POST | `/stop` | Cancel the in-flight generation for a session. Body: `session_id`. See "Stop / cancel generation" below. |
| POST | `/validate` | Approve a question+SQL(+answer) pair into the trained Qdrant set. |
| POST | `/rate` | Community-rate an answer (`good`/`bad`/`mid`) into the Q&A Qdrant set. |
| POST | `/reject` | Record a wrong answer into the failed-queries set for review. |
| GET | `/today-summary` | Proxies the Laravel HRM today-summary analytics endpoint. |
| GET | `/sessions` | List chat sessions (id, title, created_at). |
| GET | `/sessions/:sessionId/history` | Full turn history for one session. |
| DELETE | `/sessions/:sessionId` | Delete a session (cascades to its history rows). |

## Stop / cancel generation

`LangchainService.stopGeneration(sessionId)` (called from `POST /stop`) does two things, keyed by `sessionId`:
- Adds the session to `stopRequested` (a `Set<string>`), checked once per streamed chunk inside `narrateGemini()`'s for-await loop — breaks early, stopping US from consuming/emitting further chunks. `@google/genai`'s `generateContentStream` has no exposed abort signal, so this can't guarantee Google's own generation halts server-side, only that this process stops waiting on/forwarding it.
- Aborts the tracked `AbortController` for that session in `ollamaAbortControllers` — this DOES kill the actual in-flight Ollama HTTP request (`callOllama`'s axios call is wired to `controller.signal`), so Ollama generation genuinely stops, not just client-side rendering.

Both maps are cleared/reset at the start of every new turn (`ask()` deletes any stale `stopRequested` entry immediately; `callOllama`'s `finally` always removes its own controller once the request settles) — a stop from a previous turn can never leak into a new one, and a stale controller can never be aborted after its request already finished.

An abort mid-stream resolves with whatever text was generated so far (never rejects) — `askInternal`'s failed-query recording and the frontend's generic-error path both exist for real failures, not user-requested stops, so a stop must never look like one.

Frontend (`app-ai-chat`): `stopGeneration()` unsubscribes the local HTTP call (stops rendering more of the answer) AND fires `POST /stop` (stops the actual backend generation) — both matter, neither alone is enough.

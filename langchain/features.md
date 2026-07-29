# Langchain Module — Features & Stack

What this module actually uses, end to end. Not a wishlist — every item below is wired into `langchain.service.ts` and its neighbors right now.

## LLM providers

- **Ollama** (local, default) — `OLLAMA_URL` (`http://localhost:11434`), model `OLLAMA_MODEL` (currently `qwen3:8b`). Used for SQL-gen, HR tool routing, narration, fix-on-error retry, reference-adaptation — every `narrate()` call.
  - `think: false` — `qwen3:8b` is a reasoning model; without this it burns its whole `num_predict` budget on invisible `<think>` chain-of-thought and returns empty content.
  - `num_ctx: 8192` — explicit context window override. Ollama defaults to 2048 if unset in the model's Modelfile, which the schema-heavy prompts here (DB_SCHEMA alone is ~15KB) silently overflowed.
  - `keep_alive: '30m'` — keeps the model resident between requests instead of Ollama's ~5min idle-unload.
- **Gemini** (`@google/genai`, optional) — `GEMINI_API_KEY` + `GEMINI_MODEL` (default `gemini-flash-latest`). Only active when `MODEL=gemini` env switch is set; otherwise everything runs through Ollama. Same `narrate()` call sites, provider picked once via `hasGemini`.
- **Ollama embeddings** — `nomic-embed-text` via `OLLAMA_EMBEDDING_MODEL`, used only for Qdrant similarity search (not chat/completion).

## Vector DB / semantic cache

- **Qdrant** — `QDRANT_URL` (`http://localhost:6333`), four collections:
  - `langchain_trained_queries` — question → SQL or HR-tool-call, manually approved via `/validate` (or `TRAIN_MODE` auto-emit + approval). Curated — only what a human vetted.
  - `langchain_q_and_a` — community good/bad/mid rated Q&A pairs (`/rate`), independently searchable. Also curated.
  - `langchain_failed_queries` — questions the assistant couldn't answer or got flagged wrong, for retraining (`retrain-failed.ts`).
  - `langchain_conversation_log` — **every** turn, unconditionally, no rating/approval needed (`LangchainQdrantService.logConversation()`, called once per `ask()` from a single choke point regardless of which internal branch answered). One point per turn, never deduped by question — repeated identical questions are repeated points, since frequency is itself the analytics signal (most-asked questions, failure-rate trends, which tool/SQL path answered what, over time). Fire-and-forget — a logging failure here never affects the actual answer. Deliberately a *separate* collection from the two curated ones above: mixing unvetted answers into the cache-lookup collections would let a wrong answer get replayed with false confidence.
  - Domain-keyword guard (`sameDomain()`) — cosine similarity alone false-matched same-template-different-domain questions (e.g. "total payroll" scoring 0.77 against a cached "total bonuses" entry); a match is now only trusted if the two questions share a recognized HR-domain noun.
  - Intent-category guard (`sameIntent()`) — same-domain isn't enough either: "total payroll amount" (aggregate) matched a cached "payroll history summary" (listing) at 0.72, and `adaptReferenceSql()` stretched it into hallucinated SQL. A match is now also rejected across `comparison`/`aggregate`/`listing` query-shape categories.
  - `seed-qdrant.ts` — bulk-seeds common Q&A pairs so they never touch the live LLM at all.

## Database access

- **Prisma** — raw `$queryRawUnsafe` for the free-form SQL-gen path (via `McpService.runSelectQuery`, SELECT-only enforced), and typed Prisma Client queries for every HR tool (`hr.tools.ts`) — no raw SQL there at all.
- **MCP (Model Context Protocol)** — `McpService` exposes the same HR queries as MCP tools (`get_employees`, `get_attendance_today`, `run_select_query`, ...) over `StreamableHTTPServerTransport`, for external MCP-compatible clients, separate from the in-process HR tool router below.

## HR tool-calling (`hr.tools.ts`)

Fixed, type-safe (Zod-validated) Prisma queries — no SQL generation — for the most common HR questions: employees, attendance (+ today's present/absent/late counts), leave requests/types, payroll totals & status breakdown (with automatic fallback to the most recently processed period if the requested month has none yet), departments/designations, upcoming holidays.

- Routed via a **plain-prompt tool router** (`tryHrTool()`) — the LLM picks a tool name + JSON args from a manifest, not the provider's native function-calling API (tried and dropped — Gemini's AUTO tool choice would skip the tool entirely, forcing ANY tool choice broke the narration turn after).
- Trained tool calls (question → tool + args) are cached in Qdrant exactly like SQL, with the same verbatim-above/adapt-below `HIGH_CONFIDENCE_SCORE` replay logic (`replayTrainedTool()`, `adaptReferenceToolArgs()`).
- Router prompt is date-aware (`today` passed in) so it can resolve "last month"/"this month"/named months into concrete `month`/`year` args instead of silently defaulting to the current period.

## Observability

- **Langfuse** (deprecated v3 SDK, chosen for low integration cost over the new OTel-based `@langfuse/*` rewrite) — one trace per `ask()` request (session/user/question), every `narrate()` call logged as a nested generation (input/output/model/latency/error). No-op until `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` are set in `.env`.
- Threaded via `AsyncLocalStorage`, not function-parameter passing — `ask()` sets the trace context once, `narrate()` (called from 7+ places, several levels deep) reads it back without any signature changes elsewhere.

## Safety / guardrails

- SQL-gen is SELECT-only: `isSafeSQL()` requires the query to start with `SELECT` and rejects `INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/TRUNCATE/EXEC/EXECUTE` as **whole words** (a naive substring check previously false-rejected any query touching a `created_at`/`updated_at` column, since `CREATE`/`UPDATE` are substrings of those column names).
- Known-bad answers (`FAILURE_ANSWERS`) can never be trained/cached as good, even if a user mis-rates them.

## Realtime / integration

- **Socket.IO** (`config/socket/socket.config`) — `TRAIN_MODE=true` emits `langchain:validate` on every live SQL-gen or tool-router hit, for a human to approve into the trained set.
- **Laravel HRM API** — `fetchTodaySummary()` calls `LARAVEL_URL/api/hrm/analytics/today-summary`, authenticated with the requesting user's own Sanctum token (passed from the Angular chat widget as `laravel_token`, falling back to the static `LARAVEL_TOKEN` env var for non-chat callers).

## Conversation handling

- Session + chat history persisted via Prisma (`langchain_sessions`, `langchain_chat_histories`), capped at `HISTORY_LIMIT` (10) messages of context per request.
- Self-reference resolution ("my shift" → "{name}'s shift") — gated to a recognized personal-data noun list so unrelated phrasing ("my system") isn't corrupted.
- Pronoun resolution ("he"/"she"/"they" → last-mentioned employee name from history).
- Greeting/small-talk short-circuit — skips the whole SQL/tool pipeline for pure social messages.

import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import moment from 'moment';
import { GoogleGenAI } from '@google/genai';
import { PrismaService } from '@prisma/prisma.service';
import { McpService } from '@module/mcp/mcp.service';
import { HrToolsService, HrTool } from '@module/langchain/hr.tools';
import { StoreToolsService, StoreTool } from '@module/langchain/store.tools';
import { DB_SCHEMA, STORE_DB_SCHEMA, SYSTEM_PERSONA } from '@module/langchain/langchain.context';
import { toMarkdownTable, formatCell } from '@module/langchain/langchain.markdown';
import { LangchainQdrantService, QARating, AnswerSource } from '@module/langchain/langchain.qdrant';
import { LangfuseService } from '@module/langchain/langfuse.service';
import { socketService } from 'config/socket/socket.config';

const HISTORY_LIMIT = 10;
const GEMINI_TEXT_MODEL = process.env.GEMINI_MODEL ?? 'gemini-flash-latest';

@Injectable()
export class LangchainService {
  private readonly logger = new Logger(LangchainService.name);
  private readonly genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  private readonly laravelUrl = (process.env.LARAVEL_URL ?? 'http://localhost:8000').replace(/\/+$/, '');
  private readonly ollamaUrl = process.env.OLLAMA_URL ?? 'http://localhost:11434';
  private readonly ollamaModel = process.env.OLLAMA_MODEL ?? 'llama3.2';

  // Lightweight per-session conversation state — NOT a framework state
  // machine, just enough to resolve short follow-ups against the previous
  // turn without re-deriving everything from rendered answer text (which can
  // be phrased any way the LLM likes and is fundamentally unreliable to
  // regex against). Two independent things tracked, both set once per turn
  // from ask()'s single choke point / the tool-success sites below, read at
  // the start of the NEXT turn:
  //   - entity: WHO the last turn was about ("what's HER shift" after "who is
  //     employee 3982" — resolvePronouns() reads this instead of the old
  //     "Name (" text-regex, which stopped matching once narrateRows() started
  //     returning free-form multi-field prose instead of that one legacy shape).
  //   - intentTool/intentArgs: WHICH tool + args last answered a question, so a
  //     follow-up with no pronoun at all ("what about last month?", "same for
  //     the other department") can re-run the same tool with just the changed
  //     arg instead of the router re-resolving from a bare fragment.
  // In-memory, per-session, intentionally ephemeral (same durability class as
  // LangchainQdrantService's `ensured` Set) — a lost entry on restart just
  // falls back to the old history-scan/carry-forward behavior, never a hard
  // failure. Not persisted across node-server restarts or multiple instances
  // — move to Redis/DB if that ever matters.
  private readonly sessionState = new Map<string, { entity?: string; intentTool?: string; intentArgs?: Record<string, any> }>();

  // Stop/cancel support. Two mechanisms, because the two providers don't
  // offer the same cancellation primitive:
  //   - Ollama: a real AbortController per in-flight session, wired into the
  //     axios request's `signal` (callOllama) — abort() actually kills the
  //     HTTP request, so the model stops generating server-side too, not
  //     just client-side rendering.
  //   - Gemini (`@google/genai`): no exposed abort signal on
  //     generateContentStream — `stopRequested` is checked once per chunk in
  //     the for-await loop (narrateGemini) and breaks early. Best-effort:
  //     stops US from consuming/emitting further chunks immediately, but
  //     can't guarantee Google's own generation stops mid-flight.
  // Both keyed by sessionId, both cleared at the start of each new turn
  // (ask()) so a stop from a previous turn can never leak into a new one.
  private readonly stopRequested = new Set<string>();
  private readonly ollamaAbortControllers = new Map<string, AbortController>();

  stopGeneration(sessionId: string): void {
    this.stopRequested.add(sessionId);
    this.ollamaAbortControllers.get(sessionId)?.abort();
  }

  private rememberIntent(sessionId: string, tool: string, args: Record<string, any>): void {
    this.sessionState.set(sessionId, { ...this.sessionState.get(sessionId), intentTool: tool, intentArgs: args });
  }

  // Explicit provider switch — MODEL=gemini routes SQL-gen/narration through
  // Gemini, anything else (including unset, or MODEL=ollama) uses Ollama.
  // GEMINI_API_KEY stays configured either way so flipping this back doesn't
  // need a key re-add.
  private get hasGemini(): boolean {
    return process.env.MODEL === 'gemini' && !!process.env.GEMINI_API_KEY;
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly mcp: McpService,
    private readonly qdrant: LangchainQdrantService,
    private readonly hrTools: HrToolsService,
    private readonly storeTools: StoreToolsService,
    private readonly langfuse: LangfuseService,
  ) {}

  private toolsFor(module: 'HRM' | 'STORE'): { tools: (HrTool | StoreTool)[]; findTool: (name: string) => HrTool | StoreTool | undefined } {
    return module === 'STORE'
      ? { tools: this.storeTools.tools, findTool: (name) => this.storeTools.findTool(name) }
      : { tools: this.hrTools.tools, findTool: (name) => this.hrTools.findTool(name) };
  }

  /** A trained/rated tool call doesn't carry which module it was trained
   * under — look it up across both tool sets by name (HR and Store tool
   * names never collide by naming convention: get_employees vs get_products,
   * etc.), so a replay works regardless of which module the question is
   * asked in now. */
  private findToolAnyModule(name: string): HrTool | StoreTool | undefined {
    return this.hrTools.findTool(name) ?? this.storeTools.findTool(name);
  }

  async fetchTodaySummary(shiftId?: number, requestToken?: string): Promise<any> {
    const url = `${this.laravelUrl}/api/hrm/analytics/today-summary${shiftId ? `?shift_id=${shiftId}` : ''}`;
    // Per-request token (the logged-in user's own Sanctum token, passed from the
    // frontend chat widget) takes priority — LARAVEL_TOKEN is only a fallback for
    // server-to-server callers that don't have a user session (e.g. cron/CLI).
    const token = requestToken || process.env.LARAVEL_TOKEN;
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await axios.get(url, { headers, timeout: 10000 });
      return res.data;
    } catch (err: any) {
      // A 401 with no LARAVEL_TOKEN configured is an expected, already-handled
      // state (callers fall through to the normal SQL/tool pipeline) — logging
      // it at error level floods the log on every "today summary" question
      // with nothing actionable. Anything else (network down, 500s, or a 401
      // despite a configured token, which means the token itself is bad) is a
      // real problem and stays loud.
      const isExpectedAuthGap = !token && err?.response?.status === 401;
      if (isExpectedAuthGap) {
        this.logger.warn('fetchTodaySummary: no LARAVEL_TOKEN configured, skipping (falling through to normal pipeline)');
      } else {
        this.logger.error('fetchTodaySummary failed', err?.message);
      }
      return null;
    }
  }

  /**
   * Public entry point — just sets the Langfuse AsyncLocalStorage context
   * (sessionId/userName/question) for the whole request, then delegates to
   * askInternal(). narrate() (called from 7+ places, several levels deep
   * inside askInternal's private helpers) reads this context back via ALS to
   * tag every LLM call's trace without needing sessionId/userName threaded
   * through every method signature.
   *
   * Also the single choke point for the passive conversation log (every turn
   * embedded into Qdrant's langchain_conversation_log, unconditionally — not
   * just human-rated/trained ones) — sitting here means it captures whichever
   * of askInternal's ~10 return branches actually answered, without touching
   * any of them individually.
   */
  async ask(
    question: string,
    sessionId: string,
    trainMode = false,
    userName = 'Unknown',
    laravelToken?: string,
    module: 'HRM' | 'STORE' = 'HRM',
  ): Promise<{ answer: string; data?: any; sql?: string; tool?: string; fromCache?: boolean }> {
    // A stop from a PREVIOUS turn must never leak into this new one.
    this.stopRequested.delete(sessionId);
    const result = await this.langfuse.runWithContext({ sessionId, userName, question }, () =>
      this.askInternal(question, sessionId, trainMode, userName, laravelToken, module),
    );
    // A chart-worthy question ("attendance analytics for this year", "compare
    // attendance this month vs last") can be answered via a live tool call
    // (result.tool set, frontend's CHART_TOOLS map keys off it directly), a
    // Qdrant cache hit replaying an OLD trained/rated SQL answer from before
    // hr.tools.ts existed (result.tool is never set for a SQL source), or the
    // SQL-gen fallback (same, no tool name). The frontend only ever draws a
    // chart when `tool` is present, so any non-tool path silently lost the
    // chart even though the row shape is identical either way. Infer the tool
    // label from the shape of the actual rows returned, regardless of which
    // stage produced them, rather than only trusting a live tool-router hit.
    if (!result.tool) {
      const inferred = this.inferChartTool(result.data);
      if (inferred) result.tool = inferred;
    }
    const entity = this.extractEntityName(result.data);
    if (entity) this.sessionState.set(sessionId, { ...this.sessionState.get(sessionId), entity });

    this.logConversationAsync(question, result, sessionId, userName);
    return result;
  }

  // Only person-shaped rows (first_name/last_name, or a full_name field) —
  // deliberately NOT a generic 'name' field, which would just as happily
  // match a department/product/supplier row and cache the wrong kind of
  // entity as "the person the pronoun refers to". he/she/his/her/they/him/
  // them always implies a PERSON, so scope stays exactly that narrow.
  private extractEntityName(data: any): string | null {
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row !== 'object') return null;
    if (typeof row.full_name === 'string' && row.full_name.trim()) return row.full_name.trim();
    if (typeof row.first_name === 'string' && row.first_name.trim()) {
      return [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
    }
    return null;
  }

  // Chart-worthy tool result shapes, keyed by the exact tool name the
  // frontend's CHART_TOOLS map expects — see hr.tools.ts's
  // getAttendanceAnalytics()/getAttendanceComparison() for the row shapes.
  private static readonly CHART_SHAPES: { tool: string; keys: string[] }[] = [
    { tool: 'get_attendance_analytics', keys: ['status', 'count'] },
    { tool: 'get_attendance_comparison', keys: ['period', 'attendance_rate'] },
  ];

  private inferChartTool(rows: any): string | undefined {
    if (!Array.isArray(rows) || rows.length === 0 || rows[0] == null || typeof rows[0] !== 'object') return undefined;
    const rowKeys = new Set(Object.keys(rows[0]));
    const shape = LangchainService.CHART_SHAPES.find((s) => s.keys.every((k) => rowKeys.has(k)));
    return shape?.tool;
  }

  /** Fire-and-forget, same reasoning as saveHistoryAsync — the answer is
   * already on its way back to the user, nothing depends on this write. */
  private logConversationAsync(
    question: string,
    result: { answer: string; sql?: string; tool?: string; fromCache?: boolean },
    sessionId: string,
    userName: string,
  ): void {
    this.qdrant
      .logConversation({
        question,
        answer: result.answer,
        tool: result.tool,
        sql: result.sql,
        fromCache: result.fromCache,
        sessionId,
        userName,
      })
      .catch((err) => this.logger.warn('logConversation failed', err?.message));
  }

  private async askInternal(
    question: string,
    sessionId: string,
    trainMode = false,
    userName = 'Unknown',
    laravelToken?: string,
    module: 'HRM' | 'STORE' = 'HRM',
  ): Promise<{ answer: string; data?: any; sql?: string; tool?: string; fromCache?: boolean }> {
    await this.ensureSession(sessionId, question);

    // Greetings / small-talk — skip SQL pipeline entirely
    if (this.isConversational(question)) {
      const today = moment().format('YYYY-MM-DD');
      const persona = SYSTEM_PERSONA.replace('{TODAY}', today).replace('{USER_NAME}', userName).replace('{MODULE}', module);
      const answer = (await this.narrate(`${persona}\n\nUser: ${question}`, 'small_talk', sessionId)).trim();
      this.saveHistoryAsync(sessionId, question, answer);
      return { answer };
    }

    // Today summary — HRM-only concept, fetched from Laravel HRM analytics API, fall through on failure
    const isTodaySummaryQ = module === 'HRM' && /today.{0,20}(summary|overview|report|stats|dashboard|attendance|present|absent|leave|shift)|what.{0,30}today|(summary|overview|report|stats).{0,20}today|^\s*total\s+attendance\b/i.test(question);
    if (!trainMode && isTodaySummaryQ) {
      const shiftMatch = question.match(/shift[_\s#]*(\d+)/i);
      const shiftId = shiftMatch ? parseInt(shiftMatch[1], 10) : undefined;
      const summary = await this.fetchTodaySummary(shiftId, laravelToken);
      if (summary) {
        const answer = this.formatTodaySummary(summary);
        this.saveHistoryAsync(sessionId, question, answer);
        return { answer, data: summary };
      }
      // API unavailable — continue to fast-query / agent fallback below
    }

    // Self-reference resolution — "my"/"me" means the logged-in user, not a generic
    // question. Without this, "what is my shift list" has no name to filter on and
    // falls back to listing everyone's shifts.
    const selfResolvedQuestion = this.resolveSelfReference(question, userName);

    // Pronoun resolution — replace he/she/his/her with last mentioned employee from history
    const history = await this.loadHistory(sessionId);
    const resolvedQuestion = this.resolvePronouns(selfResolvedQuestion, history, sessionId);

    const today = moment().format('YYYY-MM-DD');
    const schema = (module === 'STORE' ? STORE_DB_SCHEMA : DB_SCHEMA).replace('{TODAY}', today).replace('{USER_NAME}', userName);

    // If not training: check Qdrant for a semantically-similar approved query first.
    // resolvedQuestion carries conversation state (pronoun resolution against the
    // last mentioned employee), so a follow-up question matches on the same intent.
    // A match is never executed verbatim — the reference question+SQL is handed to
    // the LLM as a worked example to ADAPT to the actual question (different shift
    // letter, department, person, row count, count-vs-list, etc.), replacing a long
    // chain of brittle regex substitutions that broke on every new phrasing.
    if (!trainMode) {
      const trained = await this.qdrant.findSimilar(resolvedQuestion);
      if (trained) {
        try {
          // Tool-based trained entry — replay the tool call directly, no SQL involved.
          if (trained.tool) {
            const replayed = await this.replayTrainedTool(trained.tool, trained.args, resolvedQuestion, trained.question, trained.score);
            if (replayed) {
              const answer = await this.narrateRows(question, replayed.rows, sessionId, trained.instruction || undefined);
              this.saveHistoryAsync(sessionId, question, answer);
              this.rememberIntent(sessionId, trained.tool, replayed.args);
              return { answer, data: replayed.rows, tool: trained.tool, fromCache: true };
            }
            // Tool replay failed (schema drift, bad args) — fall through to SQL/AI below.
          } else if (!trained.sql) {
            // Non-SQL, non-tool answers (greetings, "what is my name", today-summary
            // text) can be trained too — no query to re-run, just replay the saved answer.
            const answer = trained.answer || 'No cached answer available.';
            this.saveHistoryAsync(sessionId, question, answer);
            return { answer, fromCache: true };
          } else {
            const sqlToRun = trained.score >= LangchainService.HIGH_CONFIDENCE_SCORE
              ? trained.sql
              : await this.adaptReferenceSql(trained.question, trained.sql, resolvedQuestion, schema);
            const cached = await this.mcp.runSelectQuery(sqlToRun);
            if (!cached.rows) throw new Error(cached.error);
            const rows = this.serializeRows(cached.rows);
            const answer = await this.narrateRows(question, rows, sessionId, trained.instruction || undefined);
            this.saveHistoryAsync(sessionId, question, answer);
            return { answer, data: rows, sql: sqlToRun, fromCache: true };
          }
        } catch (err: any) {
          this.logger.warn('Trained answer source failed, falling through to AI', err?.message);
        }
      }

      // No trained hit — check the community-rated Q&A set (best good/bad
      // ratio among near matches, see LangchainQdrantService.findBestQA).
      const qa = await this.qdrant.findBestQA(resolvedQuestion);
      if (qa) {
        try {
          if (qa.tool) {
            const replayed = await this.replayTrainedTool(qa.tool, qa.args, resolvedQuestion, qa.question, qa.score);
            if (replayed) {
              const answer = await this.narrateRows(question, replayed.rows, sessionId);
              this.saveHistoryAsync(sessionId, question, answer);
              this.rememberIntent(sessionId, qa.tool, replayed.args);
              return { answer, data: replayed.rows, tool: qa.tool, fromCache: true };
            }
          } else if (!qa.sql) {
            this.saveHistoryAsync(sessionId, question, qa.answer);
            return { answer: qa.answer, fromCache: true };
          } else {
            const sqlToRun = qa.score >= LangchainService.HIGH_CONFIDENCE_SCORE
              ? qa.sql
              : await this.adaptReferenceSql(qa.question, qa.sql, resolvedQuestion, schema);
            const cached = await this.mcp.runSelectQuery(sqlToRun);
            if (!cached.rows) throw new Error(cached.error);
            const rows = this.serializeRows(cached.rows);
            const answer = await this.narrateRows(question, rows, sessionId);
            this.saveHistoryAsync(sessionId, question, answer);
            return { answer, data: rows, sql: sqlToRun, fromCache: true };
          }
        } catch (err: any) {
          this.logger.warn('Rated Q&A answer source failed, falling through to AI', err?.message);
        }
      }
    }

    const historyContext = history.length
      ? `\nConversation so far:\n${history.map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}`).join('\n')}\n`
      : '';

    // HR tool-calling — for questions an HR tool can answer directly (employees,
    // attendance, leave, payroll, departments/designations, holidays), call the
    // matching Prisma-backed tool from hr.tools.ts instead of having the LLM
    // freehand a SQL query. Uses the same plain-prompt-then-parse approach as the
    // rest of this pipeline (not the provider's native function-calling API) —
    // see the note below on why native tool-calling was dropped for SQL-gen.
    if (!trainMode) {
      const toolResult = await this.tryModuleTool(resolvedQuestion, today, module, historyContext, sessionId);
      if (toolResult) {
        const answer = await this.narrateRows(question, toolResult.rows, sessionId);
        this.saveHistoryAsync(sessionId, question, answer);
        this.rememberIntent(sessionId, toolResult.tool, toolResult.args);

        if (process.env.TRAIN_MODE === 'true') {
          socketService.emit('langchain:validate', { question, tool: toolResult.tool, args: toolResult.args, answer });
          this.logger.log(`Emitted langchain:validate (tool) for: "${question}"`);
        }

        return { answer, data: toolResult.rows, tool: toolResult.tool, fromCache: false };
      }
    }

    // Manual generate SQL -> execute -> fix-on-error -> narrate pipeline, via
    // this.narrate() (Gemini when GEMINI_API_KEY is set, Ollama otherwise). An
    // ADK tool-calling agent was tried here for the Gemini path but proved
    // unreliable — gemini-flash-latest would skip the tool and answer with a
    // generic greeting under AUTO tool choice, and forcing ANY tool choice broke
    // its own narration turn. This plain-prompt pipeline is reliable either way.
    const result = await this.askViaLLM(resolvedQuestion, schema, historyContext, sessionId);
    if ('error' in result) {
      await this.qdrant.recordFailedQuery(question, result.sql, result.error, this.hasGemini ? 'gemini_error' : 'ollama_error');
      return { answer: result.error, sql: result.sql };
    }
    const sql = result.sql;
    const rows = result.rows;
    const finalAnswer = result.answer.trim();

    this.saveHistoryAsync(sessionId, question, finalAnswer);

    this.logger.log(`TRAIN_MODE=${process.env.TRAIN_MODE}`);
    if (process.env.TRAIN_MODE === 'true' && sql) {
      socketService.emit('langchain:validate', { question, sql, answer: finalAnswer });
      this.logger.log(`Emitted langchain:validate for: "${question}"`);
    }

    return { answer: finalAnswer, data: rows, sql, fromCache: false };
  }

  // A Qdrant match at or above this similarity score is trusted verbatim — no
  // adapt-and-verify LLM call at all. Below it, the match is close enough to be
  // relevant but not close enough to assume it's the exact same question (could
  // differ in a specific value/letter/name/count), so it still goes through
  // adaptReferenceSql(). 0.92 sits well above SIMILARITY_THRESHOLD (0.7, the
  // minimum to even be considered a candidate) — this is specifically for
  // near-identical repeats/paraphrases, cutting an LLM round-trip off the most
  // common case (the same or near-same question asked again).
  private static readonly HIGH_CONFIDENCE_SCORE = 0.92;

  // Generic failure/error strings this service itself returns as an "answer" —
  // never valid to persist as a trained/good cached answer. A user training or
  // rating one of these "Good" would otherwise permanently cache the failure
  // and replay it forever on every semantically-similar future question.
  private static readonly FAILURE_ANSWERS = new Set([
    'AI model unavailable. Please try again.',
    'Only read queries are allowed.',
    'Could not execute query safely.',
    'Could not execute the query for this question.',
    'Could not answer that question.',
    'No cached answer available.',
  ]);

  private isFailureAnswer(answer?: string): boolean {
    return !!answer && LangchainService.FAILURE_ANSWERS.has(answer.trim());
  }

  async validate(
    question: string,
    source: AnswerSource,
    answer?: string,
    note?: string,
  ): Promise<{ success: boolean; message?: string }> {
    if (!source.sql && !source.tool && this.isFailureAnswer(answer)) {
      return { success: false, message: 'This looks like a failure/error response, not a real answer — nothing to train.' };
    }
    await this.qdrant.upsertTrained(question, source, answer, note);
    this.logger.log(`Trained: "${question}"`);
    return { success: true };
  }

  async recordWrongAnswer(question: string, sql?: string, answer?: string): Promise<void> {
    await this.qdrant.recordFailedQuery(question, sql, answer, 'marked_wrong');
    this.logger.log(`Recorded wrong answer: "${question}"`);
  }

  /**
   * Good/Bad/Mid feedback from the inline rate buttons. Always logs the pair +
   * vote into the community-rated Q&A set — except a failure/error answer rated
   * anything other than Bad, which is recorded as a failed query instead so it
   * can never get cached/replayed as if it were a correct answer.
   */
  async rateAnswer(
    question: string,
    answer: string,
    source: AnswerSource,
    rating: QARating,
    note?: string,
  ): Promise<{ success: boolean; message?: string }> {
    if (this.isFailureAnswer(answer) && rating !== 'bad') {
      await this.qdrant.recordFailedQuery(question, source.sql, answer, 'rated_on_failure_answer');
      return { success: false, message: 'This was a failure/error response — recorded for review, not cached as good/mid.' };
    }
    await this.qdrant.upsertQA(question, answer, source);
    await this.qdrant.rateQA(question, rating);
    if (rating === 'good' && (source.sql || source.tool)) {
      await this.qdrant.upsertTrained(question, source, answer, note);
    } else if (rating === 'bad') {
      await this.qdrant.recordFailedQuery(question, source.sql, answer, 'rated_bad');
    }
    this.logger.log(`Rated "${rating}": "${question}"`);
    return { success: true };
  }

  async getSessions(): Promise<{ session_id: string; title: string | null; created_at: Date | null }[]> {
    return this.prisma.langchain_sessions.findMany({
      select: { session_id: true, title: true, created_at: true },
      orderBy: { created_at: 'desc' },
    });
  }

  async getSessionHistory(sessionId: string): Promise<{ role: string; content: string; created_at: Date | null }[]> {
    const rows = await this.prisma.langchain_chat_histories.findMany({
      where: { session_id: sessionId },
      select: { role: true, content: true, created_at: true },
      orderBy: { created_at: 'asc' },
    });
    return rows.map((r) => ({ role: r.role, content: r.content, created_at: r.created_at }));
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.prisma.langchain_sessions.delete({ where: { session_id: sessionId } });
  }

  private async ensureSession(sessionId: string, firstQuestion: string): Promise<void> {
    const existing = await this.prisma.langchain_sessions.findUnique({ where: { session_id: sessionId } });
    if (!existing) {
      const title = firstQuestion.length > 60 ? firstQuestion.slice(0, 57) + '...' : firstQuestion;
      await this.prisma.langchain_sessions.create({ data: { session_id: sessionId, title } });
    }
  }

  private async loadHistory(sessionId: string): Promise<{ role: string; content: string }[]> {
    const rows = await this.prisma.langchain_chat_histories.findMany({
      where: { session_id: sessionId },
      select: { role: true, content: true },
      orderBy: { created_at: 'desc' },
      take: HISTORY_LIMIT,
    });
    return rows.reverse();
  }

  private async saveHistory(sessionId: string, question: string, answer: string): Promise<void> {
    await this.prisma.langchain_chat_histories.createMany({
      data: [
        { session_id: sessionId, role: 'user', content: question },
        { session_id: sessionId, role: 'assistant', content: answer },
      ],
    });
  }

  /** Fire-and-forget history write — the caller is about to return the answer to
   * the user; there's nothing left that depends on this row existing yet, so
   * don't make the response wait on a DB write that can happen right after. */
  private saveHistoryAsync(sessionId: string, question: string, answer: string): void {
    this.saveHistory(sessionId, question, answer).catch((err) => this.logger.warn('saveHistory failed', err?.message));
  }

  // "my <noun>" only means the logged-in user when <noun> is an actual
  // personal-data reference (shift, leave, attendance, ...). Rewriting every
  // bare "my" unconditionally corrupted unrelated phrasing — "how many
  // employee my system right now" became "...employee {name}'s system...",
  // a question nothing in the schema matches, and the SQL-gen fallback
  // produced a garbage filtered COUNT(*) instead of erroring out loudly.
  private static readonly SELF_REFERENCE_NOUNS = /^(shift|shifts|leave|leaves|attendance|payroll|salary|salaries|profile|name|department|designation|roster|bonus|bonuses|asset|assets|notice|notices|record|records|info|information|detail|details|id|number|status|history|promotion|promotions|group|team)/i;

  /** "my <noun>"/"me" refers to the logged-in user — resolve to their actual
   * name so downstream name-lookup/roster filtering has something concrete to
   * search. Only rewrites "my" when followed by a recognized personal-data
   * noun, and only rewrites "me" when it's a personal-reference object (not
   * filler like "show me"/"tell me"/"give me"). */
  private resolveSelfReference(question: string, userName: string): string {
    if (!userName || userName === 'Unknown') return question;
    if (!/\b(my|me)\b/i.test(question)) return question;

    let result = question.replace(/\bmy\s+(\w+)/gi, (match, noun) =>
      LangchainService.SELF_REFERENCE_NOUNS.test(noun) ? `${userName}'s ${noun}` : match,
    );
    result = result.replace(/\b(?<!show |tell |give |find |get |help )me\b/gi, userName);
    return result;
  }

  private resolvePronouns(question: string, history: { role: string; content: string }[], sessionId: string): string {
    const hasPronouns = /\b(he|she|his|her|him|they|their|them)\b/i.test(question);
    if (!hasPronouns) return question;

    // Preferred source — the actual entity extracted from the previous
    // turn's ROW DATA (see extractEntityName/ask()), not re-derived from
    // whatever prose the LLM happened to phrase the answer in.
    const cachedEntity = this.sessionState.get(sessionId)?.entity;
    if (cachedEntity) {
      return question
        .replace(/\b(his|her|their)\b/gi, `${cachedEntity}'s`)
        .replace(/\b(he|she|they|him|them)\b/gi, cachedEntity);
    }

    // Fallback — scan assistant messages in reverse for a known employee name
    // (legacy "Name (" narration pattern; kept in case some older cached
    // answer or a future narration style still matches it).
    const namePattern = /^([A-Z][a-z]+(?: [A-Z][a-z.]+){1,3})\s*\(/;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role !== 'assistant') continue;
      const match = history[i].content.match(namePattern);
      if (match) {
        const name = match[1];
        return question
          .replace(/\b(his|her|their)\b/gi, `${name}'s`)
          .replace(/\b(he|she|they|him|them)\b/gi, name);
      }
    }

    // No specific name in history (e.g. previous answer was a count, not a name) —
    // carry the last user question forward so the pronoun still has a topic to
    // resolve against, instead of sending the bare fragment on its own.
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role !== 'user') continue;
      return `Regarding the previous question "${history[i].content}": ${question}`;
    }
    return question;
  }

  private isConversational(q: string): boolean {
    const trimmed = q.trim();
    // Must match the FULL question — no $ anchor missing causes prefix-match false positives
    const patterns = [
      /^(hi|hello|hey|howdy|greetings|salaam|assalamu\s*alaikum|namaskar|bonjour|hola)$/i,
      /^good\s+(morning|afternoon|evening|night)(\s+\w+)?$/i,   // "good morning" or "good morning sir"
      /^(how are you|how's it going|what's up|how do you do|how are things)\??$/i,
      /^(thank(s| you)(\s+(so much|a lot|very much))?|thx|ty)[\s!.]*$/i,
      /^(bye|goodbye|see you|take care|later|ciao)[\s!.]*$/i,
      /^(ok|okay|got it|understood|noted|great|awesome|nice|cool|perfect|sounds good|excellent|wonderful|fantastic|brilliant|amazing|superb|well done|good job|nice one|that.?s great|that.?s awesome|that.?s cool|that.?s nice|that.?s perfect|that.?s amazing|that.?s wonderful|that.?s fantastic|that.?s correct|that.?s right|correct|right|sure|alright|fair enough|makes sense|i see|i got it|i understand)[\s!.]*$/i,
      /^(wow|wow+|woah|whoa|oh wow|oh nice|oh great|oh cool|oh perfect|yep|yup|yeah|yes|nope|nah|no|hmm|hm|lol|haha|hehe)[\s!.]*$/i,
      /^(who are you|what are you|what can you do)\??$/i,
      /^what is (your name|my name)\??$/i,
      /^(tell me about (this|the) company|what (is|does) (this|the) company( do)?|who (are|is) (we|this company)|about (this|the) company)\??$/i,
      // Personal/human-interaction questions directed at the assistant itself —
      // no HRM/STORE data involved, answered from persona/personality, not SQL/tools.
      /^(do you (like|love) me|do you have (feelings|emotions)|are you (human|a robot|a bot|alive|real|sentient|conscious)|can (we|you) be friends|do you get (tired|bored|sad|happy)|what.?s your name|who made you|who created you|are you (an ai|artificial intelligence)|do you (sleep|dream|eat)|are you single|will you marry me|i love you|you.?re (funny|smart|cute|nice|helpful|the best|amazing|great))[\s!.?]*$/i,
    ];
    return patterns.some((p) => p.test(trimmed));
  }

  /**
   * Turns SQL result rows into an answer. A single small aggregate row
   * (COUNT/SUM — the common case) is formatted directly, no LLM call. Multiple
   * rows render as an indexed markdown table — never as LLM-narrated numbered
   * prose, which has repeatedly hallucinated/truncated/mis-formatted list data.
   * The LLM is only used for a short lead-in sentence, or for the full answer
   * when a trained instruction demands specific phrasing.
   */
  private async narrateRows(question: string, rows: any[], sessionId?: string, instruction?: string): Promise<string> {
    if (rows.length === 1 && rows[0] != null && Object.keys(rows[0]).length <= 4 && !instruction) {
      return this.formatAggregateRow(rows[0]);
    }

    const table = rows.length > 1 ? '\n\n' + toMarkdownTable(rows) : '';

    if (rows.length > 1 && !instruction) {
      return `Found ${rows.length} result(s):${table}`;
    }

    const dataPreview = JSON.stringify(rows.slice(0, 50), null, 2);
    const extraInstruction = instruction
      ? `\nExtra instruction saved for this question at train time — always apply it: ${instruction}`
      : '';
    const narratePrompt = `A user asked: "${question}"
The database returned ${rows.length} row(s): ${dataPreview}

Write a clear, concise natural language answer. Be direct. Include key numbers or names from the data.
If multiple records are involved, write only a short lead-in sentence (e.g. "Here are the results:") — do NOT enumerate or restate the rows yourself, a table with every row already follows your answer.
Money amounts are in BDT (Bangladeshi Taka) — write them as "BDT 2,400", never "$2,400" or "USD".${extraInstruction}`;
    try {
      const lead = (await this.narrate(narratePrompt, 'narrate_rows', sessionId)).trim();
      return lead + table;
    } catch {
      return `Found ${rows.length} result(s).${table}`;
    }
  }

  /**
   * Plain-prompt tool router — asks the model to pick one of the CURRENT
   * MODULE's fixed tools (hr.tools.ts for HRM, store.tools.ts for STORE) by
   * name and its arguments, given only that module's tool manifest
   * (name/description/param names), then calls it directly via Prisma. No SQL
   * is generated or run for anything this resolves. Scoping the manifest to
   * one module keeps the router prompt small AND stops it "finding" the wrong
   * module's tool for an ambiguous question (e.g. "status" existing on both
   * HR leave requests and Store purchase requisitions) — the frontend's
   * module dropdown decides which tool set is even offered.
   *
   * Deliberately NOT the provider's native function-calling/tool-choice API —
   * that was tried for this same pipeline (see askViaLLM's SQL-gen path) and
   * proved unreliable: gemini-flash-latest would skip the tool under AUTO tool
   * choice, and forcing ANY tool choice broke the narration turn after. A plain
   * prompt asking for a JSON `{tool, args}` object (or the literal word NONE)
   * that gets parsed and validated against the tool's zod schema is far more
   * predictable, and any failure to parse/validate/match just falls through to
   * the SQL pipeline below rather than erroring the whole question out.
   */
  private async tryModuleTool(question: string, today: string, module: 'HRM' | 'STORE', historyContext: string, sessionId: string): Promise<{ tool: string; args: Record<string, any>; rows: any[] } | null> {
    const { tools, findTool } = this.toolsFor(module);
    const manifest = tools
      .map((t) => `- ${t.name}(${Object.keys((t.schema as any).shape ?? {}).join(', ')}): ${t.description}`)
      .join('\n');

    // Explicit structured hint (on top of the free-text historyContext) —
    // the last tool+args that actually answered a question in this session,
    // so a follow-up with NO pronoun and NO explicit subject at all ("what
    // about last month?", "same for the other department") can be resolved
    // as "re-run that same tool, just change this one arg" instead of the
    // router trying to re-derive everything from a bare fragment.
    const lastIntent = this.sessionState.get(sessionId);
    const intentHint = lastIntent?.intentTool
      ? `\nLast tool call that answered a question in this conversation: ${lastIntent.intentTool}(${JSON.stringify(lastIntent.intentArgs ?? {})}). If the current question is a bare follow-up with no clear subject of its own, assume it means "run that same tool again with only what changed" and merge accordingly.\n`
      : '';

    const prompt = `You are a router that decides whether a user's question can be answered by one of these fixed ${module} tools:
${manifest}

Today's date is ${today}. Every tool here uses from_date/to_date (or joined_after/joined_before) date-range args, never a bare month/year — always compute concrete YYYY-MM-DD values yourself for any period phrasing, never leave them empty (that silently defaults to the current period, which is wrong). Two different phrasings need two different calculations, at whatever granularity (month OR year) the question names:
1. A NAMED period ("July", "in March", "for June", "2025", "in the year 2024") — use that calendar period's own full boundaries: from_date = 1st day of that month/year, to_date = last day of that month/year (Dec 31 for a named year).
2. A relative, unnamed period ("last month", "one month", "last N months", "this month", "this year", "last year") — this is a ROLLING or to-date window, NOT a fixed prior calendar period. "This month"/"this year" = from_date = 1st of the current month/year, to_date = today. "Last month"/"one month" = from_date = today minus 1 month, to_date = today. "Last year"/"one year" = from_date = today minus 1 year, to_date = today. "Last N months/years" = from_date = today minus N months/years, to_date = today.
${historyContext}${intentHint}
User question: "${question}"

The question may be a short follow-up that only makes sense given the conversation above (e.g. "and her department?", "what about last month?", "same for the other one") — use the conversation history to fill in the missing subject/period/filter in your chosen tool's args, don't just treat the bare fragment in isolation.

If one of the tools above can answer this, reply with ONLY a single-line JSON object of the exact shape {"tool": "<tool_name>", "args": { ... }} — args must only use the parameter names listed for that tool, and can be omitted/empty if none apply.
If none of the tools fit — the question needs a table/relationship none of them cover (salary details, side bills, holiday swaps, promotion configs, notice read/ack tracking, face IDs, shift overrides, etc.) — reply with exactly: NONE
No markdown, no explanation, no code fences — just the JSON object or the word NONE.`;

    let raw: string;
    try {
      raw = (await this.narrate(prompt, 'module_tool_router')).trim();
    } catch (err: any) {
      this.logger.warn('Tool router prompt failed, falling through to SQL', err?.message);
      return null;
    }

    if (!raw || /^none$/i.test(raw)) return null;

    let parsed: { tool?: string; args?: Record<string, any> };
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    } catch {
      return null;
    }

    if (!parsed.tool) return null;
    const tool = findTool(parsed.tool);
    if (!tool) return null;

    try {
      const args = tool.schema.parse(parsed.args ?? {}) as Record<string, any>;
      const result = await tool.handler(args);
      // Some tools (e.g. getEmployeeByName) return a single object or null/
      // undefined when nothing matches — Array.isArray(null) is false, so
      // naively wrapping in [result] produced [null]/[undefined], and
      // narrateRows()'s Object.keys(rows[0]) crashed on that. Treat a
      // nullish single result as "no rows", not a row containing nothing.
      const rows = Array.isArray(result) ? result : result == null ? [] : [result];
      return { tool: tool.name, args, rows };
    } catch (err: any) {
      this.logger.warn(`Tool "${parsed.tool}" args invalid or execution failed, falling through to SQL`, err?.message);
      return null;
    }
  }

  /**
   * Replays a trained/rated tool-based answer source. At/above HIGH_CONFIDENCE_SCORE
   * the saved args are reused verbatim (same trust rule as adaptReferenceSql's SQL
   * path). Below it, the args are close enough to be relevant but the question may
   * differ in a specific value (different name/month/status/etc.) — the LLM is asked
   * to adapt just the args JSON to the actual question, validated against the tool's
   * zod schema before use. Any failure (unknown tool, invalid args, handler error)
   * returns null so the caller falls through to the SQL/AI pipeline.
   */
  private async replayTrainedTool(
    toolName: string,
    trainedArgs: Record<string, any> | undefined,
    question: string,
    referenceQuestion: string,
    score: number,
  ): Promise<{ rows: any[]; args: Record<string, any> } | null> {
    const tool = this.findToolAnyModule(toolName);
    if (!tool) return null;

    try {
      let args = trainedArgs ?? {};
      if (score < LangchainService.HIGH_CONFIDENCE_SCORE && referenceQuestion.trim().toLowerCase() !== question.trim().toLowerCase()) {
        args = await this.adaptReferenceToolArgs(tool, referenceQuestion, trainedArgs ?? {}, question);
      }
      const parsedArgs = tool.schema.parse(args) as Record<string, any>;
      const result = await tool.handler(parsedArgs);
      // Some tools (e.g. getEmployeeByName) return a single object or null/
      // undefined when nothing matches — Array.isArray(null) is false, so
      // naively wrapping in [result] produced [null]/[undefined], and
      // narrateRows()'s Object.keys(rows[0]) crashed on that. Treat a
      // nullish single result as "no rows", not a row containing nothing.
      const rows = Array.isArray(result) ? result : result == null ? [] : [result];
      return { rows, args: parsedArgs };
    } catch (err: any) {
      this.logger.warn(`Trained tool "${toolName}" replay failed, falling through`, err?.message);
      return null;
    }
  }

  /** Same idea as adaptReferenceSql, but for a tool's args JSON instead of raw SQL. */
  private async adaptReferenceToolArgs(
    tool: HrTool | StoreTool,
    referenceQuestion: string,
    referenceArgs: Record<string, any>,
    question: string,
  ): Promise<Record<string, any>> {
    const paramNames = Object.keys((tool.schema as any).shape ?? {}).join(', ');
    const prompt = `A previously verified question and the args used to answer it via the "${tool.name}" tool (params: ${paramNames}):
Question: "${referenceQuestion}"
Args: ${JSON.stringify(referenceArgs)}

The user actually asked: "${question}"

If this asks for the exact same thing, return the args unchanged.
If it differs in a specific value (a different name, month, year, status, etc.), adapt only what needs to change — keep everything else.
Return ONLY the raw JSON args object. No markdown, no explanation, no code blocks.`;
    try {
      const raw = (await this.narrate(prompt, 'adapt_tool_args')).trim();
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      return JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    } catch {
      return referenceArgs;
    }
  }

  /**
   * A Qdrant match is a REFERENCE, not a verbatim script — hands the matched
   * question+SQL to the LLM as a worked example and asks it to adapt the SQL to
   * the actual question (different shift letter, department, person, row count,
   * count-vs-list, etc.), or reuse it unchanged if the intent is identical.
   * Replaces a chain of brittle regex substitutions that needed a new special
   * case for every new phrasing and still couldn't cover everything.
   */
  private async adaptReferenceSql(referenceQuestion: string, referenceSql: string, question: string, schema: string): Promise<string> {
    if (referenceQuestion.trim().toLowerCase() === question.trim().toLowerCase()) return referenceSql;
    const prompt = `${schema}

A previously verified question and its correct SQL (a reference example):
Question: "${referenceQuestion}"
SQL: ${referenceSql}

The user actually asked: "${question}"

If this asks for the exact same thing, return the reference SQL unchanged.
If it differs in a specific value (a different shift letter, department, designation, person's name, row count, ID, etc.) or intent (count vs list vs detail), adapt the reference SQL's structure/joins/logic to match — keep what's still correct, change only what needs to change.
Return ONLY the raw SQL query. No markdown, no explanation, no code blocks.`;
    try {
      const adapted = this.extractSQL(await this.narrate(prompt, 'adapt_reference_sql'));
      return this.isSafeSQL(adapted) ? adapted : referenceSql;
    } catch {
      return referenceSql;
    }
  }

  private formatAggregateRow(row: Record<string, any>): string {
    return Object.entries(row)
      .map(([key, value]) => `${this.humanizeKey(key)}: ${this.formatAggregateValue(value)}`)
      .join(', ');
  }

  // Delegates to the same formatCell() the multi-row markdown table path uses
  // (langchain.markdown.ts) — handles the "[object Object]" nested-relation
  // case and ISO-date-string formatting identically in both single-row and
  // multi-row answers, one implementation instead of two drifting copies.
  private formatAggregateValue(value: any): string {
    // A single-row aggregate answer renders as "Key: value, Key: value" prose
    // — an empty/whitespace-only string (e.g. religion = '' in the DB, not
    // NULL) leaves a trailing "Religion: " with nothing after the colon,
    // reading as broken. A blank table CELL (formatCell, multi-row path)
    // is normal/expected — this fallback is deliberately scoped to just this
    // inline single-row format, not applied to formatCell itself.
    if (value == null) return 'N/A';
    if (typeof value === 'string' && value.trim() === '') return 'N/A';
    return formatCell(value);
  }

  private humanizeKey(key: string): string {
    return key
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  private formatTodaySummary(summary: any): string {
    const d = summary?.data ?? {};
    const s = summary?.['shift-data'] ?? {};
    const lines: string[] = ['Today\'s HR Summary:'];
    if (d.totalEmployees != null) lines.push(`  Total Employees: ${d.totalEmployees}`);
    if (d.presentCount != null)   lines.push(`  Present: ${d.presentCount}`);
    if (d.absentCount != null)    lines.push(`  Absent: ${d.absentCount}`);
    if (d.leaveTodayCount != null) lines.push(`  On Leave: ${d.leaveTodayCount}`);
    if (s.shiftEmployeeCount != null) lines.push(`  Shift Employees: ${s.shiftEmployeeCount}`);
    if (s.totalInShift != null)   lines.push(`  Total In Shift: ${s.totalInShift}`);
    if (s.totalShiftPresent != null) lines.push(`  Shift Present: ${s.totalShiftPresent}`);
    if (s.totalAbsentInShift != null) lines.push(`  Shift Absent: ${s.totalAbsentInShift}`);
    if (s.totalOverTime != null)  lines.push(`  Overtime Count: ${s.totalOverTime}`);
    return lines.join('\n');
  }

  /**
   * Single choke point for every LLM call in this service (SQL-gen, HR tool
   * router, narration, fix-retry, adapt-reference — 7+ call sites). Every call
   * is logged to Langfuse as a generation (input/output/model/latency), tagged
   * with `name` and the current ask()'s sessionId via AsyncLocalStorage — this
   * is what would have turned today's several bugs (empty completions from a
   * truncated context window, a reasoning model burning its whole token budget
   * on invisible chain-of-thought, ...) into a two-minute trace lookup instead
   * of a session of manual curl probing.
   *
   * `streamSessionId` — only passed by the call sites that produce user-facing
   * answer text (small_talk, narrate_rows), never for internal SQL/JSON
   * generation (sql_gen, sql_fix, hr_tool_router, adapt_*) which would be
   * meaningless to show typing out live. When set, each token/delta is
   * broadcast over Socket.IO as `langchain:stream` — same broadcast-to-all
   * pattern already used for `langchain:validate`, the frontend filters by
   * `session_id` to only append chunks belonging to its own chat session.
   */
  private async narrate(prompt: string, name = 'narrate', streamSessionId?: string): Promise<string> {
    const model = this.hasGemini ? GEMINI_TEXT_MODEL : this.ollamaModel;
    const startTime = new Date();
    const onChunk = streamSessionId
      ? (chunk: string) => socketService.emit('langchain:stream', { session_id: streamSessionId, chunk })
      : undefined;
    try {
      const output = this.hasGemini ? await this.narrateGemini(prompt, onChunk, streamSessionId) : await this.callOllama(prompt, onChunk, streamSessionId);
      this.langfuse.logGeneration({ name, input: prompt, output, model, startTime, endTime: new Date() });
      return output;
    } catch (err: any) {
      this.langfuse.logGeneration({
        name,
        input: prompt,
        model,
        startTime,
        endTime: new Date(),
        level: 'ERROR',
        statusMessage: err?.message,
      });
      throw err;
    }
  }

  private async narrateGemini(prompt: string, onChunk?: (chunk: string) => void, sessionId?: string): Promise<string> {
    if (!onChunk) {
      const response = await this.genai.models.generateContent({
        model: GEMINI_TEXT_MODEL,
        contents: prompt,
      });
      return response.text ?? '';
    }

    const stream = await this.genai.models.generateContentStream({
      model: GEMINI_TEXT_MODEL,
      contents: prompt,
    });
    let full = '';
    for await (const part of stream) {
      // @google/genai's generateContentStream has no exposed abort signal —
      // this is the best cancellation available: stop consuming/emitting
      // further chunks the instant a stop is requested, even though Google's
      // own generation may keep running server-side until the stream ends.
      if (sessionId && this.stopRequested.has(sessionId)) break;
      const delta = part.text ?? '';
      if (delta) {
        full += delta;
        onChunk(delta);
      }
    }
    return full;
  }

  /**
   * Main SQL Q&A pipeline: generate SQL -> execute -> fix-on-error -> narrate,
   * via this.narrate() (Gemini when GEMINI_API_KEY is set, Ollama otherwise).
   */
  private async askViaLLM(
    question: string,
    schema: string,
    historyContext: string,
    sessionId?: string,
  ): Promise<{ sql: string; rows: any[]; answer: string } | { error: string; sql?: string }> {
    const sqlPrompt = `You are a SQL expert for a MySQL database.
${schema}
${historyContext}
Write a single SELECT SQL query to answer this question: "${question}"

Rules:
- Only SELECT statements. No INSERT, UPDATE, DELETE, DROP.
- Use proper JOINs when needed.
- Never use SELECT * — always list only the specific columns needed to answer the question.
- Never select deleted_at, created_at, or updated_at unless the question explicitly asks about creation/update/deletion time — these are internal bookkeeping columns, not useful data for the user.
- Limit results to 100 rows max.
- Return ONLY the raw SQL query. No markdown, no explanation, no code blocks.`;

    let sql: string;
    try {
      sql = this.extractSQL(await this.narrate(sqlPrompt, 'sql_gen'));
    } catch (err) {
      this.logger.error('SQL generation failed', err);
      return { error: 'AI model unavailable. Please try again.' };
    }

    if (!this.isSafeSQL(sql)) {
      return { error: 'Only read queries are allowed.', sql };
    }

    let rows: any[];
    const result = await this.mcp.runSelectQuery(sql);
    if (result.error) {
      this.logger.error('SQL execution failed', result.error);
      try {
        const fixPrompt = `This SQL query failed with error: "${result.error}".
Query: ${sql}
Schema: ${schema}
Fix the SQL and return ONLY the corrected raw SQL query.`;
        const fixedSql = this.extractSQL(await this.narrate(fixPrompt, 'sql_fix'));
        if (!this.isSafeSQL(fixedSql)) return { error: 'Could not execute query safely.', sql };
        const fixed = await this.mcp.runSelectQuery(fixedSql);
        if (!fixed.rows) return { error: 'Could not execute query safely.', sql };
        rows = this.serializeRows(fixed.rows);
        sql = fixedSql;
      } catch {
        return { error: 'Could not execute the query for this question.', sql };
      }
    } else {
      rows = this.serializeRows(result.rows!);
    }

    const answer = await this.narrateRows(question, rows, sessionId);

    return { sql, rows, answer };
  }

  private async callOllama(prompt: string, onChunk?: (chunk: string) => void, sessionId?: string): Promise<string> {
    const controller = new AbortController();
    if (sessionId) this.ollamaAbortControllers.set(sessionId, controller);

    try {
      const response = await axios.post(
        `${this.ollamaUrl}/api/chat`,
        {
          model: this.ollamaModel,
          // Always streamed at the transport level (NDJSON lines from Ollama) —
          // onChunk is only wired up to actually forward deltas to the frontend
          // for user-facing answer generations (see narrate()'s streamSessionId);
          // internal SQL/JSON generations still just accumulate silently and
          // return the full string, same contract as before.
          stream: true,
          // qwen3:8b is a reasoning model — Ollama splits its output into an
          // invisible `thinking` (chain-of-thought) block and the actual
          // `content`. With num_predict capped at 512 and thinking left on, the
          // model was still mid-<think> when the token budget ran out on every
          // single request — 100% of the 512 tokens went to reasoning, 0 to the
          // actual SQL/answer, so `content` came back empty regardless of the
          // question ("Only read queries are allowed." on everything). Disabling
          // thinking skips straight to the answer — verified: ~136 tokens, ~8s,
          // correct SQL, for a query that previously always returned empty.
          think: false,
          messages: [{ role: 'user', content: prompt }],
          // keep_alive: model stays resident in memory between requests instead of
          // Ollama's default ~5min idle-unload — reloading a multi-GB model is the
          // single biggest local-inference latency spike, easily several seconds.
          keep_alive: '30m',
          // SQL/narration answers are always short — capping generation length
          // stops the model from running on past a useful answer.
          //
          // num_ctx: qwen3:8b's Modelfile sets no num_ctx, so Ollama silently
          // defaulted every request here to its runtime default of 2048 tokens.
          // DB_SCHEMA alone is ~15KB (several thousand tokens) — every SQL-gen
          // prompt (schema + persona + conversation history + question) was
          // overflowing that window and getting truncated before the model ever
          // saw the full schema, causing empty/garbled completions for anything
          // not already cached in Qdrant. qwen3:8b supports up to 40960 — 8192
          // comfortably covers this prompt's actual size with headroom to spare.
          options: { num_predict: 512, num_ctx: 8192 },
        },
        { timeout: 60000, responseType: 'stream', signal: controller.signal },
      );

      return await new Promise<string>((resolve, reject) => {
        let full = '';
        let buffer = '';
        response.data.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let obj: any;
            try {
              obj = JSON.parse(trimmed);
            } catch {
              continue; // shouldn't happen (NDJSON is line-delimited), skip defensively
            }
            const delta: string = obj?.message?.content ?? '';
            if (delta) {
              full += delta;
              onChunk?.(delta);
            }
          }
        });
        response.data.on('end', () => resolve(full));
        // An abort() call while the stream is in flight ends up here, not as
        // a rejection of the outer axios.post() promise — resolve with
        // whatever was generated before the stop instead of surfacing it as
        // a hard failure (askInternal would otherwise record this as a
        // failed query and show a generic error to the user for what was
        // actually just a user-requested stop).
        response.data.on('error', (err: any) => {
          if (axios.isCancel(err) || err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') resolve(full);
          else reject(err);
        });
      });
    } catch (err: any) {
      // Aborted before the initial response ever arrived (e.g. stopped
      // during the connection/prompt-eval phase, before any token streamed)
      // — nothing was generated yet, so an empty string is the right answer,
      // not a thrown error surfaced to the user as a failure.
      if (axios.isCancel(err) || err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return '';
      throw err;
    } finally {
      if (sessionId) this.ollamaAbortControllers.delete(sessionId);
    }
  }

  private extractSQL(raw: string): string {
    const match = raw.match(/```(?:sql)?\s*([\s\S]*?)```/i);
    if (match) return match[1].trim();
    return raw.trim();
  }

  private isSafeSQL(sql: string): boolean {
    const upper = sql.toUpperCase();
    if (!upper.trimStart().startsWith('SELECT')) return false;
    // Word-boundary match, not substring — a naive .includes() also matched
    // 'UPDATE' inside 'UPDATED_AT' and 'CREATE' inside 'CREATED_AT', both of
    // which exist on nearly every table here, so any legitimate SELECT that
    // merely referenced those (extremely common) columns got falsely rejected.
    const forbidden = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'EXEC', 'EXECUTE'];
    return !forbidden.some((kw) => new RegExp(`\\b${kw}\\b`).test(upper));
  }

  private serializeRows(rows: any[]): any[] {
    return rows.map((row) => {
      const out: any = {};
      for (const [k, v] of Object.entries(row)) {
        if (typeof v === 'bigint') out[k] = Number(v);
        else if (v instanceof Date) out[k] = v.toISOString();
        // DECIMAL columns from a raw SQL query come back as Prisma Decimal
        // instances, not plain numbers — same gap serializeBigInt() (the tool
        // path) already covers via .toNumber(), but this SQL-gen path never
        // unwrapped them. An un-unwrapped Decimal reaching toMarkdownTable's
        // formatCell() risks rendering as raw object noise (or worse, if any
        // downstream code treats it as a function reference).
        else if (v != null && typeof v === 'object' && typeof (v as any).toNumber === 'function') out[k] = (v as any).toNumber();
        else out[k] = v;
      }
      return out;
    });
  }
}

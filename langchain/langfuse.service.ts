import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import Langfuse from 'langfuse';

export interface AskContext {
  sessionId: string;
  userName: string;
  question: string;
}

interface StoredContext {
  /** null when tracing is disabled (no keys configured), so logGeneration/logEvent are no-ops. */
  trace: ReturnType<Langfuse['trace']> | null;
}

/**
 * Thin wrapper around Langfuse (deprecated v3 SDK — the simple trace/
 * generation/event API, not the new OTel-based @langfuse/* rewrite; chosen
 * deliberately for low integration cost, see langchain module notes). A no-op
 * everywhere if LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY aren't configured, so
 * this is safe to leave wired in with tracing switched off.
 *
 * One Langfuse trace per ask() request (sessionId/userId/input set once);
 * every narrate() call in LangchainService logs a generation NESTED under
 * that trace — that's every single LLM call (SQL-gen, HR tool router,
 * narration, fix-retry, adapt-reference) for one question, in one waterfall
 * view. That's the exact thing that took a whole session of manual curl
 * probing to inspect one call at a time before this existed.
 *
 * Uses AsyncLocalStorage instead of threading the trace through every private
 * method's parameters — ask() creates it once via runWithContext(), and
 * narrate() (called from 7+ places, several levels deep) just reads it back,
 * no signature changes needed anywhere else.
 */
@Injectable()
export class LangfuseService implements OnModuleDestroy {
  private readonly logger = new Logger(LangfuseService.name);
  private readonly client: Langfuse | null;
  private readonly als = new AsyncLocalStorage<StoredContext>();

  constructor() {
    const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
    const secretKey = process.env.LANGFUSE_SECRET_KEY;
    if (!publicKey || !secretKey) {
      this.client = null;
      this.logger.warn('LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY not set — tracing disabled (no-op).');
      return;
    }
    this.client = new Langfuse({
      publicKey,
      secretKey,
      baseUrl: process.env.LANGFUSE_HOST || 'https://cloud.langfuse.com',
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.shutdownAsync().catch(() => {});
  }

  runWithContext<T>(context: AskContext, fn: () => Promise<T>): Promise<T> {
    const trace = this.client
      ? this.client.trace({
          name: 'ask',
          sessionId: context.sessionId,
          userId: context.userName,
          input: context.question,
        })
      : null;
    return this.als.run({ trace }, fn);
  }

  private trace(): StoredContext['trace'] {
    return this.als.getStore()?.trace ?? null;
  }

  logGeneration(params: {
    name: string;
    input: string;
    output?: string;
    model: string;
    startTime: Date;
    endTime: Date;
    level?: 'DEFAULT' | 'ERROR' | 'WARNING';
    statusMessage?: string;
  }): void {
    const trace = this.trace();
    if (!trace) return;
    try {
      trace.generation({
        name: params.name,
        input: params.input,
        output: params.output,
        model: params.model,
        startTime: params.startTime,
        endTime: params.endTime,
        level: params.level ?? 'DEFAULT',
        statusMessage: params.statusMessage,
      });
    } catch (err: any) {
      this.logger.warn('logGeneration failed', err?.message);
    }
  }

  logEvent(params: { name: string; input?: unknown; output?: unknown; metadata?: Record<string, unknown> }): void {
    const trace = this.trace();
    if (!trace) return;
    try {
      trace.event({
        name: params.name,
        input: params.input,
        output: params.output,
        metadata: params.metadata,
      });
    } catch (err: any) {
      this.logger.warn('logEvent failed', err?.message);
    }
  }
}

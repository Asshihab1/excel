import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import axios from 'axios';
import { QdrantClient } from '@qdrant/js-client-rest';

const COLLECTION = 'langchain_trained_queries';
const FAILED_COLLECTION = 'langchain_failed_queries';
const QA_COLLECTION = 'langchain_q_and_a';
// Every Q&A turn, unconditionally — not just human-approved/rated ones (those
// stay in COLLECTION/QA_COLLECTION, kept curated for cache-lookup replay).
// This is a passive analytics log: most-asked-questions, failure-rate trends,
// which tool/SQL path answered what, over time. One point per turn (never
// deduped by question — the same question asked 10 times is 10 points, that
// frequency IS the signal), so its own random ID, not pointId()'s question-hash.
const LOG_COLLECTION = 'langchain_conversation_log';
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const OLLAMA_EMBEDDING_MODEL = process.env.OLLAMA_EMBEDDING_MODEL ?? 'nomic-embed-text';
const VECTOR_SIZE = 768; // nomic-embed-text output dimension
// nomic-embed-text scores genuine paraphrases much lower than higher-end embedding
// models — measured ~0.63-0.77 for real paraphrases of trained questions ("who came
// in late" vs "who is late today") against ~0.39-0.43 for unrelated questions. 0.85
// was tuned for a different model's range and was missing nearly every paraphrase,
// forcing live SQL generation (and its recurring null-name bugs) on questions that
// were already trained under slightly different wording.
const SIMILARITY_THRESHOLD = 0.7;

// nomic-embed-text doesn't discriminate well between different HR sub-domains
// phrased as the same generic template — "total payroll this month", "total
// bonuses paid this month", "total overtime pay this month" all land within
// ~0.68-0.77 of each other regardless of which one was actually asked, so a
// payroll question can win a cosine-similarity match against a cached BONUS
// query (both score above SIMILARITY_THRESHOLD) and silently answer the wrong
// thing. This is a cheap keyword sanity check on top of the score: a match is
// only trusted if the incoming question and the cached question share at
// least one recognized HR domain noun — reject a same-score, wrong-domain
// collision rather than serve it with confidence.
const DOMAIN_KEYWORDS = [
  'payroll', 'salary', 'salaries', 'wage', 'wages',
  'bonus', 'bonuses',
  'leave', 'leaves',
  'attendance', 'present', 'absent', 'late',
  'shift', 'shifts', 'roster', 'rostered',
  'overtime',
  'promotion', 'promotions',
  'asset', 'assets',
  'notice', 'notices',
  'blacklist', 'blacklisted',
  'holiday', 'holidays', 'weekend', 'weekends',
  'department', 'designation', 'section',
  'employee', 'employees', 'staff',
  'deduction', 'deductions', 'tax', 'loan', 'loans', 'penalty', 'penalties',
];

// Compound phrases that name a distinct sub-entity sharing a word with a
// broader DOMAIN_KEYWORDS entry — "employee group" (the employee_groups
// table: shift-batch roster unit) is NOT the same thing as "employee"
// (headcount), but both share the literal word "employee", so the plain
// shared-keyword check above passed a "how many employee group" question
// straight through to a cached "how many employee" (COUNT(*) FROM employees)
// answer. When a compound phrase is present, it replaces the generic keyword
// it would otherwise also match — a compound-vs-bare collision is rejected
// exactly like a payroll-vs-bonus one.
const COMPOUND_KEYWORDS: { phrases: string[]; token: string; suppresses: string[] }[] = [
  { phrases: ['employee group', 'employee groups'], token: 'employee_group', suppresses: ['employee', 'employees'] },
];

function domainKeywordsOf(text: string): Set<string> {
  const lower = text.toLowerCase();
  const keywords = new Set(DOMAIN_KEYWORDS.filter((k) => lower.includes(k)));
  for (const { phrases, token, suppresses } of COMPOUND_KEYWORDS) {
    if (phrases.some((p) => lower.includes(p))) {
      suppresses.forEach((s) => keywords.delete(s));
      keywords.add(token);
    }
  }
  return keywords;
}

/** True if neither question mentions a recognized domain noun (nothing to
 * compare — let the score stand alone), or they share at least one. False
 * only when both mention domain nouns but none overlap — a same-template,
 * different-domain collision. */
function sameDomain(question: string, candidateQuestion: string): boolean {
  const a = domainKeywordsOf(question);
  if (a.size === 0) return true;
  const b = domainKeywordsOf(candidateQuestion);
  if (b.size === 0) return true;
  for (const k of a) if (b.has(k)) return true;
  return false;
}

// Words that carry no identifying information on their own — question
// scaffolding, pronouns, filler verbs. Stripping these (plus DOMAIN_KEYWORDS,
// which are category words, not identifiers) from a question leaves only the
// SPECIFIC subject it's actually about — a name, a department, a shift
// letter, whatever varies between two otherwise-identical-shaped questions.
const GENERIC_QUESTION_WORDS = new Set([
  'who', 'is', 'are', 'was', 'were', 'what', 'when', 'where', 'why', 'how',
  'his', 'her', 'hers', 'him', 'he', 'she', 'they', 'their', 'them', 'the', 'and',
  'of', 'in', 'on', 'for', 'to', 'from', 'with', 'about', 'tell', 'me', 'show',
  'list', 'find', 'get', 'give', 'my', 'you', 'your', 'we', 'our', 'us', 'please',
  'does', 'did', 'can', 'could', 'would', 'should', 'will', 'that', 'this', 'these',
  'those', 'not', 'yes', 'has', 'have', 'had', 'been', 'being', 'its', 'all', 'any',
  'some', 'than', 'then', 'more', 'most', 'much', 'many', 'named', 'name', 'called',
]);

function specificTokensOf(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const tokens = new Set<string>();
  for (const w of words) {
    if (w.length < 3) continue;
    if (GENERIC_QUESTION_WORDS.has(w)) continue;
    if (DOMAIN_KEYWORDS.includes(w)) continue;
    tokens.add(w);
  }
  return tokens;
}

// Guards against embedding similarity alone matching two questions whose
// TEMPLATE is near-identical but whose SPECIFIC SUBJECT differs — "who is
// arif" vs a cached "who is shihab" score very high on template similarity
// (the sentence structure dominates the embedding; a single name barely
// moves it) even though they're about two different people. Without this,
// a high-confidence match (>= HIGH_CONFIDENCE_SCORE) replays the OLD
// person's cached tool args/SQL verbatim, no adaptation, wrong answer,
// silently — the same class of bug sameDomain()/sameIntent() catch for
// domain/shape collisions, but for the actual subject identity.
// True if neither question has a specific identifying token (nothing to
// compare, score stands alone), or both do and share at least one. False
// only when both have identifying tokens and none overlap.
function sameSpecificEntity(question: string, candidateQuestion: string): boolean {
  const a = specificTokensOf(question);
  if (a.size === 0) return true;
  const b = specificTokensOf(candidateQuestion);
  if (b.size === 0) return true;
  for (const t of a) if (b.has(t)) return true;
  return false;
}

// Same domain noun (e.g. "attendance"/"payroll") isn't enough — a same-domain
// question can still be a fundamentally different SHAPE of query than what a
// cached reference answers, and adaptReferenceSql()'s "change a name/date/
// count" adaptation only works for genuinely-the-same-shape questions:
//   - "compare attendance this month vs last month" (comparison, multi-period)
//     scored 0.7 against a cached SIMPLE "total attendance?" (single count) —
//     adapted into a self-contradicting WHERE clause that always returned 0.
//   - "total payroll amount for this year" (aggregate SUM) scored 0.72 against
//     a cached "payroll history summary" (row listing) — adapted into SQL
//     that hallucinated a `status = 'paid'` filter matching no real rows.
// Each category below is a distinct query shape; if a question matches one
// and the candidate matches a different (non-empty) one, reject the match
// outright rather than let adaptReferenceSql bridge shapes it isn't meant to.
const INTENT_CATEGORIES: Record<string, string[]> = {
  comparison: ['compare', 'comparison', 'compared', 'ratio', 'vs', 'versus', 'trend', 'change', 'difference', 'growth', 'increase', 'decrease'],
  aggregate: ['total', 'sum', 'amount', 'average', 'how much'],
  listing: ['list', 'summary', 'history', 'breakdown', 'show me', 'all '],
  // "which month was most payroll AMOUNT" shares the weak word "amount" with
  // the aggregate category, so it collided with a plain "total payroll this
  // month" aggregate question — same domain, same weak keyword, but a
  // fundamentally different shape (ranking/extremum across many periods vs a
  // single period's SUM). A superlative word is a much stronger, more
  // specific signal than "amount"/"total" alone, so it wins outright below.
  superlative: ['most', 'highest', 'lowest', 'best', 'worst', 'top', 'maximum', 'minimum', 'max', 'min'],
};

function intentCategoriesOf(text: string): Set<string> {
  const lower = text.toLowerCase();
  const categories = new Set<string>();
  for (const [category, words] of Object.entries(INTENT_CATEGORIES)) {
    if (words.some((w) => (w.includes(' ') ? lower.includes(w) : new RegExp(`\\b${w}\\b`).test(lower)))) {
      categories.add(category);
    }
  }
  // Superlative phrasing dominates — a ranking/extremum question ("which
  // month had the MOST X") is never the same shape as a plain aggregate/
  // listing question, even if it happens to share a generic word like
  // "amount"/"total" with one.
  if (categories.has('superlative')) {
    categories.delete('aggregate');
    categories.delete('listing');
  }
  return categories;
}

/** True if neither question matches a recognized intent category, or they
 * share at least one. False only when both match a category and none overlap
 * — a same-domain, different-query-shape collision. */
function sameIntent(question: string, candidateQuestion: string): boolean {
  const a = intentCategoriesOf(question);
  if (a.size === 0) return true;
  const b = intentCategoriesOf(candidateQuestion);
  if (b.size === 0) return true;
  for (const c of a) if (b.has(c)) return true;
  return false;
}

// A trained/rated entry answers a question via exactly one of these two
// sources — a fixed HR tool call (hr.tools.ts) or a raw SQL query. Tool-based
// entries skip SQL generation/execution entirely on replay.
export interface AnswerSource {
  sql?: string;
  tool?: string;
  args?: Record<string, any>;
}

export interface TrainedMatch extends AnswerSource {
  question: string;
  answer: string;
  instruction: string;
  score: number;
}

export interface FailedQuery {
  question: string;
  sql: string;
  answer: string;
  reason: string;
  recorded_at: string;
}

export type QARating = 'good' | 'bad' | 'mid';

export interface QAMatch extends AnswerSource {
  question: string;
  answer: string;
  /** @deprecated kept for backward-compat payload reads — use `sql` instead. */
  query: string;
  good_ratio: number;
  bad_ratio: number;
  mid_ratio: number;
  score: number;
}

/**
 * Semantic cache for HR text-to-SQL queries. Replaces the old Redis
 * exact-normalized-string cache — questions phrased differently but meaning
 * the same thing now hit the same trained SQL. Embeddings always go through
 * the local Ollama nomic-embed-text model, independent of which provider
 * (Gemini/Ollama) answers the question — the trained set's vectors are all
 * in this one embedding space, and mixing embedding models would make
 * cosine similarity meaningless even if dimensions happened to match.
 */
@Injectable()
export class LangchainQdrantService {
  private readonly logger = new Logger(LangchainQdrantService.name);
  private readonly client = new QdrantClient({ url: process.env.QDRANT_URL ?? 'http://localhost:6333' });
  private readonly ensured = new Set<string>();

  private async ensureCollection(collection: string): Promise<void> {
    if (this.ensured.has(collection)) return;
    const { collections } = await this.client.getCollections();
    if (!collections.some((c) => c.name === collection)) {
      await this.client.createCollection(collection, {
        vectors: { size: VECTOR_SIZE, distance: 'Cosine' },
      });
      if (collection === QA_COLLECTION) {
        // getKnownBadPayloads() and findBestQA() both range-filter on these —
        // an integer payload index turns that scan into an indexed lookup
        // instead of a full collection scan as the Q&A set grows.
        await this.client.createPayloadIndex(collection, { field_name: 'bad_ratio', field_schema: 'integer' }).catch(() => {});
        await this.client.createPayloadIndex(collection, { field_name: 'good_ratio', field_schema: 'integer' }).catch(() => {});
      }
    }
    this.ensured.add(collection);
  }

  private async embed(text: string): Promise<number[]> {
    const res = await axios.post(
      `${OLLAMA_URL}/api/embeddings`,
      // keep_alive: this embedding model is called on every single question
      // (cache lookup) — never let it idle-unload between requests.
      { model: OLLAMA_EMBEDDING_MODEL, prompt: text, keep_alive: '30m' },
      { timeout: 30000 },
    );
    const values = res.data?.embedding;
    if (!values) throw new Error('Ollama embedding response missing values');
    return values;
  }

  private pointId(question: string): string {
    return createHash('sha1').update(question.trim().toLowerCase()).digest('hex').slice(0, 32);
  }

  /**
   * A trained entry can be semantically close enough to win a match for a
   * question with a genuinely different intent (e.g. "total shift?" — COUNT —
   * matching "show me all shifts in list" — wants a list). Community feedback
   * on THAT specific combination already exists in langchain_q_and_a (keyed by
   * the incoming question, not the trained one) — a query/answer marked net-bad
   * there must never be served again for a similar question, regardless of
   * which trained entry produced it. Rebuilt from Qdrant on every call rather
   * than cached, since a Bad rating must take effect immediately.
   */
  private async getKnownBadPayloads(): Promise<Set<string>> {
    await this.ensureCollection(QA_COLLECTION);
    const bad = new Set<string>();
    let offset: string | number | undefined | null = undefined;
    do {
      const page = await this.client.scroll(QA_COLLECTION, {
        limit: 100,
        with_payload: true,
        with_vector: false,
        offset,
        filter: { must: [{ key: 'bad_ratio', range: { gte: 1 } }] },
      });
      for (const point of page.points) {
        const p = point.payload as { query?: string; answer?: string; good_ratio?: number; bad_ratio?: number };
        if ((p.bad_ratio ?? 0) <= (p.good_ratio ?? 0)) continue;
        if (p.query) bad.add(p.query);
        else if (p.answer) bad.add(`ANSWER::${p.answer}`);
      }
      offset = page.next_page_offset as string | number | null | undefined;
    } while (offset);
    return bad;
  }

  async findSimilar(question: string): Promise<TrainedMatch | null> {
    try {
      await this.ensureCollection(COLLECTION);
      const [vector, knownBad] = await Promise.all([this.embed(question), this.getKnownBadPayloads()]);
      const hits = await this.client.search(COLLECTION, {
        vector,
        limit: 5,
        with_payload: true,
        score_threshold: SIMILARITY_THRESHOLD,
      });
      for (const hit of hits) {
        const payload = hit.payload as { question: string; sql?: string; tool?: string; args?: Record<string, any>; answer?: string; note?: string };
        const key = payload.sql || (payload.tool ? `TOOL::${payload.tool}::${JSON.stringify(payload.args ?? {})}` : `ANSWER::${payload.answer ?? ''}`);
        if (knownBad.has(key)) continue;
        if (!sameDomain(question, payload.question)) continue;
        if (!sameIntent(question, payload.question)) continue;
        if (!sameSpecificEntity(question, payload.question)) continue;
        return {
          question: payload.question,
          sql: payload.sql,
          tool: payload.tool,
          args: payload.args,
          answer: payload.answer ?? '',
          instruction: payload.note ?? '',
          score: hit.score,
        };
      }
      return null;
    } catch (err: any) {
      this.logger.warn('Qdrant lookup failed', err?.message);
      return null;
    }
  }

  /**
   * Trains a question against exactly one answer source — a fixed HR tool call
   * (`source.tool` + `source.args`) or raw SQL (`source.sql`) — plus the answer
   * text. `note` is an optional extra instruction captured at train time (e.g.
   * "always number the rows") — findSimilar() surfaces it back as `instruction`
   * so the narration step for this specific question keeps applying it on every
   * future semantic match, not just the one that was trained.
   */
  async upsertTrained(question: string, source: AnswerSource, answer?: string, note?: string): Promise<void> {
    await this.ensureCollection(COLLECTION);
    const vector = await this.embed(question);
    await this.client.upsert(COLLECTION, {
      points: [{
        id: this.pointId(question),
        vector,
        payload: { question, sql: source.sql ?? '', tool: source.tool ?? '', args: source.args ?? {}, answer: answer ?? '', note: note ?? '' },
      }],
    });
  }

  /**
   * Records a question the assistant couldn't answer or answered wrong
   * (agent failure, no rows, or user-flagged "Wrong — Discard"), along with
   * whatever answer was actually given, so these gaps are visible for
   * review/retraining separately from the trained set.
   */
  async recordFailedQuery(question: string, sql: string | undefined, answer: string | undefined, reason: string): Promise<void> {
    try {
      await this.ensureCollection(FAILED_COLLECTION);
      const vector = await this.embed(question);
      await this.client.upsert(FAILED_COLLECTION, {
        points: [
          {
            id: this.pointId(question),
            vector,
            payload: { question, sql: sql ?? '', answer: answer ?? '', reason, recorded_at: new Date().toISOString() },
          },
        ],
      });
    } catch (err: any) {
      this.logger.warn('Failed to record failed query in Qdrant', err?.message);
    }
  }

  async listFailedQueries(): Promise<FailedQuery[]> {
    await this.ensureCollection(FAILED_COLLECTION);
    const points: FailedQuery[] = [];
    let offset: string | number | undefined | null = undefined;
    do {
      const page = await this.client.scroll(FAILED_COLLECTION, {
        limit: 100,
        with_payload: true,
        with_vector: false,
        offset,
      });
      for (const point of page.points) {
        points.push(point.payload as unknown as FailedQuery);
      }
      offset = page.next_page_offset as string | number | null | undefined;
    } while (offset);
    return points;
  }

  async deleteFailedQuery(question: string): Promise<void> {
    await this.ensureCollection(FAILED_COLLECTION);
    await this.client.delete(FAILED_COLLECTION, { points: [this.pointId(question)] });
  }

  /**
   * Records/updates a question+answer(+source) pair in the community-rated Q&A
   * set. `source` is a SQL query or a tool call, same as upsertTrained() — kept
   * under the legacy `query` payload key too (SQL only) for backward-compat
   * reads. Existing good/bad/mid counters are preserved across re-rating the
   * same question (e.g. retraining a variant, updating its answer source).
   */
  async upsertQA(question: string, answer: string, source: AnswerSource = {}): Promise<void> {
    await this.ensureCollection(QA_COLLECTION);
    const id = this.pointId(question);
    const vector = await this.embed(question);
    const [existing] = await this.client.retrieve(QA_COLLECTION, { ids: [id], with_payload: true });
    const prev = existing?.payload as Partial<QAMatch> | undefined;
    await this.client.upsert(QA_COLLECTION, {
      points: [
        {
          id,
          vector,
          payload: {
            question,
            answer,
            query: source.sql ?? '',
            sql: source.sql ?? '',
            tool: source.tool ?? '',
            args: source.args ?? {},
            good_ratio: prev?.good_ratio ?? 0,
            bad_ratio: prev?.bad_ratio ?? 0,
            mid_ratio: prev?.mid_ratio ?? 0,
          },
        },
      ],
    });
  }

  /** Increments the given rating's counter for a question already upserted via upsertQA(). */
  async rateQA(question: string, rating: QARating): Promise<void> {
    await this.ensureCollection(QA_COLLECTION);
    const id = this.pointId(question);
    const [existing] = await this.client.retrieve(QA_COLLECTION, { ids: [id], with_payload: true, with_vector: true });
    if (!existing) return;
    const payload = existing.payload as Record<string, any>;
    const field = `${rating}_ratio`;
    payload[field] = (payload[field] ?? 0) + 1;
    await this.client.upsert(QA_COLLECTION, {
      points: [{ id, vector: existing.vector as number[], payload }],
    });
  }

  /**
   * Finds the best-rated semantically-similar Q&A entry, if any. Looks at the
   * top handful of matches (not just the closest) and picks the one with the
   * best good-vs-bad ratio, so a highly-rated slightly-less-similar answer can
   * win over a barely-more-similar one nobody has vetted. Entries with more bad
   * votes than good are never surfaced.
   */
  async findBestQA(question: string): Promise<QAMatch | null> {
    try {
      await this.ensureCollection(QA_COLLECTION);
      const vector = await this.embed(question);
      const hits = await this.client.search(QA_COLLECTION, {
        vector,
        limit: 5,
        with_payload: true,
        score_threshold: SIMILARITY_THRESHOLD,
      });
      const candidates = hits
        .map((h) => ({ ...(h.payload as Omit<QAMatch, 'score'>), score: h.score }))
        .filter((e) => e.bad_ratio <= e.good_ratio)
        .filter((e) => sameDomain(question, e.question))
        .filter((e) => sameIntent(question, e.question))
        .filter((e) => sameSpecificEntity(question, e.question))
        .sort((a, b) => (b.good_ratio - b.bad_ratio) - (a.good_ratio - a.bad_ratio) || b.score - a.score);
      return candidates[0] ?? null;
    } catch (err: any) {
      this.logger.warn('Qdrant Q&A lookup failed', err?.message);
      return null;
    }
  }

  /**
   * Passive analytics log — every single turn, unconditionally, no rating or
   * approval needed. Never blocks or fails the actual answer: embedding is
   * one more network call on the hot path, so this is meant to be invoked
   * fire-and-forget (see LangchainService.logConversationAsync) and any
   * failure here is just logged and swallowed.
   */
  async logConversation(entry: {
    question: string;
    answer: string;
    tool?: string;
    sql?: string;
    fromCache?: boolean;
    sessionId?: string;
    userName?: string;
  }): Promise<void> {
    await this.ensureCollection(LOG_COLLECTION);
    const vector = await this.embed(entry.question);
    await this.client.upsert(LOG_COLLECTION, {
      points: [
        {
          id: randomUUID(),
          vector,
          payload: {
            question: entry.question,
            answer: entry.answer,
            tool: entry.tool ?? '',
            sql: entry.sql ?? '',
            from_cache: entry.fromCache ?? false,
            session_id: entry.sessionId ?? '',
            user_name: entry.userName ?? '',
            asked_at: new Date().toISOString(),
          },
        },
      ],
    });
  }
}

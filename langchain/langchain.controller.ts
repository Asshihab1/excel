import { Body, Controller, Post, Get, Delete, Param, Query, HttpCode } from '@nestjs/common';
import { LangchainService } from '@module/langchain/langchain.service';

@Controller()
export class LangchainController {
  constructor(private readonly langchainService: LangchainService) {}

  @Post('ask')
  @HttpCode(200)
  async ask(@Body() body: { question: string; session_id: string; train_mode?: boolean; user_name?: string; laravel_token?: string; module?: string }) {
    const question = (body?.question ?? '').trim();
    const sessionId = (body?.session_id ?? '').trim();
    if (!question) return { answer: 'Please provide a question.' };
    if (!sessionId) return { answer: 'Please provide a session_id.' };
    const module = body.module === 'STORE' ? 'STORE' : 'HRM';
    return this.langchainService.ask(
      question,
      sessionId,
      body.train_mode ?? false,
      (body.user_name ?? '').trim() || 'Unknown',
      (body.laravel_token ?? '').trim() || undefined,
      module,
    );
  }

  @Post('stop')
  @HttpCode(200)
  stop(@Body() body: { session_id: string }) {
    const sessionId = (body?.session_id ?? '').trim();
    if (!sessionId) return { success: false, message: 'session_id is required.' };
    this.langchainService.stopGeneration(sessionId);
    return { success: true };
  }

  @Post('validate')
  @HttpCode(200)
  async validate(@Body() body: { question: string; sql?: string; tool?: string; args?: Record<string, any>; answer?: string; note?: string }) {
    const question = (body?.question ?? '').trim();
    const sql = (body?.sql ?? '').trim();
    const tool = (body?.tool ?? '').trim();
    const answer = (body.answer ?? '').trim();
    if (!question || (!sql && !tool && !answer)) {
      return { success: false, message: 'question and either sql, tool, or answer are required.' };
    }
    return this.langchainService.validate(
      question,
      { sql: sql || undefined, tool: tool || undefined, args: body.args },
      answer || undefined,
      (body.note ?? '').trim() || undefined,
    );
  }

  @Post('rate')
  @HttpCode(200)
  async rate(@Body() body: { question: string; answer: string; sql?: string; tool?: string; args?: Record<string, any>; rating: 'good' | 'bad' | 'mid'; note?: string }) {
    const question = (body?.question ?? '').trim();
    const answer = (body?.answer ?? '').trim();
    const rating = body?.rating;
    if (!question || !answer || !['good', 'bad', 'mid'].includes(rating)) {
      return { success: false, message: 'question, answer, and a valid rating (good|bad|mid) are required.' };
    }
    return this.langchainService.rateAnswer(
      question,
      answer,
      { sql: (body.sql ?? '').trim() || undefined, tool: (body.tool ?? '').trim() || undefined, args: body.args },
      rating,
      (body.note ?? '').trim() || undefined,
    );
  }

  @Post('reject')
  @HttpCode(200)
  async reject(@Body() body: { question: string; sql?: string; answer?: string }) {
    const question = (body?.question ?? '').trim();
    if (!question) return { success: false, message: 'question is required.' };
    await this.langchainService.recordWrongAnswer(
      question,
      (body.sql ?? '').trim() || undefined,
      (body.answer ?? '').trim() || undefined,
    );
    return { success: true };
  }

  @Get('today-summary')
  async todaySummary(@Query('shift_id') shiftId?: string) {
    const id = shiftId ? parseInt(shiftId, 10) : undefined;
    const data = await this.langchainService.fetchTodaySummary(id);
    if (!data) return { error: 'Could not fetch today summary from HRM.' };
    return data;
  }

  @Get('sessions')
  async getSessions() {
    return this.langchainService.getSessions();
  }

  @Get('sessions/:sessionId/history')
  async getSessionHistory(@Param('sessionId') sessionId: string) {
    return this.langchainService.getSessionHistory(sessionId);
  }

  @Delete('sessions/:sessionId')
  async deleteSession(@Param('sessionId') sessionId: string) {
    await this.langchainService.deleteSession(sessionId);
    return { success: true };
  }
}

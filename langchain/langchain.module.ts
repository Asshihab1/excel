import { Module } from '@nestjs/common';
import { LangchainController } from '@module/langchain/langchain.controller';
import { LangchainService } from '@module/langchain/langchain.service';
import { LangchainQdrantService } from '@module/langchain/langchain.qdrant';
import { McpService } from '@module/mcp/mcp.service';
import { HrToolsService } from '@module/langchain/hr.tools';
import { LangfuseService } from '@module/langchain/langfuse.service';
import { PrismaService } from '@prisma/prisma.service';

@Module({
  controllers: [LangchainController],
  providers: [LangchainService, LangchainQdrantService, McpService, HrToolsService, LangfuseService, PrismaService],
})
export class LangchainModule {}

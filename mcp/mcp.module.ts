import { Module } from '@nestjs/common';
import { McpController } from '@module/mcp/mcp.controller';
import { McpService } from '@module/mcp/mcp.service';
import { PrismaService } from '@prisma/prisma.service';

@Module({
  controllers: [McpController],
  providers: [McpService, PrismaService],
})
export class McpModule {}

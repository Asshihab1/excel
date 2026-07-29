import { Routes } from '@nestjs/core';
import { McpModule } from '@module/mcp/mcp.module';

export const McpRoutes: Routes = [
  {
    path: 'mcp-server',
    module: McpModule,
  },
];

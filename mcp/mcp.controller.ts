import { All, Controller, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { McpService } from '@module/mcp/mcp.service';

@Controller()
export class McpController {
  constructor(private readonly mcpService: McpService) {}

  @All('mcp')
  async handle(@Req() req: Request, @Res() res: Response) {
    const transport = this.mcpService.createTransport();
    await transport.handleRequest(req, res, req.body);
  }
}

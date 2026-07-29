import { Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { PrismaService } from '@prisma/prisma.service';
import { z } from 'zod';

@Injectable()
export class McpService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Public tool methods (callable directly by other services) ────────────

  async getEmployees(limit = 50): Promise<any[]> {
    return this.prisma.$queryRawUnsafe<any[]>(
      `SELECT id, first_name, last_name, employee_no, section, designation
       FROM employees WHERE is_active = 1 LIMIT ${limit}`,
    );
  }

  async getAttendanceToday(shiftId?: number): Promise<any[]> {
    const where = shiftId ? `AND al.shift_id = ${shiftId}` : '';
    return this.prisma.$queryRawUnsafe<any[]>(
      `SELECT al.id, e.first_name, e.last_name, e.employee_no,
              al.in_time, al.out_time, al.status, al.shift_id
       FROM attendance_logs al
       JOIN employees e ON e.id = al.employee_id
       WHERE DATE(al.in_time) = CURDATE() ${where}
       ORDER BY al.in_time DESC LIMIT 100`,
    );
  }

  async runSelectQuery(sql: string): Promise<{ rows?: any[]; error?: string }> {
    const trimmed = sql.trim();
    if (!trimmed.toLowerCase().startsWith('select')) {
      return { error: 'Only SELECT queries are permitted.' };
    }
    try {
      const rows = await this.prisma.$queryRawUnsafe<any[]>(trimmed);
      return { rows };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  async getLeaveRequests(opts: {
    hr_status?: 'pending' | 'approved' | 'rejected';
    supervisor_status?: 'pending' | 'approved' | 'rejected';
    limit?: number;
  } = {}): Promise<any[]> {
    const conditions: string[] = [];
    if (opts.hr_status) conditions.push(`lr.hr_status = '${opts.hr_status}'`);
    if (opts.supervisor_status) conditions.push(`lr.supervisor_status = '${opts.supervisor_status}'`);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return this.prisma.$queryRawUnsafe<any[]>(
      `SELECT lr.id, e.first_name, e.last_name,
              lr.leave_type_id, lr.supervisor_status, lr.hr_status, lr.final_status, lr.created_at
       FROM leave_requests lr
       JOIN employees e ON e.id = lr.employee_id
       ${where}
       ORDER BY lr.created_at DESC LIMIT ${opts.limit ?? 50}`,
    );
  }

  // ─── MCP HTTP transport (per-request fresh server) ────────────────────────

  createTransport(): StreamableHTTPServerTransport {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = this.buildServer();
    server.connect(transport);
    return transport;
  }

  private buildServer(): McpServer {
    const server = new McpServer({ name: 'mes-mcp', version: '1.0.0' });

    server.registerTool(
      'get_employees',
      {
        description: 'Get list of active employees',
        inputSchema: z.object({ limit: z.number().optional() }),
      },
      async ({ limit }) => ({
        content: [{ type: 'text', text: JSON.stringify(await this.getEmployees(limit), null, 2) }],
      }),
    );

    server.registerTool(
      'get_attendance_today',
      {
        description: 'Get attendance logs for today',
        inputSchema: z.object({ shift_id: z.number().optional() }),
      },
      async ({ shift_id }) => ({
        content: [{ type: 'text', text: JSON.stringify(await this.getAttendanceToday(shift_id), null, 2) }],
      }),
    );

    server.registerTool(
      'run_select_query',
      {
        description: 'Run a raw SELECT query against the MES database',
        inputSchema: z.object({ sql: z.string() }),
      },
      async ({ sql }) => {
        const result = await this.runSelectQuery(sql);
        return result.error
          ? { content: [{ type: 'text', text: result.error }], isError: true }
          : { content: [{ type: 'text', text: JSON.stringify(result.rows, null, 2) }] };
      },
    );

    server.registerTool(
      'get_leave_requests',
      {
        description: 'Get leave requests filtered by status',
        inputSchema: z.object({
          hr_status: z.enum(['pending', 'approved', 'rejected']).optional(),
          supervisor_status: z.enum(['pending', 'approved', 'rejected']).optional(),
          limit: z.number().optional(),
        }),
      },
      async (opts) => ({
        content: [{ type: 'text', text: JSON.stringify(await this.getLeaveRequests(opts), null, 2) }],
      }),
    );

    return server;
  }
}

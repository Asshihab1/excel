import { Injectable } from '@nestjs/common';
import { PrismaService } from '@prisma/prisma.service';
import { z } from 'zod';
import { serializeBigInt } from '@module/langchain/langchain.util';

export interface HrTool {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  handler: (args: any) => Promise<any>;
}

const EMPLOYEE_SELECT = {
  id: true,
  custom_id: true,
  employee_no: true,
  first_name: true,
  last_name: true,
  is_active: true,
  department: true,
  section: true,
  designation: true,
  employee_type: true,
  joining_date: true,
  contact_number: true,
  email: true,
  departments: { select: { name: true } },
  designations: { select: { name: true } },
  employee_groups: { select: { name: true, is_permanent: true } },
} as const;

@Injectable()
export class HrToolsService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Employees ──────────────────────────────────────────────────────────

  async getEmployees(opts: {
    name?: string;
    department?: string;
    designation?: string;
    is_active?: boolean;
    // Rolling joining_date window — "who joined in the last month/2 months"
    // means everyone hired between (today - N months) and today, a continuous
    // range, NOT a single specific calendar month/year like payroll periods
    // are bucketed by. The router computes these as concrete YYYY-MM-DD dates.
    joined_after?: string;
    joined_before?: string;
    limit?: number;
  } = {}): Promise<any[]> {
    const where: Record<string, any> = {};
    if (opts.name) {
      where.OR = [
        { first_name: { contains: opts.name } },
        { last_name: { contains: opts.name } },
      ];
    }
    if (opts.department) where.department = { contains: opts.department };
    if (opts.designation) where.designation = { contains: opts.designation };
    if (opts.is_active !== undefined) where.is_active = opts.is_active;
    if (opts.joined_after || opts.joined_before) {
      where.joining_date = {
        ...(opts.joined_after ? { gte: new Date(opts.joined_after) } : {}),
        ...(opts.joined_before ? { lte: new Date(opts.joined_before) } : {}),
      };
    }

    const rows = await this.prisma.employees.findMany({
      where,
      select: EMPLOYEE_SELECT,
      take: opts.limit ?? 50,
      orderBy: opts.joined_after || opts.joined_before ? { joining_date: 'desc' } : { first_name: 'asc' },
    });
    return serializeBigInt(rows);
  }

  async getEmployeeByName(name: string): Promise<any | null> {
    const row = await this.prisma.employees.findFirst({
      where: {
        OR: [
          { first_name: { contains: name } },
          { last_name: { contains: name } },
        ],
      },
      select: EMPLOYEE_SELECT,
    });
    return serializeBigInt(row);
  }

  // ─── Attendance ─────────────────────────────────────────────────────────

  async getAttendance(opts: {
    employee_name?: string;
    date?: string;
    from_date?: string;
    to_date?: string;
    status?: string;
    limit?: number;
  } = {}): Promise<any[]> {
    const where: Record<string, any> = {};

    if (opts.employee_name) {
      where.employees = {
        OR: [
          { first_name: { contains: opts.employee_name } },
          { last_name: { contains: opts.employee_name } },
        ],
      };
    }
    // attendance_logs.status only ever holds 'VALID'/'INVALID' (see the note
    // above attendanceBreakdown below) — normalize whatever case the router
    // emits ("valid", "Valid", "VALID") to the exact stored value instead of
    // silently matching zero rows on a case mismatch.
    if (opts.status) where.status = opts.status.toUpperCase();
    if (opts.date) {
      where.attendance_date = new Date(opts.date);
    } else if (opts.from_date || opts.to_date) {
      where.attendance_date = {
        ...(opts.from_date ? { gte: new Date(opts.from_date) } : {}),
        ...(opts.to_date ? { lte: new Date(opts.to_date) } : {}),
      };
    }

    const rows = await this.prisma.attendance_logs.findMany({
      where,
      select: {
        id: true,
        attendance_date: true,
        check_in_time: true,
        check_out_time: true,
        status: true,
        has_overtime: true,
        overtime_minutes: true,
        employees: { select: { first_name: true, last_name: true, employee_no: true, department: true } },
      },
      take: opts.limit ?? 100,
      orderBy: { attendance_date: 'desc' },
    });
    return serializeBigInt(rows);
  }

  // attendance_logs.status is 'VALID'/'INVALID' — there is no 'present'/
  // 'absent'/'late' status value in this schema (a previous version of this
  // method filtered on those and silently always returned zeros). "Present"
  // = distinct employees with a VALID log in the window; "absent" = active
  // employees with none; "late" = a VALID log whose check_in_time is after
  // that employee's shift start_time (no stored "late" flag — computed the
  // same way the rest of this codebase's trained queries do it, via a join to
  // employee_shifts, but in JS here since hr.tools.ts stays off raw SQL).
  // Shared by getTodayAttendanceCounts (today only) and getAttendanceAnalytics
  // (any date window, e.g. "this month") — same breakdown, different range.
  private async attendanceBreakdown(from: Date, to: Date): Promise<{ present: number; absent: number; late: number; active_employees: number }> {
    const [validLogs, totalActive] = await Promise.all([
      this.prisma.attendance_logs.findMany({
        where: { attendance_date: { gte: from, lte: to }, status: 'VALID' },
        select: { employee_id: true, check_in_time: true, employee_shifts: { select: { start_time: true } } },
      }),
      this.prisma.employees.count({ where: { is_active: true } }),
    ]);

    const timeOfDay = (d: Date) => d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
    const presentEmployeeIds = new Set(validLogs.map((l) => l.employee_id?.toString()));
    const present = presentEmployeeIds.size;
    const late = validLogs.filter((l) => l.employee_shifts && timeOfDay(l.check_in_time) > timeOfDay(l.employee_shifts.start_time)).length;
    const absent = Math.max(0, totalActive - present);

    return { present, absent, late, active_employees: totalActive };
  }

  async getTodayAttendanceCounts(): Promise<{ present: number; absent: number; late: number; total_active_employees: number }> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const b = await this.attendanceBreakdown(startOfDay, endOfDay);
    return { present: b.present, absent: b.absent, late: b.late, total_active_employees: b.active_employees };
  }

  // "Attendance analytics"/"attendance breakdown for this month" — a single
  // period's present/absent/late distribution, chart-ready (one row per
  // status). Distinct from get_today_attendance_counts (today only, fixed)
  // and get_attendance_comparison (always exactly this-month-vs-last-month) —
  // this one takes an arbitrary from_date/to_date window, defaulting to the
  // current calendar month.
  async getAttendanceAnalytics(opts: { from_date?: string; to_date?: string } = {}): Promise<any[]> {
    const now = new Date();
    const from = opts.from_date ? new Date(opts.from_date) : new Date(now.getFullYear(), now.getMonth(), 1);
    const to = opts.to_date ? new Date(opts.to_date) : now;

    const b = await this.attendanceBreakdown(from, to);
    return [
      { status: 'Present', count: b.present },
      { status: 'Absent', count: b.absent },
      { status: 'Late', count: b.late },
    ];
  }

  // "Compare attendance this month vs last month" — a fixed, deterministic
  // period-over-period comparison (no router date-math needed at all, unlike
  // get_payroll_totals/get_employees — "this month"/"last month" here always
  // means the current calendar month-to-date vs the immediately preceding
  // full calendar month, so the tool just always computes exactly that).
  // attendance_rate = VALID logs / (active employees x calendar days elapsed
  // in the period) x 100 — a simple headcount-days ratio, not a true
  // working-days rate (weekends/holidays aren't excluded), consistent with
  // how "total attendance" is already computed elsewhere in this codebase's
  // trained queries (daily distinct-employee counts, no working-calendar
  // logic). Returns one row per period so it renders as a 2-row table AND is
  // directly chart-ready (period/attendance_rate) for the frontend bar chart.
  async getAttendanceComparison(): Promise<any[]> {
    const now = new Date();
    const currentStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const currentEnd = now;

    const previousMonthAnchor = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const previousStart = previousMonthAnchor;
    const previousEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

    const activeEmployees = await this.prisma.employees.count({ where: { is_active: true } });

    const periodStats = async (start: Date, end: Date, label: string) => {
      const present = await this.prisma.attendance_logs.count({
        where: { attendance_date: { gte: start, lte: end }, status: 'VALID' },
      });
      const daysElapsed = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1);
      const possible = activeEmployees * daysElapsed;
      const attendance_rate = possible > 0 ? Math.round((present / possible) * 10000) / 100 : 0;
      return { period: label, present_days: present, active_employees: activeEmployees, days_counted: daysElapsed, attendance_rate };
    };

    const monthLabel = (d: Date) => d.toLocaleString('en-US', { month: 'short', year: 'numeric' });

    const current = await periodStats(currentStart, currentEnd, `This Month (${monthLabel(currentStart)})`);
    const previous = await periodStats(previousStart, previousEnd, `Last Month (${monthLabel(previousStart)})`);

    return [current, previous];
  }

  // ─── Leave ──────────────────────────────────────────────────────────────

  async getLeaveRequests(opts: {
    employee_name?: string;
    hr_status?: 'pending' | 'approved' | 'rejected';
    supervisor_status?: 'pending' | 'approved' | 'rejected';
    final_status?: 'pending' | 'approved' | 'rejected';
    limit?: number;
  } = {}): Promise<any[]> {
    const where: Record<string, any> = {};
    if (opts.employee_name) {
      where.employees_leave_requests_employee_idToemployees = {
        OR: [
          { first_name: { contains: opts.employee_name } },
          { last_name: { contains: opts.employee_name } },
        ],
      };
    }
    if (opts.hr_status) where.hr_status = opts.hr_status;
    if (opts.supervisor_status) where.supervisor_status = opts.supervisor_status;
    if (opts.final_status) where.final_status = opts.final_status;

    const rows = await this.prisma.leave_requests.findMany({
      where,
      select: {
        id: true,
        custom_id: true,
        start_date: true,
        end_date: true,
        leave_type_name: true,
        reason: true,
        supervisor_status: true,
        hr_status: true,
        final_status: true,
        created_at: true,
        employees_leave_requests_employee_idToemployees: {
          select: { first_name: true, last_name: true, department: true },
        },
      },
      take: opts.limit ?? 50,
      orderBy: { created_at: 'desc' },
    });
    return serializeBigInt(rows);
  }

  async getLeaveTypes(): Promise<any[]> {
    const rows = await this.prisma.leave_types.findMany({
      select: { id: true, name: true, days: true, description: true },
      orderBy: { name: 'asc' },
    });
    return serializeBigInt(rows);
  }

  // "Total bonus outstanding/amount this month" wants SUM(amount) for a
  // period, not a per-record listing (getBonuses above) — same gap as payroll
  // (only a listing tool existed, no aggregate one, so this class of question
  // fell through to a mismatched cache hit / wrong source). Keyed off
  // attendance_date (the bonus's own period-anchor field), with the same
  // fallback-to-most-recent-period-with-data as getPayrollTotals — bonus
  // `status` is unpopulated (NULL) for all records in this dataset, so
  // "outstanding" here just means the accrued total, not a status filter.
  async getBonusTotals(opts: { from_date?: string; to_date?: string } = {}): Promise<{
    from_date: string;
    to_date: string;
    total_bonus: number;
    record_count: number;
    note?: string;
  }> {
    const now = new Date();
    const from = opts.from_date ? new Date(opts.from_date) : new Date(now.getFullYear(), now.getMonth(), 1);
    const to = opts.to_date ? new Date(opts.to_date) : now;

    const sumFor = async (f: Date, t: Date) => {
      const agg = await this.prisma.employee_bonuses.aggregate({
        where: { attendance_date: { gte: f, lte: t } },
        _sum: { amount: true },
        _count: { _all: true },
      });
      return { total_bonus: Number(agg._sum.amount ?? 0), record_count: agg._count._all };
    };

    const current = await sumFor(from, to);
    if (current.record_count > 0) {
      return { from_date: this.formatDate(from), to_date: this.formatDate(to), ...current };
    }

    const latest = await this.prisma.employee_bonuses.findFirst({
      where: { attendance_date: { not: null } },
      orderBy: { attendance_date: 'desc' },
      select: { attendance_date: true },
    });
    if (!latest?.attendance_date) {
      return { from_date: this.formatDate(from), to_date: this.formatDate(to), ...current };
    }

    const latestMonthStart = new Date(latest.attendance_date.getFullYear(), latest.attendance_date.getMonth(), 1);
    const latestMonthEnd = new Date(latest.attendance_date.getFullYear(), latest.attendance_date.getMonth() + 1, 0);
    const fallback = await sumFor(latestMonthStart, latestMonthEnd);
    return {
      from_date: this.formatDate(latestMonthStart),
      to_date: this.formatDate(latestMonthEnd),
      ...fallback,
      note: `No bonuses found for ${this.formatDate(from)} to ${this.formatDate(to)} yet — showing the most recent period with bonus records (${this.formatDate(latestMonthStart)} to ${this.formatDate(latestMonthEnd)}) instead.`,
    };
  }

  // ─── Salary Structure ───────────────────────────────────────────────────

  // employee_salaries.total_salary is the CONFIGURED base salary structure
  // per employee (title/basic/house_rent/allowances) — distinct from
  // payrolls.net_salary/gross_salary, which is a specific MONTH's actual
  // payroll run. "Is there any employee salary below X"/"who earns less
  // than X" means this table, not a payroll period.
  async getEmployeesBelowSalary(opts: { max_salary: number; limit?: number }): Promise<any[]> {
    const rows = await this.prisma.employee_salaries.findMany({
      where: { total_salary: { lt: opts.max_salary } },
      select: {
        title: true,
        total_salary: true,
        basic: true,
        employees: { select: { first_name: true, last_name: true, employee_no: true, department: true, designation: true } },
      },
      take: opts.limit ?? 50,
      orderBy: { total_salary: 'asc' },
    });
    return serializeBigInt(rows);
  }

  // ─── Payroll ────────────────────────────────────────────────────────────

  async getPayrollSummary(opts: {
    employee_name?: string;
    month?: number;
    year?: number;
    limit?: number;
  } = {}): Promise<any[]> {
    const where: Record<string, any> = {};
    if (opts.employee_name) {
      where.employees = {
        OR: [
          { first_name: { contains: opts.employee_name } },
          { last_name: { contains: opts.employee_name } },
        ],
      };
    }
    if (opts.month) where.month = opts.month;
    if (opts.year) where.year = opts.year;

    const rows = await this.prisma.payrolls.findMany({
      where,
      select: {
        id: true,
        month: true,
        year: true,
        basic_salary: true,
        gross_salary: true,
        total_deductions: true,
        net_salary: true,
        status: true,
        employees: { select: { first_name: true, last_name: true, department: true } },
      },
      take: opts.limit ?? 50,
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    });

    // "Ratio of payroll earning" — take-home ratio (net/gross), standard per
    // payroll record (i.e. per payroll month, since each row already is one
    // month's payroll for that employee) rather than a single averaged number.
    const withRatio = rows.map((r) => {
      const gross = Number(r.gross_salary ?? 0);
      const net = Number(r.net_salary ?? 0);
      return { ...r, net_to_gross_ratio: gross > 0 ? Math.round((net / gross) * 10000) / 100 : 0 };
    });

    return serializeBigInt(withRatio);
  }

  private formatDate(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  // "Total payroll"/"total worth of payroll" questions want SUM(net_salary) etc.
  // for a period, not a per-employee row listing (getPayrollSummary above).
  //
  // Keyed off start_date/end_date (a continuous range), NOT the month/year
  // integer columns — those are just a bucket label and don't reliably match
  // the record's actual pay-period dates (e.g. a real record labeled
  // month=6/year=2026 had end_date in July). from_date/to_date is computed by
  // the router: a NAMED month ("July") means that calendar month's boundaries
  // (July 1 to July 31); a relative "last month"/"one month" means a rolling
  // window from (today minus N months) to today — see the router prompt.
  //
  // If nothing falls in the requested window (e.g. asked mid-month before
  // the run), falls back to the most recently processed period instead of
  // silently returning zeros — that reads as "the system is broken" when
  // really payroll for that window just hasn't run yet.
  async getPayrollTotals(opts: { from_date?: string; to_date?: string } = {}): Promise<{
    from_date: string;
    to_date: string;
    total_payroll: number;
    total_gross: number;
    total_deductions: number;
    employee_count: number;
    note?: string;
  }> {
    const now = new Date();
    const from = opts.from_date ? new Date(opts.from_date) : new Date(now.getFullYear(), now.getMonth(), 1);
    const to = opts.to_date ? new Date(opts.to_date) : now;

    const sumFor = async (f: Date, t: Date) => {
      const agg = await this.prisma.payrolls.aggregate({
        where: { start_date: { gte: f, lte: t }, is_active: true },
        _sum: { net_salary: true, gross_salary: true, total_deductions: true },
        _count: { _all: true },
      });
      return {
        total_payroll: Number(agg._sum.net_salary ?? 0),
        total_gross: Number(agg._sum.gross_salary ?? 0),
        total_deductions: Number(agg._sum.total_deductions ?? 0),
        employee_count: agg._count._all,
      };
    };

    const current = await sumFor(from, to);
    if (current.employee_count > 0) {
      return { from_date: this.formatDate(from), to_date: this.formatDate(to), ...current };
    }

    const latest = await this.prisma.payrolls.findFirst({
      where: { is_active: true, start_date: { not: null } },
      orderBy: { start_date: 'desc' },
      select: { start_date: true, end_date: true },
    });
    if (!latest?.start_date || !latest.end_date) {
      return { from_date: this.formatDate(from), to_date: this.formatDate(to), ...current };
    }

    const fallback = await sumFor(latest.start_date, latest.end_date);
    return {
      from_date: this.formatDate(latest.start_date),
      to_date: this.formatDate(latest.end_date),
      ...fallback,
      note: `No payroll found for ${this.formatDate(from)} to ${this.formatDate(to)} yet — showing the most recently processed period (${this.formatDate(latest.start_date)} to ${this.formatDate(latest.end_date)}) instead.`,
    };
  }

  // "How many payrolls are pending/processed/paid this month" / "payroll status
  // breakdown" — same start_date/end_date-keyed window and empty-period
  // fallback as getPayrollTotals (see its comment for why start_date/end_date
  // rather than month/year).
  async getPayrollStatusBreakdown(opts: { from_date?: string; to_date?: string } = {}): Promise<{
    from_date: string;
    to_date: string;
    counts: Record<string, number>;
    note?: string;
  }> {
    const now = new Date();
    const from = opts.from_date ? new Date(opts.from_date) : new Date(now.getFullYear(), now.getMonth(), 1);
    const to = opts.to_date ? new Date(opts.to_date) : now;

    const countsFor = async (f: Date, t: Date) => {
      const grouped = await this.prisma.payrolls.groupBy({
        by: ['status'],
        where: { start_date: { gte: f, lte: t }, is_active: true },
        _count: { _all: true },
      });
      const counts: Record<string, number> = {};
      for (const g of grouped) counts[g.status] = g._count._all;
      return counts;
    };

    const current = await countsFor(from, to);
    const currentTotal = Object.values(current).reduce((a, b) => a + b, 0);
    if (currentTotal > 0) {
      return { from_date: this.formatDate(from), to_date: this.formatDate(to), counts: current };
    }

    const latest = await this.prisma.payrolls.findFirst({
      where: { is_active: true, start_date: { not: null } },
      orderBy: { start_date: 'desc' },
      select: { start_date: true, end_date: true },
    });
    if (!latest?.start_date || !latest.end_date) {
      return { from_date: this.formatDate(from), to_date: this.formatDate(to), counts: current };
    }

    return {
      from_date: this.formatDate(latest.start_date),
      to_date: this.formatDate(latest.end_date),
      counts: await countsFor(latest.start_date, latest.end_date),
      note: `No payroll found for ${this.formatDate(from)} to ${this.formatDate(to)} yet — showing the most recently processed period (${this.formatDate(latest.start_date)} to ${this.formatDate(latest.end_date)}) instead.`,
    };
  }

  // ─── Shifts & roster ────────────────────────────────────────────────────

  async getShifts(): Promise<any[]> {
    const rows = await this.prisma.employee_shifts.findMany({
      where: { is_active: true },
      select: { id: true, name: true, start_time: true, end_time: true, is_night: true, total_working_hours: true },
      orderBy: { name: 'asc' },
    });
    return serializeBigInt(rows);
  }

  // "Current shift" = the shift whose start_time/end_time window covers the
  // current time-of-day, handling overnight shifts where start_time > end_time
  // (e.g. 22:00 -> 06:00). start_time/end_time are stored as DATETIME but only
  // the time-of-day component is meaningful.
  async getCurrentShift(): Promise<any[]> {
    const shifts = await this.prisma.employee_shifts.findMany({
      where: { is_active: true },
      select: { id: true, name: true, start_time: true, end_time: true, is_night: true },
    });

    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const toMinutes = (d: Date) => d.getHours() * 60 + d.getMinutes();

    const current = shifts.filter((s) => {
      const start = toMinutes(s.start_time);
      const end = toMinutes(s.end_time);
      return start <= end ? nowMinutes >= start && nowMinutes <= end : nowMinutes >= start || nowMinutes <= end;
    });

    return serializeBigInt(current);
  }

  // Resolves both direct (employee_id) and group-based (group_id) roster
  // assignments — most roster rows in this system are group-based, so a plain
  // WHERE employee_id = ... join would undercount/miss almost everything.
  async getTodayRoster(opts: { employee_name?: string; group_name?: string; shift_name?: string; limit?: number } = {}): Promise<any[]> {
    const now = new Date();
    const rosters = await this.prisma.rosters.findMany({
      where: {
        is_active: true,
        start_date: { lte: now },
        end_date: { gte: now },
        ...(opts.shift_name ? { employee_shifts: { name: { contains: opts.shift_name } } } : {}),
        ...(opts.group_name ? { employee_groups: { name: { contains: opts.group_name } } } : {}),
      },
      include: {
        employee_shifts: { select: { name: true } },
        employee_groups: { select: { name: true } },
        employees: { select: { id: true, first_name: true, last_name: true, employee_no: true, is_active: true } },
      },
    });

    const nameFilter = opts.employee_name?.toLowerCase();
    const rows: any[] = [];
    for (const r of rosters) {
      const assignees = r.employee_id
        ? r.employees
          ? [r.employees]
          : []
        : await this.prisma.employees.findMany({
            where: { group_id: r.group_id, is_active: true },
            select: { id: true, first_name: true, last_name: true, employee_no: true },
          });

      for (const emp of assignees) {
        if (nameFilter && !`${emp.first_name} ${emp.last_name ?? ''}`.toLowerCase().includes(nameFilter)) continue;
        rows.push({
          employee: `${emp.first_name} ${emp.last_name ?? ''}`.trim(),
          employee_no: emp.employee_no,
          shift_name: r.employee_shifts?.name,
          group_name: r.employee_groups?.name ?? null,
          start_date: r.start_date,
          end_date: r.end_date,
        });
      }
    }
    return serializeBigInt(rows.slice(0, opts.limit ?? 100));
  }

  // "Employee group" (employee_groups table — a shift-batch roster unit, e.g.
  // group_id on employees) is a DISTINCT concept from a plain employee
  // headcount, even though both mention "employee" — see sameDomain()'s
  // compound-keyword handling in langchain.qdrant.ts for the cache-collision
  // this note was added alongside.
  async getEmployeeGroups(): Promise<any[]> {
    const rows = await this.prisma.employee_groups.findMany({
      where: { is_active: true },
      select: {
        id: true,
        name: true,
        is_permanent: true,
        employee_shifts: { select: { name: true } },
        _count: { select: { employees: true } },
      },
      orderBy: { name: 'asc' },
    });
    return serializeBigInt(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        is_permanent: r.is_permanent,
        shift_name: r.employee_shifts?.name ?? null,
        employee_count: r._count.employees,
      })),
    );
  }

  // ─── Bonuses ────────────────────────────────────────────────────────────

  async getBonuses(opts: {
    employee_name?: string;
    bonus_type?: string;
    month?: number;
    year?: number;
    limit?: number;
  } = {}): Promise<any[]> {
    const where: Record<string, any> = {};
    if (opts.employee_name) {
      where.employees = {
        OR: [
          { first_name: { contains: opts.employee_name } },
          { last_name: { contains: opts.employee_name } },
        ],
      };
    }
    if (opts.bonus_type) where.bonus_type = { contains: opts.bonus_type };
    if (opts.month || opts.year) {
      const now = new Date();
      const year = opts.year ?? now.getFullYear();
      const month = opts.month ?? now.getMonth() + 1;
      where.attendance_date = {
        gte: new Date(year, month - 1, 1),
        lt: new Date(year, month, 1),
      };
    }

    const rows = await this.prisma.employee_bonuses.findMany({
      where,
      select: {
        id: true,
        bonus_type: true,
        amount: true,
        status: true,
        attendance_date: true,
        employees: { select: { first_name: true, last_name: true } },
      },
      take: opts.limit ?? 50,
      orderBy: { attendance_date: 'desc' },
    });
    return serializeBigInt(rows);
  }

  // ─── Promotions ─────────────────────────────────────────────────────────

  async getPromotions(opts: {
    employee_name?: string;
    status?: 'pending' | 'approved' | 'rejected';
    limit?: number;
  } = {}): Promise<any[]> {
    const where: Record<string, any> = {};
    if (opts.employee_name) {
      where.employees = {
        OR: [
          { first_name: { contains: opts.employee_name } },
          { last_name: { contains: opts.employee_name } },
        ],
      };
    }
    if (opts.status) where.status = opts.status;

    const rows = await this.prisma.promotions.findMany({
      where,
      select: {
        id: true,
        promotion_title: true,
        old_designation: true,
        new_designation: true,
        old_salary: true,
        new_salary: true,
        status: true,
        promotion_date: true,
        employees: { select: { first_name: true, last_name: true } },
      },
      take: opts.limit ?? 50,
      orderBy: { promotion_date: 'desc' },
    });
    return serializeBigInt(rows);
  }

  // ─── Assets ─────────────────────────────────────────────────────────────

  async getEmployeeAssets(opts: { employee_name?: string; is_returned?: boolean; limit?: number } = {}): Promise<any[]> {
    const where: Record<string, any> = {};
    if (opts.employee_name) {
      where.employees = {
        OR: [
          { first_name: { contains: opts.employee_name } },
          { last_name: { contains: opts.employee_name } },
        ],
      };
    }
    if (opts.is_returned !== undefined) {
      where.return_date = opts.is_returned ? { not: null } : null;
    }

    const rows = await this.prisma.employee_has_assets.findMany({
      where,
      select: {
        id: true,
        issued_date: true,
        return_date: true,
        remarks: true,
        assets: { select: { name: true } },
        employees: { select: { first_name: true, last_name: true } },
      },
      take: opts.limit ?? 50,
      orderBy: { issued_date: 'desc' },
    });
    return serializeBigInt(rows);
  }

  // ─── Notices & blacklist ────────────────────────────────────────────────

  async getNotices(opts: { limit?: number } = {}): Promise<any[]> {
    const rows = await this.prisma.notices.findMany({
      where: { is_active: true },
      select: { id: true, title: true, target_audience: true, published_at: true },
      take: opts.limit ?? 20,
      orderBy: { published_at: 'desc' },
    });
    return serializeBigInt(rows);
  }

  async getBlacklist(opts: { employee_name?: string; active_only?: boolean; limit?: number } = {}): Promise<any[]> {
    const where: Record<string, any> = {};
    if (opts.employee_name) {
      where.employees = {
        OR: [
          { first_name: { contains: opts.employee_name } },
          { last_name: { contains: opts.employee_name } },
        ],
      };
    }
    if (opts.active_only) where.status = true;

    const rows = await this.prisma.employee_blacklists.findMany({
      where,
      select: {
        id: true,
        reason: true,
        status: true,
        revoke_reason: true,
        employees: { select: { first_name: true, last_name: true } },
      },
      take: opts.limit ?? 50,
      orderBy: { created_at: 'desc' },
    });
    return serializeBigInt(rows);
  }

  // ─── Org structure ──────────────────────────────────────────────────────

  async getDepartments(): Promise<any[]> {
    const rows = await this.prisma.departments.findMany({
      where: { is_active: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    return serializeBigInt(rows);
  }

  async getDesignations(): Promise<any[]> {
    const rows = await this.prisma.designations.findMany({
      where: { is_active: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    return serializeBigInt(rows);
  }

  async getUpcomingHolidays(opts: { year?: number; limit?: number } = {}): Promise<any[]> {
    const where: Record<string, any> = { start_date: { gte: new Date() } };
    if (opts.year) where.year = opts.year;

    const rows = await this.prisma.holidays.findMany({
      where,
      select: {
        id: true,
        title: true,
        start_date: true,
        end_date: true,
        is_recurring: true,
        holiday_types: { select: { name: true } },
      },
      take: opts.limit ?? 20,
      orderBy: { start_date: 'asc' },
    });
    return serializeBigInt(rows);
  }

  // employee_weekends is a per-EMPLOYEE dated off-day schedule (weekly off,
  // industrial/holiday swaps, etc.), distinct from the company-wide `holidays`
  // table getUpcomingHolidays reads — "is there a holiday for me this month"
  // means this table, not that one. Defaults to the current calendar month.
  async getEmployeeWeekends(opts: {
    employee_name?: string;
    // employee_weekends.type is NOT just "weekend" — it also stores
    // PUBLIC_HOLIDAY/GOVT_HOLIDAY/INDUSTRIAL_HOLIDAY/SPECIAL_EVENT rows in the
    // same table. "My weekend(s)" must filter type='WEEKEND' specifically, or
    // it silently mixes in unrelated holiday-type rows — see tool description.
    type?: string;
    from_date?: string;
    to_date?: string;
    limit?: number;
  } = {}): Promise<any[]> {
    const now = new Date();
    const from = opts.from_date ? new Date(opts.from_date) : new Date(now.getFullYear(), now.getMonth(), 1);
    const to = opts.to_date ? new Date(opts.to_date) : new Date(now.getFullYear(), now.getMonth() + 1, 0);

    const where: Record<string, any> = { weekend_date: { gte: from, lte: to } };
    if (opts.type) where.type = opts.type;
    if (opts.employee_name) {
      where.employees = {
        OR: [
          { first_name: { contains: opts.employee_name } },
          { last_name: { contains: opts.employee_name } },
        ],
      };
    }

    const rows = await this.prisma.employee_weekends.findMany({
      where,
      select: {
        id: true,
        weekend_date: true,
        type: true,
        status: true,
        reason: true,
        is_industrial: true,
        employees: { select: { first_name: true, last_name: true } },
        holiday_types: { select: { name: true } },
      },
      take: opts.limit ?? 50,
      orderBy: { weekend_date: 'asc' },
    });
    return serializeBigInt(rows);
  }

  // ─── Tool manifest — name/description/schema/handler for LLM tool-calling ─

  get tools(): HrTool[] {
    return [
      {
        name: 'get_employees',
        description: 'Search/list employees, optionally filtered by name, department, designation, active status, or joining_date window (joined_after/joined_before, YYYY-MM-DD). Use for "who joined in the last month/last N months/this year" — that is a ROLLING window from (today minus N months) to today, NOT a single specific calendar month like a payroll period — YOU must compute joined_after = today minus N months yourself and pass it, do not leave it empty.',
        schema: z.object({
          name: z.string().optional().describe('Partial first or last name'),
          department: z.string().optional(),
          designation: z.string().optional(),
          is_active: z.boolean().optional(),
          joined_after: z.string().optional().describe('YYYY-MM-DD, inclusive lower bound on joining_date'),
          joined_before: z.string().optional().describe('YYYY-MM-DD, inclusive upper bound on joining_date'),
          limit: z.number().optional(),
        }),
        handler: (args) => this.getEmployees(args),
      },
      {
        name: 'get_employee_by_name',
        description: 'Look up a single employee by first or last name — includes their department, designation, AND employee_groups (which group they belong to, e.g. "what is my group"/"what group is <name> in"). For a specific person\'s own group, use this, NOT get_employee_groups (which lists all groups, not one person\'s membership).',
        schema: z.object({ name: z.string() }),
        handler: (args) => this.getEmployeeByName(args.name),
      },
      {
        name: 'get_attendance',
        description: 'Get attendance log entries, optionally filtered by employee name, a single date, a date range, or status. The status column only ever holds VALID (a real attendance record exists) or INVALID — there is NO "present"/"absent"/"late" status value. For "present"/"attended" questions pass status="VALID"; there is no "absent" status to filter by (absent = no VALID log — leave status empty and reason about it from the answer instead); for "late" do NOT pass status at all (lateness isn\'t a stored status — use get_today_attendance_counts or get_attendance_analytics for present/absent/late breakdowns instead of this tool).',
        schema: z.object({
          employee_name: z.string().optional(),
          date: z.string().optional().describe('YYYY-MM-DD'),
          from_date: z.string().optional().describe('YYYY-MM-DD'),
          to_date: z.string().optional().describe('YYYY-MM-DD'),
          status: z.string().optional().describe('VALID or INVALID — the only two real values in the database'),
          limit: z.number().optional(),
        }),
        handler: (args) => this.getAttendance(args),
      },
      {
        name: 'get_today_attendance_counts',
        description: 'Get today\'s present/absent/late counts and total active employee count.',
        schema: z.object({}),
        handler: () => this.getTodayAttendanceCounts(),
      },
      {
        name: 'get_attendance_analytics',
        description: 'Get present/absent/late breakdown (one row per status, chart-ready) for a date window (from_date/to_date, YYYY-MM-DD, defaults to current-month-to-date if both omitted). Use for "attendance analytics"/"attendance breakdown for this month/<month>/<year>" questions — NOT for "today" specifically (use get_today_attendance_counts) and NOT for a this-vs-last-month comparison (use get_attendance_comparison). YOU must compute concrete from_date/to_date for any named or relative period phrasing, same rules as the payroll tools.',
        schema: z.object({
          from_date: z.string().optional(),
          to_date: z.string().optional(),
        }),
        handler: (args) => this.getAttendanceAnalytics(args),
      },
      {
        name: 'get_attendance_comparison',
        description: 'Compare attendance rate/ratio for this month vs last month — always exactly those two calendar periods, no args needed. Use for "compare attendance this month to last month"/"attendance ratio this month based on last month"/similar period-over-period attendance comparison questions. Returns one row per period with a percentage attendance_rate, chart-ready.',
        schema: z.object({}),
        handler: () => this.getAttendanceComparison(),
      },
      {
        name: 'get_leave_requests',
        description: 'Get leave requests, optionally filtered by employee name, supervisor status, HR status, or final status (pending/approved/rejected).',
        schema: z.object({
          employee_name: z.string().optional(),
          hr_status: z.enum(['pending', 'approved', 'rejected']).optional(),
          supervisor_status: z.enum(['pending', 'approved', 'rejected']).optional(),
          final_status: z.enum(['pending', 'approved', 'rejected']).optional(),
          limit: z.number().optional(),
        }),
        handler: (args) => this.getLeaveRequests(args),
      },
      {
        name: 'get_leave_types',
        description: 'List all configured leave types and their annual day allowance.',
        schema: z.object({}),
        handler: () => this.getLeaveTypes(),
      },
      {
        name: 'get_employees_below_salary',
        description: 'List employees whose CONFIGURED base salary structure (employee_salaries.total_salary) is below a given threshold — NOT a specific month\'s payroll run (use get_payroll_summary/get_payroll_totals for that). Use for "is there any employee salary below X"/"who earns less than X"/"employees under X salary" questions. Convert shorthand like "7k" to 7000 yourself.',
        schema: z.object({
          max_salary: z.number().describe('Employees with total_salary strictly less than this are returned'),
          limit: z.number().optional(),
        }),
        handler: (args) => this.getEmployeesBelowSalary(args),
      },
      {
        name: 'get_payroll_summary',
        description: 'Get individual payroll records (one row per payroll month), optionally filtered by employee name, month, or year. Each row includes net_to_gross_ratio (take-home %, standard per payroll month). Use for "ratio of <employee>\'s payroll/earning"/per-employee payroll history/listing questions — not for company-wide totals (use get_payroll_totals for that).',
        schema: z.object({
          employee_name: z.string().optional(),
          month: z.number().optional(),
          year: z.number().optional(),
          limit: z.number().optional(),
        }),
        handler: (args) => this.getPayrollSummary(args),
      },
      {
        name: 'get_payroll_totals',
        description: 'Get the SUM total payroll (net/gross/deductions) and employee count for a date window (from_date/to_date, YYYY-MM-DD, defaults to current-month-to-date if both omitted). Keyed off actual pay-period dates, not a month/year label. Use for "total payroll"/"total worth of payroll"/"total outstanding payroll"/"payroll amount for <month>/<year>/this month/this year/last month/last year" questions — not for per-employee listing. YOU must compute and pass concrete from_date/to_date for any period phrasing at whatever granularity is named (month or year): a NAMED period ("July", "2025") = that period\'s own full calendar boundaries; "last month/year"/"one month/year"/"last N months/years" (relative, no name) = a ROLLING window from (today minus N months/years) to today, not a specific fixed prior period.',
        schema: z.object({
          from_date: z.string().optional().describe('YYYY-MM-DD, inclusive lower bound on the payroll start_date'),
          to_date: z.string().optional().describe('YYYY-MM-DD, inclusive upper bound on the payroll start_date'),
        }),
        handler: (args) => this.getPayrollTotals(args),
      },
      {
        name: 'get_payroll_status_breakdown',
        description: 'Get payroll counts by status (pending/processed/paid/rejected) for a date window (from_date/to_date, YYYY-MM-DD, defaults to current-month-to-date if both omitted). Keyed off actual pay-period dates, not a month/year label. Use for "how many payrolls are pending/outstanding for <month>/<year>/this month/this year/last month/last year"/"payroll status breakdown" questions. YOU must compute and pass concrete from_date/to_date for any period phrasing at whatever granularity is named (month or year): a NAMED period ("July", "2025") = that period\'s own full calendar boundaries; "last month/year"/"one month/year"/"last N months/years" (relative, no name) = a ROLLING window from (today minus N months/years) to today, not a specific fixed prior period.',
        schema: z.object({
          from_date: z.string().optional().describe('YYYY-MM-DD, inclusive lower bound on the payroll start_date'),
          to_date: z.string().optional().describe('YYYY-MM-DD, inclusive upper bound on the payroll start_date'),
        }),
        handler: (args) => this.getPayrollStatusBreakdown(args),
      },
      {
        name: 'get_departments',
        description: 'List all active departments.',
        schema: z.object({}),
        handler: () => this.getDepartments(),
      },
      {
        name: 'get_designations',
        description: 'List all active designations.',
        schema: z.object({}),
        handler: () => this.getDesignations(),
      },
      {
        name: 'get_shifts',
        description: 'List all active shift definitions (name, start/end time, night-shift flag).',
        schema: z.object({}),
        handler: () => this.getShifts(),
      },
      {
        name: 'get_current_shift',
        description: 'Get the shift(s) currently running right now, based on the current time of day (handles overnight shifts).',
        schema: z.object({}),
        handler: () => this.getCurrentShift(),
      },
      {
        name: 'get_today_roster',
        description: 'Get who is rostered/assigned to work today, optionally filtered by employee name, group name, or shift name. Resolves both direct and group-based roster assignments.',
        schema: z.object({
          employee_name: z.string().optional(),
          group_name: z.string().optional(),
          shift_name: z.string().optional().describe('e.g. "A", "B", "night"'),
          limit: z.number().optional(),
        }),
        handler: (args) => this.getTodayRoster(args),
      },
      {
        name: 'get_employee_groups',
        description: 'List ALL active employee groups (employee_groups — a shift-batch roster unit) with their assigned shift and member count. Use for "how many employee groups"/"employee group list"/"list of groups" questions — this is NOT the same as a plain employee headcount, do not confuse with get_employees. For which group ONE SPECIFIC person belongs to ("what is my group") use get_employee_by_name instead, not this.',
        schema: z.object({}),
        handler: () => this.getEmployeeGroups(),
      },
      {
        name: 'get_bonuses',
        description: 'Get individual employee bonus records (one row per bonus), optionally filtered by employee name, bonus type, month, or year. Use for listing/per-employee questions, not totals.',
        schema: z.object({
          employee_name: z.string().optional(),
          bonus_type: z.string().optional(),
          month: z.number().optional(),
          year: z.number().optional(),
          limit: z.number().optional(),
        }),
        handler: (args) => this.getBonuses(args),
      },
      {
        name: 'get_bonus_totals',
        description: 'Get the SUM total bonus amount and record count for a date window (from_date/to_date, YYYY-MM-DD, defaults to current-month-to-date if both omitted). Use for "total bonus outstanding/amount/paid for <month>/<year>/this month/this year/last month" questions — not for per-employee listing (use get_bonuses for that). YOU must compute and pass concrete from_date/to_date for any period phrasing at whatever granularity is named (month or year): a NAMED period ("July", "2025") = that period\'s own full calendar boundaries; "last month/year"/"one month/year" (relative, no name) = a ROLLING window from (today minus N months/years) to today.',
        schema: z.object({
          from_date: z.string().optional().describe('YYYY-MM-DD, inclusive lower bound on attendance_date'),
          to_date: z.string().optional().describe('YYYY-MM-DD, inclusive upper bound on attendance_date'),
        }),
        handler: (args) => this.getBonusTotals(args),
      },
      {
        name: 'get_promotions',
        description: 'Get employee promotion records, optionally filtered by employee name or status (pending/approved/rejected).',
        schema: z.object({
          employee_name: z.string().optional(),
          status: z.enum(['pending', 'approved', 'rejected']).optional(),
          limit: z.number().optional(),
        }),
        handler: (args) => this.getPromotions(args),
      },
      {
        name: 'get_employee_assets',
        description: 'Get assets issued to employees, optionally filtered by employee name or whether the asset has been returned.',
        schema: z.object({
          employee_name: z.string().optional(),
          is_returned: z.boolean().optional(),
          limit: z.number().optional(),
        }),
        handler: (args) => this.getEmployeeAssets(args),
      },
      {
        name: 'get_notices',
        description: 'List recently published company notices.',
        schema: z.object({ limit: z.number().optional() }),
        handler: (args) => this.getNotices(args),
      },
      {
        name: 'get_blacklist',
        description: 'Get blacklisted-employee records, optionally filtered by employee name or active-only.',
        schema: z.object({
          employee_name: z.string().optional(),
          active_only: z.boolean().optional(),
          limit: z.number().optional(),
        }),
        handler: (args) => this.getBlacklist(args),
      },
      {
        name: 'get_upcoming_holidays',
        description: 'List upcoming company-wide named holidays (the `holidays` table — festivals/public holidays that apply to everyone). Optionally filtered by year. NOT for a specific employee\'s personal weekend/off-day schedule — use get_employee_weekends for that.',
        schema: z.object({
          year: z.number().optional(),
          limit: z.number().optional(),
        }),
        handler: (args) => this.getUpcomingHolidays(args),
      },
      {
        name: 'get_employee_weekends',
        description: 'Get a specific employee\'s dated off-day schedule (employee_weekends table — per-employee). This table stores MULTIPLE distinct types in the `type` column: WEEKEND, PUBLIC_HOLIDAY, GOVT_HOLIDAY, INDUSTRIAL_HOLIDAY, SPECIAL_EVENT — a question about "weekend(s)" must pass type="WEEKEND" or it will silently include unrelated holiday-type rows too; a question about "holiday" without naming a specific type should omit `type` (return all types) unless a specific one is named. For a date window (from_date/to_date, YYYY-MM-DD, defaults to the current calendar month). Use for "is there a holiday for me/for <name> this month"/"my weekend days"/"holiday swap" questions — this is a DIFFERENT table from get_upcoming_holidays (company-wide named holidays), always use this one for a specific person\'s own schedule.',
        schema: z.object({
          employee_name: z.string().optional().describe('Partial first or last name — for "me"/"my", this is already resolved to the actual logged-in user\'s name upstream'),
          type: z.enum(['WEEKEND', 'PUBLIC_HOLIDAY', 'GOVT_HOLIDAY', 'INDUSTRIAL_HOLIDAY', 'SPECIAL_EVENT']).optional().describe('Pass "WEEKEND" whenever the question specifically says "weekend"'),
          from_date: z.string().optional(),
          to_date: z.string().optional(),
          limit: z.number().optional(),
        }),
        handler: (args) => this.getEmployeeWeekends(args),
      },
    ];
  }

  findTool(name: string): HrTool | undefined {
    return this.tools.find((t) => t.name === name);
  }
}

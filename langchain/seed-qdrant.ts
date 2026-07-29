/**
 * Bulk-seeds the Qdrant semantic cache (`langchain_trained_queries`) with a broad set of
 * HR-management question/SQL pairs, so common questions hit the cache immediately instead
 * of always going through the full LLM agent. Normally a pair only enters Qdrant one at a
 * time, via TRAIN_MODE + manual /validate approval after the agent generates it live — this
 * script front-loads that process with known-good SQL for the most common HR questions.
 *
 * Run: npm run train:seed-qdrant   (from node-server/)
 *
 * Safe to re-run — upsertTrained() keys each point by a hash of the question text, so
 * re-running just overwrites the same entries rather than duplicating them.
 */
import { LangchainQdrantService } from '@module/langchain/langchain.qdrant';

interface SeedPair {
  question: string;
  sql: string;
}

const SEED_PAIRS: SeedPair[] = [
  // ── Headcount / employees ────────────────────────────────────────────────
  {
    question: 'how many total employees do we have',
    sql: `SELECT COUNT(*) AS total_employees, SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active_employees FROM employees`,
  },
  {
    question: 'how many active employees are there',
    sql: `SELECT COUNT(*) AS active_employees FROM employees WHERE is_active = 1`,
  },
  {
    question: 'how many employee in this system',
    sql: `SELECT COUNT(*) AS total_employees, SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active_employees FROM employees`,
  },
  {
    question: 'list all active employees',
    sql: `SELECT CONCAT(e.first_name,' ',e.last_name) AS name, e.employee_no, e.designation, d.name AS department, e.section, es.name AS shift FROM employees e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN employee_shifts es ON es.id = e.shift_id WHERE e.is_active = 1 ORDER BY e.first_name LIMIT 50`,
  },
  {
    question: 'show me 10 employees in list',
    sql: `SELECT id, first_name, last_name, employee_no FROM employees WHERE is_active = 1 ORDER BY id LIMIT 10`,
  },
  {
    question: 'show recently joined employees',
    sql: `SELECT CONCAT(first_name,' ',last_name) AS full_name, employee_no, designation, department, joining_date FROM employees WHERE is_active = 1 ORDER BY joining_date DESC LIMIT 5`,
  },
  {
    question: 'how many employees per department',
    sql: `SELECT d.name AS department, COUNT(e.id) AS employee_count FROM departments d LEFT JOIN employees e ON e.department_id = d.id AND e.is_active = 1 GROUP BY d.id ORDER BY employee_count DESC`,
  },
  {
    question: 'employee groups list',
    sql: `SELECT eg.id, eg.name, eg.custom_id, eg.is_active, eg.is_permanent, es.name AS shift_name, COUNT(e.id) AS employee_count FROM employee_groups eg LEFT JOIN employee_shifts es ON es.id = eg.shift_id LEFT JOIN employees e ON e.group_id = eg.id AND e.is_active = 1 GROUP BY eg.id ORDER BY eg.name`,
  },
  {
    question: 'how many blacklisted employees are there',
    sql: `SELECT COUNT(*) AS blacklisted_count FROM employee_blacklists WHERE is_active = 1 AND status = 1`,
  },
  {
    question: 'list blacklisted employees',
    sql: `SELECT CONCAT(e.first_name,' ',e.last_name) AS employee, e.employee_no, eb.reason, eb.remarks FROM employee_blacklists eb JOIN employees e ON e.id = eb.employee_id WHERE eb.is_active = 1 AND eb.status = 1`,
  },

  // ── Attendance ────────────────────────────────────────────────────────────
  {
    question: 'how many employees attended today',
    sql: `SELECT COUNT(DISTINCT al.employee_id) AS attended_today FROM attendance_logs al WHERE al.attendance_date = CURDATE() AND al.status = 'VALID'`,
  },
  {
    question: 'list employees attended today',
    sql: `SELECT CONCAT(e.first_name,' ',e.last_name) AS employee, e.employee_no, al.check_in_time, al.check_out_time FROM attendance_logs al JOIN employees e ON e.id = al.employee_id WHERE al.attendance_date = CURDATE() AND al.status = 'VALID' ORDER BY al.check_in_time`,
  },
  {
    question: 'how many employees are absent today',
    sql: `SELECT COUNT(*) AS absent_count FROM employees e WHERE e.is_active = 1 AND e.id NOT IN (SELECT employee_id FROM attendance_logs WHERE attendance_date = CURDATE() AND status = 'VALID')`,
  },
  {
    question: 'list absent employees today',
    sql: `SELECT e.id, CONCAT(e.first_name,' ',e.last_name) AS employee, e.employee_no, e.department, e.designation FROM employees e WHERE e.is_active = 1 AND e.id NOT IN (SELECT employee_id FROM attendance_logs WHERE attendance_date = CURDATE() AND status = 'VALID')`,
  },
  {
    question: 'how many employees did night shift today',
    sql: `SELECT COUNT(DISTINCT al.employee_id) AS night_shift_count FROM attendance_logs al JOIN employee_shifts es ON es.id = al.shift_id WHERE al.attendance_date = CURDATE() AND al.status = 'VALID' AND es.is_night = 1`,
  },
  {
    question: 'who did night shift today',
    sql: `SELECT CONCAT(e.first_name,' ',e.last_name) AS employee, e.employee_no, es.name AS shift_name, DATE_FORMAT(al.check_in_time,'%H:%i') AS check_in FROM attendance_logs al JOIN employees e ON e.id = al.employee_id JOIN employee_shifts es ON es.id = al.shift_id WHERE al.attendance_date = CURDATE() AND al.status = 'VALID' AND es.is_night = 1 ORDER BY al.check_in_time`,
  },
  {
    question: 'who is late today',
    sql: `SELECT CONCAT(e.first_name,' ',e.last_name) AS employee, e.employee_no, es.name AS shift_name, es.start_time AS shift_start, al.check_in_time FROM attendance_logs al JOIN employees e ON e.id = al.employee_id JOIN employee_shifts es ON es.id = al.shift_id WHERE al.attendance_date = CURDATE() AND al.status = 'VALID' AND TIME(al.check_in_time) > es.start_time`,
  },
  {
    question: 'who came in late',
    sql: `SELECT CONCAT(e.first_name,' ',e.last_name) AS employee, e.employee_no, es.name AS shift_name, es.start_time AS shift_start, al.check_in_time FROM attendance_logs al JOIN employees e ON e.id = al.employee_id JOIN employee_shifts es ON es.id = al.shift_id WHERE al.attendance_date = CURDATE() AND al.status = 'VALID' AND TIME(al.check_in_time) > es.start_time`,
  },
  {
    question: 'who attended in late time',
    sql: `SELECT CONCAT(e.first_name,' ',e.last_name) AS employee, e.employee_no, es.name AS shift_name, es.start_time AS shift_start, al.check_in_time FROM attendance_logs al JOIN employees e ON e.id = al.employee_id JOIN employee_shifts es ON es.id = al.shift_id WHERE al.attendance_date = CURDATE() AND al.status = 'VALID' AND TIME(al.check_in_time) > es.start_time`,
  },
  {
    question: 'total late employees',
    sql: `SELECT COUNT(DISTINCT al.employee_id) AS total_late_employees FROM attendance_logs al JOIN employee_shifts es ON es.id = al.shift_id WHERE al.attendance_date = CURDATE() AND al.status = 'VALID' AND TIME(al.check_in_time) > es.start_time`,
  },
  {
    question: 'what is his name',
    sql: `SELECT CONCAT(e.first_name,' ',e.last_name) AS employee_name, e.employee_no FROM attendance_logs al JOIN employees e ON e.id = al.employee_id JOIN employee_shifts es ON es.id = al.shift_id WHERE al.attendance_date = CURDATE() AND al.status = 'VALID' AND TIME(al.check_in_time) > es.start_time`,
  },
  {
    question: 'total overtime today',
    sql: `SELECT COUNT(*) AS overtime_count, SUM(al.overtime_minutes) AS total_overtime_minutes FROM attendance_logs al WHERE al.attendance_date = CURDATE() AND al.has_overtime = 1`,
  },
  {
    question: 'who has overtime today',
    sql: `SELECT CONCAT(e.first_name,' ',e.last_name) AS employee, e.employee_no, al.overtime_minutes, al.overtime_status FROM attendance_logs al JOIN employees e ON e.id = al.employee_id WHERE al.attendance_date = CURDATE() AND al.has_overtime = 1 ORDER BY al.overtime_minutes DESC`,
  },

  // ── Shifts ────────────────────────────────────────────────────────────────
  {
    question: 'list all shifts',
    sql: `SELECT id, name, start_time, end_time, total_working_hours, is_night, is_active FROM employee_shifts ORDER BY start_time`,
  },
  {
    question: 'what is the current shift running now',
    sql: `SELECT es.name AS shift_name, es.start_time, es.end_time, es.is_night, COUNT(e.id) AS assigned_employees FROM employee_shifts es LEFT JOIN employees e ON e.shift_id = es.id AND e.is_active = 1 WHERE es.is_active = 1 AND (CASE WHEN es.start_time <= es.end_time THEN TIME(NOW()) BETWEEN es.start_time AND es.end_time ELSE TIME(NOW()) >= es.start_time OR TIME(NOW()) <= es.end_time END) GROUP BY es.id`,
  },
  {
    question: 'who is on shift right now',
    sql: `SELECT CONCAT(e.first_name,' ',e.last_name) AS employee, e.employee_no, es.name AS shift_name FROM employees e JOIN employee_shifts es ON es.id = e.shift_id WHERE e.is_active = 1 AND es.is_active = 1 AND (CASE WHEN es.start_time <= es.end_time THEN TIME(NOW()) BETWEEN es.start_time AND es.end_time ELSE TIME(NOW()) >= es.start_time OR TIME(NOW()) <= es.end_time END)`,
  },
  {
    question: 'list night shift employees',
    sql: `SELECT CONCAT(e.first_name,' ',e.last_name) AS employee, e.employee_no, es.name AS shift_name FROM employees e JOIN employee_shifts es ON es.id = e.shift_id WHERE es.is_night = 1 AND e.is_active = 1`,
  },
  {
    question: 'shift overrides today',
    sql: `SELECT so.type, CONCAT(a.first_name,' ',a.last_name) AS absent_employee, CONCAT(r.first_name,' ',r.last_name) AS replacement_employee, es.name AS shift_name FROM shift_overrides so LEFT JOIN employees a ON a.id = so.absent_employee_id LEFT JOIN employees r ON r.id = so.replacement_employee_id LEFT JOIN employee_shifts es ON es.id = so.shift_id WHERE so.is_active = 1 AND so.date = CURDATE()`,
  },

  // ── Roster ────────────────────────────────────────────────────────────────
  // Roster rows in this system are almost always group-based (employee_id NULL,
  // group_id set) — must resolve through employee_groups -> employees, or
  // COUNT(DISTINCT employee_id)/direct employee joins silently return 0.
  {
    question: "who is rostered today",
    sql: `SELECT CONCAT(e.first_name,' ',e.last_name) AS employee, e.employee_no, eg.name AS group_name, es.name AS shift_name, r.start_date, r.end_date FROM rosters r LEFT JOIN employee_groups eg ON eg.id = r.group_id JOIN employee_shifts es ON es.id = r.shift_id JOIN employees e ON (e.id = r.employee_id) OR (e.group_id = r.group_id AND e.is_active = 1) WHERE r.is_active = 1 AND DATE(r.start_date) <= CURDATE() AND DATE(r.end_date) >= CURDATE() ORDER BY es.name, e.first_name`,
  },
  {
    question: 'how many employees are rostered today',
    sql: `SELECT COUNT(DISTINCT e.id) AS rostered_count FROM rosters r JOIN employees e ON (e.id = r.employee_id) OR (e.group_id = r.group_id AND e.is_active = 1) WHERE r.is_active = 1 AND DATE(r.start_date) <= CURDATE() AND DATE(r.end_date) >= CURDATE()`,
  },
  {
    question: 'roster breakdown by shift today',
    sql: `SELECT es.name AS shift_name, COUNT(DISTINCT e.id) AS employee_count FROM rosters r JOIN employee_shifts es ON es.id = r.shift_id JOIN employees e ON (e.id = r.employee_id) OR (e.group_id = r.group_id AND e.is_active = 1) WHERE r.is_active = 1 AND DATE(r.start_date) <= CURDATE() AND DATE(r.end_date) >= CURDATE() GROUP BY es.id ORDER BY employee_count DESC`,
  },
  {
    question: 'how many employee belong in shift A',
    sql: `SELECT COUNT(DISTINCT e.id) AS employee_count FROM rosters r JOIN employee_shifts es ON es.id = r.shift_id JOIN employees e ON (e.id = r.employee_id) OR (e.group_id = r.group_id AND e.is_active = 1) WHERE r.is_active = 1 AND DATE(r.start_date) <= CURDATE() AND DATE(r.end_date) >= CURDATE() AND LOWER(es.name) LIKE '%a%'`,
  },
  {
    question: 'show me employee list who belong in shift A',
    sql: `SELECT CONCAT(e.first_name,' ',e.last_name) AS employee, e.employee_no FROM rosters r JOIN employee_shifts es ON es.id = r.shift_id JOIN employees e ON (e.id = r.employee_id) OR (e.group_id = r.group_id AND e.is_active = 1) WHERE r.is_active = 1 AND DATE(r.start_date) <= CURDATE() AND DATE(r.end_date) >= CURDATE() AND LOWER(es.name) LIKE '%a%' ORDER BY e.first_name`,
  },
  {
    question: 'how many employee belong in department production',
    sql: `SELECT COUNT(*) AS employee_count FROM employees WHERE is_active = 1 AND LOWER(department) LIKE '%production%'`,
  },
  {
    question: 'show me employee list who belong in department production',
    sql: `SELECT CONCAT(first_name,' ',last_name) AS employee, employee_no FROM employees WHERE is_active = 1 AND LOWER(department) LIKE '%production%' ORDER BY first_name`,
  },
  {
    question: 'how many employee belong in designation operator',
    sql: `SELECT COUNT(*) AS employee_count FROM employees WHERE is_active = 1 AND LOWER(designation) LIKE '%operator%'`,
  },
  {
    question: 'show me employee list who belong in designation operator',
    sql: `SELECT CONCAT(first_name,' ',last_name) AS employee, employee_no FROM employees WHERE is_active = 1 AND LOWER(designation) LIKE '%operator%' ORDER BY first_name`,
  },
  {
    question: 'show me shift list for shihab',
    sql: `SELECT CONCAT(e.first_name,' ',e.last_name) AS employee, e.employee_no, es.name AS shift_name, r.start_date, r.end_date FROM rosters r JOIN employee_shifts es ON es.id = r.shift_id JOIN employees e ON (e.id = r.employee_id) OR (e.group_id = r.group_id AND e.is_active = 1) WHERE r.is_active = 1 AND (LOWER(e.first_name) LIKE '%shihab%' OR LOWER(e.last_name) LIKE '%shihab%' OR LOWER(CONCAT(e.first_name,' ',e.last_name)) LIKE '%shihab%') ORDER BY r.start_date DESC, e.employee_no LIMIT 100`,
  },

  // ── Leave management ──────────────────────────────────────────────────────
  {
    question: 'who is on leave today',
    sql: `SELECT CONCAT(e.first_name,' ',e.last_name) AS employee, e.employee_no, lt.name AS leave_type, ld.leave_date FROM leave_dates ld JOIN employees e ON e.id = ld.employee_id JOIN leave_requests lr ON lr.id = ld.leave_id LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id WHERE ld.leave_date = CURDATE() AND lr.final_status = 'approved'`,
  },
  {
    question: 'how many employees are on leave today',
    sql: `SELECT COUNT(DISTINCT ld.employee_id) AS on_leave_count FROM leave_dates ld JOIN leave_requests lr ON lr.id = ld.leave_id WHERE ld.leave_date = CURDATE() AND lr.final_status = 'approved'`,
  },
  {
    question: 'pending leave requests',
    sql: `SELECT lr.custom_id, CONCAT(e.first_name,' ',e.last_name) AS employee, lr.leave_type_name, lr.start_date, lr.end_date, lr.hr_status, lr.supervisor_status FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id WHERE lr.final_status = 'pending' ORDER BY lr.start_date`,
  },
  {
    question: 'how many pending leave requests are there',
    sql: `SELECT COUNT(*) AS pending_count FROM leave_requests WHERE final_status = 'pending'`,
  },
  {
    question: 'leave requests awaiting supervisor approval',
    sql: `SELECT lr.custom_id, CONCAT(e.first_name,' ',e.last_name) AS employee, lr.leave_type_name, lr.start_date, lr.end_date FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id WHERE lr.supervisor_status = 'pending'`,
  },
  {
    question: 'leave requests awaiting hr approval',
    sql: `SELECT lr.custom_id, CONCAT(e.first_name,' ',e.last_name) AS employee, lr.leave_type_name, lr.start_date, lr.end_date FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id WHERE lr.supervisor_status = 'approved' AND lr.hr_status = 'pending'`,
  },

  // ── Payroll ───────────────────────────────────────────────────────────────
  // "total payroll this month" is deliberately NOT seeded here — it's now
  // answered by the get_payroll_totals HR tool (hr.tools.ts), which falls back
  // to the most recently processed period when the current month has no
  // payroll yet. A seeded plain-SQL entry for it would return bare zeros for
  // that same case and — being a semantic-cache hit — would run before the
  // tool router ever gets a chance, permanently shadowing the smarter tool.
  // "payroll status breakdown this month" / "how many payrolls are still
  // pending this month" also deliberately NOT seeded — both are now answered
  // by the get_payroll_status_breakdown HR tool, same fallback-to-latest-
  // processed-period reasoning as above (an empty current month otherwise
  // reads as "Pending Count: 0" with zero explanation).
  {
    question: 'top paid employees this month',
    sql: `SELECT CONCAT(e.first_name,' ',e.last_name) AS name, p.net_salary FROM payrolls p JOIN employees e ON e.id = p.employee_id WHERE p.month = MONTH(CURDATE()) AND p.year = YEAR(CURDATE()) AND p.is_active = 1 ORDER BY p.net_salary DESC LIMIT 10`,
  },
  {
    question: 'total deductions this month',
    sql: `SELECT SUM(total_deductions) AS total_deductions, SUM(tax) AS total_tax, SUM(social_security) AS total_social_security, SUM(loans) AS total_loans, SUM(penalties) AS total_penalties FROM payrolls WHERE month = MONTH(CURDATE()) AND year = YEAR(CURDATE()) AND is_active = 1`,
  },

  // ── Bonuses ───────────────────────────────────────────────────────────────
  {
    question: 'total bonuses paid this month',
    sql: `SELECT SUM(amount) AS total, COUNT(*) AS records FROM employee_bonuses WHERE MONTH(attendance_date) = MONTH(CURDATE()) AND YEAR(attendance_date) = YEAR(CURDATE())`,
  },
  {
    question: 'bonus breakdown by type this month',
    sql: `SELECT bt.name AS bonus_type, COUNT(*) AS count, SUM(eb.amount) AS total FROM employee_bonuses eb JOIN bonus_types bt ON bt.id = eb.bonus_type_id WHERE MONTH(eb.attendance_date) = MONTH(CURDATE()) AND YEAR(eb.attendance_date) = YEAR(CURDATE()) GROUP BY bt.name ORDER BY total DESC`,
  },
  {
    question: 'top bonus earners',
    sql: `SELECT CONCAT(e.first_name,' ',e.last_name) AS employee, SUM(eb.amount) AS total_bonus FROM employee_bonuses eb JOIN employees e ON e.id = eb.emp_id GROUP BY eb.emp_id ORDER BY total_bonus DESC LIMIT 10`,
  },

  // ── Promotions ────────────────────────────────────────────────────────────
  {
    question: 'recent promotions',
    sql: `SELECT CONCAT(e.first_name,' ',e.last_name) AS employee, p.old_designation, p.new_designation, p.old_salary, p.new_salary, p.salary_increment, p.promotion_date FROM promotions p JOIN employees e ON e.id = p.employee_id WHERE p.status = 'approved' ORDER BY p.promotion_date DESC LIMIT 10`,
  },
  {
    question: 'employees eligible for promotion',
    sql: `SELECT CONCAT(e.first_name,' ',e.last_name) AS employee, pc.promotion_title, pc.eligibility_date FROM promotion_configurations pc JOIN employees e ON e.department_id = pc.department_id OR e.group_id = pc.employee_group_id OR e.id = pc.employee_id WHERE pc.is_active = 1 AND pc.eligibility_date <= CURDATE() AND e.is_active = 1`,
  },

  // ── Assets ────────────────────────────────────────────────────────────────
  {
    question: 'assets currently issued to employees',
    sql: `SELECT CONCAT(e.first_name,' ',e.last_name) AS employee, a.name AS asset_name, eha.issued_date FROM employee_has_assets eha JOIN employees e ON e.id = eha.employee_id JOIN assets a ON a.id = eha.asset_id WHERE eha.is_active = 1 AND eha.return_date IS NULL ORDER BY eha.issued_date DESC`,
  },
  {
    question: 'how many assets are currently issued',
    sql: `SELECT COUNT(*) AS issued_count FROM employee_has_assets WHERE is_active = 1 AND return_date IS NULL`,
  },

  // ── Notices ───────────────────────────────────────────────────────────────
  {
    question: 'recent notices published',
    sql: `SELECT title, target_audience, published_at FROM notices WHERE is_active = 1 ORDER BY published_at DESC LIMIT 10`,
  },
  {
    question: 'unread notices for employees',
    sql: `SELECT n.title, COUNT(ne.id) AS unread_count FROM notices n JOIN notices_employees ne ON ne.notice_id = n.id WHERE ne.is_read = 0 AND n.is_active = 1 GROUP BY n.id ORDER BY unread_count DESC`,
  },

  // ── Leave management (more) ─────────────────────────────────────────────────
  {
    question: 'rejected leave requests',
    sql: `SELECT lr.custom_id, CONCAT(e.first_name,' ',e.last_name) AS employee, lr.leave_type_name, lr.start_date, lr.end_date, lr.hr_remarks FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id WHERE lr.final_status = 'rejected' ORDER BY lr.hr_action_at DESC LIMIT 20`,
  },
  {
    question: 'approved leave requests this month',
    sql: `SELECT lr.custom_id, CONCAT(e.first_name,' ',e.last_name) AS employee, lr.leave_type_name, lr.start_date, lr.end_date FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id WHERE lr.final_status = 'approved' AND MONTH(lr.start_date) = MONTH(CURDATE()) AND YEAR(lr.start_date) = YEAR(CURDATE()) ORDER BY lr.start_date`,
  },
  {
    question: 'leave requests for employee shihab',
    sql: `SELECT lr.custom_id, lr.leave_type_name, lr.start_date, lr.end_date, lr.final_status FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id WHERE LOWER(e.first_name) LIKE '%shihab%' OR LOWER(e.last_name) LIKE '%shihab%' OR LOWER(CONCAT(e.first_name,' ',e.last_name)) LIKE '%shihab%' ORDER BY lr.start_date DESC`,
  },
  {
    question: 'upcoming leave this week',
    sql: `SELECT CONCAT(e.first_name,' ',e.last_name) AS employee, lr.leave_type_name, lr.start_date, lr.end_date FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id WHERE lr.final_status = 'approved' AND lr.start_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY) ORDER BY lr.start_date`,
  },
  {
    question: 'leave breakdown by type this year',
    sql: `SELECT lr.leave_type_name, COUNT(*) AS request_count FROM leave_requests lr WHERE lr.final_status = 'approved' AND YEAR(lr.start_date) = YEAR(CURDATE()) GROUP BY lr.leave_type_name ORDER BY request_count DESC`,
  },
  {
    question: 'list of leave types',
    sql: `SELECT id, name, days, description FROM leave_types ORDER BY name`,
  },
  {
    question: 'pending holiday swap requests',
    sql: `SELECT CONCAT(e.first_name,' ',e.last_name) AS employee, ehs.original_holiday_date, ehs.swapped_holiday_date, ehs.reason FROM employee_holiday_swaps ehs JOIN employees e ON e.id = ehs.employee_id WHERE ehs.status = 'pending' AND ehs.is_active = 1`,
  },
  {
    question: 'upcoming holidays',
    sql: `SELECT title, start_date, end_date, is_recurring FROM holidays WHERE start_date >= CURDATE() ORDER BY start_date LIMIT 10`,
  },

  // ── Payroll (more) ───────────────────────────────────────────────────────────
  {
    question: 'salary details for shihab',
    sql: `SELECT es.title, es.total_salary, es.basic, es.house_rent, es.medical_allowance, es.transport_allowance, es.other_allowance FROM employee_salaries es JOIN employees e ON e.id = es.employee_id WHERE LOWER(e.first_name) LIKE '%shihab%' OR LOWER(e.last_name) LIKE '%shihab%' OR LOWER(CONCAT(e.first_name,' ',e.last_name)) LIKE '%shihab%'`,
  },
  {
    question: 'total overtime pay this month',
    sql: `SELECT SUM(overtime) AS total_overtime_pay, COUNT(*) AS employee_count FROM payrolls WHERE month = MONTH(CURDATE()) AND year = YEAR(CURDATE()) AND is_active = 1 AND overtime > 0`,
  },
  {
    question: 'payroll history summary',
    sql: `SELECT ph.start_date, ph.end_date, ph.total_employees, ph.total_salary, ph.total_deductions, ph.total_bonuses FROM payroll_histories ph WHERE ph.is_active = 1 ORDER BY ph.end_date DESC LIMIT 10`,
  },
  {
    question: 'employees with pending loans deducted this month',
    sql: `SELECT CONCAT(e.first_name,' ',e.last_name) AS employee, p.loans FROM payrolls p JOIN employees e ON e.id = p.employee_id WHERE p.month = MONTH(CURDATE()) AND p.year = YEAR(CURDATE()) AND p.is_active = 1 AND p.loans > 0 ORDER BY p.loans DESC`,
  },
  {
    question: 'lowest paid employees this month',
    sql: `SELECT CONCAT(e.first_name,' ',e.last_name) AS name, p.net_salary FROM payrolls p JOIN employees e ON e.id = p.employee_id WHERE p.month = MONTH(CURDATE()) AND p.year = YEAR(CURDATE()) AND p.is_active = 1 ORDER BY p.net_salary ASC LIMIT 10`,
  },

  // ── Bonuses (more) ───────────────────────────────────────────────────────────
  {
    question: 'bonus breakdown by department this month',
    sql: `SELECT d.name AS department, COUNT(*) AS count, SUM(eb.amount) AS total FROM employee_bonuses eb JOIN departments d ON d.id = eb.department_id WHERE MONTH(eb.attendance_date) = MONTH(CURDATE()) AND YEAR(eb.attendance_date) = YEAR(CURDATE()) GROUP BY d.name ORDER BY total DESC`,
  },
  {
    question: 'total bonus for employee shihab',
    sql: `SELECT CONCAT(e.first_name,' ',e.last_name) AS name, SUM(eb.amount) AS total_bonus FROM employee_bonuses eb JOIN employees e ON e.id = eb.emp_id WHERE LOWER(e.first_name) LIKE '%shihab%' OR LOWER(e.last_name) LIKE '%shihab%' OR LOWER(CONCAT(e.first_name,' ',e.last_name)) LIKE '%shihab%' GROUP BY eb.emp_id`,
  },

  // ── Promotions (more) ────────────────────────────────────────────────────────
  {
    question: 'rejected promotions',
    sql: `SELECT CONCAT(e.first_name,' ',e.last_name) AS employee, p.old_designation, p.new_designation, p.note FROM promotions p JOIN employees e ON e.id = p.employee_id WHERE p.status = 'rejected' ORDER BY p.promotion_date DESC LIMIT 20`,
  },
  {
    question: 'promotion history for shihab',
    sql: `SELECT p.old_designation, p.new_designation, p.old_salary, p.new_salary, p.salary_increment, p.promotion_date, p.status FROM promotions p JOIN employees e ON e.id = p.employee_id WHERE LOWER(e.first_name) LIKE '%shihab%' OR LOWER(e.last_name) LIKE '%shihab%' OR LOWER(CONCAT(e.first_name,' ',e.last_name)) LIKE '%shihab%' ORDER BY p.promotion_date DESC`,
  },

  // ── Assets (more) ─────────────────────────────────────────────────────────────
  {
    question: 'assets assigned to employee shihab',
    sql: `SELECT a.name AS asset_name, eha.issued_date, eha.return_date FROM employee_has_assets eha JOIN employees e ON e.id = eha.employee_id JOIN assets a ON a.id = eha.asset_id WHERE (LOWER(e.first_name) LIKE '%shihab%' OR LOWER(e.last_name) LIKE '%shihab%' OR LOWER(CONCAT(e.first_name,' ',e.last_name)) LIKE '%shihab%') AND eha.is_active = 1`,
  },
  {
    question: 'list of asset groups',
    sql: `SELECT id, name, is_active FROM asset_groups ORDER BY name`,
  },
  {
    question: 'returned assets this month',
    sql: `SELECT CONCAT(e.first_name,' ',e.last_name) AS employee, a.name AS asset_name, eha.return_date FROM employee_has_assets eha JOIN employees e ON e.id = eha.employee_id JOIN assets a ON a.id = eha.asset_id WHERE eha.return_date IS NOT NULL AND MONTH(eha.return_date) = MONTH(CURDATE()) AND YEAR(eha.return_date) = YEAR(CURDATE())`,
  },

  // ── Blacklist (more) ─────────────────────────────────────────────────────────
  {
    question: 'blacklist reasons breakdown',
    sql: `SELECT reason, COUNT(*) AS count FROM employee_blacklists WHERE is_active = 1 AND status = 1 GROUP BY reason ORDER BY count DESC`,
  },

  // ── Notices (more) ───────────────────────────────────────────────────────────
  {
    question: 'notices for department production',
    sql: `SELECT n.title, n.published_at FROM notices n JOIN notices_departments nd ON nd.notice_id = n.id JOIN departments d ON d.id = nd.department_id WHERE n.is_active = 1 AND LOWER(d.name) LIKE '%production%' ORDER BY n.published_at DESC`,
  },
  {
    question: 'unacknowledged notices',
    sql: `SELECT n.title, COUNT(ne.id) AS unacknowledged_count FROM notices n JOIN notices_employees ne ON ne.notice_id = n.id WHERE ne.is_acknowledged = 0 AND n.is_active = 1 GROUP BY n.id ORDER BY unacknowledged_count DESC`,
  },

  // ── Organization / employee profile (more) ──────────────────────────────────
  {
    question: 'list of departments',
    sql: `SELECT id, name, is_active FROM departments ORDER BY name`,
  },
  {
    question: 'list of designations',
    sql: `SELECT id, name, is_active FROM designations ORDER BY name`,
  },
  {
    question: 'list of employee types',
    sql: `SELECT id, name, is_active, is_officer_staff FROM employee_types ORDER BY name`,
  },
  {
    question: 'list of employee sections',
    sql: `SELECT id, name, is_active FROM employee_sections ORDER BY name`,
  },
  {
    question: 'who are the supervisors',
    sql: `SELECT CONCAT(first_name,' ',last_name) AS employee, employee_no, department, designation FROM employees WHERE is_supervisor = 1 AND is_active = 1 ORDER BY first_name`,
  },
  {
    question: 'employees reporting to a supervisor named shihab',
    sql: `SELECT CONCAT(e.first_name,' ',e.last_name) AS employee, e.employee_no FROM employees e JOIN employees s ON s.id = e.supervisor_id WHERE (LOWER(s.first_name) LIKE '%shihab%' OR LOWER(s.last_name) LIKE '%shihab%' OR LOWER(CONCAT(s.first_name,' ',s.last_name)) LIKE '%shihab%') AND e.is_active = 1`,
  },
  {
    question: 'gender breakdown of employees',
    sql: `SELECT gender, COUNT(*) AS count FROM employees WHERE is_active = 1 GROUP BY gender`,
  },
  {
    question: 'marital status breakdown of employees',
    sql: `SELECT marital_status, COUNT(*) AS count FROM employees WHERE is_active = 1 GROUP BY marital_status`,
  },
  {
    question: 'blood group breakdown of employees',
    sql: `SELECT blood_group, COUNT(*) AS count FROM employees WHERE is_active = 1 AND blood_group IS NOT NULL AND blood_group != '' GROUP BY blood_group ORDER BY count DESC`,
  },
  {
    question: 'employees with birthday this month',
    sql: `SELECT CONCAT(first_name,' ',last_name) AS employee, employee_no, date_of_birth FROM employees WHERE is_active = 1 AND MONTH(date_of_birth) = MONTH(CURDATE()) ORDER BY DAY(date_of_birth)`,
  },
  {
    question: 'employees with work anniversary this month',
    sql: `SELECT CONCAT(first_name,' ',last_name) AS employee, employee_no, joining_date, TIMESTAMPDIFF(YEAR, joining_date, CURDATE()) AS years_of_service FROM employees WHERE is_active = 1 AND MONTH(joining_date) = MONTH(CURDATE()) ORDER BY DAY(joining_date)`,
  },
  {
    question: 'employees referred by shihab',
    sql: `SELECT CONCAT(e.first_name,' ',e.last_name) AS employee, e.employee_no FROM employees e WHERE e.is_active = 1 AND (LOWER(e.referred_by) LIKE '%shihab%')`,
  },
  {
    question: 'employees on fixed shift',
    sql: `SELECT CONCAT(first_name,' ',last_name) AS employee, employee_no FROM employees WHERE is_active = 1 AND is_shift_fixed = 1`,
  },
];

async function main(): Promise<void> {
  const qdrant = new LangchainQdrantService();
  let done = 0;

  for (const pair of SEED_PAIRS) {
    try {
      await qdrant.upsertTrained(pair.question, { sql: pair.sql });
      done++;
      console.log(`[${done}/${SEED_PAIRS.length}] trained: "${pair.question}"`);
    } catch (err: any) {
      console.error(`Failed to seed "${pair.question}":`, err?.message ?? err);
    }
  }

  console.log(`Done — seeded ${done}/${SEED_PAIRS.length} HR question/SQL pairs into Qdrant.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

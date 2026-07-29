/**
 * Reviews `langchain_failed_queries` (questions the assistant couldn't answer or
 * answered wrong — see LangchainQdrantService.recordFailedQuery) and, for the ones
 * with a known-correct fix below, upserts the correct SQL into `langchain_trained_queries`
 * and removes them from the failed set. Questions with no fix are left in place and
 * logged for manual review.
 *
 * Run: npm run train:retrain-failed   (from node-server/)
 */
import { LangchainQdrantService } from '@module/langchain/langchain.qdrant';

interface Fix {
  match: RegExp;
  sql: string;
}

// Canonical fixes for recurring failed-question patterns, per langchain.context.ts's
// attendance rules: always query attendance_logs (not employees) for attendance counts,
// status = 'VALID' counts as present.
const FIXES: Fix[] = [
  {
    match: /^\s*(today\s+)?total\s+attendance(\s+today)?\??\s*$/i,
    sql: `SELECT COUNT(DISTINCT al.employee_id) AS total_attendance FROM attendance_logs al WHERE al.attendance_date = CURDATE() AND al.status = 'VALID'`,
  },
  {
    match: /^\s*total\s+late(\s+employees)?(\s+today)?\??\s*$/i,
    sql: `SELECT COUNT(DISTINCT al.employee_id) AS total_late_employees FROM attendance_logs al JOIN employee_shifts es ON es.id = al.shift_id WHERE al.attendance_date = CURDATE() AND al.status = 'VALID' AND TIME(al.check_in_time) > es.start_time`,
  },
  {
    match: /who\s+(attended|came|arrived).{0,15}late/i,
    sql: `SELECT CONCAT(e.first_name,' ',e.last_name) AS employee, e.employee_no, es.name AS shift_name, es.start_time AS shift_start, al.check_in_time FROM attendance_logs al JOIN employees e ON e.id = al.employee_id JOIN employee_shifts es ON es.id = al.shift_id WHERE al.attendance_date = CURDATE() AND al.status = 'VALID' AND TIME(al.check_in_time) > es.start_time`,
  },
  {
    match: /what.{0,10}(his|her|their|its)\s+name\??\s*$/i,
    sql: `SELECT CONCAT(e.first_name,' ',e.last_name) AS employee_name, e.employee_no FROM attendance_logs al JOIN employees e ON e.id = al.employee_id JOIN employee_shifts es ON es.id = al.shift_id WHERE al.attendance_date = CURDATE() AND al.status = 'VALID' AND TIME(al.check_in_time) > es.start_time`,
  },
];

async function main() {
  const qdrant = new LangchainQdrantService();
  const failed = await qdrant.listFailedQueries();

  if (!failed.length) {
    console.log('No failed queries recorded.');
    return;
  }

  let fixedCount = 0;
  const unresolved: string[] = [];

  for (const entry of failed) {
    const fix = FIXES.find((f) => f.match.test(entry.question));
    if (!fix) {
      unresolved.push(entry.question);
      continue;
    }
    await qdrant.upsertTrained(entry.question, { sql: fix.sql }, undefined, `auto-retrained from failed query (${entry.reason})`);
    await qdrant.deleteFailedQuery(entry.question);
    fixedCount += 1;
    console.log(`Trained + cleared: "${entry.question}"`);
  }

  console.log(`\nDone. ${fixedCount} trained, ${unresolved.length} still unresolved.`);
  if (unresolved.length) {
    console.log('Unresolved (needs a manual fix added to FIXES, or is not a real question):');
    unresolved.forEach((q) => console.log(`  - "${q}"`));
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

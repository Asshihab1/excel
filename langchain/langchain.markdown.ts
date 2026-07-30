import moment from 'moment';

// serializeRows()/serializeBigInt() turn every Date into a raw ISO string
// (e.g. "2026-07-28T00:00:00.000Z") before rows ever get here — shown as-is
// that's unreadable noise in a chat answer. Detect it and format with moment:
// midnight-UTC (the time component MySQL DATE columns always serialize as)
// renders as a plain date, anything with a real time-of-day keeps it.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function formatDateString(value: string): string {
  const isMidnight = /T00:00:00(\.0+)?Z$/.test(value);
  return moment(value).format(isMidnight ? 'MMM D, YYYY' : 'MMM D, YYYY h:mm A');
}

// A raw `(value ?? '').toString()` on a nested relation object (e.g. HR
// tools' `employees: {first_name, last_name}` or `holiday_types: {name}`)
// stringifies to the literal, useless "[object Object]". Prefer a natural
// display field when the shape is recognizable, otherwise flatten to
// "key: value" pairs rather than showing raw object noise.
export function formatCell(value: any): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' && ISO_DATE_RE.test(value)) return formatDateString(value);
  // `typeof value !== 'object'` is also true for 'function' — a raw function
  // reference (e.g. a Decimal-like instance whose numeric fields were never
  // unwrapped upstream, or any other unserialized value) must never fall into
  // the plain String(value) branch below: String() on a function returns its
  // full source text, which showed up verbatim as unreadable minified code in
  // a table cell. Prisma Decimal instances specifically expose .toNumber() —
  // unwrap those before the generic object-flattening branches run.
  if (typeof value === 'function') return '';
  if (typeof value === 'object' && typeof value.toNumber === 'function') return String(value.toNumber());
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return value.map(formatCell).join(', ');
  if ('name' in value) return String(value.name ?? '');
  if ('first_name' in value || 'last_name' in value) {
    return [value.first_name, value.last_name].filter(Boolean).join(' ');
  }
  return Object.entries(value)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
}

export function toMarkdownTable(rows: any[]): string {
  if (!rows.length) return '';
  const keys = Object.keys(rows[0]);
  const header = `| # | ${keys.join(' | ')} |`;
  const sep = `| --- | ${keys.map(() => '---').join(' | ')} |`;
  const body = rows
    .map((r, i) => `| ${i + 1} | ${keys.map((k) => formatCell(r[k]).replace(/\|/g, '\\|')).join(' | ')} |`)
    .join('\n');
  return `${header}\n${sep}\n${body}`;
}

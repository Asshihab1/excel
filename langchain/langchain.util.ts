// Prisma returns BigInt for unsigned-bigint columns (ids, fk's) and Decimal
// objects for money columns — neither is JSON-serializable as-is, so every
// tool result (HR or Store) is run through this before it reaches the
// LLM/HTTP layer. Shared by hr.tools.ts and store.tools.ts.
export function serializeBigInt(value: any): any {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serializeBigInt);
  if (typeof value === 'object') {
    if (typeof value.toNumber === 'function') return value.toNumber(); // Prisma Decimal
    const out: Record<string, any> = {};
    for (const key of Object.keys(value)) out[key] = serializeBigInt(value[key]);
    return out;
  }
  return value;
}

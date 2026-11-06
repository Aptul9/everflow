export function utc(stamp: string = new Date().toISOString()): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(stamp);
  if (!match) throw new RangeError(`Invalid aware timestamp: ${stamp}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!
    || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) {
    throw new RangeError(`Invalid timestamp: ${stamp}`);
  }
  // Date handles timezone arithmetic at whole seconds. Keep the original fraction outside its millisecond precision.
  const instant = new Date(stamp.replace(/\.\d+(?=Z|[+-])/, ''));
  if (!Number.isFinite(instant.getTime())) throw new RangeError(`Invalid timestamp: ${stamp}`);
  const iso = instant.toISOString();
  if (iso.length !== 24) throw new RangeError(`Timestamp outside supported UTC year range: ${stamp}`);
  return iso.replace('.000Z', `.${(match[7] ?? '').padEnd(6, '0')}Z`);
}

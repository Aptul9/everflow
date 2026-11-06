import { expect, test } from 'vitest';
import { utc } from '../src/dispatcher/time.ts';

test.each([
  ['2026-11-06T00:00:00Z', '2026-11-06T00:00:00.000000Z'],
  ['2026-11-06T02:00:00.123456+02:00', '2026-11-06T00:00:00.123456Z'],
  ['2026-11-05T23:00:00.123-01:00', '2026-11-06T00:00:00.123000Z'],
  ['2024-02-29T00:00:00Z', '2024-02-29T00:00:00.000000Z'],
])('normalizes %s to one UTC microsecond representation without truncation', (value, expected) => {
  expect(utc(value)).toBe(expected);
});

test.each([
  'not-a-date', '2026-11-06T00:00:00', '2026-02-29T00:00:00Z', '2026-11-31T00:00:00Z',
  '2026-11-06T24:00:00Z', '2026-11-06T00:00:60Z', '2026-11-06T00:00:00+24:00',
  '2026-11-06T00:00:00.1234567Z',
])('refuses invalid or naive timestamp %s', (value) => {
  expect(() => utc(value)).toThrow(/timestamp/i);
});

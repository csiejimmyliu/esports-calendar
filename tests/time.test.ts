import { describe, expect, it } from 'vitest';
import { addDays, fixedClock, formatInZone, normalizeToUtcIso, parseUtcInstant, TimestampError } from '../src/core/time.js';

describe('parseUtcInstant', () => {
  it('accepts an explicit Z', () => {
    expect(parseUtcInstant('2026-08-09T08:00:00Z', 'test')).toBe(Date.UTC(2026, 7, 9, 8, 0, 0));
  });

  it('accepts an explicit numeric offset', () => {
    expect(parseUtcInstant('2026-08-09T16:00:00+08:00', 'test')).toBe(Date.UTC(2026, 7, 9, 8, 0, 0));
  });

  it('refuses a timestamp with no zone marker instead of guessing', () => {
    // BLAST's tournament.startDate looks exactly like this, in the same object as a Z-suffixed
    // scheduledAt. Date.parse would read it in the host's local zone: right in CI, hours wrong
    // on a laptop in Taipei, and silent either way.
    expect(() => parseUtcInstant('2026-07-21T12:00:00', 'tournament.startDate')).toThrow(TimestampError);
  });

  it('normalizes to a canonical Z form', () => {
    expect(normalizeToUtcIso('2026-08-09T16:00:00.000+08:00', 'test')).toBe('2026-08-09T08:00:00Z');
  });
});

describe('formatInZone', () => {
  it('renders 08:00Z as 16:00 in Asia/Taipei', () => {
    expect(formatInZone('2026-08-09T08:00:00Z', 'Asia/Taipei')).toEqual({
      date: '2026-08-09',
      time: '16:00',
      weekday: 'Sun',
    });
  });

  it('rolls the date forward when the offset crosses midnight', () => {
    // 2026-08-09T17:00Z is already the 10th in Taipei. Storing UTC and converting at render is
    // the whole point of NFR-7; this is the case that proves it is actually happening.
    expect(formatInZone('2026-08-09T17:00:00Z', 'Asia/Taipei')).toEqual({
      date: '2026-08-10',
      time: '01:00',
      weekday: 'Mon',
    });
  });

  it('renders the same instant differently per zone', () => {
    expect(formatInZone('2026-08-09T08:00:00Z', 'America/Los_Angeles').time).toBe('01:00');
  });
});

describe('fixedClock', () => {
  it('returns the same instant every call', () => {
    const clock = fixedClock('2026-08-09T00:00:00Z');
    expect(clock.now().toISOString()).toBe('2026-08-09T00:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-08-09T00:00:00.000Z');
  });

  it('hands out a fresh Date so a caller cannot mutate the clock', () => {
    const clock = fixedClock('2026-08-09T00:00:00Z');
    clock.now().setFullYear(1999);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });
});

describe('addDays', () => {
  it('adds whole days in UTC', () => {
    expect(addDays(new Date('2026-08-09T00:00:00Z'), 7).toISOString()).toBe('2026-08-16T00:00:00.000Z');
  });
});

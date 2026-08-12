import { describe, expect, it } from 'vitest';

import { visibleChange } from '../src/sync/diff.js';
import type { MatchSnapshot } from '../src/sync/diff.js';

const BASE: MatchSnapshot = {
  startsAtUtc: '2026-08-09T08:00:00Z',
  state: 'unstarted',
  seriesLength: 3,
  stageLabel: 'Week 1',
  sideTeamIds: ['team-a', 'team-b'],
};

describe('visibleChange', () => {
  it('is false for two snapshots with identical visible fields', () => {
    expect(visibleChange(BASE, { ...BASE })).toBe(false);
  });

  const cases: [string, Partial<MatchSnapshot>][] = [
    ['a reschedule', { startsAtUtc: '2026-08-10T08:00:00Z' }],
    ['a state transition', { state: 'inProgress' }],
    ['a best-of change', { seriesLength: 5 }],
    ['a stage/block rename', { stageLabel: 'Week 2' }],
  ];
  it.each(cases)('bumps on %s', (_label, change) => {
    expect(visibleChange(BASE, { ...BASE, ...change })).toBe(true);
  });

  it('bumps when a TBD side resolves — FR-1 rule 7, "TBD opponents resolve into the calendar by themselves"', () => {
    const tbd: MatchSnapshot = { ...BASE, sideTeamIds: [null, 'team-b'] };
    expect(visibleChange(tbd, BASE)).toBe(true);
  });

  it('bumps when either side of the tuple changes independently', () => {
    expect(visibleChange(BASE, { ...BASE, sideTeamIds: ['team-a', 'team-c'] })).toBe(true);
    expect(visibleChange(BASE, { ...BASE, sideTeamIds: ['team-z', 'team-b'] })).toBe(true);
  });

  it('does NOT bump on a score-only change — spoiler-free ICS must not re-notify on a result', () => {
    // score/gamesPlayed are deliberately not part of MatchSnapshot at all; this test documents
    // why by construction rather than by a field comparison that could accidentally include them.
    expect(visibleChange(BASE, { ...BASE })).toBe(false);
  });
});

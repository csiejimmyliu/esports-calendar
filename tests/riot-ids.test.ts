import { describe, expect, it } from 'vitest';
import { splitRiotTeamId } from '../src/sources/riot/ids.js';

/**
 * The three cases that matter, each named after the failure it prevents.
 * See docs/sources/lolesports.md and lolesports-rest.md.
 */
describe('splitRiotTeamId', () => {
  it('splits a GraphQL composite id and keeps the team half', () => {
    // Confirmed by two endpoints agreeing: REST getEventDetails returns the suffix alone.
    expect(splitRiotTeamId('116566854547835328:99566404850008779')).toEqual({
      kind: 'team',
      teamId: '99566404850008779',
    });
  });

  it('reports the ":0" TBD sentinel as TBD, not as a team whose id is "0"', () => {
    // Treating "0" as a team id collapses every undecided opponent into one shared phantom team.
    expect(splitRiotTeamId('117047583684384478:0')).toEqual({ kind: 'tbd' });
  });

  it('passes a plain REST id through unchanged', () => {
    // Every REST endpoint, LoL and VALORANT alike, returns this form.
    expect(splitRiotTeamId('99566404850008779')).toEqual({
      kind: 'team',
      teamId: '99566404850008779',
    });
  });

  it('reports an id with more than one colon as unknown rather than guessing a segment', () => {
    const result = splitRiotTeamId('a:b:c');
    expect(result).toEqual({ kind: 'unknown', raw: 'a:b:c' });
  });

  it('reports an empty team segment as unknown', () => {
    expect(splitRiotTeamId('12345:')).toEqual({ kind: 'unknown', raw: '12345:' });
  });
});

/**
 * Source registry: a plain map from adapter id to its `game`/`source` registry rows.
 *
 * Deliberately a plain map, not filesystem discovery — an adapter appearing in the runtime by
 * being copied into a directory is the opposite of what NFR-3/source isolation wants. Adding a
 * source is a code change here, on purpose.
 *
 * This module is descriptive only: it does not construct adapters or transports. Constructing a
 * `riot-rest-lol` adapter needs a transport (fixture or live) and a `LeagueConfig`, both of which
 * are the CLI's concern (src/cli/sync.ts), matching how src/cli/next-matches.ts already builds
 * one. What lives here is only what `db/queries/registry.ts` needs to seed `game` and `source`.
 */

import { RIOT_REST_BASE } from '../sources/riot/rest/client.js';

export interface SourceRegistryEntry {
  id: string;
  game: { id: string; slug: string; name: string };
  source: { id: string; slug: string; name: string; organizer: string; baseUrl: string };
}

export const SOURCE_REGISTRY: readonly SourceRegistryEntry[] = [
  {
    id: 'riot-rest-lol',
    game: { id: 'lol', slug: 'lol', name: 'League of Legends' },
    source: {
      id: 'riot-rest-lol',
      slug: 'riot-rest-lol',
      name: 'Riot REST (LoL)',
      organizer: 'Riot Games',
      baseUrl: RIOT_REST_BASE,
    },
  },
];

export function findSource(id: string): SourceRegistryEntry {
  const entry = SOURCE_REGISTRY.find((e) => e.id === id);
  if (entry === undefined) {
    throw new Error(
      `unknown source id ${JSON.stringify(id)}; registered: ${SOURCE_REGISTRY.map((e) => e.id).join(', ')}`,
    );
  }
  return entry;
}

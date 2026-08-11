/**
 * Riot serves most of its images over plain http, which is blocked as mixed content on an https
 * page. Rewritten at the adapter boundary rather than at render, so every consumer — web, ICS,
 * iOS — gets the same URL.
 *
 * This applies to getTeams as much as to getSchedule. The getTeams asset is usually the better and
 * newer one and is preferred for that reason, but it is *not* more secure: 153 of the 168 narrowed
 * rows are http, and 1358 of all 1568. An earlier assumption that getTeams solved mixed content was
 * wrong. (Counts measured against the full 1568-row capture, committed at
 * fixtures/riot-lol/rest_getTeams_full.json — see tests/team-index-collisions.test.ts. In the
 * trimmed 71-row fixture it is 47 of 47.)
 *
 * Never warned per item: it is nearly every image in every response, and hundreds of identical
 * warnings would bury the one that matters.
 */
export function toHttps(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.startsWith('http://') ? `https://${url.slice('http://'.length)}` : url;
}

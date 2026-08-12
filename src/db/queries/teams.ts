import type { PoolClient } from 'pg';

export interface TeamFields {
  name: string;
  code: string | null;
  logoUrl: string | null;
}

export async function insertTeam(client: PoolClient, gameId: string, fields: TeamFields): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO team (game_id, name, code, image_url) VALUES ($1, $2, $3, $4) RETURNING id`,
    [gameId, fields.name, fields.code, fields.logoUrl],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('insertTeam: INSERT ... RETURNING produced no row');
  return row.id;
}

export async function updateTeamFields(client: PoolClient, teamId: string, fields: TeamFields): Promise<void> {
  await client.query(`UPDATE team SET name = $2, code = $3, image_url = $4 WHERE id = $1`, [
    teamId,
    fields.name,
    fields.code,
    fields.logoUrl,
  ]);
}

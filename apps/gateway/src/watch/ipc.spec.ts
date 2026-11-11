import { describe, expect, it } from 'vitest';
import { parseScoresMessage, parseTeamsMessage } from './ipc.js';

describe('watch child team and score lines', () => {
  it('accepts slot teams and rejects a bad one', () => {
    expect(
      parseTeamsMessage(
        JSON.stringify({
          type: 'teams',
          serverAlias: 'default',
          teams: [
            { slot: 0, team: 3 },
            { slot: 63, team: 0 },
          ],
        }),
      ),
    ).toEqual({
      type: 'teams',
      serverAlias: 'default',
      teams: [
        { slot: 0, team: 3 },
        { slot: 63, team: 0 },
      ],
    });
    expect(
      parseTeamsMessage(
        JSON.stringify({
          type: 'teams',
          serverAlias: 'default',
          teams: [],
        }),
      )?.teams,
    ).toEqual([]);
    expect(
      parseTeamsMessage(
        JSON.stringify({
          type: 'teams',
          serverAlias: 'default',
          teams: [{ slot: 64, team: 1 }],
        }),
      ),
    ).toBeUndefined();
    expect(
      parseTeamsMessage(
        JSON.stringify({
          type: 'teams',
          serverAlias: 'default',
          teams: [{ slot: 1, team: 4 }],
        }),
      ),
    ).toBeUndefined();
    expect(
      parseTeamsMessage(
        JSON.stringify({
          type: 'teams',
          serverAlias: 'default',
          teams: [{ slot: 1.5, team: 1 }],
        }),
      ),
    ).toBeUndefined();
  });

  it('accepts a map score and rejects a bad map or number', () => {
    expect(
      parseScoresMessage(
        JSON.stringify({
          type: 'scores',
          serverAlias: 'default',
          mapName: 'mp_toujane',
          axis: 3,
          allies: null,
        }),
      ),
    ).toEqual({
      type: 'scores',
      serverAlias: 'default',
      mapName: 'mp_toujane',
      axis: 3,
      allies: null,
    });
    expect(
      parseScoresMessage(
        JSON.stringify({
          type: 'scores',
          serverAlias: 'default',
          mapName: '../mp_toujane',
          axis: 1,
          allies: 1,
        }),
      ),
    ).toBeUndefined();
    expect(
      parseScoresMessage(
        JSON.stringify({
          type: 'scores',
          serverAlias: 'default',
          mapName: 'mp_toujane',
          axis: 1.5,
          allies: 1,
        }),
      ),
    ).toBeUndefined();
  });
});

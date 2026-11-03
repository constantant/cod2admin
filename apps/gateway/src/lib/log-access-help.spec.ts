import { describe, expect, it } from 'vitest';
import { logNotFoundHelp, unreadableLogHelp } from './log-access-help.js';

const HOST = { user: 'cod2admin', inContainer: false };
const CONTAINER = { user: 'cod2admin', inContainer: true };
const LOG = '/home/cod2/homedir/main/games_mp.log';

describe('unreadableLogHelp', () => {
  it('gives commands for the exact file, every folder above it, and the bot user', () => {
    const text = unreadableLogHelp([LOG], HOST);

    expect(text).toContain(
      'setfacl -m u:cod2admin:x /home /home/cod2 /home/cod2/homedir /home/cod2/homedir/main',
    );
    expect(text).toContain(`setfacl -m u:cod2admin:r ${LOG}`);
    expect(text).toContain('setfacl -d -m u:cod2admin:r /home/cod2/homedir/main');
    expect(text).toContain('/findlog again');
  });

  it("doesn't give host commands for a path inside a container", () => {
    const text = unreadableLogHelp(['/cod2-logs/games_mp.log'], CONTAINER);

    expect(text).not.toContain('setfacl');
    expect(text).toContain('chmod o+r');
    expect(text).toContain('machine that runs the container');
  });

  it('stays within a Telegram message when many files are found', () => {
    const paths = Array.from(
      { length: 200 },
      (_, i) => `/srv/servers/server-with-a-long-name-${i}/main/games_mp.log`,
    );

    const text = unreadableLogHelp(paths, HOST);

    expect(text.length).toBeLessThan(4096);
    expect(text).toContain('197 more files');
  });
});

describe('logNotFoundHelp', () => {
  it('covers an unopenable folder, Docker and another machine', () => {
    const text = logNotFoundHelp('ctf', LOG, HOST);

    expect(text).toContain('"ctf"');
    expect(text).toContain(LOG);
    expect(text).toContain('find / -name games_mp.log');
    expect(text).toContain('bind mount');
    expect(text).toContain('another machine');
  });

  it('shows how to mount the folder when the bot runs in a container', () => {
    const text = logNotFoundHelp('ctf', undefined, CONTAINER);

    expect(text).toContain('/cod2-logs:ro');
    expect(text).not.toContain('find /');
  });
});

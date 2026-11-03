import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname } from 'node:path';

const GUIDE_URL =
  'https://github.com/constantant/cod2admin/blob/main/installer/README.md#connecting-the-game-log';
const GUIDE_RU_URL =
  'https://github.com/constantant/cod2admin/blob/main/docs/game-log-access-ru.md';
/** Each file gets its own commands, and Telegram caps a message at 4096 characters. */
const MAX_FILES_WITH_COMMANDS = 3;

export interface BotRuntime {
  /** The OS user the bot runs as, the one that needs read access. */
  user: string;
  /** In a container, the paths the bot sees aren't the paths on the machine. */
  inContainer: boolean;
}

export function detectBotRuntime(): BotRuntime {
  return {
    user: userInfo().username,
    inContainer: existsSync('/.dockerenv') || existsSync('/run/.containerenv'),
  };
}

/** Every folder that has to let the bot through: `/a/b/c.log` gives `/a`, `/a/b`. */
function parentFolders(path: string): string[] {
  const folders: string[] = [];
  for (let dir = dirname(path); dir !== '/' && dir !== '.'; dir = dirname(dir)) {
    folders.unshift(dir);
  }
  return folders;
}

function accessCommands(path: string, user: string): string {
  const folders = parentFolders(path);
  return [
    ...(folders.length > 0
      ? [`setfacl -m u:${user}:x ${folders.join(' ')}`]
      : []),
    `setfacl -m u:${user}:r ${path}`,
    `setfacl -d -m u:${user}:r ${dirname(path)}`,
  ].join('\n');
}

const guideLinks = `Full guide: ${GUIDE_URL}\nПо-русски: ${GUIDE_RU_URL}`;

/** What to do about log files that exist, but that the bot's user can't read. */
export function unreadableLogHelp(
  paths: readonly string[],
  runtime: BotRuntime,
): string {
  if (runtime.inContainer) {
    return (
      `I can see this log, but I can't read it:\n${paths.join('\n')}\n\n` +
      "I run in a container, so these are paths inside it, and read-only mounts can't be changed from here. " +
      'On the machine that runs the container, find the same file and run this as root:\n\n' +
      'chmod o+r games_mp.log\n\n' +
      'Its folder, and every folder above it, also needs o+x. This lets every user on that machine read the log.\n\n' +
      `Then send /findlog again.\n\n${guideLinks}`
    );
  }

  const shown = paths.slice(0, MAX_FILES_WITH_COMMANDS);
  const blocks = shown.map(
    (path) => `${path}\n\n${accessCommands(path, runtime.user)}`,
  );
  const hidden = paths.length - shown.length;
  return (
    `I found the log, but my user (${runtime.user}) can't read it. Run this on the server as root:\n\n` +
    blocks.join('\n\n') +
    (hidden > 0 ? `\n\n(${hidden} more files found: same commands for each.)` : '') +
    '\n\nThese give access to my user only. The last line keeps it working if the server creates the file again. ' +
    'If setfacl is missing, install the acl package.\n\n' +
    `Then send /findlog again.\n\n${guideLinks}`
  );
}

/** What to do when the bot can't find any log for this server. */
export function logNotFoundHelp(
  alias: string,
  reportedPath: string | undefined,
  runtime: BotRuntime,
): string {
  const intro =
    `I couldn't find the log of "${alias}" on this machine.` +
    (reportedPath ? `\nThe server says it writes to ${reportedPath}` : '');

  const anotherMachine =
    "If the game server is on another machine, I can't read its log from here. Install the bot on that " +
    'machine to get !report cards and the app\'s chat. All other commands keep working without the log.';

  if (runtime.inContainer) {
    return (
      `${intro}\n\n` +
      'I run in a container, so I only see folders mounted into it. Mount the folder with games_mp.log ' +
      'read-only, for example in docker-compose.yml:\n\n' +
      'volumes:\n  - /path/on/host/main:/cod2-logs:ro\n\n' +
      'Recreate the container, then send /findlog again. If the game server runs in Docker too, its log ' +
      `folder has to be a bind mount, so the file exists on the machine.\n\n${anotherMachine}\n\n${guideLinks}`
    );
  }
  return (
    `${intro}\n\n` +
    "I can't search folders my user can't open. If the game server is on this machine, find the log as root:\n\n" +
    'find / -name games_mp.log 2>/dev/null\n\n' +
    'Then send /findlog <that path>, and I\'ll give you the commands to let me read it. If the game server ' +
    'runs in Docker, its log folder has to be a bind mount, so the file exists on the machine.\n\n' +
    `${anotherMachine}\n\n${guideLinks}`
  );
}

/** `2h 30m` → `2ч 30м`: a length, as the gateway and the app write it in English. */
export function ruSpan(span: string): string {
  return span
    .replace(/(\d+)d/g, '$1д')
    .replace(/(\d+)h/g, '$1ч')
    .replace(/(\d+)m/g, '$1м');
}

function ruCount(
  count: number,
  one: string,
  few: string,
  many: string,
): string {
  const tens = count % 100;
  const units = count % 10;
  if (tens >= 11 && tens <= 14) {
    return many;
  }
  return units === 1 ? one : units >= 2 && units <= 4 ? few : many;
}

const ROLES: Readonly<Record<string, string>> = {
  owner: 'владелец',
  admin: 'админ',
  moderator: 'модератор',
};
const REQUIRED: Readonly<Record<string, string>> = {
  'A map name': 'имя карты',
  'A message': 'сообщение',
  "The player's name": 'имя игрока',
};
const role = (name: string) => ROLES[name] ?? name;
const players = (count: string) =>
  `${count} ${ruCount(Number(count), 'игрок', 'игрока', 'игроков')}`;

/** English → Russian, for whole texts. English is the key (i18n.ts). */
export const RU_TEXT: Readonly<Record<string, string>> = {
  // Navigation and common words
  Home: 'Главная',
  Players: 'Игроки',
  Chat: 'Чат',
  Reports: 'Жалобы',
  More: 'Ещё',
  Maps: 'Карты',
  Bans: 'Баны',
  'Notes & watchlist': 'Заметки и наблюдение',
  Servers: 'Серверы',
  'Server settings': 'Настройки сервера',
  'VPN rules': 'Правила VPN',
  Presets: 'Шаблоны',
  Admins: 'Админы',
  'Audit log': 'Журнал действий',
  Console: 'Консоль',
  'Telegram routes': 'Маршруты до Telegram',
  'Bot update': 'Обновление бота',
  'Switch map, restart, edit the rotation': 'Смена карты, перезапуск, ротация',
  'Browse, edit, lift, add': 'Просмотр, изменение, снятие, добавление',
  'Keep an eye on a player': 'Присмотреть за игроком',
  'Every server the bot manages': 'Все серверы бота',
  'What the server reports': 'Что сообщает сервер',
  'Kick VPN players, exceptions, networks': 'Кик за VPN, исключения, сети',
  'One-tap reasons, lengths and messages':
    'Причины, сроки и сообщения в одно нажатие',
  'Who has access, and their roles': 'У кого есть доступ и какие роли',
  'Who did what': 'Кто что делал',
  'Raw RCON commands': 'Команды RCON напрямую',
  'How the bot reaches Telegram': 'Как бот подключается к Telegram',
  'Install a new version': 'Поставить новую версию',
  owner: 'владелец',
  admin: 'админ',
  moderator: 'модератор',
  OK: 'ОК',
  Cancel: 'Отмена',
  Save: 'Сохранить',
  'Saved.': 'Сохранено.',
  Add: 'Добавить',
  Edit: 'Изменить',
  Delete: 'Удалить',
  Remove: 'Убрать',
  Back: 'Назад',
  Clear: 'Сбросить',
  Reload: 'Обновить',
  Refresh: 'Обновить',
  Load: 'Загрузить',
  'Load more': 'Загрузить ещё',
  'Show more': 'Показать ещё',
  'Loading…': 'Загрузка…',
  'Try again': 'Повторить',
  Go: 'Выполнить',
  Set: 'Задать',
  'Set…': 'Задать…',
  All: 'Все',
  'just now': 'только что',
  unknown: 'неизвестно',
  from: 'от',
  by: 'выдал',
  to: 'кому:',
  ms: 'мс',
  '(you)': '(вы)',
  '(empty)': '(пусто)',

  // App shell
  'No access': 'Нет доступа',
  "Can't open the manager": 'Не удалось открыть приложение',
  'Opened outside Telegram. For local development, start the bot with MINIAPP_DEV_TELEGRAM_ID.':
    'Открыто не из Telegram. Для локальной разработки запустите бота с MINIAPP_DEV_TELEGRAM_ID.',
  Live: 'На связи',
  'Reconnecting…': 'Переподключение…',
  Server: 'Сервер',

  // Dashboard
  Online: 'В сети',
  Offline: 'Не в сети',
  offline: 'не в сети',
  'players now': 'игроков сейчас',
  map: 'карта',
  Period: 'Период',
  '24 hours': '24 часа',
  '7 days': '7 дней',
  '30 days': '30 дней',
  'All time': 'За всё время',
  'No history for this period yet. The bot checks the server once a minute and keeps 30 days.':
    'За этот период истории пока нет. Бот проверяет сервер раз в минуту и хранит данные 30 дней.',
  peak: 'пик',
  average: 'в среднем',
  uptime: 'в сети',
  Chart: 'График',
  Table: 'Таблица',
  Time: 'Время',
  'Most played': 'Чаще всего играют',
  'By time with at least one player on.':
    'По времени, когда на сервере был хотя бы один игрок.',
  'All server settings': 'Все настройки сервера',

  // Players
  players: 'игроков',
  'players ·': 'игроков ·',
  'on VPN': 'с VPN',
  Updated: 'Обновлено',
  'Name or IP': 'Имя или IP',
  'Sort by': 'Сортировка',
  Score: 'Счёт',
  Ping: 'Пинг',
  Name: 'Имя',
  'Nobody is playing right now.': 'Сейчас никто не играет.',
  'No status yet.': 'Состояния пока нет.',
  'On the watchlist': 'В списке наблюдения',
  'Has notes': 'Есть заметки',
  '· on': '· на',
  '· bot v': '· бот v',
  '· score': '· счёт',
  '· ping': '· пинг',
  '· on the watchlist': '· в списке наблюдения',
  '· has notes': '· есть заметки',
  Location: 'Откуда',
  Provider: 'Провайдер',
  Flag: 'Метка',
  '0 (none — bans use the IP)': '0 (нет, баны идут по IP)',
  Kick: 'Кик',
  'Temp ban': 'Врем. бан',
  Ban: 'Бан',
  'Ban…': 'Забанить…',
  Message: 'Сообщение',
  'History & notes': 'История и заметки',
  'Private message': 'Личное сообщение',
  Send: 'Отправить',
  Duration: 'Срок',
  'Reason (optional)': 'Причина (необязательно)',
  'Common reasons': 'Частые причины',
  Notes: 'Заметки',
  'None.': 'Нет.',
  'Add a note on': 'Заметка на',
  'their name': 'его имя',
  Watch: 'Следить',
  'Actions on this server': 'Действия на этом сервере',
  'None on record.': 'Записей нет.',
  'None on record, by this name.': 'Записей с этим именем нет.',
  Lifted: 'Снят',
  Temp: 'Временный',
  Permanent: 'Навсегда',
  permanent: 'навсегда',
  'no reason': 'без причины',
  'A permanent ban, on every server. You can lift it later from Bans.':
    'Бан навсегда, на всех серверах. Снять его можно позже в разделе «Баны».',
  'A permanent ban of their IP (they have no GUID), on every server. You can lift it later from Bans.':
    'Бан по IP навсегда (GUID у игрока нет), на всех серверах. Снять его можно позже в разделе «Баны».',

  // Chat
  'No chat feed for': 'Нет чата для сервера',
  "The bot reads chat from the server's games_mp.log, so it has to run on the game server's machine with COD2_LOG_PATH set. A bot that manages the server over RCON only can't see the chat.":
    'Бот читает чат из games_mp.log сервера, поэтому должен работать на той же машине, с настроенным путём к журналу. Бот, который управляет сервером только по RCON, чата не видит.',
  team: 'команда',
  'Nothing said yet.': 'Пока никто ничего не написал.',
  'Send to': 'Кому',
  Everyone: 'Всем',
  'Message to everyone': 'Сообщение всем',
  'Moderators can read the chat; writing to it needs the admin role.':
    'Модераторы могут читать чат; писать в него могут только админы.',
  'That player has left — pick someone else.':
    'Этот игрок вышел. Выберите другого.',

  // Reports
  'Which reports': 'Какие жалобы',
  Open: 'Открытые',
  Closed: 'Закрытые',
  'No reason given': 'Причина не указана',
  'Nobody with that name is on now.':
    'Сейчас на сервере нет игрока с таким именем.',
  Ignore: 'Игнорировать',
  'Mark handled': 'Отметить решённой',
  'No closed reports yet.': 'Закрытых жалоб пока нет.',
  'No open reports. Players file them in game with !report.':
    'Открытых жалоб нет. Игроки подают их в игре командой !report.',
  'Close this report?': 'Закрыть жалобу?',
  Handled: 'Решена',
  Ignored: 'Проигнорирована',
  handled: 'решена',
  ignored: 'проигнорирована',
  Kicked: 'Кикнут',
  Banned: 'Забанен',
  'Temp-banned': 'Временно забанен',
  'IP-banned (GUID unavailable)': 'Забанен по IP (нет GUID)',
  'IP temp-banned (GUID unavailable)': 'Временно забанен по IP (нет GUID)',
  'Ignored.': 'Проигнорировано.',
  'Marked as handled.': 'Отмечено как решённая.',

  // Notes
  'Name, IP, GUID or text': 'Имя, IP, GUID или текст',
  'Watchlist only': 'Только список наблюдения',
  'Stop watching': 'Перестать следить',
  'No notes match.': 'Заметок не найдено.',
  'No notes yet. Add one here, or from a player.':
    'Заметок пока нет. Добавьте здесь или в карточке игрока.',
  'Add a note': 'Новая заметка',
  About: 'О ком',
  'A name': 'Имя',
  'An IP': 'IP',
  'A GUID': 'GUID',
  'Names can be taken by anyone; an IP or GUID is more certain.':
    'Имя может взять кто угодно; IP или GUID надёжнее.',
  'Name, IP or GUID': 'Имя, IP или GUID',
  Note: 'Заметка',
  'Put on the watchlist': 'В список наблюдения',
  'Note added.': 'Заметка добавлена.',
  'Edit note': 'Изменить заметку',
  'Delete this note?': 'Удалить заметку?',
  'Note deleted.': 'Заметка удалена.',

  // Maps
  'Now playing': 'Сейчас идёт',
  'Next map': 'Следующая карта',
  'Restart map': 'Перезапустить карту',
  'Restart round': 'Перезапустить раунд',
  Mode: 'Режим',
  'Game mode': 'Режим игры',
  'Find a map': 'Найти карту',
  '— load in': '— запустить в режиме',
  "custom map — you'll be asked to confirm.":
    'нестандартная карта: приложение попросит подтвердить.',
  'From the rotation': 'Из ротации',
  '— map and mode as configured': '— карта и режим как в настройках',
  'The server lists no maps.': 'Сервер не показывает список карт.',
  'Restart the map?': 'Перезапустить карту?',
  'Reloads the current map. Scores start over.':
    'Текущая карта загрузится заново. Счёт обнулится.',
  'Restart the round?': 'Перезапустить раунд?',
  'A quick restart, without reloading the level. Scores start over.':
    'Быстрый перезапуск без загрузки уровня. Счёт обнулится.',
  'Go to the next map?': 'Перейти к следующей карте?',
  'Ends this map and moves on in the rotation.':
    'Текущая карта закончится, начнётся следующая из ротации.',
  Restart: 'Перезапустить',
  Switch: 'Сменить',
  'The current round ends and everyone loads the new map.':
    'Текущий раунд закончится, и все загрузят новую карту.',
  "It's not a standard CoD2 map: players who don't have it may be dropped unless the server offers downloads.":
    'Это нестандартная карта CoD2: игроков без неё может выкинуть, если сервер не раздаёт файлы.',
  'Map rotation': 'Ротация карт',
  "Lasts until the server restarts: to keep it, put it in the server's config too.":
    'Действует до перезапуска сервера. Чтобы сохранить, пропишите её и в конфиге сервера.',
  'Move up': 'Выше',
  'Move down': 'Ниже',
  Map: 'Карта',
  "Rotation saved. It lasts until the server restarts: to keep it, put it in the server's config too.":
    'Ротация сохранена. Она действует до перезапуска сервера: чтобы сохранить, пропишите её и в конфиге сервера.',

  // Bans
  'Ban type': 'Тип бана',
  'IP bans': 'Баны по IP',
  'GUID bans': 'Баны по GUID',
  'Show lifted': 'Показывать снятые',
  'Name, IP or reason': 'Имя, IP или причина',
  Mute: 'Заглушить',
  Unmute: 'Снять',
  'Muted players': 'Заглушённые игроки',
  'A warning, then kicks for chatting':
    'За сообщения в чате: предупреждение, затем кик',
  'Until lifted': 'Пока не снимут',
  'No muted players.': 'Заглушённых игроков нет.',
  "The game can't block chat, so their messages still appear. The first gets them a private warning, each one after that a kick. Applies on every server whose chat the bot can read.":
    'Игра не умеет блокировать чат, поэтому сообщения игрока всё равно появятся. За первое он получит личное предупреждение, за каждое следующее — кик. Действует на всех серверах, чат которых бот может читать.',
  'Name or GUID': 'Имя или GUID',
  'Most players have no GUID (GUID 0), so most bans are IP bans.':
    'У большинства игроков нет GUID (GUID 0), поэтому почти все баны идут по IP.',
  selected: 'выбрано',
  Unban: 'Разбанить',
  Actions: 'Действия',
  'Edit reason or expiry': 'Изменить причину или срок',
  'No bans.': 'Банов нет.',
  'Add a ban': 'Добавить бан',
  'Edit ban': 'Изменить бан',
  Reason: 'Причина',
  Expiry: 'Срок',
  Keep: 'Не менять',
  'from now': 'с этого момента',
  'By IP': 'По IP',
  'By GUID': 'По GUID',
  'IP address': 'IP-адрес',
  'Player name': 'Имя игрока',
  Length: 'Срок',
  'Applies on every server. Someone online now is kicked within seconds.':
    'Действует на всех серверах. Если игрок сейчас на сервере, его кикнет через несколько секунд.',
  'Ban updated.': 'Бан изменён.',
  'Unbanned.': 'Разбанен.',
  'Lifts every ban on these GUIDs/IPs, on all servers.':
    'Снимет все баны этих GUID и IP на всех серверах.',

  // Console, settings
  'Run again': 'Повторить',
  Run: 'Выполнить',
  '(no output)': '(нет вывода)',
  'RCON command on': 'Команда RCON на',
  'Sent as typed, like /rcon in the chat. Every command goes into the audit log.':
    'Отправляется как написано, как /rcon в чате. Каждая команда попадает в журнал действий.',
  'Find a setting': 'Найти настройку',
  What: 'Что сообщает',
  "reports publicly. A change can be undone by a server restart, unless it's in the server's config too.":
    'для всех. После перезапуска сервера изменение может пропасть, если его нет и в конфиге сервера.',
  'Nothing to show.': 'Показывать нечего.',
  'Set a server setting': 'Задать настройку сервера',
  Setting: 'Настройка',
  Value: 'Значение',

  // Admins
  'Add someone': 'Добавить человека',
  'Admins manage moderators; only the owner can change admins.':
    'Админы управляют модераторами; менять админов может только владелец.',
  Everything: 'Всё',
  'Bans, maps, chat, moderators': 'Баны, карты, чат, модераторы',
  'Kicks and temp bans': 'Кики и временные баны',
  '· added by': '· добавил',
  Role: 'Роль',
  "Hasn't opened the bot yet": 'Ещё не открывал бота',
  'They can find their Telegram ID by opening this app: it shows it when they have no access.':
    'Свой ID в Telegram человек увидит, открыв это приложение: оно покажет его, если доступа нет.',
  'Telegram ID': 'ID в Telegram',
  "They'll lose access to the bot and this app right away.":
    'Человек сразу потеряет доступ к боту и приложению.',
  'Removed from admins.': 'Убран из админов.',

  // Audit
  'Target or reason': 'Цель или причина',
  Action: 'Действие',
  From: 'Откуда',
  Anywhere: 'Отовсюду',
  'Chat command': 'Команда в чате',
  'Chat button': 'Кнопка в чате',
  App: 'Приложение',
  Automatic: 'Автоматически',
  'Nothing matches.': 'Ничего не найдено.',
  'The bot': 'Бот',

  // Servers
  'Add a server': 'Добавить сервер',
  default: 'основной',
  'open now': 'открыт',
  'Open this one': 'Открыть',
  Select: 'Выбрать',
  'unknown map': 'неизвестная карта',
  'Not answering right now.': 'Сейчас не отвечает.',
  Address: 'Адрес',
  Log: 'Журнал',
  'not read': 'не читается',
  '!report cards': 'Карточки !report',
  'Go to the bound chat': 'Приходят в привязанный чат',
  'Make default': 'Сделать основным',
  'Game log…': 'Журнал игры…',
  'Update…': 'Изменить…',
  'The bot tries the address and password before saving anything (up to ~10 seconds).':
    'Перед сохранением бот проверит адрес и пароль (до ~10 секунд).',
  'Check and save': 'Проверить и сохранить',
  'Check and add': 'Проверить и добавить',
  'Short name': 'Короткое имя',
  'Letters, digits, - and _': 'Латинские буквы, цифры, - и _',
  Port: 'Порт',
  'RCON password': 'Пароль RCON',
  'The bot stops managing it right away. Bans stay; add the server again to pick up where you left off.':
    'Бот сразу перестанет им управлять. Баны останутся; добавьте сервер снова, чтобы продолжить.',
  'Chat and !report need the bot to read the games_mp.log of this server. The search looks through this machine and can take up to ~30 seconds.':
    'Для чата и !report бот должен читать games_mp.log этого сервера. Поиск идёт по этой машине и может занять до ~30 секунд.',
  'What to do': 'Что сделать',
  'Find it for me': 'Найти автоматически',
  'Use the path below': 'Использовать путь ниже',
  'Stop reading the log': 'Перестать читать журнал',
  Path: 'Путь',
  'Which one is it?': 'Какой из них?',
  "These could be the log, but the bot can't tell for sure.":
    'Похоже, журнал один из этих файлов, но бот не может сказать точно.',
  'Use it': 'Использовать',
  File: 'Файл',
  'Log not changed': 'Журнал не изменён',

  // VPN
  'Kick players on a VPN': 'Кикать игроков с VPN',
  'Players marked 🛡 (VPN, proxy, Tor, hosting or a network below) are kicked on sight on every server, with a message in the game chat. Nobody is banned: a VPN address is shared by strangers.':
    'Игроков с меткой 🛡 (VPN, прокси, Tor, хостинг или сеть из списка ниже) кикает сразу на всех серверах, с сообщением в игровом чате. Банов нет: адрес VPN делят между собой незнакомые люди.',
  'Never kicked': 'Никогда не кикать',
  'GUID or name': 'GUID или имя',
  'Anyone can take a name; a GUID is safer.':
    'Имя может взять кто угодно; GUID надёжнее.',
  'Nobody is exempt.': 'Исключений нет.',
  'Networks marked as VPN': 'Сети с меткой VPN',
  'Player IP or ASN': 'IP игрока или ASN',
  'For VPNs the public lists miss: everyone on that provider gets the mark.':
    'Для VPN, которых нет в публичных списках: метку получат все игроки этого провайдера.',
  'None yet.': 'Пока нет.',
  'VPN flags are off on this bot (VPN_FLAG_ENABLED=false), so nobody gets flagged and nobody is kicked.':
    'Метки VPN в этом боте выключены (VPN_FLAG_ENABLED=false), поэтому никого не отмечает и не кикает.',
  'Start kicking VPN players?': 'Начать кикать игроков с VPN?',
  'Everyone marked 🛡 is kicked on sight, on every server, starting within seconds.':
    'Всех с меткой 🛡 начнёт кикать на всех серверах уже через несколько секунд.',
  'Turn on': 'Включить',

  // Presets
  'One per line. Everyone with access sees the same ones.':
    'По одному на строку. Шаблоны общие для всех, у кого есть доступ.',
  'Reasons for kicks and bans': 'Причины киков и банов',
  'Temp-ban lengths, in minutes': 'Сроки временных банов, в минутах',
  '30 = 30 minutes, 1440 = a day, 10080 = a week':
    '30 — полчаса, 1440 — сутки, 10080 — неделя',
  'Ready-made chat messages': 'Готовые сообщения в чат',

  // Telegram routes
  'Connected through': 'Подключён через',
  'Try api.telegram.org directly first':
    'Сначала пробовать api.telegram.org напрямую',
  'Routes, in the order tried': 'Маршруты в порядке проверки',
  'Check all': 'Проверить все',
  'Checking…': 'Проверка…',
  'in use': 'используется',
  'Add a relay': 'Добавить релей',
  "It's checked before it's saved.": 'Перед сохранением релей проверяется.',
  'Back to the defaults': 'Вернуть настройки по умолчанию',
  'Remove this relay?': 'Убрать этот релей?',
  'Go back to the defaults?': 'Вернуть настройки по умолчанию?',
  'Relays you added are dropped.': 'Добавленные вами релеи будут удалены.',
  Reset: 'Сбросить',

  // Self-update
  Running: 'Работает',
  Available: 'Доступна',
  'This is the latest version.': 'Это последняя версия.',
  "Couldn't ask GitHub for the latest version:":
    'Не удалось узнать последнюю версию на GitHub:',
  'Updating. The bot restarts and this app reconnects by itself; the result comes to your chat with the bot.':
    'Идёт обновление. Бот перезапустится, приложение подключится само; результат придёт в ваш чат с ботом.',
  "This install can't update itself: re-run install.sh to enable it.":
    'Эта установка не обновляется сама: чтобы включить, запустите install.sh ещё раз.',
  'Update to': 'Обновить до',
  'Check again': 'Проверить снова',
  "What's new": 'Что нового',
  'This restarts the bot. It rolls back by itself if the new version fails to start.':
    'Бот перезапустится. Если новая версия не запустится, он сам вернётся на старую.',
  Update: 'Обновить',

  // From the gateway
  'Open this app from the bot in Telegram.':
    'Откройте приложение из бота в Telegram.',
  'This session is too old — close the app and open it again from the bot.':
    'Сессия устарела. Закройте приложение и откройте его снова из бота.',
  "Can't reach the bot. Check your connection and try again.":
    'Нет связи с ботом. Проверьте подключение и повторите.',
  'Something went wrong on the bot. Check its log.':
    'В боте что-то пошло не так. Проверьте его журнал.',
  'Too many actions at once — wait a few seconds.':
    'Слишком много действий сразу. Подождите несколько секунд.',
  "The game server didn't respond, even after retrying for ~10 seconds — it may be rate-limiting queries or offline. Try again in a moment.":
    'Игровой сервер не ответил даже после ~10 секунд попыток: возможно, он ограничивает запросы или выключен. Повторите чуть позже.',
  'Sent.': 'Отправлено.',
  'Already up to date.': 'Версия уже последняя.',
  'A rotation entry is invalid.': 'В ротации есть неверная запись.',
  'Choose an IP or GUID ban.': 'Выберите бан по IP или GUID.',
  'Enter a GUID or a name.': 'Введите GUID или имя.',
  'No such ban.': 'Такого бана нет.',
  'No such note.': 'Такой заметки нет.',
  'On or off?': 'Включить или выключить?',
  'Pick a game mode.': 'Выберите режим игры.',
  'Unknown action.': 'Неизвестное действие.',
  'Unknown command.': 'Неизвестная команда.',
  'Unknown report or action.': 'Неизвестная жалоба или действие.',
  'Write something in the note.': 'Напишите что-нибудь в заметке.',
  "Changing the RCON password from here would cut the bot off from this server. Change it in the server's config, then update the server here.":
    'Если сменить пароль RCON отсюда, бот потеряет связь с сервером. Смените его в конфиге сервера, затем обновите сервер здесь.',
  'Enter a full path, starting with /.': 'Введите полный путь, начиная с /.',
  'Enter a GUID (not 0), an IPv4 address or a player name.':
    'Введите GUID (не 0), адрес IPv4 или имя игрока.',
  'Enter an https address, like https://my-relay.deno.dev':
    'Введите адрес https, например https://my-relay.deno.dev',
  'Enter an IPv4 address, like 203.0.113.7.':
    'Введите адрес IPv4, например 203.0.113.7.',
  'Enter a player IP or an ASN, like AS202226.':
    'Введите IP игрока или ASN, например AS202226.',
  'Enter the GUID the server shows (not 0).':
    'Введите GUID, который показывает сервер (не 0).',
  'Enter their numeric Telegram ID. They can see it by opening this app.':
    'Введите числовой ID в Telegram. Человек увидит его, открыв это приложение.',
  'Fill in the name, address, port and password — none of them can contain spaces.':
    'Заполните имя, адрес, порт и пароль. Пробелов в них быть не должно.',
  "Only its author or an admin can change someone's note.":
    'Чужую заметку может менять только её автор или админ.',
  'Only the owner can grant the admin role.':
    'Роль админа может выдать только владелец.',
  'Pick the admin or moderator role.': 'Выберите роль админа или модератора.',
  "Self-update isn't available on this install — re-run install.sh to enable it.":
    'На этой установке самообновление недоступно. Чтобы включить, запустите install.sh ещё раз.',
  'Someone else has dealt with this report already.':
    'Этой жалобой уже занялся кто-то другой.',
  "That player isn't connected any more.": 'Этот игрок уже вышел.',
  "That's not a valid setting name.": 'Такого имени настройки быть не может.',
  "That's the only route left — add another one first.":
    'Это последний маршрут. Сначала добавьте другой.',
  'The duration must be between 1 minute and a year.':
    'Срок должен быть от минуты до года.',
  'The new expiry must be in the future — or lift the ban instead.':
    'Новый срок должен быть в будущем. Или снимите бан.',
  'There are no relays — add one before turning direct access off.':
    'Релеев нет. Добавьте хотя бы один, прежде чем выключать прямой доступ.',
  "They're not on the list any more.": 'Этого человека уже нет в списке.',
  "This can't be done right now.": 'Сейчас это сделать нельзя.',
  "This server's log is set in the bot's config file. To manage it here, remove COD2_LOG_PATH from .env and restart the bot.":
    'Журнал этого сервера задан в конфиге бота. Чтобы управлять им здесь, уберите COD2_LOG_PATH из .env и перезапустите бота.',
  'Type a command (up to 512 characters).':
    'Введите команду (до 512 символов).',
  "You can't change your own role.": 'Свою роль менять нельзя.',
  "You can't change the owner.": 'Владельца менять нельзя.',
  "You can't change another admin.": 'Другого админа менять нельзя.',
};

/** For texts with something variable in them: the first match wins. */
export const RU_PATTERNS: readonly [RegExp, (...groups: string[]) => string][] =
  [
    // Times and counts
    [/^(\d+[mhd])$/, ruSpan],
    [/^(.+) ago$/, (span) => `${ruSpan(span)} назад`],
    [/^(.+) left$/, (span) => `осталось ${ruSpan(span)}`],
    [/^lifted (.+)$/, (ago) => `снят ${ago}`],
    [/^expires in (.+)$/, (span) => `истекает через ${ruSpan(span)}`],
    [/^(\d+) players$/, players],
    [/^(\d+) open$/, (count) => `открытых: ${count}`],
    [/^client (\d+)$/, (num) => `клиент ${num}`],
    [/^Works, (\d+) ms$/, (ms) => `Работает, ${ms} мс`],
    [/^· live$/, () => '· на связи'],
    [/^Unbanned (\d+)\.$/, (count) => `Разбанено: ${count}.`],

    [
      /^Players over the last (\d+) hours, peak (\d+), average (.+)$/,
      (hours, peak, average) =>
        `Игроки за ${hours} ч, пик ${peak}, в среднем ${average}`,
    ],

    // Confirmations
    [/^Ban (.+)\?$/, (name) => `Забанить ${name}?`],
    [/^Unban (\d+) players\?$/, (count) => `Разбанить игроков: ${count}?`],
    [/^Unban (.+)\?$/, (target) => `Разбанить ${target}?`],
    [/^Remove (.+)\?$/, (name) => `Убрать ${name}?`],
    [/^Remove (.+)$/, (name) => `Убрать ${name}`],
    [/^Change (.+)$/, (name) => `Изменить ${name}`],
    [/^Update to (.+)\?$/, (tag) => `Обновить до ${tag}?`],
    [/^Update to (.+)…$/, (tag) => `Обновить до ${tag}…`],
    [/^Update (.+)$/, (alias) => `Изменить ${alias}`],
    [/^Switch to (.+)\?$/, (map) => `Сменить карту на ${map}?`],
    [
      /^Mark the report on (.+) as handled\.$/,
      (name) => `Отметить жалобу на ${name} как решённую.`,
    ],
    [/^Game log of (.+)$/, (alias) => `Журнал игры сервера ${alias}`],
    [
      /^The mode changes from (.+) to (.+)\.$/,
      (from, to) => `Режим сменится с ${from} на ${to}.`,
    ],
    [
      /^(.+\.) The mode changes from (.+) to (.+)\.$/,
      (first, from, to) =>
        `${RU_TEXT[first] ?? first} Режим сменится с ${from} на ${to}.`,
    ],
    [
      /^Unbanned\. (.+) didn't answer, so its ban\.txt may still block them — try again later\.$/,
      (alias) =>
        `Разбанен. ${alias} не ответил, поэтому его ban.txt ещё может блокировать игрока. Повторите позже.`,
    ],
    [
      /^No ban matches "(.+)"\.$/,
      (query) => `По запросу «${query}» банов нет.`,
    ],
    [/^No map matches "(.+)"\.$/, (query) => `По запросу «${query}» карт нет.`],
    [
      /^Nobody matches "(.*)"\.$/,
      (query) => `По запросу «${query}» никого нет.`,
    ],
    [
      /^No chat: send \/bindserver (.+) in your admins' group$/,
      (alias) =>
        `Чат не привязан: отправьте /bindserver ${alias} в группе админов`,
    ],

    // Alerts
    [
      /^New report on (.+) \((.+)\)$/,
      (name, server) => `Новая жалоба на ${name} (${server})`,
    ],
    [
      /^Watched player joined: (.+)$/,
      (name) => `Зашёл игрок из списка наблюдения: ${name}`,
    ],

    // Moderation results
    [
      /^IP temp-banned \(GUID unavailable\) (.+) for (\S+)\.$/,
      (name, span) => `${name} забанен по IP на ${ruSpan(span)} (нет GUID).`,
    ],
    [
      /^IP-banned \(GUID unavailable\) (.+)\.$/,
      (name) => `${name} забанен по IP (нет GUID).`,
    ],
    [/^Kicked (.+)\.$/, (name) => `${name} кикнут.`],
    [
      /^Temp-banned (.+) for (\S+)\.$/,
      (name, span) => `${name} забанен на ${ruSpan(span)}.`,
    ],
    [/^Banned (.+)\.$/, (name) => `${name} забанен.`],
    [/^Sent to (.+)\.$/, (name) => `Отправлено игроку ${name}.`],
    [
      /^Cannot (\w+) (.+): no GUID and no known IP to fall back to\.$/,
      (_kind, name) =>
        `Нельзя наказать ${name}: нет ни GUID, ни известного IP.`,
    ],
    [
      /^(.+) isn't in slot (\d+) any more — refresh the list\.$/,
      (who, num) => `${who} больше не в слоте ${num}. Обновите список.`,
    ],

    // Maps and level commands
    [/^Changing map to (.+)…$/, (map) => `Меняем карту на ${map}…`],
    [
      /^Restarting the map…( (.+) is back up\.)?$/,
      (_rest, alias) =>
        alias
          ? `Карта перезапущена, ${alias} снова в сети.`
          : 'Перезапускаем карту…',
    ],
    [
      /^Restarting the round…( (.+) is back up\.)?$/,
      (_rest, alias) =>
        alias
          ? `Раунд перезапущен, ${alias} снова в сети.`
          : 'Перезапускаем раунд…',
    ],
    [
      /^Moving to the next map…( (.+) is back up\.)?$/,
      () => 'Переходим к следующей карте…',
    ],
    [/^Now on (.+)\.$/, (map) => `Сейчас идёт ${map}.`],
    [
      /^(.+) is still on (.+)\. If the rotation has other maps, try again\.$/,
      (alias, map) =>
        `${alias} всё ещё на карте ${map}. Если в ротации есть другие карты, повторите.`,
    ],
    [
      /^Sent, but (.+) hasn't come back yet\. Check it in a moment\.$/,
      (alias) =>
        `Отправлено, но ${alias} ещё не вернулся. Проверьте чуть позже.`,
    ],
    [
      /^(.+) didn't take the whole rotation, so the old one was put back\. Try fewer maps\.$/,
      (alias) =>
        `${alias} не принял ротацию целиком, поэтому старая возвращена. Попробуйте меньше карт.`,
    ],
    [
      /^(.+) is in the rotation twice with the same mode\.$/,
      (map) => `${map} дважды в ротации с одним и тем же режимом.`,
    ],
    [
      /^A rotation needs between 1 and (\d+) maps\.$/,
      (max) => `В ротации должно быть от 1 до ${max} карт.`,
    ],
    [
      /^(.+) has no game mode "(.+)"\.$/,
      (alias, mode) => `На ${alias} нет режима «${mode}».`,
    ],
    [
      /^There's no map "(.+)" on (.+)\.$/,
      (map, alias) => `На ${alias} нет карты «${map}».`,
    ],

    // Bans
    [
      /^(IP|GUID) (.+) banned( for (\S+))?\. If they're online, they're kicked within seconds\.$/,
      (kind, value, _for, span) =>
        `${kind} ${value} забанен${span ? ` на ${ruSpan(span)}` : ''}. Если игрок на сервере, его кикнет через несколько секунд.`,
    ],
    [
      /^Pick between 1 and (\d+) bans to lift\.$/,
      (max) => `Выберите от 1 до ${max} банов.`,
    ],
    [
      /^(.+) didn't answer, so its ban\.txt may still block this player after the ban expires\. Unban them then if they still can't join\.$/,
      (alias) =>
        `${alias} не ответил, поэтому его ban.txt может блокировать игрока и после окончания бана. Если игрок не сможет зайти, разбаньте его.`,
    ],

    // Admins and roles
    [
      /^Added (\d+) as (\w+)\.$/,
      (id, name) => `${id} добавлен, роль: ${role(name)}.`,
    ],
    [/^Role changed to (\w+)\.$/, (name) => `Роль изменена: ${role(name)}.`],
    [/^(\d+) is on the list already\.$/, (id) => `${id} уже есть в списке.`],
    [
      /^This needs the (\w+) role — you're (\w+)\.$/,
      (need, have) => `Нужна роль «${role(need)}», у вас «${role(have)}».`,
    ],
    [
      /^You're not an admin of this bot\. Ask the owner to add you \(your Telegram ID is (\d+)\)\.$/,
      (id) =>
        `Вы не админ этого бота. Попросите владельца добавить вас (ваш ID в Telegram: ${id}).`,
    ],

    // Servers
    [
      /^Server "(.+)" (added|updated): (\d+) players on (.+)\.$/,
      (alias, what, count, map) =>
        `Сервер «${alias}» ${what === 'added' ? 'добавлен' : 'изменён'}: ${players(count)}, карта ${map === 'an unknown map' ? 'неизвестна' : map}.`,
    ],
    [/^Server "(.+)" removed\.$/, (alias) => `Сервер «${alias}» убран.`],
    [
      /^"(.+)" is now the default server\.$/,
      (alias) => `«${alias}» теперь основной сервер.`,
    ],
    [
      /^There's no server "(.+)" any more\.$/,
      (alias) => `Сервера «${alias}» больше нет.`,
    ],
    [
      /^"(.+)" comes from the bot's config file and would come back on the next restart, so it can't be removed here\.$/,
      (alias) =>
        `«${alias}» задан в конфиге бота и вернётся при следующем запуске, поэтому убрать его отсюда нельзя.`,
    ],
    [
      /^"(.+)" comes from the bot's config file, so it can't be changed here\..*$/,
      (alias) =>
        `«${alias}» задан в конфиге бота, поэтому менять его здесь нельзя. Выберите другое имя или измените его через install.sh --config на машине бота.`,
    ],
    [
      /^No answer from (.+)\. Check the address and port, and that the server is running\. Nothing was saved\.$/,
      (address) =>
        `${address} не отвечает. Проверьте адрес, порт и что сервер запущен. Ничего не сохранено.`,
    ],
    [
      /^(.+) answered, but rejected the RCON password\. Nothing was saved\.$/,
      (address) =>
        `${address} ответил, но не принял пароль RCON. Ничего не сохранено.`,
    ],
    [/^Now reading (.+)\.$/, (path) => `Теперь читается ${path}.`],
    [
      /^Stopped reading the log of "(.+)"\.$/,
      (alias) => `Журнал «${alias}» больше не читается.`,
    ],
    [
      /^(\S+) set\. A server restart can undo it unless it's in the config too\.$/,
      (name) =>
        `${name} задана. После перезапуска сервера значение может пропасть, если его нет и в конфиге.`,
    ],

    // VPN and relays
    [/^(.+) is already exempt\.$/, (entry) => `${entry} уже в исключениях.`],
    [
      /^AS(\d+) is already marked as VPN\.$/,
      (asn) => `AS${asn} уже отмечена как VPN.`,
    ],
    [
      /^Couldn't find the provider network for (.+)\. Add it by ASN instead, e\.g\. AS202226\.$/,
      (ip) =>
        `Не удалось найти сеть провайдера для ${ip}. Добавьте её по ASN, например AS202226.`,
    ],
    [/^(.+) is already in the list\.$/, (url) => `${url} уже в списке.`],
    [
      /^Couldn't reach Telegram through (.+) \((.+)\)\. Nothing was changed\.$/,
      (url, error) =>
        `Через ${url} не удалось подключиться к Telegram (${error}). Ничего не изменено.`,
    ],

    // Self-update
    [
      /^Applying (.+)… the bot restarts shortly and rolls back by itself if the new version fails to start\.$/,
      (tag) =>
        `Ставим ${tag}… Бот скоро перезапустится. Если новая версия не запустится, он сам вернётся на старую.`,
    ],
    [
      /^The latest version is (.+) now\. Look it over and try again\.$/,
      (tag) =>
        `Теперь последняя версия ${tag}. Посмотрите, что в ней нового, и повторите.`,
    ],
    [
      /^(.+) is required\.$/,
      (field) => `Нужно указать: ${REQUIRED[field] ?? field}.`,
    ],
  ];

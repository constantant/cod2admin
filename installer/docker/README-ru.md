# Установка бота на старую систему (Ubuntu 18.04) через Docker

Обычный установщик на Ubuntu 18.04 не работает: для неё нет пакетов Node.js 20 и Caddy. Поэтому
бот ставится в контейнер с Debian 12 на той же машине. Сама система не меняется — добавляется
только Docker. Игровой сервер при этом не трогается.

Контейнер использует сеть хоста, так что внутри него `127.0.0.1` — это сама машина: бот ходит
к RCON по `127.0.0.1`, а Mini App доступен на портах 80/443 машины.

## Что нужно

- root (или `sudo`) на машине;
- открытые из интернета порты 80 и 443 (TCP) — только для Mini App;
- свободные локальные порты 5432 и 18090 (их занимают база и Mini App бота);
- токен бота от @BotFather, `rcon_password` и порт игрового сервера;
- путь к папке, где лежит `games_mp.log` (для `!report` и чата в Mini App).

## 1. Docker

```sh
sudo apt-get update
sudo apt-get install -y docker.io
docker --version
uname -r
```

Нужен Docker не старее 20.10.10. Быстрая проверка, что Node.js 20 запускается на ядре этой
машины (официально ему нужно ядро 4.18+, а в Ubuntu 18.04 бывает 4.15):

```sh
sudo docker run --rm node:20-slim node -e "console.log('ok', process.version)"
```

Если команда печатает `ok v20...` — всё в порядке. Образ после проверки можно удалить:
`sudo docker rmi node:20-slim`.

## 2. Файлы

```sh
sudo mkdir -p /opt/cod2admin-docker && cd /opt/cod2admin-docker
sudo curl -fLO https://raw.githubusercontent.com/constantant/cod2admin/main/installer/docker/run.sh
sudo curl -fLO https://raw.githubusercontent.com/constantant/cod2admin/main/installer/docker/boot.sh
```

## 3. Контейнер

Укажи папку, в которой лежит `games_mp.log` (папку, а не сам файл):

```sh
sudo sh run.sh /home/cod2/.callofduty2/main
```

Без лога (только RCON-команды) — просто `sudo sh run.sh`.

Бот в контейнере работает от отдельного пользователя, поэтому файл лога должен читаться всеми:
`chmod o+r games_mp.log`, а у папки должны быть права `o+rx`.

## 4. Установка бота

```sh
sudo docker exec -it cod2admin sh /boot.sh install
```

Это скачивает последнюю версию и запускает обычный установщик. Ответы на его вопросы:

| Вопрос | Ответ |
|---|---|
| Локальный Postgres | да |
| Токен бота | токен от @BotFather |
| RCON host | `127.0.0.1` |
| RCON port | порт игрового сервера (например, `28995`) |
| RCON password | `rcon_password` из `server_mp.cfg` |
| Путь к `games_mp.log` | `/cod2-logs/games_mp.log` |
| Включить Mini App | да |
| Домен для Mini App | пусто — будет бесплатное имя `<ip>.sslip.io` |

Если на машине включён `ufw`, открой порты для Mini App сам (установщик внутри контейнера этого
сделать не может):

```sh
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
```

Из России бот сам переключится на встроенные релеи для Telegram — установщик напишет
`Connected as @... (via relay ...)`.

## Управление

```sh
sudo docker exec cod2admin tail -n 50 /opt/cod2admin/cod2admin.log   # лог бота
sudo docker logs cod2admin                                           # запуск/остановка контейнера
sudo docker restart cod2admin                                        # перезапуск
sudo docker stop cod2admin                                           # остановить
sudo docker start cod2admin                                          # запустить снова
```

После перезагрузки машины контейнер, база, Caddy и бот поднимаются сами. Обновление — как
обычно, командой `/update` в Telegram.

## Важно

- **Не удаляй контейнер** (`docker rm`). Файлы бота живут внутри него. База и сертификаты лежат
  на машине в `/opt/cod2admin-docker/data`, поэтому после удаления достаточно повторить шаги 3
  и 4 — админы, баны и история сохранятся, но на вопросы установщика придётся ответить заново.
- **Изменить настройки** (токен, RCON, Mini App): снова выполни команду из шага 4 и выбери
  `1) Reconfigure`.
- **RCON только локально.** Пакеты бота идут с `127.0.0.1`, так что правило из
  `docs/rcon-local-only-ru.md` подходит без изменений.

## Что проверено

Набор проверен в контейнере Debian 12: установка, Mini App по HTTPS через Caddy, чтение лога,
перезапуск и остановка контейнера, повторная установка поверх сохранённой базы. На настоящей
Ubuntu 18.04 и в режиме сети хоста он ещё не запускался — если что-то пойдёт не так, пришли вывод
`sudo docker logs cod2admin` и последние строки лога бота.

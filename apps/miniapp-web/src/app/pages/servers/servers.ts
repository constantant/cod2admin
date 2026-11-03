import {
  ChangeDetectionStrategy,
  Component,
  inject,
  type OnInit,
  signal,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import type { ServerDto } from '@cod2admin/miniapp-api';
import { ApiService } from '../../core/api';
import { SessionService } from '../../core/session';
import { Forms } from '../../shared/form-dialog';
import { GameName } from '../../shared/game-name';
import { Icon } from '../../shared/icon';
import { Notify } from '../../shared/notify';
import { modeLabel } from '../maps/maps';
import { T } from '../../shared/i18n';

/**
 * Every server the bot manages: `/servers`, `/addserver`, `/removeserver`, `/setdefault` and
 * `/findlog`. `/bindserver` stays a chat command: it binds the chat it's sent in.
 */
@Component({
  selector: 'c2a-servers-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [T, MatButtonModule, MatProgressBarModule, GameName, Icon],
  template: `
    @if (loading()) {
      <mat-progress-bar mode="indeterminate" />
    }
    <div class="page">
      @if (session.can('owner')) {
        <button mat-flat-button class="add" (click)="add()">
          <c2a-icon name="add" /> {{ 'Add a server' | t }}
        </button>
      }
      @for (server of servers(); track server.alias) {
        <section class="card server">
          <div class="row">
            <span class="state" [class.on]="server.online"></span>
            <strong class="alias">{{ server.alias }}</strong>
            @if (server.isDefault) {
              <span class="badge">{{ 'default' | t }}</span>
            }
            <span class="spacer"></span>
            @if (server.alias !== session.server()) {
              <button mat-button (click)="open(server)">
                {{ 'Open this one' | t }}
              </button>
            } @else {
              <span class="muted small">{{ 'open now' | t }}</span>
            }
          </div>
          @if (server.online) {
            @if (server.hostname) {
              <div><c2a-game-name [name]="server.hostname" /></div>
            }
            <div class="muted small">
              {{ server.players
              }}{{ server.maxClients ? '/' + server.maxClients : '' }}
              {{ 'players ·' | t }}
              {{ server.map ?? ('unknown map' | t) }}
              {{ server.gametype ? '· ' + mode(server.gametype) : '' }}
            </div>
          } @else {
            <div class="muted small">{{ 'Not answering right now.' | t }}</div>
          }
          @if (server.connection; as connection) {
            <dl>
              <dt>{{ 'Address' | t }}</dt>
              <dd class="mono">{{ connection.host }}:{{ connection.port }}</dd>
              <dt>{{ 'Log' | t }}</dt>
              <dd class="mono">{{ connection.logPath ?? ('not read' | t) }}</dd>
              <dt>{{ '!report cards' | t }}</dt>
              <dd>
                {{
                  (connection.boundChat
                    ? 'Go to the bound chat'
                    : 'No chat: send /bindserver ' +
                      server.alias +
                      " in your admins' group"
                  ) | t
                }}
              </dd>
            </dl>
            <div class="actions">
              @if (!server.isDefault) {
                <button mat-stroked-button (click)="setDefault(server)">
                  {{ 'Make default' | t }}
                </button>
              }
              @if (session.can('owner')) {
                @if (!connection.logFromConfig) {
                  <button mat-stroked-button (click)="manageLog(server)">
                    {{ 'Game log…' | t }}
                  </button>
                }
                @if (!connection.fromConfig) {
                  <button mat-stroked-button (click)="update(server)">
                    {{ 'Update…' | t }}
                  </button>
                  <button
                    mat-stroked-button
                    class="danger"
                    (click)="remove(server)"
                  >
                    {{ 'Remove' | t }}
                  </button>
                }
              }
            </div>
          }
        </section>
      }
    </div>
  `,
  styles: `
    .add {
      margin-bottom: 12px;
    }
    .server {
      margin-bottom: 10px;
    }
    .state {
      width: 10px;
      height: 10px;
      flex: none;
      border-radius: 50%;
      background: var(--mat-sys-error);
      &.on {
        background: var(--mat-sys-primary);
      }
    }
    .alias {
      overflow-wrap: anywhere;
    }
    .badge {
      font: var(--mat-sys-label-small);
      padding: 1px 6px;
      border-radius: 6px;
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
    }
    .small {
      font: var(--mat-sys-body-small);
    }
    dl {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 2px 12px;
      margin: 10px 0;
      font: var(--mat-sys-body-small);
    }
    dt {
      color: var(--mat-sys-on-surface-variant);
    }
    dd {
      margin: 0;
      overflow-wrap: anywhere;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .danger {
      color: var(--mat-sys-error);
    }
  `,
})
export class ServersPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly notify = inject(Notify);
  private readonly forms = inject(Forms);
  protected readonly session = inject(SessionService);

  protected readonly servers = signal<ServerDto[]>([]);
  protected readonly loading = signal(false);
  protected readonly mode = modeLabel;

  ngOnInit(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.servers.set((await this.api.servers()).servers);
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.loading.set(false);
    }
  }

  protected open(server: ServerDto): void {
    this.session.selectServer(server.alias);
  }

  /** The top bar's list changes too. */
  private async afterChange(message: string): Promise<void> {
    this.notify.success(message);
    await Promise.all([this.load(), this.session.load()]);
  }

  private askServer(alias?: string, connection?: ServerDto['connection']) {
    return this.forms.open({
      title: alias ? `Update ${alias}` : 'Add a server',
      message:
        'The bot tries the address and password before saving anything (up to ~10 seconds).',
      confirm: alias ? 'Check and save' : 'Check and add',
      fields: [
        ...(alias
          ? []
          : [
              {
                key: 'alias',
                label: 'Short name',
                required: true,
                hint: 'Letters, digits, - and _',
              },
            ]),
        {
          key: 'host',
          label: 'Address',
          required: true,
          value: connection?.host ?? '',
          mono: true,
        },
        {
          key: 'port',
          label: 'Port',
          type: 'number' as const,
          required: true,
          value: String(connection?.port ?? 28960),
          mono: true,
        },
        {
          key: 'password',
          label: 'RCON password',
          type: 'password' as const,
          required: true,
        },
      ],
    });
  }

  protected async add(): Promise<void> {
    const values = await this.askServer();
    if (values) {
      await this.saveServer(String(values['alias']), values);
    }
  }

  protected async update(server: ServerDto): Promise<void> {
    const values = await this.askServer(server.alias, server.connection);
    if (values) {
      await this.saveServer(server.alias, values);
    }
  }

  private async saveServer(
    alias: string,
    values: Record<string, string | boolean>,
  ): Promise<void> {
    this.loading.set(true);
    try {
      const result = await this.api.addServer({
        alias: alias.trim(),
        host: String(values['host']).trim(),
        port: Number(values['port']),
        password: String(values['password']),
      });
      await this.afterChange(result.message);
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.loading.set(false);
    }
  }

  protected async setDefault(server: ServerDto): Promise<void> {
    try {
      await this.afterChange(
        (await this.api.setDefaultServer(server.alias)).message,
      );
    } catch (error) {
      this.notify.error(error);
    }
  }

  protected async remove(server: ServerDto): Promise<void> {
    const ok = await this.notify.confirm({
      title: `Remove ${server.alias}?`,
      message:
        'The bot stops managing it right away. Bans stay; add the server again to pick up where you left off.',
      confirm: 'Remove',
      danger: true,
    });
    if (!ok) {
      return;
    }
    try {
      await this.afterChange(
        (await this.api.removeServer(server.alias)).message,
      );
    } catch (error) {
      this.notify.error(error);
    }
  }

  protected async manageLog(server: ServerDto): Promise<void> {
    const values = await this.forms.open({
      title: `Game log of ${server.alias}`,
      message:
        'Chat and !report need the bot to read the games_mp.log of this server. The search looks through this machine and can take up to ~30 seconds.',
      confirm: 'Go',
      fields: [
        {
          key: 'action',
          label: 'What to do',
          type: 'select',
          value: 'search',
          options: [
            { value: 'search', label: 'Find it for me' },
            { value: 'set', label: 'Use the path below' },
            { value: 'off', label: 'Stop reading the log' },
          ],
        },
        {
          key: 'path',
          label: 'Path',
          value: server.connection?.logPath ?? '',
          mono: true,
        },
      ],
    });
    if (values) {
      await this.runLog(
        server,
        values['action'] as string,
        String(values['path']),
      );
    }
  }

  private async runLog(
    server: ServerDto,
    action: string,
    path: string,
  ): Promise<void> {
    this.loading.set(true);
    try {
      const result = await this.api.serverLog(
        server.alias,
        action === 'set'
          ? { action: 'set', path }
          : { action: action === 'off' ? 'off' : 'search' },
      );
      if (result.changed) {
        await this.afterChange(result.message);
      } else if (result.possible.length > 0) {
        const choice = await this.forms.open({
          title: 'Which one is it?',
          message: "These could be the log, but the bot can't tell for sure.",
          confirm: 'Use it',
          fields: [
            {
              key: 'path',
              label: 'File',
              type: 'select',
              value: result.possible[0],
              options: result.possible.map((value) => ({
                value,
                label: value,
              })),
            },
          ],
        });
        if (choice) {
          await this.runLog(server, 'set', String(choice['path']));
        }
      } else {
        await this.notify.confirm({
          title: 'Log not changed',
          message: result.message,
          confirm: 'OK',
        });
      }
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.loading.set(false);
    }
  }
}

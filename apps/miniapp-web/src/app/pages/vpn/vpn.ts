import {
  ChangeDetectionStrategy,
  Component,
  inject,
  type OnInit,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import {
  MatSlideToggleModule,
  type MatSlideToggleChange,
} from '@angular/material/slide-toggle';
import type { VpnResponse } from '@cod2admin/miniapp-api';
import { ApiService } from '../../core/api';
import { Icon } from '../../shared/icon';
import { Notify } from '../../shared/notify';

/** VPN rules: `/vpnkick` and `/vpnnets`. Applied at once, on every server. */
@Component({
  selector: 'c2a-vpn-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatSlideToggleModule,
    Icon,
  ],
  template: `
    <div class="page">
      @if (data(); as data) {
        @if (!data.flagsEnabled) {
          <div class="banner">
            VPN flags are off on this bot (VPN_FLAG_ENABLED=false), so nobody
            gets flagged and nobody is kicked.
          </div>
        }
        <section class="card">
          <mat-slide-toggle
            [checked]="data.kickEnabled"
            [disabled]="busy()"
            (change)="setKick($event)"
            >Kick players on a VPN</mat-slide-toggle
          >
          <p class="muted small">
            Players marked 🛡 (VPN, proxy, Tor, hosting or a network below) are
            kicked on sight on every server, with a message in the game chat.
            Nobody is banned: a VPN address is shared by strangers.
          </p>
        </section>

        <h2>Never kicked</h2>
        <form class="add" (ngSubmit)="allow()">
          <mat-form-field
            class="grow"
            subscriptSizing="dynamic"
            appearance="outline"
          >
            <mat-label>GUID or name</mat-label>
            <input matInput name="player" [(ngModel)]="player" />
          </mat-form-field>
          <button
            mat-stroked-button
            type="submit"
            [disabled]="busy() || !player().trim()"
          >
            Add
          </button>
        </form>
        <p class="muted small">Anyone can take a name; a GUID is safer.</p>
        <ul>
          @for (entry of data.exempt; track entry) {
            <li>
              <span class="grow">{{ entry }}</span>
              <button
                mat-icon-button
                [attr.aria-label]="'Remove ' + entry"
                (click)="unallow(entry)"
              >
                <c2a-icon name="close" />
              </button>
            </li>
          } @empty {
            <li class="muted">Nobody is exempt.</li>
          }
        </ul>

        <h2>Networks marked as VPN</h2>
        <form class="add" (ngSubmit)="addNetwork()">
          <mat-form-field
            class="grow"
            subscriptSizing="dynamic"
            appearance="outline"
          >
            <mat-label>Player IP or ASN</mat-label>
            <input
              matInput
              name="network"
              class="mono"
              placeholder="AS202226"
              [(ngModel)]="network"
            />
          </mat-form-field>
          <button
            mat-stroked-button
            type="submit"
            [disabled]="busy() || !network().trim()"
          >
            Add
          </button>
        </form>
        <p class="muted small">
          For VPNs the public lists miss: everyone on that provider gets the
          mark.
        </p>
        <ul>
          @for (entry of data.networks; track entry.asn) {
            <li>
              <span class="grow">
                <span class="mono">AS{{ entry.asn }}</span>
                @if (entry.name) {
                  <span class="muted"> {{ entry.name }}</span>
                }
              </span>
              <button
                mat-icon-button
                [attr.aria-label]="'Remove AS' + entry.asn"
                (click)="removeNetwork(entry.asn)"
              >
                <c2a-icon name="close" />
              </button>
            </li>
          } @empty {
            <li class="muted">None yet.</li>
          }
        </ul>
      }
    </div>
  `,
  styles: `
    h2 {
      font: var(--mat-sys-title-small);
      margin: 20px 0 8px;
    }
    .small {
      font: var(--mat-sys-body-small);
      margin: 8px 0;
    }
    .add {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .grow {
      flex: 1;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    li {
      display: flex;
      align-items: center;
      min-height: 40px;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
  `,
})
export class VpnPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly notify = inject(Notify);

  protected readonly data = signal<VpnResponse | null>(null);
  protected readonly busy = signal(false);
  protected readonly player = signal('');
  protected readonly network = signal('');

  ngOnInit(): void {
    void this.run(() => this.api.vpn());
  }

  private async run(action: () => Promise<VpnResponse>): Promise<boolean> {
    this.busy.set(true);
    try {
      this.data.set(await action());
      return true;
    } catch (error) {
      this.notify.error(error);
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  /** A toggle flips itself on tap, so a cancel or a refusal has to flip it back. */
  protected async setKick(event: MatSlideToggleChange): Promise<void> {
    const enabled = event.checked;
    const ok =
      !enabled ||
      (await this.notify.confirm({
        title: 'Start kicking VPN players?',
        message:
          'Everyone marked 🛡 is kicked on sight, on every server, starting within seconds.',
        confirm: 'Turn on',
        danger: true,
      }));
    if (!ok || !(await this.run(() => this.api.setVpnKick(enabled)))) {
      event.source.checked = !enabled;
    }
  }

  protected async allow(): Promise<void> {
    if (await this.run(() => this.api.vpnAllow(this.player()))) {
      this.player.set('');
    }
  }

  protected unallow(entry: string): Promise<boolean> {
    return this.run(() => this.api.vpnUnallow(entry));
  }

  protected async addNetwork(): Promise<void> {
    if (await this.run(() => this.api.addVpnNetwork(this.network()))) {
      this.network.set('');
    }
  }

  protected removeNetwork(asn: number): Promise<boolean> {
    return this.run(() => this.api.removeVpnNetwork(asn));
  }
}

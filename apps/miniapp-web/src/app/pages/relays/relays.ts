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
import type { RelaysResponse, RelayTestResponse } from '@cod2admin/miniapp-api';
import { ApiService } from '../../core/api';
import { Icon } from '../../shared/icon';
import { Notify } from '../../shared/notify';

/** How the bot reaches Telegram (`/relays`, docs/PLAN-russia-access.md). Owner only. */
@Component({
  selector: 'c2a-relays-page',
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
        <section class="card">
          <div class="muted">Connected through</div>
          <div class="current mono">{{ current() }}</div>
          <mat-slide-toggle
            [checked]="data.direct"
            [disabled]="busy()"
            (change)="setDirect($event)"
            >Try api.telegram.org directly first</mat-slide-toggle
          >
        </section>

        <div class="heading">
          <h2>Routes, in the order tried</h2>
          <button mat-button [disabled]="testing()" (click)="test()">
            {{ testing() ? 'Checking…' : 'Check all' }}
          </button>
        </div>
        <ol>
          @for (route of data.routes; track route.url) {
            <li>
              <div class="route">
                <div class="mono">
                  {{ route.label }}
                  @if (route.inUse) {
                    <span class="badge">in use</span>
                  }
                </div>
                @if (result(route.url); as result) {
                  <div class="small" [class.bad]="!result.ok">
                    {{
                      result.ok ? 'Works, ' + result.ms + ' ms' : result.error
                    }}
                  </div>
                }
              </div>
              @if (data.relays.includes(route.url)) {
                <button
                  mat-icon-button
                  [attr.aria-label]="'Remove ' + route.label"
                  (click)="remove(route.url)"
                >
                  <c2a-icon name="close" />
                </button>
              }
            </li>
          }
        </ol>

        <form class="add" (ngSubmit)="add()">
          <mat-form-field
            class="grow"
            subscriptSizing="dynamic"
            appearance="outline"
          >
            <mat-label>Add a relay</mat-label>
            <input
              matInput
              name="url"
              class="mono"
              placeholder="https://my-relay.deno.dev"
              autocapitalize="off"
              [(ngModel)]="url"
            />
          </mat-form-field>
          <button
            mat-stroked-button
            type="submit"
            [disabled]="busy() || !url().trim()"
          >
            Add
          </button>
        </form>
        <p class="muted small">It's checked before it's saved.</p>
        @if (data.changed) {
          <button mat-button (click)="reset()">Back to the defaults</button>
        }
      }
    </div>
  `,
  styles: `
    .current {
      margin: 4px 0 12px;
      overflow-wrap: anywhere;
    }
    .heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 16px;
    }
    h2 {
      font: var(--mat-sys-title-small);
      margin: 0;
    }
    ol {
      margin: 8px 0 16px;
      padding: 0 0 0 20px;
    }
    li {
      padding: 4px 0;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    li > * {
      vertical-align: middle;
    }
    .route {
      display: inline-block;
      width: calc(100% - 48px);
      overflow-wrap: anywhere;
    }
    .grow {
      flex: 1;
      min-width: 0;
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
    .bad {
      color: var(--mat-sys-error);
    }
    .add {
      display: flex;
      gap: 8px;
      align-items: center;
    }
  `,
})
export class RelaysPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly notify = inject(Notify);

  protected readonly data = signal<RelaysResponse | null>(null);
  protected readonly results = signal<RelayTestResponse['results']>([]);
  protected readonly busy = signal(false);
  protected readonly testing = signal(false);
  protected readonly url = signal('');

  ngOnInit(): void {
    void this.run(() => this.api.relays());
  }

  protected current(): string {
    const data = this.data();
    return (
      data?.routes.find((route) => route.url === data.current)?.label ??
      data?.current ??
      ''
    );
  }

  protected result(url: string) {
    return this.results().find((entry) => entry.url === url);
  }

  private async run(action: () => Promise<RelaysResponse>): Promise<boolean> {
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

  protected async test(): Promise<void> {
    this.testing.set(true);
    try {
      this.results.set((await this.api.testRelays()).results);
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.testing.set(false);
    }
  }

  protected async add(): Promise<void> {
    if (await this.run(() => this.api.addRelay(this.url().trim()))) {
      this.url.set('');
    }
  }

  protected async remove(url: string): Promise<void> {
    const ok = await this.notify.confirm({
      title: 'Remove this relay?',
      message: url,
      confirm: 'Remove',
      danger: true,
    });
    if (ok) {
      await this.run(() => this.api.removeRelay(url));
    }
  }

  /** A toggle flips itself on tap, so a refusal has to flip it back. */
  protected async setDirect(event: MatSlideToggleChange): Promise<void> {
    const direct = event.checked;
    if (!(await this.run(() => this.api.setRelayDirect(direct)))) {
      event.source.checked = !direct;
    }
  }

  protected async reset(): Promise<void> {
    const ok = await this.notify.confirm({
      title: 'Go back to the defaults?',
      message: 'Relays you added are dropped.',
      confirm: 'Reset',
      danger: true,
    });
    if (ok) {
      await this.run(() => this.api.resetRelays());
    }
  }
}

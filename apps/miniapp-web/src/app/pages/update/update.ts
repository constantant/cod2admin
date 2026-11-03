import {
  ChangeDetectionStrategy,
  Component,
  inject,
  type OnInit,
  signal,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import type { UpdateStatusResponse } from '@cod2admin/miniapp-api';
import { ApiService } from '../../core/api';
import { Notify } from '../../shared/notify';

/** `/update` (docs/PLAN.md §13). Owner only. The new version's report comes to the owner's chat. */
@Component({
  selector: 'c2a-update-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatProgressBarModule],
  template: `
    @if (loading()) {
      <mat-progress-bar mode="indeterminate" />
    }
    <div class="page">
      @if (data(); as data) {
        @if (data.problem) {
          <pre class="banner">{{ data.problem }}</pre>
        }
        <section class="card">
          <div class="muted">Running</div>
          <div class="version">v{{ data.running }}</div>
          @if (data.checkError) {
            <p class="muted">
              Couldn't ask GitHub for the latest version: {{ data.checkError }}
            </p>
          } @else if (data.available) {
            <div class="muted">Available</div>
            <div class="version">{{ data.latest }}</div>
          } @else {
            <p class="muted">This is the latest version.</p>
          }
          @if (applying()) {
            <p>
              Updating. The bot restarts and this app reconnects by itself; the
              result comes to your chat with the bot.
            </p>
          } @else if (!data.enabled) {
            <p class="muted">
              This install can't update itself: re-run install.sh to enable it.
            </p>
          } @else if (data.available) {
            <button mat-flat-button (click)="apply(data.latest!)">
              Update to {{ data.latest }}…
            </button>
          }
          <button mat-button [disabled]="loading()" (click)="load()">
            Check again
          </button>
        </section>
        @if (data.available && data.notes) {
          <h2>What's new</h2>
          <pre class="notes">{{ data.notes }}</pre>
        }
      }
    </div>
  `,
  styles: `
    .version {
      font: var(--mat-sys-title-large);
      margin-bottom: 12px;
    }
    h2 {
      font: var(--mat-sys-title-small);
      margin: 20px 0 8px;
    }
    pre {
      font: var(--mat-sys-body-small);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      margin: 0 0 12px;
    }
  `,
})
export class UpdatePage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly notify = inject(Notify);

  protected readonly data = signal<UpdateStatusResponse | null>(null);
  protected readonly loading = signal(false);
  protected readonly applying = signal(false);

  ngOnInit(): void {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.data.set(await this.api.updateStatus());
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.loading.set(false);
    }
  }

  protected async apply(tag: string): Promise<void> {
    const ok = await this.notify.confirm({
      title: `Update to ${tag}?`,
      message:
        'This restarts the bot. It rolls back by itself if the new version fails to start.',
      confirm: 'Update',
      danger: true,
    });
    if (!ok) {
      return;
    }
    this.loading.set(true);
    try {
      this.notify.success((await this.api.applyUpdate(tag)).message);
      this.applying.set(true);
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.loading.set(false);
    }
  }
}

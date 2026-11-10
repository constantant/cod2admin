import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  type OnInit,
  signal,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import type { UpdateStatusResponse } from '@cod2admin/miniapp-api';
import { ApiService } from '../../core/api';
import { Notify } from '../../shared/notify';
import { dateLocale, T } from '../../shared/i18n';
import {
  parseReleaseNotes,
  type NoteSection,
} from '../../shared/release-notes';

interface ReleaseView {
  tag: string;
  date: string;
  installed: boolean;
  sections: NoteSection[];
}

/** `/update` (docs/PLAN.md §13). Owner only. The new version's report comes to the owner's chat. */
@Component({
  selector: 'c2a-update-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [T, MatButtonModule, MatProgressBarModule],
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
          <div class="muted">{{ 'Running' | t }}</div>
          <div class="version">{{ 'v' | t }}{{ data.running }}</div>
          @if (data.checkError) {
            <p class="muted">
              {{ "Couldn't ask GitHub for the latest version:" | t }}
              {{ data.checkError }}
            </p>
          } @else if (data.available) {
            <div class="muted">{{ 'Available' | t }}</div>
            <div class="version">{{ data.latest }}</div>
          } @else {
            <p class="muted">{{ 'This is the latest version.' | t }}</p>
          }
          @if (applying()) {
            <p>
              {{
                'Updating. The bot restarts and this app reconnects by itself; the result comes to your chat with the bot.'
                  | t
              }}
            </p>
          } @else if (!data.enabled) {
            <p class="muted">
              {{
                "This install can't update itself: re-run install.sh to enable it."
                  | t
              }}
            </p>
          } @else if (data.available) {
            <button mat-flat-button (click)="apply(data.latest!)">
              {{ 'Update to' | t }} {{ data.latest }}…
            </button>
          }
          <button mat-button [disabled]="loading()" (click)="load()">
            {{ 'Check again' | t }}
          </button>
        </section>
        @if (releases().length > 0) {
          <h2>{{ (data.available ? "What's new" : 'Recent releases') | t }}</h2>
          @for (release of releases(); track release.tag) {
            <section class="card release">
              <div class="row">
                <span class="tag">{{ release.tag }}</span>
                @if (release.installed) {
                  <span class="chip">{{ 'installed' | t }}</span>
                }
                <span class="spacer"></span>
                <span class="muted">{{ release.date }}</span>
              </div>
              @for (section of release.sections; track $index) {
                @if (section.title) {
                  <div class="group">{{ section.title | t }}</div>
                }
                <ul>
                  @for (item of section.items; track $index) {
                    <li>{{ item }}</li>
                  }
                </ul>
              } @empty {
                <p class="muted">{{ 'No notes for this release.' | t }}</p>
              }
            </section>
          }
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
    .release {
      margin-bottom: 8px;
    }
    .tag {
      font: var(--mat-sys-title-medium);
    }
    .chip {
      margin-left: 8px;
      padding: 0 8px;
      border-radius: 8px;
      font: var(--mat-sys-label-small);
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
    }
    .group {
      margin-top: 12px;
      font: var(--mat-sys-label-medium);
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--mat-sys-on-surface-variant);
    }
    ul {
      margin: 4px 0 0;
      padding-left: 20px;
      font: var(--mat-sys-body-medium);
      overflow-wrap: anywhere;
    }
    li {
      margin-bottom: 4px;
    }
  `,
})
export class UpdatePage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly notify = inject(Notify);

  protected readonly data = signal<UpdateStatusResponse | null>(null);
  protected readonly releases = computed<ReleaseView[]>(() => {
    const data = this.data();
    return (data?.releases ?? []).map((release) => ({
      tag: release.tag,
      date: release.publishedAt
        ? new Date(release.publishedAt).toLocaleDateString(dateLocale, {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          })
        : '',
      installed: release.tag.replace(/^v/, '') === data?.running,
      sections: parseReleaseNotes(release.notes),
    }));
  });
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

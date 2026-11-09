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
import type {
  ChatTemplateLineDto,
  ChatTemplatesResponse,
} from '@cod2admin/miniapp-api';
import { ApiService } from '../../core/api';
import { Notify } from '../../shared/notify';
import { T } from '../../shared/i18n';

const LABEL: Record<ChatTemplateLineDto['id'], string> = {
  kick: 'Kick',
  ban: 'Ban',
  tempban: 'Temp ban',
  vpn_kick: 'VPN kick',
  known_kick: 'Known-name kick',
  mute_warn: 'Mute warning',
};

/** The lines the bot sends into the game. Empty sends nothing. */
@Component({
  selector: 'c2a-templates-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    T,
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
  ],
  template: `
    <div class="page">
      @if (data(); as data) {
        <p class="muted small">
          {{
            'Lines the bot sends into the game. Leave one empty to send nothing. A message someone types is not one of these.'
              | t
          }}
        </p>
        @for (line of data.lines; track line.id) {
          <section class="card">
            <div class="head">
              <h2>{{ label(line.id) | t }}</h2>
              <span class="muted small">{{
                (line.channel === 'tell' ? 'Only that player' : 'Everyone') | t
              }}</span>
            </div>
            <mat-form-field
              class="grow"
              subscriptSizing="dynamic"
              appearance="outline"
            >
              <input
                matInput
                [name]="line.id"
                [maxlength]="128"
                [ngModel]="drafts()[line.id]"
                (ngModelChange)="edit(line.id, $event)"
              />
            </mat-form-field>
            <p class="muted small">
              {{ 'Placeholders' | t }}:
              <span class="mono">{{ line.placeholders }}</span>
            </p>
            <p class="muted small">
              {{ 'Players see now' | t }}:
              @if (line.preview) {
                <span class="mono">{{ line.preview }}</span>
              } @else {
                {{ 'Sends nothing.' | t }}
              }
            </p>
            <button
              mat-button
              type="button"
              [disabled]="busy()"
              (click)="reset(line)"
            >
              {{ 'Reset' | t }}
            </button>
          </section>
        }
        <button mat-flat-button [disabled]="busy()" (click)="save()">
          {{ 'Save' | t }}
        </button>
      }
    </div>
  `,
  styles: `
    .small {
      font: var(--mat-sys-body-small);
      margin: 8px 0;
    }
    .head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
    }
    h2 {
      font: var(--mat-sys-title-small);
      margin: 0;
    }
    section {
      margin-bottom: 12px;
    }
    .mono {
      font-family: monospace;
    }
  `,
})
export class TemplatesPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly notify = inject(Notify);

  protected readonly data = signal<ChatTemplatesResponse | null>(null);
  protected readonly drafts = signal<
    Partial<Record<ChatTemplateLineDto['id'], string>>
  >({});
  protected readonly busy = signal(false);

  ngOnInit(): void {
    void this.load();
  }

  protected label(id: ChatTemplateLineDto['id']): string {
    return LABEL[id];
  }

  protected edit(id: ChatTemplateLineDto['id'], value: string): void {
    this.drafts.update((drafts) => ({ ...drafts, [id]: value }));
  }

  protected reset(line: ChatTemplateLineDto): void {
    this.edit(line.id, line.defaultText);
  }

  protected async save(): Promise<void> {
    this.busy.set(true);
    try {
      this.apply(await this.api.saveChatTemplates(this.drafts()));
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.busy.set(false);
    }
  }

  private async load(): Promise<void> {
    this.busy.set(true);
    try {
      this.apply(await this.api.chatTemplates());
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.busy.set(false);
    }
  }

  private apply(data: ChatTemplatesResponse): void {
    this.data.set(data);
    this.drafts.set(
      Object.fromEntries(data.lines.map((line) => [line.id, line.text])),
    );
  }
}

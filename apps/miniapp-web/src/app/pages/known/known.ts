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
import type { KnownPlayerDto, KnownResponse } from '@cod2admin/miniapp-api';
import { ApiService } from '../../core/api';
import { Forms } from '../../shared/form-dialog';
import { Icon } from '../../shared/icon';
import { Notify } from '../../shared/notify';
import { T } from '../../shared/i18n';

/** Known players: `/known`. A nickname tied to the provider networks its owner plays from. */
@Component({
  selector: 'c2a-known-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    T,
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
          <mat-slide-toggle
            [checked]="data.enabled"
            [disabled]="busy()"
            (change)="setEnabled($event)"
            >{{ 'Use the known players list' | t }}</mat-slide-toggle
          >
          <p class="muted small">
            {{
              'A listed name from a listed network is never kicked for a VPN. The same name from any other network, or with a different GUID, is kicked on sight on every server. Nobody is banned, and bans and mutes still apply.'
                | t
            }}
          </p>
        </section>

        <h2>{{ 'Add a known player' | t }}</h2>
        <form class="add" (ngSubmit)="add()">
          <mat-form-field
            class="grow"
            subscriptSizing="dynamic"
            appearance="outline"
          >
            <mat-label>{{ 'Nickname' | t }}</mat-label>
            <input matInput name="name" [(ngModel)]="name" />
          </mat-form-field>
          <mat-form-field
            class="grow"
            subscriptSizing="dynamic"
            appearance="outline"
          >
            <mat-label>{{ 'Player IP, ASN or GUID' | t }}</mat-label>
            <input
              matInput
              name="value"
              class="mono"
              [placeholder]="'AS12389 / guid:716922' | t"
              [(ngModel)]="value"
            />
          </mat-form-field>
          <button
            mat-stroked-button
            type="submit"
            [disabled]="busy() || !name().trim() || !value().trim()"
          >
            {{ 'Add' | t }}
          </button>
        </form>
        <p class="muted small">
          {{
            'Adding a name that is already listed gives it one more network or GUID. The ASN only tells the provider: someone on the same provider with the same name passes. A real GUID (most players have 0) is stronger: a different GUID on a listed name is kicked, even from a listed network.'
              | t
          }}
        </p>

        <h2>{{ 'Known players' | t }}</h2>
        <ul>
          @for (entry of data.entries; track entry.name) {
            <li>
              <div class="grow">
                <div class="title">{{ entry.display }}</div>
                <div class="chips">
                  @for (asn of entry.asns; track asn) {
                    <button
                      class="chip mono"
                      type="button"
                      [disabled]="busy()"
                      [attr.aria-label]="'Remove AS' + asn | t"
                      (click)="removeAsn(entry, asn)"
                    >
                      {{ 'AS' | t }}{{ asn }}
                      <c2a-icon name="close" />
                    </button>
                  }
                  @for (guid of entry.guids; track guid) {
                    <button
                      class="chip mono"
                      type="button"
                      [disabled]="busy()"
                      [attr.aria-label]="'Remove GUID ' + guid | t"
                      (click)="removeGuid(entry, guid)"
                    >
                      {{ 'GUID' | t }} {{ guid }}
                      <c2a-icon name="close" />
                    </button>
                  }
                  <button
                    class="chip"
                    type="button"
                    [disabled]="busy()"
                    (click)="addAsn(entry)"
                  >
                    <c2a-icon name="add" /> {{ 'Network or GUID' | t }}
                  </button>
                </div>
                @if (entry.note) {
                  <div class="muted small">{{ entry.note }}</div>
                }
              </div>
              <button
                mat-icon-button
                [attr.aria-label]="'Edit note' | t"
                (click)="editNote(entry)"
              >
                <c2a-icon name="edit" />
              </button>
              <button
                mat-icon-button
                [attr.aria-label]="'Remove ' + entry.display | t"
                (click)="remove(entry)"
              >
                <c2a-icon name="close" />
              </button>
            </li>
          } @empty {
            <li class="muted">{{ 'None yet.' | t }}</li>
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
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .grow {
      flex: 1;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .title {
      font: var(--mat-sys-title-small);
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 4px;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 8px;
      background: none;
      color: inherit;
      padding: 2px 8px;
      font: var(--mat-sys-label-medium);
      cursor: pointer;
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
      padding: 6px 0;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
  `,
})
export class KnownPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly notify = inject(Notify);
  private readonly forms = inject(Forms);

  protected readonly data = signal<KnownResponse | null>(null);
  protected readonly busy = signal(false);
  protected readonly name = signal('');
  protected readonly value = signal('');

  ngOnInit(): void {
    void this.run(() => this.api.known());
  }

  private async run(action: () => Promise<KnownResponse>): Promise<boolean> {
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
  protected async setEnabled(event: MatSlideToggleChange): Promise<void> {
    const enabled = event.checked;
    const ok =
      !enabled ||
      (await this.notify.confirm({
        title: 'Start enforcing the known players list?',
        message:
          'A listed name from a network that is not listed for it is kicked on sight, on every server, starting within seconds. Check the list first.',
        confirm: 'Turn on',
        danger: true,
      }));
    if (!ok || !(await this.run(() => this.api.setKnownEnabled(enabled)))) {
      event.source.checked = !enabled;
    }
  }

  protected async add(): Promise<void> {
    if (await this.run(() => this.api.addKnown(this.name(), this.value()))) {
      this.name.set('');
      this.value.set('');
    }
  }

  protected async addAsn(entry: KnownPlayerDto): Promise<void> {
    const values = await this.forms.open({
      title: 'Add a network or GUID',
      confirm: 'Add',
      fields: [
        {
          key: 'value',
          label: 'Player IP, ASN or GUID',
          mono: true,
          required: true,
        },
      ],
    });
    if (values) {
      await this.run(() =>
        this.api.addKnown(entry.display, String(values['value'])),
      );
    }
  }

  protected removeAsn(entry: KnownPlayerDto, asn: number): Promise<boolean> {
    return this.run(() => this.api.removeKnownAsn(entry.name, asn));
  }

  protected removeGuid(entry: KnownPlayerDto, guid: string): Promise<boolean> {
    return this.run(() => this.api.removeKnownGuid(entry.name, guid));
  }

  protected async editNote(entry: KnownPlayerDto): Promise<void> {
    const values = await this.forms.open({
      title: 'Note',
      confirm: 'Save',
      fields: [{ key: 'note', label: 'Note', value: entry.note ?? '' }],
    });
    if (values) {
      await this.run(() =>
        this.api.setKnownNote(entry.name, String(values['note'])),
      );
    }
  }

  protected async remove(entry: KnownPlayerDto): Promise<void> {
    const ok = await this.notify.confirm({
      title: 'Remove this known player?',
      message: entry.display,
      confirm: 'Remove',
      danger: true,
    });
    if (ok) {
      await this.run(() => this.api.removeKnown(entry.name));
    }
  }
}

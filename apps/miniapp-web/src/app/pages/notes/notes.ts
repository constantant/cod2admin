import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import type { NoteDto, NoteKind } from '@cod2admin/miniapp-api';
import { ApiService } from '../../core/api';
import { formatAgo } from '../../shared/format';
import { Forms } from '../../shared/form-dialog';
import { Icon } from '../../shared/icon';
import { Notify } from '../../shared/notify';

const KIND_LABELS: Record<NoteKind, string> = {
  guid: 'GUID',
  ip: 'IP',
  name: 'Name',
};

/**
 * Notes on players and the watchlist (docs/PLAN-miniapp.md §6.4): for keeping an eye on someone
 * before there's enough to ban them. Watched players get a mark in the list and a heads-up when they
 * join.
 */
@Component({
  selector: 'c2a-notes-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressBarModule,
    MatSlideToggleModule,
    Icon,
  ],
  template: `
    @if (loading()) {
      <mat-progress-bar mode="indeterminate" />
    }
    <div class="page">
      <div class="tools">
        <mat-form-field
          class="search"
          subscriptSizing="dynamic"
          appearance="outline"
        >
          <c2a-icon matPrefix name="search" class="prefix" />
          <input
            matInput
            placeholder="Name, IP, GUID or text"
            [ngModel]="query()"
            (ngModelChange)="query.set($event)"
          />
        </mat-form-field>
        <button mat-flat-button (click)="add()">
          <c2a-icon name="add" /> Add
        </button>
      </div>
      <mat-slide-toggle
        class="watch-only"
        [checked]="watchOnly()"
        (change)="watchOnly.set($event.checked)"
        >Watchlist only</mat-slide-toggle
      >

      @for (note of items(); track note.id) {
        <section class="card note">
          <div class="row">
            <span class="kind">{{ kind(note.kind) }}</span>
            <span class="value mono">{{ note.value }}</span>
            @if (note.watch) {
              <c2a-icon
                name="eye"
                class="watched"
                aria-label="On the watchlist"
              />
            }
            <span class="spacer"></span>
            @if (note.editable) {
              <button
                mat-icon-button
                [attr.aria-label]="note.watch ? 'Stop watching' : 'Watch'"
                (click)="toggleWatch(note)"
              >
                <c2a-icon [name]="note.watch ? 'eyeOff' : 'eye'" />
              </button>
              <button mat-icon-button aria-label="Edit" (click)="edit(note)">
                <c2a-icon name="edit" />
              </button>
              <button
                mat-icon-button
                aria-label="Delete"
                (click)="remove(note)"
              >
                <c2a-icon name="delete" />
              </button>
            }
          </div>
          <div class="text">{{ note.note }}</div>
          <div class="muted small">
            {{ note.author }} · {{ ago(note.updatedAt) }}
          </div>
        </section>
      } @empty {
        @if (!loading()) {
          <p class="empty">
            {{
              query() || watchOnly()
                ? 'No notes match.'
                : 'No notes yet. Add one here, or from a player.'
            }}
          </p>
        }
      }
      @if (more()) {
        <button mat-button class="full-width" (click)="load(true)">
          Show more
        </button>
      }
    </div>
  `,
  styles: `
    .tools {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .search {
      flex: 1;
    }
    .prefix {
      margin: 0 4px 0 12px;
    }
    .watch-only {
      display: block;
      margin: 12px 4px;
    }
    .note {
      margin-bottom: 10px;
    }
    .kind {
      font: var(--mat-sys-label-small);
      padding: 1px 6px;
      border-radius: 6px;
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
    }
    .value {
      overflow-wrap: anywhere;
    }
    .watched {
      width: 18px;
      height: 18px;
      color: var(--mat-sys-tertiary);
    }
    .text {
      margin: 4px 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .small {
      font: var(--mat-sys-body-small);
    }
  `,
})
export class NotesPage {
  private readonly api = inject(ApiService);
  private readonly notify = inject(Notify);
  private readonly forms = inject(Forms);

  protected readonly items = signal<NoteDto[]>([]);
  protected readonly query = signal('');
  protected readonly watchOnly = signal(false);
  protected readonly loading = signal(false);
  protected readonly more = signal(false);

  constructor() {
    effect(() => {
      this.query();
      this.watchOnly();
      untracked(() => void this.load());
    });
  }

  protected kind(kind: NoteKind): string {
    return KIND_LABELS[kind];
  }

  protected ago(iso: string): string {
    return formatAgo(iso);
  }

  protected async load(append = false): Promise<void> {
    const query = this.query().trim();
    const watchOnly = this.watchOnly();
    this.loading.set(true);
    try {
      const page = await this.api.notes(
        query,
        watchOnly,
        append ? this.items().length : 0,
      );
      if (query === this.query().trim() && watchOnly === this.watchOnly()) {
        this.items.update((items) =>
          append ? [...items, ...page.items] : page.items,
        );
        this.more.set(page.more);
      }
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.loading.set(false);
    }
  }

  protected async add(): Promise<void> {
    const values = await this.forms.open({
      title: 'Add a note',
      confirm: 'Add',
      fields: [
        {
          key: 'kind',
          label: 'About',
          type: 'select',
          value: 'name',
          options: [
            { value: 'name', label: 'A name' },
            { value: 'ip', label: 'An IP' },
            { value: 'guid', label: 'A GUID' },
          ],
          hint: 'Names can be taken by anyone; an IP or GUID is more certain.',
        },
        { key: 'value', label: 'Name, IP or GUID', required: true },
        { key: 'note', label: 'Note', type: 'textarea', required: true },
        { key: 'watch', label: 'Put on the watchlist', type: 'checkbox' },
      ],
    });
    if (!values) {
      return;
    }
    try {
      await this.api.addNote({
        kind: values['kind'] as NoteKind,
        value: String(values['value']),
        note: String(values['note']),
        watch: values['watch'] === true,
      });
      this.notify.success('Note added.');
      await this.load();
    } catch (error) {
      this.notify.error(error);
    }
  }

  protected async edit(note: NoteDto): Promise<void> {
    const values = await this.forms.open({
      title: 'Edit note',
      message: `${KIND_LABELS[note.kind]} ${note.value}`,
      confirm: 'Save',
      fields: [
        {
          key: 'note',
          label: 'Note',
          type: 'textarea',
          required: true,
          value: note.note,
        },
      ],
    });
    if (values) {
      await this.save(note, { note: String(values['note']) });
    }
  }

  protected toggleWatch(note: NoteDto): Promise<void> {
    return this.save(note, { watch: !note.watch });
  }

  private async save(
    note: NoteDto,
    changes: { note?: string; watch?: boolean },
  ): Promise<void> {
    try {
      const updated = await this.api.updateNote(note.id, changes);
      this.items.update((items) =>
        items.map((item) => (item.id === note.id ? updated : item)),
      );
    } catch (error) {
      this.notify.error(error);
    }
  }

  protected async remove(note: NoteDto): Promise<void> {
    const ok = await this.notify.confirm({
      title: 'Delete this note?',
      message: note.note,
      confirm: 'Delete',
      danger: true,
    });
    if (!ok) {
      return;
    }
    try {
      this.notify.success((await this.api.deleteNote(note.id)).message);
      this.items.update((items) => items.filter((item) => item.id !== note.id));
    } catch (error) {
      this.notify.error(error);
    }
  }
}

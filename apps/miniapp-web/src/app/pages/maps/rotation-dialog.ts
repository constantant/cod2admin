import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import {
  MAT_DIALOG_DATA,
  MatDialogModule,
  MatDialogRef,
} from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import type { MapsResponse } from '@cod2admin/miniapp-api';
import { ApiService } from '../../core/api';
import { Icon } from '../../shared/icon';
import { Notify } from '../../shared/notify';
import { T } from '../../shared/i18n';

interface Entry {
  map: string;
  gametype: string | null;
}

/** Reorders, adds and removes `sv_mapRotation` entries. Closes with `true` once saved. */
@Component({
  selector: 'c2a-rotation-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    T,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatSelectModule,
    Icon,
  ],
  template: `
    <h2 mat-dialog-title>{{ 'Map rotation' | t }}</h2>
    <mat-dialog-content>
      <p class="muted small">
        {{
          "Lasts until the server restarts: to keep it, put it in the server's config too."
            | t
        }}
      </p>
      <ol>
        @for (entry of entries(); track $index) {
          <li>
            <span class="what">
              {{ entry.map }}
              @if (entry.gametype) {
                <span class="muted">{{ entry.gametype }}</span>
              }
            </span>
            <button
              mat-icon-button
              [attr.aria-label]="'Move up' | t"
              [disabled]="$first"
              (click)="move($index, -1)"
            >
              <c2a-icon name="up" />
            </button>
            <button
              mat-icon-button
              [attr.aria-label]="'Move down' | t"
              [disabled]="$last"
              (click)="move($index, 1)"
            >
              <c2a-icon name="down" />
            </button>
            <button
              mat-icon-button
              [attr.aria-label]="'Remove' | t"
              (click)="remove($index)"
            >
              <c2a-icon name="close" />
            </button>
          </li>
        }
      </ol>
      <div class="add">
        <mat-form-field subscriptSizing="dynamic" class="grow">
          <mat-label>{{ 'Map' | t }}</mat-label>
          <mat-select [value]="newMap()" (valueChange)="newMap.set($event)">
            @for (map of data.maps.maps; track map.name) {
              <mat-option [value]="map.name">{{ map.name }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        @if (data.maps.gametypes.length > 0) {
          <mat-form-field subscriptSizing="dynamic" class="mode">
            <mat-label>{{ 'Mode' | t }}</mat-label>
            <mat-select [value]="newMode()" (valueChange)="newMode.set($event)">
              @for (gametype of data.maps.gametypes; track gametype) {
                <mat-option [value]="gametype">{{ gametype }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
        }
        <button
          mat-stroked-button
          [disabled]="!newMap() || isListed()"
          (click)="add()"
        >
          {{ 'Add' | t }}
        </button>
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>{{ 'Cancel' | t }}</button>
      <button
        mat-flat-button
        [disabled]="busy() || entries().length === 0"
        (click)="save()"
      >
        {{ 'Save' | t }}
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    .small {
      font: var(--mat-sys-body-small);
    }
    ol {
      margin: 0 0 12px;
      padding: 0 0 0 24px;
    }
    li {
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .what {
      display: inline-block;
      width: calc(100% - 144px);
      overflow-wrap: anywhere;
    }
    .add {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .grow {
      flex: 1;
      min-width: 0;
    }
    .mode {
      width: 90px;
    }
  `,
})
export class RotationDialog {
  protected readonly data = inject<{ server: string; maps: MapsResponse }>(
    MAT_DIALOG_DATA,
  );
  private readonly ref = inject(MatDialogRef<RotationDialog, boolean>);
  private readonly api = inject(ApiService);
  private readonly notify = inject(Notify);

  protected readonly entries = signal<Entry[]>([...this.data.maps.rotation]);
  protected readonly newMap = signal<string | null>(null);
  protected readonly newMode = signal<string | null>(
    this.data.maps.defaultGametype,
  );
  protected readonly busy = signal(false);

  protected isListed(): boolean {
    return this.entries().some(
      (entry) =>
        entry.map === this.newMap() && entry.gametype === this.newMode(),
    );
  }

  protected move(index: number, by: number): void {
    this.entries.update((entries) => {
      const next = [...entries];
      const [entry] = next.splice(index, 1);
      next.splice(index + by, 0, entry!);
      return next;
    });
  }

  protected remove(index: number): void {
    this.entries.update((entries) => entries.filter((_, i) => i !== index));
  }

  protected add(): void {
    const map = this.newMap();
    if (map) {
      this.entries.update((entries) => [
        ...entries,
        { map, gametype: this.newMode() },
      ]);
      this.newMap.set(null);
    }
  }

  protected async save(): Promise<void> {
    this.busy.set(true);
    try {
      const result = await this.api.saveRotation(this.data.server, {
        entries: this.entries(),
      });
      this.notify.success(result.message);
      this.ref.close(true);
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.busy.set(false);
    }
  }
}

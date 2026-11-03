import { inject, Injectable, signal } from '@angular/core';
import type { Presets } from '@cod2admin/miniapp-api';
import { ApiService } from './api';

const FALLBACK: Presets = {
  reasons: [],
  durations: [30, 120, 1440, 10_080, 43_200],
  messages: [],
};

/** Saved reasons, temp-ban lengths and chat lines (docs/PLAN-miniapp.md §6.4). Loaded once per session. */
@Injectable({ providedIn: 'root' })
export class PresetsService {
  private readonly api = inject(ApiService);
  private loading: Promise<void> | undefined;
  readonly presets = signal<Presets>(FALLBACK);

  /** A failure just leaves the built-in lengths: presets only save typing. */
  load(): Promise<void> {
    this.loading ??= this.api
      .presets()
      .then((presets) => this.presets.set(presets))
      .catch(() => {
        this.loading = undefined;
      });
    return this.loading;
  }

  async save(presets: Presets): Promise<void> {
    this.presets.set(await this.api.savePresets(presets));
  }
}

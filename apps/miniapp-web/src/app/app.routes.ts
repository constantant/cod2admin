import { inject } from '@angular/core';
import { type CanMatchFn, Route } from '@angular/router';
import type { MiniAppRole } from '@cod2admin/miniapp-api';
import { SessionService } from './core/session';

/** Hides a page from roles that can't use it — the gateway enforces the same gates (§8). */
const role =
  (minRole: MiniAppRole): CanMatchFn =>
  async () => {
    const session = inject(SessionService);
    await session.loaded;
    return session.can(minRole);
  };

export const appRoutes: Route[] = [
  { path: '', pathMatch: 'full', redirectTo: 'players' },
  { path: 'players', loadComponent: () => import('./pages/players/players').then((m) => m.PlayersPage) },
  { path: 'chat', loadComponent: () => import('./pages/chat/chat').then((m) => m.ChatPage) },
  { path: 'maps', canMatch: [role('admin')], loadComponent: () => import('./pages/maps/maps').then((m) => m.MapsPage) },
  { path: 'bans', canMatch: [role('admin')], loadComponent: () => import('./pages/bans/bans').then((m) => m.BansPage) },
  {
    path: 'console',
    canMatch: [role('owner')],
    loadComponent: () => import('./pages/console/console').then((m) => m.ConsolePage),
  },
  { path: '**', redirectTo: 'players' },
];

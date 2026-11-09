import { inject } from '@angular/core';
import { type CanMatchFn, Route } from '@angular/router';
import type { Permission } from '@cod2admin/miniapp-api';
import { SessionService } from './core/session';

/** Hides a page from staff who lack the permission — the gateway enforces the same gates. */
const allow =
  (permission: Permission): CanMatchFn =>
  async () => {
    const session = inject(SessionService);
    await session.loaded;
    return session.can(permission);
  };

export const appRoutes: Route[] = [
  { path: '', pathMatch: 'full', redirectTo: 'players' },
  {
    path: 'dashboard',
    loadComponent: () =>
      import('./pages/dashboard/dashboard').then((m) => m.DashboardPage),
  },
  {
    path: 'reports',
    loadComponent: () =>
      import('./pages/reports/reports').then((m) => m.ReportsPage),
  },
  {
    path: 'more',
    loadComponent: () => import('./pages/more/more').then((m) => m.MorePage),
  },
  {
    path: 'notes',
    loadComponent: () => import('./pages/notes/notes').then((m) => m.NotesPage),
  },
  {
    path: 'mutes',
    loadComponent: () => import('./pages/mutes/mutes').then((m) => m.MutesPage),
  },
  {
    path: 'servers',
    loadComponent: () =>
      import('./pages/servers/servers').then((m) => m.ServersPage),
  },
  {
    path: 'settings',
    canMatch: [allow('cvars.read')],
    loadComponent: () =>
      import('./pages/settings/settings').then((m) => m.SettingsPage),
  },
  {
    path: 'vpn',
    canMatch: [allow('vpn')],
    loadComponent: () => import('./pages/vpn/vpn').then((m) => m.VpnPage),
  },
  {
    path: 'known',
    canMatch: [allow('vpn')],
    loadComponent: () => import('./pages/known/known').then((m) => m.KnownPage),
  },
  {
    path: 'presets',
    canMatch: [allow('presets')],
    loadComponent: () =>
      import('./pages/presets/presets').then((m) => m.PresetsPage),
  },
  {
    path: 'admins',
    canMatch: [allow('admins.manage')],
    loadComponent: () =>
      import('./pages/admins/admins').then((m) => m.AdminsPage),
  },
  {
    path: 'audit',
    canMatch: [allow('audit')],
    loadComponent: () => import('./pages/audit/audit').then((m) => m.AuditPage),
  },
  {
    path: 'templates',
    canMatch: [allow('templates')],
    loadComponent: () =>
      import('./pages/templates/templates').then((m) => m.TemplatesPage),
  },
  {
    path: 'relays',
    canMatch: [allow('relays')],
    loadComponent: () =>
      import('./pages/relays/relays').then((m) => m.RelaysPage),
  },
  {
    path: 'update',
    canMatch: [allow('update')],
    loadComponent: () =>
      import('./pages/update/update').then((m) => m.UpdatePage),
  },
  {
    path: 'players',
    loadComponent: () =>
      import('./pages/players/players').then((m) => m.PlayersPage),
  },
  {
    path: 'chat',
    loadComponent: () => import('./pages/chat/chat').then((m) => m.ChatPage),
  },
  {
    path: 'maps',
    canMatch: [allow('maps')],
    loadComponent: () => import('./pages/maps/maps').then((m) => m.MapsPage),
  },
  {
    path: 'bans',
    canMatch: [allow('ban')],
    loadComponent: () => import('./pages/bans/bans').then((m) => m.BansPage),
  },
  {
    path: 'console',
    canMatch: [allow('rcon')],
    loadComponent: () =>
      import('./pages/console/console').then((m) => m.ConsolePage),
  },
  { path: '**', redirectTo: 'players' },
];

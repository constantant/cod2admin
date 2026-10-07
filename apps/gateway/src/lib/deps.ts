import type { AdminStore } from '@cod2admin/admin-store';
import type { GameLogTailer } from '@cod2admin/log-tailer';
import type { BanStore } from '@cod2admin/ban-store';
import type { RconClient } from '@cod2admin/rcon-client';
import type { ReportAntiSpam, SessionLookup } from '@cod2admin/report-pipeline';
import type { CountryLookup, ProviderLookup } from './geoip.js';
import type { GithubReleaseClient } from './github-releases.js';
import type {
  RouteProbeResult,
  TelegramRouter,
  TelegramRouteSettings,
} from './telegram-routes.js';
import type { ReportRegistry } from './reports.js';
import type { UpdateRegistry } from './update-registry.js';
import type { VpnKicker } from './vpn-kick.js';
import type { VpnFlags } from './vpn-ranges.js';

/**
 * Self-update (docs/PLAN.md §13.2/§13.3) config, derived from `GatewayConfig.updateStagingDir` in
 * main.ts. `undefined` means the feature is disabled — either running outside a real install
 * (e.g. `nx serve`) or an install that hasn't re-run `install.sh` since this shipped
 * (`UPDATE_STAGING_DIR` wasn't in `.env` yet). `applyUpdateScriptPath` is derived rather than a
 * second env var: `bin/` and `staging/` are always siblings under `$INSTALL_DIR` per §13.5's
 * layout.
 */
export interface UpdateFeatureConfig {
  stagingDir: string;
  applyUpdateScriptPath: string;
}

/** Everything a command handler needs beyond the incoming update (docs/PLAN.md §9 Phase 2). */
export interface GatewayDeps {
  adminStore: AdminStore;
  banStore: BanStore;
  /** Every managed server by alias. `/addserver`/`/removeserver` change it while the bot runs. */
  rconClients: Map<string, RconClient>;
  /** Builds an `RconClient` with the gateway's settings (e.g. text encoding) — used by `/addserver`. */
  createRconClient(server: {
    host: string;
    port: number;
    password: string;
  }): RconClient;
  /**
   * The server `main.ts` saves from `.env` (`COD2_SERVER_ALIAS`) on every start. `/addserver` and
   * `/removeserver` refuse to touch it, since the next restart would undo the change.
   */
  bootstrapServerAlias: string;
  /** IP → country for `/players`, `/bans` and report cards — `NO_COUNTRY_LOOKUP` when off. */
  geoip: CountryLookup;
  /** IP → provider (ISP/hosting company) for `/players` and report cards — `NO_PROVIDER_LOOKUP` when off. */
  provider: ProviderLookup;
  /** IP → VPN/proxy/Tor flag for `/players` and report cards — `NO_VPN_LOOKUP` when off. `/vpnnets` updates it. */
  vpn: VpnFlags;
  /** `/vpnkick` state and its sweep (vpn-kick.ts) — off until an admin turns it on. */
  vpnKick: VpnKicker;
  /** How the bot reaches Telegram (telegram-routes.ts) — managed with `/relays`. */
  telegramRoutes: {
    router: TelegramRouter;
    /** What applies until `/relays` changes it: `.env`, else direct + the built-in shared relays. */
    defaults: TelegramRouteSettings;
    /** `getMe` through one route, with this bot's token. */
    probe(root: string): Promise<RouteProbeResult>;
  };
  /**
   * Report-card state (docs/PLAN.md §5 steps 4/6) — process-lifetime, shared between `bot.ts`'s
   * callback handler and `main.ts`'s `GameLogTailer` wiring (`report-tailers.ts`), so both sides
   * see the same in-flight reports/cooldowns.
   */
  reportRegistry: ReportRegistry;
  reportAntiSpam: ReportAntiSpam<string>;
  /** Per-server session lookup (a `GameLogTailer` instance) for the `select` button's re-enrichment — keyed like `rconClients`. */
  sessionsByServer: Map<string, SessionLookup>;
  /** The `games_mp.log` tailer of every server with a log path — the Mini App's live chat source. */
  logTailers: Map<string, GameLogTailer>;
  updateConfig: UpdateFeatureConfig | undefined;
  githubReleaseClient: GithubReleaseClient;
  /** Pending `/update` confirm/cancel cards (docs/PLAN.md §13.3) — same shape/lifetime caveats as `reportRegistry`. */
  updateRegistry: UpdateRegistry;
  /** Set by the version-check poller so it notifies the owner once per new tag, not every tick. */
  lastNotifiedTag?: string;
}

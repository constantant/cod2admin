import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import type {
  RecordAuditLogInput,
  ServerConfig,
  ServerWatchSettings,
} from '@cod2admin/admin-store';
import type { BanStore } from '@cod2admin/ban-store';
import { connectAllowed } from '@cod2admin/game-client';
import {
  decide,
  scoreLife,
  type PopulationMoments,
  type WatchThresholds,
} from '@cod2admin/player-watch';
import {
  processMachineReport,
  type CardSender,
  type MachineReport,
} from '@cod2admin/report-pipeline';
import { stripColorCodes, type ServerStatus } from '@cod2admin/rcon-client';
import {
  createWatchStore,
  migrate as migrateWatchStore,
  type WatchEvidenceRow,
  type WatchIdentityKind,
  type WatchLifeFeatures,
  type WatchStore,
} from '@cod2admin/watch-store';
import type { ChatTemplates } from '../lib/chat-templates.js';
import { executeModerationAction } from '../lib/moderation-actions.js';
import { createPlayerIdentityResolver } from '../lib/player-identity.js';
import {
  parseLifeMessage,
  reloadMessage,
  type HelloServer,
  type LifeMessage,
} from './ipc.js';
import { matchKickSlot, watchIdentityKind } from './match-kick.js';

/** Same window as player-identity: a ban-sweep status is reused, not re-fetched. */
const FRESH_STATUS_MS = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const BACKOFF_MS = [1000, 2000, 5000, 15_000, 30_000];
const PENDING_LIFE_CAP = 100;

const SCRIPT_PATH = fileURLToPath(new URL('./child.js', import.meta.url));

export interface WatchSupervisor {
  readonly running: boolean;
  sync(): Promise<void>;
  noteStatus(alias: string, status: ServerStatus, fetchedAt?: number): void;
  whenIdle(): Promise<void>;
  stop(): void;
  /**
   * Profile guid and name count for a watch-card Kick. Undefined when the
   * store never opened.
   */
  profileForKick(
    serverAlias: string,
    profileKey: string,
  ): Promise<{ lastGuid: string | null; distinctNames24h: number } | undefined>;
  /** Newest first. Empty when the store never opened. */
  listEvidence(
    serverAlias: string,
    limit: number,
    offset: number,
  ): Promise<WatchEvidenceRow[]>;
}

export interface SpawnedWatch {
  stdin: { write(chunk: string): unknown };
  stdout: Readable;
  stderr: Readable;
  pid?: number;
  kill(signal?: NodeJS.Signals): unknown;
  on(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

export type WatchSpawn = (
  command: string,
  args: readonly string[],
  options: { stdio: ['pipe', 'pipe', 'pipe']; detached: false },
) => SpawnedWatch;

interface WatchRcon {
  getStatus(): Promise<{ cvars: Record<string, string | undefined> }>;
  status: () => Promise<ServerStatus>;
  rcon(command: string): Promise<string>;
  dumpuser?: (name: string) => Promise<Record<string, string>>;
  kick(
    clientIdOrName: string | number,
    nameIfSlot?: string,
    options?: { slotOnly?: boolean },
  ): Promise<string>;
  say(message: string): Promise<string>;
  banClient(clientId: number): Promise<string>;
}

export interface WatchSupervisorDeps {
  databaseUrl?: string;
  adminStore: {
    listServers(): Promise<ServerConfig[]>;
    getServer(alias: string): Promise<ServerConfig | undefined>;
    recordAuditLog(input: RecordAuditLogInput): Promise<unknown>;
  };
  rconClients: ReadonlyMap<string, WatchRcon>;
  banStore: BanStore;
  /** Live game-chat lines. Absent: the built-in `{name} was kicked`. */
  chatTemplates?: ChatTemplates;
  watchStore?: WatchStore;
  migrate?: (connectionString: string) => Promise<void>;
  createWatchStore?: (connectionString: string) => WatchStore;
  spawn?: WatchSpawn;
  now?: () => number;
  reportQueue?: {
    recordMachine(input: {
      serverAlias: string;
      reporterName: string;
      targetName: string;
      reason: string | null;
    }): Promise<{ id: number }>;
  };
  createCardSender?: (report: MachineReport) => CardSender<string>;
  log?: {
    warn(message: string): void;
    error(message: string, error?: unknown): void;
  };
  /** `0` skips the daily timer. The boot prune still runs. */
  pruneIntervalMs?: number;
  killGroup?: (pid: number) => void;
}

interface HeldStatus {
  status: ServerStatus;
  fetchedAt: number;
}

interface StartedChild {
  process: SpawnedWatch;
  /** Password each alias was given on the hello that started this process. */
  passwords: Map<string, string | undefined>;
  generation: number;
}

export async function startWatchSupervisor(
  deps: WatchSupervisorDeps,
): Promise<WatchSupervisor> {
  const supervisor = new Supervisor(deps);
  try {
    await supervisor.open();
  } catch (error) {
    supervisor.log.error('watch: migrate failed; supervisor stopped', error);
    return supervisor.api;
  }
  return supervisor.api;
}

class Supervisor {
  readonly log: {
    warn(message: string): void;
    error(message: string, error?: unknown): void;
  };
  private readonly now: () => number;
  private readonly spawnChild: WatchSpawn;
  private readonly killGroup: (pid: number) => void;
  private store?: WatchStore;
  private running = false;
  private chain: Promise<void> = Promise.resolve();
  private draining = false;
  private readonly dirty = new Set<string>();
  private child?: StartedChild;
  private childGeneration = 0;
  private backoffIndex = 0;
  private restartTimer?: NodeJS.Timeout;
  private pruneTimer?: NodeJS.Timeout;
  private lastHello: HelloServer[] = [];
  /** Map name last sent to the child. Null is the tracker's starting map. */
  private readonly childMaps = new Map<string, string | null>();
  /** Aliases whose status was noted and not yet told to the child. */
  private readonly noted = new Set<string>();
  private readonly held = new Map<string, HeldStatus>();
  private readonly pending = new Map<string, LifeMessage[]>();
  private readonly observed = new WeakSet<object>();
  private readonly resolvers = new Map<
    string,
    ReturnType<typeof createPlayerIdentityResolver>
  >();
  private readonly sessionLives = new Map<string, number>();
  private readonly speedCache = new Map<
    string,
    { map: string | null; speed: number | null }
  >();
  private readonly secrets = new Set<string>();
  readonly api: WatchSupervisor;

  constructor(private readonly deps: WatchSupervisorDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.spawnChild = deps.spawn ?? defaultSpawn;
    this.killGroup = deps.killGroup ?? defaultKillGroup;
    this.log = deps.log ?? {
      warn: (message) => console.warn(message),
      error: (message, error) => console.error(message, error),
    };
    const self = this;
    this.api = {
      get running() {
        return self.running;
      },
      sync: () => self.sync(),
      noteStatus: (alias, status, fetchedAt) =>
        self.noteStatus(alias, status, fetchedAt),
      whenIdle: () => self.chain,
      stop: () => self.stop(),
      profileForKick: (serverAlias, profileKey) =>
        self.profileForKick(serverAlias, profileKey),
      // Not on the kick chain: a staff read must not delay a kick.
      listEvidence: (serverAlias, limit, offset) =>
        self.listEvidence(serverAlias, limit, offset),
    };
  }

  listEvidence(
    serverAlias: string,
    limit: number,
    offset: number,
  ): Promise<WatchEvidenceRow[]> {
    const store = this.store;
    if (!store) return Promise.resolve([]);
    return store.listEvidence(serverAlias, limit, offset);
  }

  async open(): Promise<void> {
    const { deps } = this;
    if (deps.migrate) {
      await deps.migrate(deps.databaseUrl ?? '');
    } else if (!deps.watchStore) {
      if (!deps.databaseUrl) {
        throw new Error('watch: database url missing');
      }
      await migrateWatchStore(deps.databaseUrl);
    }
    if (deps.watchStore) {
      this.store = deps.watchStore;
    } else if (deps.databaseUrl) {
      this.store = (deps.createWatchStore ?? createWatchStore)(
        deps.databaseUrl,
      );
    } else {
      throw new Error('watch: database url missing');
    }
    this.running = true;
    try {
      await this.store.pruneWatchRetention(new Date(this.now()));
    } catch (error) {
      this.log.error('watch: prune failed', error);
    }
    const interval = deps.pruneIntervalMs ?? DAY_MS;
    if (interval > 0) {
      this.pruneTimer = setInterval(() => {
        void this.enqueue(() => this.prune());
      }, interval);
      this.pruneTimer.unref();
    }
    await this.sync();
  }

  noteStatus(
    alias: string,
    status: ServerStatus,
    fetchedAt = this.now(),
  ): void {
    this.held.set(alias, { status, fetchedAt });
    this.dirty.add(alias);
    this.noted.add(alias);
    if (this.draining) {
      return;
    }
    void this.enqueue(() => this.flushDirty());
  }

  async sync(): Promise<void> {
    await this.enqueue(() => this.syncBody());
  }

  stop(): void {
    this.running = false;
    this.stopChild();
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = undefined;
    }
    this.pending.clear();
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.chain.then(async () => {
      this.draining = true;
      try {
        await task();
        await this.flushDirty();
      } catch (error) {
        this.log.error('watch: task failed', error);
      } finally {
        this.draining = false;
      }
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async flushDirty(): Promise<void> {
    while (this.dirty.size > 0) {
      const aliases = [...this.dirty];
      this.dirty.clear();
      this.publishMaps();
      for (const alias of aliases) {
        await this.flush(alias);
      }
    }
  }

  private async prune(): Promise<void> {
    if (!this.running || !this.store) {
      return;
    }
    try {
      await this.store.pruneWatchRetention(new Date(this.now()));
    } catch (error) {
      this.log.error('watch: prune failed', error);
    }
  }

  private async syncBody(): Promise<void> {
    if (!this.running || !this.store) {
      return;
    }
    let servers: ServerConfig[];
    try {
      servers = await this.deps.adminStore.listServers();
    } catch (error) {
      this.log.error('watch: listServers failed', error);
      return;
    }
    const hello: HelloServer[] = [];
    for (const server of servers) {
      const entry = await this.planServer(server);
      if (entry) {
        hello.push(entry);
      }
    }
    this.applyChild(hello);
  }

  private async planServer(
    server: ServerConfig,
  ): Promise<HelloServer | undefined> {
    const watch = server.watch;
    if (!watch?.enabled) {
      return undefined;
    }
    const client = this.deps.rconClients.get(server.alias);
    if (!client) {
      this.log.warn(`watch: ${server.alias} not joining: no rcon client`);
      return undefined;
    }
    this.observeStatus(server.alias, client);
    let protocol: number;
    try {
      const status = await client.getStatus();
      const protocolText = status.cvars['protocol'];
      const gate = connectAllowed({
        protocol:
          protocolText !== undefined && /^-?\d+$/.test(protocolText)
            ? Number(protocolText)
            : null,
        sv_pure: status.cvars['sv_pure'] ?? null,
        sv_punkbuster: status.cvars['sv_punkbuster'] ?? null,
        sv_fps: null,
        keys: {},
      });
      if (!gate.ok) {
        this.log.warn(`watch: ${server.alias} not joining: ${gate.reason}`);
        return undefined;
      }
      protocol = gate.protocol;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'error';
      this.log.warn(
        `watch: ${server.alias} not joining: getstatus failed: ${message}`,
      );
      return undefined;
    }
    const mapName = this.held.get(server.alias)?.status.mapName ?? null;
    const gSpeed = await this.gSpeed(server.alias, mapName, client);
    const entry: HelloServer = {
      alias: server.alias,
      host: server.rconHost,
      port: server.rconPort,
      spectatorName: watch.spectatorName,
      protocol,
      gSpeed,
    };
    // Only a private join carries the secret, and only on hello (see applyChild).
    if (watch.join === 'private' && server.watchPrivatePassword) {
      entry.password = server.watchPrivatePassword;
      this.secrets.add(server.watchPrivatePassword);
    }
    return entry;
  }

  private applyChild(hello: HelloServer[]): void {
    for (const server of hello) {
      const held = this.held.get(server.alias)?.status.mapName?.trim() || null;
      const known = held ?? this.childMaps.get(server.alias) ?? null;
      if (known) {
        server.mapName = known;
      }
    }
    this.lastHello = hello;
    if (hello.length === 0) {
      this.stopChild();
      return;
    }
    if (this.child && this.needsRestart(hello)) {
      this.stopChild();
    }
    if (!this.child) {
      this.backoffIndex = 0;
      this.spawnHello(hello);
      return;
    }
    this.write(this.child.process, reloadMessage(hello));
  }

  /** A new secret has to be the first line of a new process, never a reload. */
  private needsRestart(hello: readonly HelloServer[]): boolean {
    const started = this.child?.passwords;
    if (!started) {
      return false;
    }
    for (const server of hello) {
      if (server.password === undefined) {
        continue;
      }
      if (started.get(server.alias) !== server.password) {
        return true;
      }
    }
    return false;
  }

  private spawnHello(hello: HelloServer[]): void {
    const generation = ++this.childGeneration;
    const child = this.spawnChild(process.execPath, [SCRIPT_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });
    const started: StartedChild = {
      process: child,
      passwords: new Map(
        hello.map((server) => [server.alias, server.password]),
      ),
      generation,
    };
    this.child = started;
    this.childMaps.clear();
    for (const server of hello) {
      const mapName = server.mapName?.trim() || null;
      if (mapName) {
        server.mapName = mapName;
      } else {
        delete server.mapName;
      }
      this.childMaps.set(server.alias, mapName);
    }
    const reader = createInterface({ input: child.stdout });
    reader.on('line', (line) => {
      const life = parseLifeMessage(line);
      if (!life) {
        return;
      }
      void this.enqueue(() => this.handleLife(life));
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      const text = this.redact(String(chunk)).trim();
      if (text.length > 0) {
        this.log.warn(`watch child: ${text}`);
      }
    });
    child.on('exit', () => {
      if (started.generation !== this.childGeneration) {
        return;
      }
      if (this.child?.process === child) {
        this.child = undefined;
      }
      this.scheduleRestart();
    });
    this.write(child, { type: 'hello', servers: hello });
  }

  private scheduleRestart(): void {
    if (!this.running || this.lastHello.length === 0 || this.restartTimer) {
      return;
    }
    const delay =
      BACKOFF_MS[Math.min(this.backoffIndex, BACKOFF_MS.length - 1)] ?? 30_000;
    this.backoffIndex += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.enqueue(async () => {
        if (!this.running || this.child || this.lastHello.length === 0) {
          return;
        }
        this.spawnHello(this.lastHello);
      });
    }, delay);
    this.restartTimer.unref();
  }

  private stopChild(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    const started = this.child;
    this.child = undefined;
    if (!started) {
      return;
    }
    this.childGeneration += 1;
    this.childMaps.clear();
    this.signal(started.process);
  }

  /**
   * A map line is only a rename between two real names. The first name is a
   * reload, which the child adopts without ending open lives. A noted status
   * with the same name confirms the child so a leaver ends as disconnect.
   * Neither line carries a password.
   */
  private publishMaps(): void {
    const noted = new Set(this.noted);
    this.noted.clear();
    const child = this.child;
    if (!child) {
      return;
    }
    let seed = false;
    for (const server of this.lastHello) {
      const mapName =
        this.held.get(server.alias)?.status.mapName?.trim() || null;
      const previous = this.childMaps.get(server.alias) ?? null;
      if (previous === mapName) {
        if (noted.has(server.alias)) {
          this.write(child.process, {
            type: 'confirm',
            serverAlias: server.alias,
            mapName,
          });
        }
        continue;
      }
      this.childMaps.set(server.alias, mapName);
      if (mapName) {
        server.mapName = mapName;
      } else {
        delete server.mapName;
      }
      if (previous !== null && mapName !== null) {
        this.write(child.process, {
          type: 'map',
          serverAlias: server.alias,
          mapName,
        });
        continue;
      }
      if (previous === null && mapName !== null) {
        seed = true;
      }
    }
    if (seed) {
      this.write(child.process, reloadMessage(this.lastHello));
    }
  }

  private signal(child: SpawnedWatch): void {
    const pid = child.pid;
    if (pid !== undefined && pid > 0) {
      try {
        // `detached: false` does not make a new group. A leader still dies
        // with the parent; ESRCH means this pid is not a group leader.
        this.killGroup(pid);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH' && code !== 'EPERM') {
          this.log.error('watch: process group signal failed', error);
        }
      }
    }
    try {
      child.kill('SIGTERM');
    } catch {
      // The child already exited.
    }
  }

  private write(child: SpawnedWatch, value: unknown): void {
    try {
      child.stdin.write(`${JSON.stringify(value)}\n`);
    } catch (error) {
      this.log.error('watch: child stdin closed', error);
    }
  }

  private observeStatus(alias: string, client: WatchRcon): void {
    if (this.observed.has(client)) {
      return;
    }
    this.observed.add(client);
    const original = client.status.bind(client);
    client.status = async () => {
      const status = await original();
      this.noteStatus(alias, status);
      return status;
    };
  }

  private resolver(alias: string, client: WatchRcon) {
    const existing = this.resolvers.get(alias);
    if (existing) {
      return existing;
    }
    const dumpuser = client.dumpuser;
    const created = createPlayerIdentityResolver({
      now: this.now,
      dumpuser:
        typeof dumpuser === 'function'
          ? (_server, name) => dumpuser.call(client, name)
          : undefined,
      status: (server) =>
        this.deps.rconClients.get(server)?.status() ??
        Promise.reject(new Error('no rcon')),
    });
    this.resolvers.set(alias, created);
    return created;
  }

  private async gSpeed(
    alias: string,
    mapName: string | null,
    client: WatchRcon,
  ): Promise<number | null> {
    const cached = this.speedCache.get(alias);
    if (cached && (mapName === null || cached.map === mapName)) {
      return cached.speed;
    }
    let speed: number | null = null;
    try {
      const text = await client.rcon('g_speed');
      const match = /-?\d+(?:\.\d+)?/.exec(text);
      const value = match ? Number(match[0]) : Number.NaN;
      if (Number.isFinite(value) && value > 0) {
        speed = value;
      }
    } catch (error) {
      this.log.warn(
        `watch: ${alias} g_speed unreadable: ${error instanceof Error ? error.message : 'error'}`,
      );
    }
    this.speedCache.set(alias, { map: mapName, speed });
    return speed;
  }

  private async flush(alias: string): Promise<void> {
    const waiting = this.pending.get(alias);
    if (!waiting || waiting.length === 0) {
      return;
    }
    this.pending.delete(alias);
    for (const life of waiting) {
      await this.handleLife(life);
    }
  }

  private hold(life: LifeMessage): void {
    const waiting = this.pending.get(life.serverAlias) ?? [];
    if (waiting.includes(life)) {
      return;
    }
    waiting.push(life);
    // A server that never returns status must not retain every closed life.
    if (waiting.length > PENDING_LIFE_CAP) {
      waiting.shift();
    }
    this.pending.set(life.serverAlias, waiting);
  }

  private async handleLife(life: LifeMessage): Promise<void> {
    if (!this.running || !this.store) {
      return;
    }
    const server = await this.deps.adminStore.getServer(life.serverAlias);
    const watch = server?.watch;
    if (!server || !watch?.enabled) {
      return;
    }
    const client = this.deps.rconClients.get(life.serverAlias);
    if (!client) {
      return;
    }
    const held = this.held.get(life.serverAlias);
    if (!this.isFresh(held)) {
      this.hold(life);
      return;
    }
    const player = held.status.players.find((row) => row.num === life.slot);
    // A fresh status with an empty slot is not the next person to reuse it.
    if (!player) {
      return;
    }
    const identity = await this.resolver(life.serverAlias, client).resolve({
      serverAlias: life.serverAlias,
      player,
      statusFetchedAt: held.fetchedAt,
    });
    const key = identity.key;
    const kind = key ? watchIdentityKind(key) : undefined;
    if (!key || !kind) {
      this.hold(life);
      return;
    }
    const displayName = stripColorCodes(identity.player.name).trim();
    const lastGuid = presentGuid(identity.player.guid);
    const lastIp = identity.player.ip?.trim() || null;
    const mapName = held.status.mapName?.trim() || null;
    const features = life.features;
    if (mapName === null) {
      await this.store.recordLife({
        serverAlias: life.serverAlias,
        profileKey: key,
        kind,
        displayName,
        lastGuid,
        lastIp,
        mapName: null,
        endReason: life.endReason,
        startedAt: new Date(life.startedAtMs),
        endedAt: new Date(life.endedAtMs),
        features,
        lifeScore: null,
        featuresOverFlag: 0,
        aimAgreeing: 0,
        excludedFromPopulation: true,
      });
      await this.rememberName(
        life.serverAlias,
        key,
        displayName,
        life.endedAtMs,
      );
      return;
    }

    const thresholds = thresholdsOf(watch);
    const [snap, away, speed] = await Promise.all([
      this.store.populationMoments({
        serverAlias: life.serverAlias,
        mapName,
        feature: 'snapOnAcquire',
        now: new Date(this.now()),
      }),
      this.store.populationMoments({
        serverAlias: life.serverAlias,
        mapName,
        feature: 'firedWhileLookingAway',
        now: new Date(this.now()),
      }),
      this.store.populationMoments({
        serverAlias: life.serverAlias,
        mapName,
        feature: 'speedOverG',
        now: new Date(this.now()),
      }),
    ]);
    const scored = scoreLife(
      { slot: life.slot, endReason: life.endReason, mapName, ...features },
      {
        confirmedAimFeatures: watch.confirmedAimFeatures,
        thresholds,
        snapOnAcquire: snap,
        firedWhileLookingAway: away,
        speedOverG: speed,
      },
    );
    await this.store.recordLife({
      serverAlias: life.serverAlias,
      profileKey: key,
      kind,
      displayName,
      lastGuid,
      lastIp,
      mapName,
      endReason: life.endReason,
      startedAt: new Date(life.startedAtMs),
      endedAt: new Date(life.endedAtMs),
      features,
      lifeScore: scored.lifeScore,
      featuresOverFlag: scored.featuresOverFlag,
      aimAgreeing: scored.aimAgreeing,
      excludedFromPopulation: scored.excludedFromPopulation,
    });
    await this.rememberName(life.serverAlias, key, displayName, life.endedAtMs);
    if (watch.mode === 'off') {
      return;
    }

    const profile = await this.store.getProfile(life.serverAlias, key);
    const names = await this.store.distinctNames24h(
      life.serverAlias,
      key,
      new Date(this.now()),
    );
    const caps = await this.store.loadCaps({
      serverAlias: life.serverAlias,
      profileKey: key,
      now: new Date(this.now()),
      cooldownMs: watch.cooldownMs,
    });
    const recent = await this.store.recentLives(life.serverAlias, key, 5);
    const sessionKey = `${life.serverAlias}\0${key}`;
    const livesThisSession = (this.sessionLives.get(sessionKey) ?? 0) + 1;
    this.sessionLives.set(sessionKey, livesThisSession);
    if (life.endReason === 'disconnect' || life.endReason === 'map') {
      this.sessionLives.delete(sessionKey);
    }
    const self = profile?.selfMoments;
    const action = decide({
      mode: watch.mode,
      endReason: life.endReason,
      lifeScore: scored.lifeScore,
      featuresOverFlag: scored.featuresOverFlag,
      aimAgreeing: scored.aimAgreeing,
      livesThisSession,
      extremeLivesInLast5: recent.filter(
        (row) => row.lifeScore !== null && row.lifeScore >= watch.kickZ,
      ).length,
      selfLivesByFeature: {
        snapOnAcquire: self?.snapOnAcquire?.n ?? 0,
        firedWhileLookingAway: self?.firedWhileLookingAway?.n ?? 0,
      },
      selfZByFeature: {
        snapOnAcquire: selfZ(
          features.snapOnAcquire,
          self?.snapOnAcquire,
          watch.minSelfLives,
        ),
        firedWhileLookingAway: selfZ(
          features.firedWhileLookingAway,
          self?.firedWhileLookingAway,
          watch.minSelfLives,
        ),
      },
      featureN: { snapOnAcquire: snap.n, firedWhileLookingAway: away.n },
      identityKind: kind,
      distinctNames24h: names,
      confirmedAimFeatures: watch.confirmedAimFeatures,
      kickedThisHour: caps.kickedThisHour,
      cardsThisHour: caps.cardsThisHour,
      cooldownActive: caps.cooldownActive,
      mapName,
      thresholds,
    });
    const target = {
      num: identity.player.num,
      name: displayName || identity.player.name,
      ...(lastGuid ? { guid: lastGuid } : {}),
      ...(lastIp ? { ip: lastIp } : {}),
    };
    const reason = reasonText(scored.lifeScore, features);
    if (action === 'none') {
      const hot =
        scored.lifeScore >= watch.flagZ && scored.featuresOverFlag >= 1;
      if (!hot) {
        return;
      }
      if (!(caps.cardsThisHour < watch.maxCardsPerHour)) {
        await this.writeEvidence(life, key, scored.lifeScore, features, {
          action: 'suppressed',
          reason: 'card_cap',
        });
        return;
      }
      if (caps.cooldownActive) {
        await this.writeEvidence(life, key, scored.lifeScore, features, {
          action: 'suppressed',
          reason: 'cooldown',
        });
      }
      return;
    }
    if (action === 'kick') {
      await this.finishKick({
        life,
        server,
        watch,
        client,
        key,
        kind,
        lastGuid,
        names,
        target,
        scoreReason: reason,
        lifeScore: scored.lifeScore,
        features,
      });
      return;
    }
    if (action === 'flag') {
      const evidenceId = await this.writeEvidence(
        life,
        key,
        scored.lifeScore,
        features,
        {
          action: 'flag',
          reason: 'flag',
        },
      );
      const sent = await this.sendCard(server, watch, {
        profileKey: key,
        target,
        reason,
        disposition: 'flag',
        evidenceId,
      });
      if (sent) {
        await this.audit(life.serverAlias, 'watch_flag', target.name, 'flag', {
          evidenceId,
          lifeScore: scored.lifeScore,
          kind,
          ...(kind === 'ip' ? {} : { profileKey: key }),
        });
      }
      return;
    }
    let reportId: number | undefined;
    if (this.deps.reportQueue) {
      const saved = await this.deps.reportQueue.recordMachine({
        serverAlias: life.serverAlias,
        reporterName: watch.spectatorName,
        targetName: target.name,
        reason,
      });
      reportId = saved.id;
    }
    const evidenceId = await this.writeEvidence(
      life,
      key,
      scored.lifeScore,
      features,
      {
        action: 'report',
        reason: 'report',
        reportId: reportId ?? null,
      },
    );
    await this.sendCard(server, watch, {
      profileKey: key,
      target,
      reason,
      disposition: 'report',
      evidenceId,
      queueId: reportId,
    });
    await this.audit(life.serverAlias, 'watch_report', target.name, 'report', {
      evidenceId,
      lifeScore: scored.lifeScore,
      kind,
      reportId: reportId ?? null,
      ...(kind === 'ip' ? {} : { profileKey: key }),
    });
  }

  /**
   * Death only, and only the slot on a status newer than the life. The map
   * on that status is not stored: `watch_lives.map_name` was written at score time.
   * GUID 0 does not fall through to the IP. An unknown `clientkick` sends nothing else.
   */
  private async finishKick(input: {
    life: LifeMessage;
    server: ServerConfig;
    watch: ServerWatchSettings;
    client: WatchRcon;
    key: string;
    kind: WatchIdentityKind;
    lastGuid: string | null;
    names: number;
    target: MachineReport['target'];
    scoreReason: string;
    lifeScore: number;
    features: WatchLifeFeatures;
  }): Promise<void> {
    const { life, client, key, kind, target } = input;
    if (life.endReason !== 'death') {
      await this.suppressKick(input, 'not_death');
      return;
    }
    const status = await this.statusForKick(
      life.serverAlias,
      client,
      life.endedAtMs,
    );
    if (!status) {
      await this.suppressKick(input, 'stale_status');
      return;
    }
    // The status round trip can outlive a disable, a mode change, or stop().
    const armed = await this.kickStillArmed(life.serverAlias, key);
    if (!armed.ok) {
      await this.suppressKick(
        {
          ...input,
          server: armed.server ?? input.server,
          watch: armed.watch ?? input.watch,
        },
        armed.reason,
      );
      return;
    }
    const { server, watch } = armed;
    const matched = matchKickSlot({
      kind,
      profileKey: key,
      lastGuid: input.lastGuid,
      distinctNames24h: input.names,
      players: status.players,
    });
    if (!matched.ok) {
      await this.suppressKick(input, matched.reason);
      return;
    }
    const kicked: MachineReport['target'] = {
      ...target,
      num: matched.num,
      name: matched.name || target.name,
    };
    let evidenceId = '';
    const result = await executeModerationAction(
      'kick',
      {
        num: kicked.num,
        name: kicked.name,
        ...(kicked.guid ? { guid: kicked.guid } : {}),
        ...(kicked.ip ? { ip: kicked.ip } : {}),
      },
      {
        serverAlias: life.serverAlias,
        rcon: client,
        banStore: this.deps.banStore,
        adminStore: this.deps.adminStore,
        actorTelegramId: 0,
        source: 'auto',
        reason: 'kick',
        auditAction: 'watch_kick',
        chatTemplateId: 'watch_kick',
        slotOnly: true,
        chatTemplates: this.deps.chatTemplates,
        detailJson: { watch: true, lifeScore: input.lifeScore },
        beforeAudit: async () => {
          evidenceId = await this.writeEvidence(
            life,
            key,
            input.lifeScore,
            input.features,
            { action: 'kick', reason: 'kick' },
          );
          return { evidenceId };
        },
      },
    );
    if (result.unknownCommand) {
      await this.suppressKick(input, 'no_clientkick');
      return;
    }
    let queueId: number | undefined;
    if (this.deps.reportQueue) {
      const saved = await this.deps.reportQueue.recordMachine({
        serverAlias: life.serverAlias,
        reporterName: watch.spectatorName,
        targetName: kicked.name,
        reason: input.scoreReason,
      });
      queueId = saved.id;
    }
    await this.sendCard(server, watch, {
      profileKey: key,
      target: kicked,
      reason: input.scoreReason,
      disposition: 'kick',
      evidenceId,
      queueId,
      kickSent: true,
    });
  }

  /** The card is still sent. No second RCON command. */
  private async suppressKick(
    input: {
      life: LifeMessage;
      server: ServerConfig;
      watch: ServerWatchSettings;
      key: string;
      kind: WatchIdentityKind;
      target: MachineReport['target'];
      scoreReason: string;
      lifeScore: number;
      features: WatchLifeFeatures;
    },
    why: string,
  ): Promise<void> {
    const { life, key, kind, target } = input;
    const evidenceId = await this.writeEvidence(
      life,
      key,
      input.lifeScore,
      input.features,
      { action: 'suppressed', reason: why },
    );
    await this.audit(
      life.serverAlias,
      'watch_kick_suppressed',
      target.name,
      why,
      {
        evidenceId,
        lifeScore: input.lifeScore,
        kind,
        reason: why,
        ...(kind === 'ip' ? {} : { profileKey: key }),
      },
    );
    await this.sendCard(input.server, input.watch, {
      profileKey: key,
      target,
      reason: input.scoreReason,
      disposition: 'kick',
      evidenceId,
      kickSent: false,
    });
  }

  /**
   * Settings and caps from after the status wait. A stop, a disable, or a
   * mode other than kick discards the drop. The hour cap is read again
   * because another kick can land during that wait.
   */
  private async kickStillArmed(
    alias: string,
    profileKey: string,
  ): Promise<
    | { ok: true; server: ServerConfig; watch: ServerWatchSettings }
    | {
        ok: false;
        reason: string;
        server?: ServerConfig;
        watch?: ServerWatchSettings;
      }
  > {
    if (!this.running || !this.store) {
      return { ok: false, reason: 'stopped' };
    }
    const server = await this.deps.adminStore.getServer(alias);
    const watch = server?.watch ?? undefined;
    if (!this.running) {
      return { ok: false, reason: 'stopped', server, watch };
    }
    if (!server || !watch?.enabled) {
      return { ok: false, reason: 'disabled', server };
    }
    if (watch.mode !== 'kick') {
      return { ok: false, reason: 'mode', server, watch };
    }
    const caps = await this.store.loadCaps({
      serverAlias: alias,
      profileKey,
      now: new Date(this.now()),
      cooldownMs: watch.cooldownMs,
    });
    if (!this.running) {
      return { ok: false, reason: 'stopped', server, watch };
    }
    if (!(caps.kickedThisHour < watch.maxKicksPerHour)) {
      return { ok: false, reason: 'kick_cap', server, watch };
    }
    if (caps.cooldownActive) {
      return { ok: false, reason: 'cooldown', server, watch };
    }
    if (!(caps.cardsThisHour < watch.maxCardsPerHour)) {
      return { ok: false, reason: 'card_cap', server, watch };
    }
    return { ok: true, server, watch };
  }

  private async profileForKick(
    serverAlias: string,
    profileKey: string,
  ): Promise<
    { lastGuid: string | null; distinctNames24h: number } | undefined
  > {
    if (!this.store) {
      return undefined;
    }
    const [profile, distinctNames24h] = await Promise.all([
      this.store.getProfile(serverAlias, profileKey),
      this.store.distinctNames24h(
        serverAlias,
        profileKey,
        new Date(this.now()),
      ),
    ]);
    return { lastGuid: profile?.lastGuid ?? null, distinctNames24h };
  }

  /**
   * Slot match only. A cached row counts when it was fetched after the death.
   * This does not write `map_name`.
   */
  private async statusForKick(
    alias: string,
    client: WatchRcon,
    endedAtMs: number,
  ): Promise<ServerStatus | undefined> {
    const held = this.held.get(alias);
    if (held && held.fetchedAt > endedAtMs) {
      return held.status;
    }
    try {
      await client.status();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'error';
      this.log.warn(`watch: ${alias} kick status failed: ${message}`);
      return undefined;
    }
    const again = this.held.get(alias);
    if (again && again.fetchedAt > endedAtMs) {
      return again.status;
    }
    return undefined;
  }

  private async writeEvidence(
    life: LifeMessage,
    profileKey: string,
    lifeScore: number,
    features: WatchLifeFeatures,
    extra: {
      action: 'flag' | 'report' | 'kick' | 'suppressed';
      reason: string;
      reportId?: number | null;
    },
  ): Promise<string> {
    return this.store!.recordEvidence({
      serverAlias: life.serverAlias,
      profileKey,
      action: extra.action,
      reason: extra.reason,
      createdAt: new Date(this.now()),
      lifeScore,
      features,
      reportId: extra.reportId ?? null,
    });
  }

  private async sendCard(
    server: ServerConfig,
    watch: ServerWatchSettings,
    report: Omit<MachineReport, 'serverAlias' | 'reporterName'>,
  ): Promise<boolean> {
    const chatId = server.boundTelegramChatId;
    const create = this.deps.createCardSender;
    if (chatId == null || !create) {
      return false;
    }
    const machine: MachineReport = {
      serverAlias: server.alias,
      reporterName: watch.spectatorName,
      ...report,
    };
    await processMachineReport(machine, {
      chatId,
      cardSender: create(machine),
    });
    return true;
  }

  private async rememberName(
    serverAlias: string,
    profileKey: string,
    strippedName: string,
    endedAtMs: number,
  ): Promise<void> {
    if (!strippedName) {
      return;
    }
    await this.store!.upsertProfileName({
      serverAlias,
      profileKey,
      strippedName,
      seenAt: new Date(endedAtMs),
    });
  }

  private async audit(
    serverAlias: string,
    action: string,
    target: string,
    reason: string,
    detailJson: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.adminStore.recordAuditLog({
      actorTelegramId: 0,
      action,
      target,
      serverAlias,
      reason,
      source: 'auto',
      detailJson,
    });
  }

  private isFresh(held: HeldStatus | undefined): held is HeldStatus {
    if (!held) {
      return false;
    }
    const at = this.now();
    return at >= held.fetchedAt && at - held.fetchedAt <= FRESH_STATUS_MS;
  }

  private redact(text: string): string {
    let out = text;
    for (const secret of this.secrets) {
      if (secret.length > 0) {
        out = out.split(secret).join('[redacted]');
      }
    }
    return out;
  }
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: { stdio: ['pipe', 'pipe', 'pipe']; detached: false },
): SpawnedWatch {
  // Pipes, and not detached: a detached child would survive the gateway.
  return spawn(command, [...args], options) as SpawnedWatch;
}

function defaultKillGroup(pid: number): void {
  process.kill(-pid, 'SIGTERM');
}

function thresholdsOf(watch: ServerWatchSettings): WatchThresholds {
  return {
    flagZ: watch.flagZ,
    kickZ: watch.kickZ,
    minFeatureN: watch.minFeatureN,
    minSelfLives: watch.minSelfLives,
    kickExtremeLives: watch.kickExtremeLives,
    kickMinSessionLives: watch.kickMinSessionLives,
    maxKicksPerHour: watch.maxKicksPerHour,
    maxCardsPerHour: watch.maxCardsPerHour,
  };
}

function presentGuid(guid: string | undefined): string | null {
  if (!guid || guid.trim() === '' || guid.trim() === '0') {
    return null;
  }
  return guid.trim();
}

/** Self z uses the stored moments. An IPC `selfLives` field is not an input. */
function selfZ(
  value: number | undefined,
  moments: PopulationMoments | undefined,
  minSelfLives: number,
): number | undefined {
  if (value === undefined || moments === undefined) {
    return undefined;
  }
  if (moments.n < minSelfLives || moments.n < 2 || moments.m2 <= 0) {
    return undefined;
  }
  const sd = Math.sqrt(moments.m2 / (moments.n - 1));
  if (!Number.isFinite(sd) || sd === 0) {
    return undefined;
  }
  const z = (value - moments.mean) / sd;
  return Number.isFinite(z) ? z : undefined;
}

function reasonText(lifeScore: number, features: WatchLifeFeatures): string {
  const parts = [`z=${lifeScore.toFixed(1)}`];
  if (features.snapOnAcquire !== undefined) {
    parts.push(`snap ${features.snapOnAcquire.toFixed(1)}`);
  }
  if (features.firedWhileLookingAway !== undefined) {
    parts.push('looking away');
  }
  if (features.speedOverG !== undefined) {
    parts.push(`speed ${features.speedOverG.toFixed(2)}`);
  }
  return parts.join(', ');
}

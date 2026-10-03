import dgram from 'node:dgram';
import { buildOobPacket, parseOobPacket, type OobPacket } from './protocol.js';
import type { TextEncoding } from './text-encoding.js';

export interface UdpTransportOptions {
  host: string;
  port: number;
  /** How long one attempt waits for the *first* reply packet before it counts as dropped. */
  timeoutMs: number;
  /** Additional attempts after the first, on timeout — UDP packets can be silently dropped. */
  retries: number;
  /** Pause between a timed-out attempt and the next one. */
  retryDelayMs: number;
  /**
   * How long to keep listening after each reply packet for more packets of the same response.
   * The server splits long `print` output (e.g. `rcon status` with many players) across several
   * packets, each with its own header, sent back-to-back — see `mergePackets`.
   */
  multiPacketWaitMs: number;
  /** Runs before every attempt, retries included — e.g. the client's own send-rate limiter. */
  beforeAttempt?: () => Promise<void>;
  /** How the payload is encoded and replies are decoded — see text-encoding.ts. */
  encoding: TextEncoding;
}

export class UdpQueryTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UdpQueryTimeoutError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sends one OOB packet and resolves with the (possibly multi-packet) reply, retrying on timeout.
 *
 * Retrying is deliberately aggressive (short attempts, many of them): a real busy server
 * (docs/PLAN.md §2.4, "Rate limiting") was measured dropping ~50% of incoming queries in bursts of
 * a few seconds — and dropping them *before* executing them (a missing reply to `rcon set` left the
 * cvar unchanged every time), so a retry doesn't run a command twice in that case.
 */
export async function sendOobQuery(payload: string, options: UdpTransportOptions): Promise<OobPacket> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    if (attempt > 0 && options.retryDelayMs > 0) {
      await sleep(options.retryDelayMs);
    }
    await options.beforeAttempt?.();
    try {
      return await sendOnce(payload, options);
    } catch (err) {
      lastError = err;
      if (!(err instanceof UdpQueryTimeoutError)) {
        break;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Joins a multi-packet response: every packet repeats the header line (e.g. `print`), and the
 * bodies are raw continuations of one another — a split can land mid-line, so they're
 * concatenated as-is, never with a separator. Packets with a different header aren't part of
 * this response and are ignored.
 */
export function mergePackets(packets: OobPacket[]): OobPacket {
  const [first] = packets;
  return {
    header: first.header,
    body: packets
      .filter((packet) => packet.header === first.header)
      .map((packet) => packet.body)
      .join(''),
  };
}

function sendOnce(payload: string, options: UdpTransportOptions): Promise<OobPacket> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const packets: OobPacket[] = [];
    let settled = false;
    let quietTimer: NodeJS.Timeout | undefined;

    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new UdpQueryTimeoutError(
            `Timed out waiting for a response to "${payload.split(' ')[0]}" after ${options.timeoutMs}ms`,
          ),
        ),
      );
    }, options.timeoutMs);

    function settle(action: () => void): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(quietTimer);
      socket.close();
      action();
    }

    socket.once('error', (err) => settle(() => reject(err)));

    socket.on('message', (data) => {
      let packet: OobPacket;
      try {
        packet = parseOobPacket(data, options.encoding);
      } catch (err) {
        settle(() => reject(err));
        return;
      }
      packets.push(packet);
      // A reply has started arriving, so this attempt didn't time out — from here on, it ends once
      // no further packet shows up within multiPacketWaitMs.
      clearTimeout(timer);
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => settle(() => resolve(mergePackets(packets))), options.multiPacketWaitMs);
    });

    const packet = buildOobPacket(payload, options.encoding);
    socket.send(packet, options.port, options.host, (err) => {
      if (err) {
        settle(() => reject(err));
      }
    });
  });
}

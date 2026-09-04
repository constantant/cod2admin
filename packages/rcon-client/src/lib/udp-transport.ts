import dgram from 'node:dgram';
import { buildOobPacket, parseOobPacket, type OobPacket } from './protocol.js';

export interface UdpTransportOptions {
  host: string;
  port: number;
  timeoutMs: number;
  /** Additional attempts after the first, on timeout — UDP packets can be silently dropped. */
  retries: number;
}

export class UdpQueryTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UdpQueryTimeoutError';
  }
}

/** Sends one OOB packet and resolves with the first reply, retrying on timeout. */
export async function sendOobQuery(payload: string, options: UdpTransportOptions): Promise<OobPacket> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    try {
      return await sendOnce(payload, options);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function sendOnce(payload: string, options: UdpTransportOptions): Promise<OobPacket> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;

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
      socket.close();
      action();
    }

    socket.once('error', (err) => settle(() => reject(err)));

    socket.once('message', (data) => {
      settle(() => {
        try {
          resolve(parseOobPacket(data));
        } catch (err) {
          reject(err);
        }
      });
    });

    const packet = buildOobPacket(payload);
    socket.send(packet, options.port, options.host, (err) => {
      if (err) {
        settle(() => reject(err));
      }
    });
  });
}

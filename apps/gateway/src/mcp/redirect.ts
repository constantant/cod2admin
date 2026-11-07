import { BlockList, isIP } from 'node:net';

/**
 * Redirect targets an AI app may register. HTTPS anywhere public, or HTTP only on the machine
 * running the app (RFC 8252 loopback). No fragments, no embedded credentials, no private hosts:
 * an authorization code must not be deliverable to an address the server cannot trust.
 */
export function isAllowedRedirect(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) {
    return false;
  }
  if (url.protocol === 'http:') {
    return isLoopback(url.hostname);
  }
  if (url.protocol !== 'https:') {
    return false;
  }
  return !isBlockedHostname(url.hostname);
}

export function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal'
  ) {
    return true;
  }
  return isIP(host) !== 0 && isBlockedAddress(host);
}

const BLOCKED = new BlockList();
for (const [subnet, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(subnet, prefix, 'ipv4');
}
BLOCKED.addAddress('::', 'ipv6');
BLOCKED.addAddress('::1', 'ipv6');
BLOCKED.addSubnet('fc00::', 7, 'ipv6');
BLOCKED.addSubnet('fe80::', 10, 'ipv6');
BLOCKED.addSubnet('ff00::', 8, 'ipv6');

/** True for addresses that are not a public unicast target, including IPv4-mapped IPv6. */
export function isBlockedAddress(address: string): boolean {
  let value = address.toLowerCase().replace(/^\[|\]$/g, '');
  // Dotted IPv4-mapped form (`::ffff:127.0.0.1`) is checked as IPv4. The hex form
  // (`::ffff:7f00:1`) stays IPv6; DNS lookup returns the dotted form.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped) {
    value = mapped[1]!;
  }
  const family = isIP(value);
  if (family === 0) {
    return true;
  }
  return BLOCKED.check(value, family === 4 ? 'ipv4' : 'ipv6');
}

/** The host a person should compare with the app they think they are connecting. */
export function redirectHost(value: string): string {
  return new URL(value).host;
}

/** One line, no control characters, so a client name cannot fake a second message. */
export function displayName(value: string | undefined): string {
  const cleaned = (value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || 'Unnamed application').slice(0, 80);
}

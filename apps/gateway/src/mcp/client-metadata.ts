import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import {
  displayName,
  isAllowedRedirect,
  isBlockedAddress,
  isBlockedHostname,
} from './redirect.js';

const DOCUMENT_BYTES = 8 * 1024;
const FETCH_TIMEOUT_MS = 5_000;

export class ClientMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientMetadataError';
  }
}

export interface ClientMetadata {
  clientId: string;
  clientName: string;
  redirectUris: string[];
}

export type AddressLookup = (
  hostname: string,
  options: LookupOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
) => void;

/**
 * Wraps a DNS lookup so a client-metadata fetch cannot be pointed at a private address.
 * Node asks for every address (`options.all`). One blocked answer rejects the name.
 */
export function guardLookup(lookup: AddressLookup): AddressLookup {
  return (hostname, options, callback) => {
    lookup(hostname, { ...options, all: true }, (error, address, family) => {
      const list = Array.isArray(address)
        ? address
        : typeof address === 'string' && address
          ? [{ address, family: family ?? 4 }]
          : [];
      if (error || list.length === 0 || list.some((entry) => isBlockedAddress(entry.address))) {
        callback(error ?? new Error('blocked address'), options.all ? [] : '', 4);
        return;
      }
      if (options.all) {
        callback(null, list);
        return;
      }
      const first = list[0]!;
      callback(null, first.address, first.family);
    });
  };
}

/**
 * Loads a client-id metadata document (the MCP registration path that replaced open dynamic
 * registration). The document is fetched only after its address is checked, with redirects
 * refused, so a client id cannot be used to reach an internal host. When this host is refused,
 * `fetchDocument` may try the Telegram relays (`fetchClientDocument`).
 */
export async function loadClientMetadata(
  clientId: string,
  fetchDocument: (url: URL) => Promise<string> = fetchPublicHttps,
): Promise<ClientMetadata> {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new ClientMetadataError('client_id must be an https URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new ClientMetadataError('client_id must be an https URL with no credentials.');
  }
  if (isBlockedHostname(url.hostname)) {
    throw new ClientMetadataError('client_id points at a blocked host.');
  }

  let body: string;
  try {
    body = await fetchDocument(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'fetch failed';
    throw new ClientMetadataError(`Could not read the client metadata: ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new ClientMetadataError('Client metadata is not JSON.');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new ClientMetadataError('Client metadata is not a JSON object.');
  }
  const document = parsed as Record<string, unknown>;
  if (document['client_id'] !== clientId) {
    throw new ClientMetadataError('client_id in the metadata does not match the URL.');
  }
  const redirects = document['redirect_uris'];
  if (!Array.isArray(redirects) || redirects.length === 0 || redirects.length > 10) {
    throw new ClientMetadataError('Client metadata needs one to ten redirect URIs.');
  }
  const redirectUris: string[] = [];
  for (const entry of redirects) {
    if (typeof entry !== 'string' || !isAllowedRedirect(entry)) {
      throw new ClientMetadataError('A redirect URI is not allowed.');
    }
    redirectUris.push(entry);
  }
  const name = document['client_name'];
  return {
    clientId,
    clientName: displayName(typeof name === 'string' ? name : undefined),
    redirectUris,
  };
}

/**
 * HTTPS GET that refuses private addresses at connect time and refuses redirects. Exported so
 * tests can substitute the lookup without opening a socket.
 */
export function fetchPublicHttps(
  url: URL,
  lookup: AddressLookup = blockingLookup,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: 'GET',
        timeout: FETCH_TIMEOUT_MS,
        headers: { accept: 'application/json' },
        lookup,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.resume();
          reject(new Error('redirects are not followed'));
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error(`HTTP ${status}`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > DOCUMENT_BYTES) {
            req.destroy(new Error('client metadata is too large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end();
  });
}

const blockingLookup = guardLookup((hostname, options, callback) => {
  dnsLookup(hostname, options, (error, address, family) => {
    callback(error, address, family);
  });
});

export interface ClientDocumentOptions {
  /** Relay base URLs, tried in order when this host itself cannot read the document. */
  relays?: readonly string[];
  fetchDirect?: (url: URL) => Promise<string>;
  fetchRelay?: (endpoint: URL) => Promise<{ status: number; body: string }>;
}

/**
 * Reads a client-metadata document from this host. Claude answers Russian addresses with a
 * redirect, and ChatGPT with 403, while the same URL is a small JSON document from the relays'
 * network. A relay is asked only after the direct read fails, and only for the same URL.
 */
export async function fetchClientDocument(
  url: URL,
  options: ClientDocumentOptions = {},
): Promise<string> {
  const fetchDirect = options.fetchDirect ?? ((target: URL) => fetchPublicHttps(target));
  try {
    return await fetchDirect(url);
  } catch (directError) {
    for (const relay of options.relays ?? []) {
      const endpoint = relayMetadataEndpoint(relay, url);
      if (!endpoint) {
        continue;
      }
      try {
        const response = options.fetchRelay
          ? await options.fetchRelay(endpoint)
          : await readRelay(endpoint);
        if (response.status === 200 && response.body.length <= DOCUMENT_BYTES) {
          return response.body;
        }
      } catch {
        // The next relay may be reachable. The direct error is what the visitor is shown.
      }
    }
    // An older relay answers 404 for this route. The copies below are the public documents
    // those two hosts serve outside Russia (2026-11-07), so a Russian install can connect
    // before its relays are redeployed. A relay that returns the document wins above.
    const known = knownClientDocument(url);
    if (known) {
      return known;
    }
    throw directError;
  }
}

/**
 * Public client documents Claude and ChatGPT serve from outside Russia. The ChatGPT per-connection
 * document is the stable one with the callback id filled in. Only the name and redirect list are
 * kept; the authorization server does not use the rest.
 */
export function knownClientDocument(url: URL): string | undefined {
  const id = url.toString();
  const fixed: Record<string, { name: string; redirects: string[] }> = {
    'https://claude.ai/oauth/mcp-oauth-client-metadata': {
      name: 'Claude',
      redirects: ['https://claude.ai/api/mcp/auth_callback'],
    },
    'https://claude.ai/oauth/claude-code-client-metadata': {
      name: 'Claude Code',
      redirects: ['http://localhost/callback', 'http://127.0.0.1/callback'],
    },
    'https://claude.ai/oauth/mcp-oauth-client-metadata/confidential_client': {
      name: 'Claude',
      redirects: ['https://claude.ai/api/mcp/auth_callback'],
    },
    'https://chatgpt.com/oauth/client.json': {
      name: 'ChatGPT',
      redirects: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    },
  };
  const match = fixed[id];
  if (match) {
    return JSON.stringify({ client_id: id, client_name: match.name, redirect_uris: match.redirects });
  }
  const callback = /^https:\/\/chatgpt\.com\/oauth\/([A-Za-z0-9_-]{8,64})\/client\.json$/.exec(id);
  if (!callback) {
    return undefined;
  }
  return JSON.stringify({
    client_id: id,
    client_name: 'ChatGPT',
    redirect_uris: [`https://chatgpt.com/connector/oauth/${callback[1]}`],
  });
}

function relayMetadataEndpoint(relay: string, target: URL): URL | undefined {
  let base: URL;
  try {
    base = new URL(relay);
  } catch {
    return undefined;
  }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    return undefined;
  }
  const path = base.pathname.replace(/\/$/, '');
  return new URL(
    `${base.origin}${path}/client-metadata?url=${encodeURIComponent(target.toString())}`,
  );
}

async function readRelay(endpoint: URL): Promise<{ status: number; body: string }> {
  const response = await fetch(endpoint, {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  const body = await response.text();
  return {
    status: response.status,
    body: body.length > DOCUMENT_BYTES ? body.slice(0, DOCUMENT_BYTES + 1) : body,
  };
}

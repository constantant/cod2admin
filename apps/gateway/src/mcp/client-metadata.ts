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
 * refused, so a client id cannot be used to reach an internal host.
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

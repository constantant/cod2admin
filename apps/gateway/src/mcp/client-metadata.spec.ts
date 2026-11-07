import { describe, expect, it } from 'vitest';
import { fetchPublicHttps, guardLookup, loadClientMetadata } from './client-metadata.js';

const CLIENT_ID = 'https://app.example/client.json';

function document(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    client_id: CLIENT_ID,
    client_name: 'Example\nApp',
    redirect_uris: ['http://127.0.0.1:8787/callback'],
    ...overrides,
  });
}

describe('loadClientMetadata', () => {
  it('reads a matching document and cleans the client name', async () => {
    const metadata = await loadClientMetadata(CLIENT_ID, async () => document());

    expect(metadata).toEqual({
      clientId: CLIENT_ID,
      clientName: 'Example App',
      redirectUris: ['http://127.0.0.1:8787/callback'],
    });
  });

  it('does not fetch a client id that points at a blocked host', async () => {
    let fetched = false;
    const fetchDocument = async () => {
      fetched = true;
      return document();
    };

    await expect(
      loadClientMetadata('https://127.0.0.1/client.json', fetchDocument),
    ).rejects.toThrow(/blocked/);
    await expect(
      loadClientMetadata('https://metadata.google.internal/client.json', fetchDocument),
    ).rejects.toThrow(/blocked/);
    await expect(loadClientMetadata('http://app.example/client.json', fetchDocument)).rejects.toThrow(
      /https/,
    );
    await expect(
      loadClientMetadata('https://user:pass@app.example/client.json', fetchDocument),
    ).rejects.toThrow(/credentials/);
    expect(fetched).toBe(false);
  });

  it('rejects a document whose client id or redirects do not match the rules', async () => {
    await expect(
      loadClientMetadata(
        CLIENT_ID,
        async () => document({ client_id: 'https://other.example/client.json' }),
      ),
    ).rejects.toThrow(/does not match/);
    await expect(
      loadClientMetadata(
        CLIENT_ID,
        async () => document({ redirect_uris: ['https://192.168.0.1/callback'] }),
      ),
    ).rejects.toThrow(/not allowed/);
    await expect(
      loadClientMetadata(CLIENT_ID, async () => document({ redirect_uris: [] })),
    ).rejects.toThrow(/one to ten/);
  });
});

describe('guardLookup', () => {
  it('rejects a private address, including one mixed with a public address', () => {
    const lookup = guardLookup((_hostname, options, callback) => {
      expect(options.all).toBe(true);
      callback(null, [
        { address: '1.1.1.1', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ]);
    });

    lookup('metadata.example', { all: true }, (error, address) => {
      expect(error?.message).toMatch(/blocked address/);
      expect(address).toEqual([]);
    });
  });

  it('returns public addresses in the shape Node asked for', () => {
    const lookup = guardLookup((_hostname, _options, callback) => {
      callback(null, [{ address: '1.1.1.1', family: 4 }]);
    });

    lookup('example.com', { all: true }, (error, address) => {
      expect(error).toBeNull();
      expect(address).toEqual([{ address: '1.1.1.1', family: 4 }]);
    });
    lookup('example.com', {}, (error, address, family) => {
      expect(error).toBeNull();
      expect(address).toBe('1.1.1.1');
      expect(family).toBe(4);
    });
  });
});

describe('fetchPublicHttps', () => {
  it('surfaces a lookup failure without reading a response', async () => {
    await expect(
      fetchPublicHttps(new URL(CLIENT_ID), (_hostname, _options, callback) => {
        callback(new Error('blocked address'), []);
      }),
    ).rejects.toThrow(/blocked address/);
  });
});

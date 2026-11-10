import { describe, expect, it, vi } from 'vitest';
import { createGithubReleaseClient } from './github-releases.js';

function fakeFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
  }) as unknown as typeof fetch;
}

const RELEASE_BODY = {
  tag_name: 'v0.0.5',
  body: '### 0.0.5\n\n- did a thing',
  assets: [
    {
      name: 'cod2admin-0.0.5.tar.gz',
      browser_download_url: 'https://example.com/cod2admin-0.0.5.tar.gz',
    },
    {
      name: 'cod2admin-gateway-0.0.5.tar.gz',
      browser_download_url:
        'https://example.com/cod2admin-gateway-0.0.5.tar.gz',
    },
    {
      name: 'cod2admin-gateway-0.0.5.tar.gz.sha256',
      browser_download_url:
        'https://example.com/cod2admin-gateway-0.0.5.tar.gz.sha256',
    },
  ],
};

describe('createGithubReleaseClient', () => {
  it('parses the tag, notes, and the gateway/checksum assets, ignoring the outer installer archive', async () => {
    const client = createGithubReleaseClient(fakeFetch(RELEASE_BODY));
    const release = await client.getLatestRelease();
    expect(release).toEqual({
      tagName: 'v0.0.5',
      notes: '### 0.0.5\n\n- did a thing',
      gatewayAsset: {
        name: 'cod2admin-gateway-0.0.5.tar.gz',
        downloadUrl: 'https://example.com/cod2admin-gateway-0.0.5.tar.gz',
      },
      checksumAsset: {
        name: 'cod2admin-gateway-0.0.5.tar.gz.sha256',
        downloadUrl:
          'https://example.com/cod2admin-gateway-0.0.5.tar.gz.sha256',
      },
    });
  });

  it('throws when the response is not ok', async () => {
    const client = createGithubReleaseClient(fakeFetch({}, false, 404));
    await expect(client.getLatestRelease()).rejects.toThrow(/404/);
  });

  it('throws a clear error when the release predates self-update assets', async () => {
    const client = createGithubReleaseClient(
      fakeFetch({
        tag_name: 'v0.0.3',
        assets: [{ name: 'cod2admin-0.0.3.tar.gz', browser_download_url: 'x' }],
      }),
    );
    await expect(client.getLatestRelease()).rejects.toThrow(/v0.0.3/);
  });

  it('lists recent release notes newest first, leaving out drafts and pre-releases', async () => {
    const client = createGithubReleaseClient(
      fakeFetch([
        {
          tag_name: 'v0.0.6',
          body: 'six',
          published_at: '2026-11-02T10:00:00Z',
          assets: [],
        },
        { tag_name: 'v0.0.6-rc1', body: 'rc', prerelease: true, assets: [] },
        { tag_name: 'v0.0.7', body: 'draft', draft: true, assets: [] },
        { tag_name: 'v0.0.5', assets: [] },
      ]),
    );
    expect(await client.listReleaseNotes(5)).toEqual([
      { tagName: 'v0.0.6', publishedAt: '2026-11-02T10:00:00Z', notes: 'six' },
      { tagName: 'v0.0.5', publishedAt: null, notes: '' },
    ]);
  });

  it('throws when listing the releases fails', async () => {
    const client = createGithubReleaseClient(fakeFetch([], false, 403));
    await expect(client.listReleaseNotes(5)).rejects.toThrow(/403/);
  });
});

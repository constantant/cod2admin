import { vi, type Mock } from 'vitest';
import type { GithubRelease, GithubReleaseClient } from '../github-releases.js';

export interface FakeGithubReleaseClient extends GithubReleaseClient {
  getLatestRelease: Mock<GithubReleaseClient['getLatestRelease']>;
}

export function sampleRelease(overrides: Partial<GithubRelease> = {}): GithubRelease {
  return {
    tagName: 'v0.0.5',
    notes: '- did a thing',
    gatewayAsset: { name: 'cod2admin-gateway-0.0.5.tar.gz', downloadUrl: 'https://example.com/cod2admin-gateway-0.0.5.tar.gz' },
    checksumAsset: {
      name: 'cod2admin-gateway-0.0.5.tar.gz.sha256',
      downloadUrl: 'https://example.com/cod2admin-gateway-0.0.5.tar.gz.sha256',
    },
    ...overrides,
  };
}

export function createFakeGithubReleaseClient(release: GithubRelease = sampleRelease()): FakeGithubReleaseClient {
  return {
    getLatestRelease: vi.fn().mockResolvedValue(release),
  };
}

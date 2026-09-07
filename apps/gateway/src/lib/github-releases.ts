const RELEASES_URL = 'https://api.github.com/repos/constantant/cod2admin/releases/latest';

export interface GithubReleaseAsset {
  name: string;
  downloadUrl: string;
}

export interface GithubRelease {
  tagName: string;
  notes: string;
  gatewayAsset: GithubReleaseAsset;
  checksumAsset: GithubReleaseAsset;
}

export interface GithubReleaseClient {
  getLatestRelease(): Promise<GithubRelease>;
}

interface GithubReleaseApiAsset {
  name: string;
  browser_download_url: string;
}

interface GithubReleaseApiResponse {
  tag_name: string;
  body?: string;
  assets: GithubReleaseApiAsset[];
}

type FetchFn = typeof fetch;

/**
 * docs/PLAN.md §13.2/§13.3 — `scripts/release.sh` publishes the gateway tarball and its `.sha256`
 * as their own release assets (alongside the human-facing installer archive), so this fetches
 * them directly rather than unwrapping a tarball-inside-a-tarball. Takes `fetchFn` as a parameter
 * (defaulting to the global `fetch`) rather than reaching for it internally, so tests can inject
 * a fake instead of hitting the real network — this codebase's established DI-over-mocking-
 * globals convention (see apps/gateway/src/lib/testing/fake-*.ts).
 */
export function createGithubReleaseClient(fetchFn: FetchFn = fetch): GithubReleaseClient {
  return {
    async getLatestRelease(): Promise<GithubRelease> {
      const res = await fetchFn(RELEASES_URL, {
        headers: { accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        throw new Error(`GitHub releases API returned ${res.status} ${res.statusText}`);
      }
      const body = (await res.json()) as GithubReleaseApiResponse;
      const gatewayAsset = body.assets.find((asset) => /^cod2admin-gateway-.*\.tar\.gz$/.test(asset.name));
      const checksumAsset = body.assets.find((asset) => /^cod2admin-gateway-.*\.tar\.gz\.sha256$/.test(asset.name));
      if (!gatewayAsset || !checksumAsset) {
        throw new Error(
          `Latest release ${body.tag_name} is missing the gateway tarball or its checksum asset ` +
            '(published before self-update support, or a broken release) - cannot self-update to it.',
        );
      }
      return {
        tagName: body.tag_name,
        notes: body.body ?? '',
        gatewayAsset: { name: gatewayAsset.name, downloadUrl: gatewayAsset.browser_download_url },
        checksumAsset: { name: checksumAsset.name, downloadUrl: checksumAsset.browser_download_url },
      };
    },
  };
}

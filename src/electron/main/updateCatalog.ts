const RELEASES_API = 'https://api.github.com/repos/redoszeryk0-sys/OrbitChat-releases/releases';

export interface AvailableUpdate {
  tag: string;
  version: string;
  notes: string;
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseVersion(value: string): ParsedVersion | null {
  let normalized = value.trim().replace(/^v/i, '');
  normalized = normalized.replace(/^(\d+\.\d+\.\d+)\.0(?=$|[-+])/, '$1');
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(normalized);
  if (!match) return null;
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return { major, minor, patch, prerelease: match[4]?.split('.') ?? [] };
}

function compareVersion(left: ParsedVersion, right: ParsedVersion): number {
  for (const field of ['major', 'minor', 'patch'] as const) {
    if (left[field] !== right[field]) return left[field] > right[field] ? 1 : -1;
  }
  if (!left.prerelease.length) return right.prerelease.length ? 1 : 0;
  if (!right.prerelease.length) return -1;
  for (let index = 0; index < Math.min(left.prerelease.length, right.prerelease.length); index++) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === b) continue;
    const aNumeric = /^(0|[1-9]\d*)$/.test(a);
    const bNumeric = /^(0|[1-9]\d*)$/.test(b);
    if (aNumeric && bNumeric) return Number(a) > Number(b) ? 1 : -1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a.localeCompare(b, 'en', { sensitivity: 'base' });
  }
  return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length > right.prerelease.length ? 1 : -1;
}

function isGitHubDownloadUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['github.com', 'release-assets.githubusercontent.com'].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Select the highest stable release that has a matching Windows x64 portable ZIP. */
export function findAvailableUpdate(releases: unknown, currentVersion: string): AvailableUpdate | null {
  const installed = parseVersion(currentVersion);
  if (!installed || !Array.isArray(releases)) return null;

  const candidates: Array<{ update: AvailableUpdate; version: ParsedVersion }> = [];
  for (const release of releases) {
    if (!isRecord(release) || release.draft === true || release.prerelease === true || typeof release.tag_name !== 'string') continue;
    const tag = release.tag_name.trim();
    const version = parseVersion(tag);
    if (!version || version.prerelease.length) continue;
    if (!Array.isArray(release.assets)) continue;

    const expected = new Set([`Orbit-Chat-${tag}-win-x64.zip`, `Orbit-Chat-${tag.replace(/^v/i, '')}-win-x64.zip`]);
    const hasWindowsZip = release.assets.some((asset) => isRecord(asset) && typeof asset.name === 'string' &&
      expected.has(asset.name) && isGitHubDownloadUrl(asset.browser_download_url));
    if (!hasWindowsZip || compareVersion(version, installed) <= 0) continue;

    const versionLabel = tag.replace(/^v/i, '');
    candidates.push({
      version,
      update: { tag, version: versionLabel, notes: typeof release.body === 'string' ? release.body.slice(0, 8_000) : '' },
    });
  }

  candidates.sort((a, b) => compareVersion(b.version, a.version));
  return candidates[0]?.update ?? null;
}

async function getReleasePage(page: number): Promise<unknown[]> {
  const response = await fetch(`${RELEASES_API}?per_page=100&page=${page}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'OrbitChat-Desktop-Updater/1.0',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(12_000),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`GitHub release lookup failed (HTTP ${response.status}).`);
  const result: unknown = await response.json();
  if (!Array.isArray(result)) throw new Error('GitHub returned an invalid release list.');
  return result;
}

export async function checkForOrbitChatUpdate(currentVersion: string): Promise<AvailableUpdate | null> {
  const releases: unknown[] = [];
  for (let page = 1; page <= 5; page++) {
    const next = await getReleasePage(page);
    releases.push(...next);
    if (next.length < 100) break;
  }
  return findAvailableUpdate(releases, currentVersion);
}

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const UPDATER_RELEASE_API = 'https://api.github.com/repos/redoszeryk0-sys/OrbitChat-releases/releases/tags/Online_installer';
const UPDATER_ASSET_NAME = 'Orbit-Chat-Updater.exe';
const MAX_UPDATER_BYTES = 200 * 1024 * 1024;

interface GitHubAsset {
  name?: unknown;
  size?: unknown;
  digest?: unknown;
  browser_download_url?: unknown;
}

function trustedDownloadUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['github.com', 'release-assets.githubusercontent.com'].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex').toLowerCase();
}

async function findUpdaterAsset(): Promise<{ url: string; size: number; sha256: string }> {
  const response = await fetch(UPDATER_RELEASE_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'OrbitChat-Desktop-Updater/1.0',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(15_000),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Could not retrieve the Orbit Chat updater (GitHub HTTP ${response.status}).`);

  const release: unknown = await response.json();
  if (!release || typeof release !== 'object' || Array.isArray(release)) throw new Error('GitHub returned invalid updater release data.');
  const fields = release as { draft?: unknown; assets?: unknown };
  if (fields.draft === true || !Array.isArray(fields.assets)) throw new Error('The Orbit Chat updater release is not available.');
  const asset = fields.assets.find((item: GitHubAsset) => item && item.name === UPDATER_ASSET_NAME) as GitHubAsset | undefined;
  if (!asset || !trustedDownloadUrl(asset.browser_download_url)) throw new Error('The Orbit Chat updater executable has not been published yet.');
  if (!Number.isSafeInteger(asset.size) || (asset.size as number) <= 0 || (asset.size as number) > MAX_UPDATER_BYTES)
    throw new Error('The published updater has an invalid or unsupported size.');
  if (typeof asset.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/i.test(asset.digest))
    throw new Error('The published updater does not have a valid GitHub SHA-256 digest.');

  return { url: asset.browser_download_url, size: asset.size as number, sha256: asset.digest.slice(7).toLowerCase() };
}

async function getBundledUpdater(): Promise<string | null> {
  const bundledPath = path.join(path.dirname(process.execPath), UPDATER_ASSET_NAME);
  let bundled;
  try {
    bundled = await stat(bundledPath);
  } catch {
    return null;
  }
  if (!bundled.isFile() || bundled.size <= 0 || bundled.size > MAX_UPDATER_BYTES)
    throw new Error('The bundled Orbit Chat updater has an invalid or unsupported size.');

  const sha256 = await sha256File(bundledPath);
  const directory = path.join(os.tmpdir(), 'OrbitChatUpdater');
  const destination = path.join(directory, `${sha256}.exe`);
  await mkdir(directory, { recursive: true });
  try {
    const cached = await stat(destination);
    if (cached.isFile() && cached.size === bundled.size && await sha256File(destination) === sha256) return destination;
  } catch { /* Copy a fresh bundled updater when no verified cached copy exists. */ }
  await rm(destination, { force: true });
  await copyFile(bundledPath, destination);

  const copied = await stat(destination);
  if (copied.size !== bundled.size || await sha256File(destination) !== sha256) {
    await rm(destination, { force: true });
    throw new Error('The bundled Orbit Chat updater could not be verified after copying.');
  }
  return destination;
}

async function getVerifiedUpdater(): Promise<string> {
  const bundledUpdater = await getBundledUpdater();
  if (bundledUpdater) return bundledUpdater;

  // Keep compatibility with installations made before the updater was bundled.
  const asset = await findUpdaterAsset();
  const directory = path.join(os.tmpdir(), 'OrbitChatUpdater');
  const destination = path.join(directory, `${asset.sha256}.exe`);
  await mkdir(directory, { recursive: true });

  try {
    const cached = await stat(destination);
    if (cached.isFile() && cached.size === asset.size && await sha256File(destination) === asset.sha256) return destination;
  } catch { /* Download a fresh copy when no verified cached updater exists. */ }
  await rm(destination, { force: true });

  const response = await fetch(asset.url, { signal: AbortSignal.timeout(3 * 60_000), redirect: 'follow' });
  if (!response.ok || !response.body || !trustedDownloadUrl(response.url))
    throw new Error('The updater download failed or redirected to an unsupported host.');
  const temporary = `${destination}.${process.pid}.download`;
  try {
    let received = 0;
    const byteLimit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > asset.size || received > MAX_UPDATER_BYTES) callback(new Error('The updater download exceeded its published size.'));
        else callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
      byteLimit,
      createWriteStream(temporary, { mode: 0o700, flags: 'wx' }),
    );
    const downloaded = await stat(temporary);
    if (downloaded.size !== asset.size || downloaded.size !== received || downloaded.size > MAX_UPDATER_BYTES)
      throw new Error('The updater download size does not match GitHub release metadata.');
    if (await sha256File(temporary) !== asset.sha256) throw new Error('The updater failed GitHub SHA-256 verification.');
    await rename(temporary, destination);
    return destination;
  } catch (error) {
    await rm(destination, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function startVerifiedUpdater(installDirectory: string, appProcessId: number, quit: () => void): Promise<void> {
  const updaterPath = await getVerifiedUpdater();
  const child = spawn(updaterPath, [
    '--install-directory', installDirectory,
    '--app-process-id', String(appProcessId),
  ], { cwd: os.tmpdir(), detached: true, stdio: 'ignore', windowsHide: true });
  await once(child, 'spawn');
  child.unref();
  setTimeout(quit, 150);
}

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const UPDATER_ASSET_NAME = 'Orbit-Chat-Updater.exe';
const MAX_UPDATER_BYTES = 200 * 1024 * 1024;

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex').toLowerCase();
}

async function getBundledUpdater(): Promise<string> {
  const bundledPath = path.join(path.dirname(process.execPath), UPDATER_ASSET_NAME);
  let bundled;
  try {
    bundled = await stat(bundledPath);
  } catch {
    throw new Error('This Orbit Chat installation does not include its updater. Install a current version using the Online Installer to enable in-app updates.');
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

export async function startVerifiedUpdater(installDirectory: string, appProcessId: number, quit: () => void): Promise<void> {
  const updaterPath = await getBundledUpdater();
  const child = spawn(updaterPath, [
    '--install-directory', installDirectory,
    '--app-process-id', String(appProcessId),
  ], { cwd: os.tmpdir(), detached: true, stdio: 'ignore', windowsHide: true });
  await once(child, 'spawn');
  child.unref();
  setTimeout(quit, 150);
}

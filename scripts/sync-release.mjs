import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseExe = path.join(rootDir, 'src-tauri', 'target', 'release', 'lemma.exe');
const nsisInstaller = path.join(
  rootDir,
  'src-tauri',
  'target',
  'release',
  'bundle',
  'nsis',
  'Lemma_0.1.0_x64-setup.exe'
);

if (fs.existsSync(releaseExe)) {
  fs.copyFileSync(releaseExe, path.join(rootDir, 'Lemma.exe'));
  console.log('Synced -> Lemma.exe');

  const localInstalledExe = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Lemma', 'lemma.exe')
    : null;
  if (localInstalledExe && fs.existsSync(localInstalledExe)) {
    const oldBackupExe = `${localInstalledExe}.old`;
    try {
      if (fs.existsSync(oldBackupExe)) {
        fs.unlinkSync(oldBackupExe);
      }
    } catch {
      // Old backup still held by a previous instance; ignore
    }

    try {
      fs.copyFileSync(releaseExe, localInstalledExe);
      console.log(`Synced -> ${localInstalledExe}`);
    } catch {
      try {
        fs.renameSync(localInstalledExe, oldBackupExe);
        fs.copyFileSync(releaseExe, localInstalledExe);
        console.log(`Synced (in-place atomic swap) -> ${localInstalledExe}`);
      } catch {
        console.log('Note: Local installed lemma.exe is currently open; close it or run installer to update.');
      }
    }
  }
}

if (fs.existsSync(nsisInstaller)) {
  fs.copyFileSync(nsisInstaller, path.join(rootDir, 'Lemma_0.1.0_安装包.exe'));
  console.log('Synced -> Lemma_0.1.0_安装包.exe');
}

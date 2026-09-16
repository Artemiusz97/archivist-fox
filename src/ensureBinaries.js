import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';

function runCmd(cmd, args) {
  return new Promise((resolve) => {
    try {
      const proc = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'ignore'] });
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

function runCmdWithOutput(cmd, args) {
  return new Promise((resolve) => {
    try {
      const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      proc.stdout.on('data', (d) => { output += d.toString(); });
      proc.stderr.on('data', (d) => { output += d.toString(); });
      proc.on('error', () => resolve({ code: -1, output: '' }));
      proc.on('close', (code) => resolve({ code, output }));
    } catch {
      resolve({ code: -1, output: '' });
    }
  });
}

async function isBinaryWorking(binPath, versionArg = '--version') {
  const { code, output } = await runCmdWithOutput(binPath, [versionArg]);
  if (code === 0) return true;
  if (output.includes('GLIBC')) {
    console.warn(`[WARNING] ${binPath} failed GLIBC check: ${output.trim()}`);
  }
  return false;
}

async function downloadFile(url, destPath) {
  console.log(`Downloading required binary from ${url}...`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  await fs.promises.writeFile(destPath, buffer, { mode: 0o755 });
  try {
    await fs.promises.chmod(destPath, 0o755);
  } catch {}
  console.log(`Downloaded ${path.basename(destPath)} successfully.`);
}

async function getGalleryDlDownloadUrl() {
  try {
    const res = await fetch('https://codeberg.org/api/v1/repos/mikf/gallery-dl/releases/latest');
    if (res.ok) {
      const data = await res.json();
      const filename = process.platform === 'win32' ? 'gallery-dl.exe' : 'gallery-dl.bin';
      const asset = data.assets?.find((a) => a.name === filename);
      if (asset?.browser_download_url) {
        return asset.browser_download_url;
      }
    }
  } catch {}

  return process.platform === 'win32'
    ? 'https://codeberg.org/mikf/gallery-dl/releases/download/v1.32.7/gallery-dl.exe'
    : 'https://codeberg.org/mikf/gallery-dl/releases/download/v1.32.7/gallery-dl.bin';
}

async function handleGalleryDlSetup(cwd) {
  // 1. Test existing config path or system gallery-dl
  if (await isBinaryWorking(config.gallerydlPath)) {
    return;
  }

  // 2. Check local binary in root folder
  const targetPath = path.join(cwd, process.platform === 'win32' ? 'gallery-dl.exe' : 'gallery-dl');
  if (fs.existsSync(targetPath)) {
    if (await isBinaryWorking(targetPath)) {
      config.gallerydlPath = targetPath;
      return;
    }
    console.warn(`Local binary ${targetPath} is present but incompatible with host GLIBC.`);
  } else {
    // Attempt download of prebuilt binary
    console.log('gallery-dl binary not found on system. Attempting automatic download...');
    try {
      const url = await getGalleryDlDownloadUrl();
      await downloadFile(url, targetPath);
      if (await isBinaryWorking(targetPath)) {
        config.gallerydlPath = targetPath;
        return;
      }
      console.warn('Downloaded gallery-dl binary is incompatible with host GLIBC (server glibc version too old).');
    } catch (err) {
      console.error('Failed to auto-download gallery-dl binary:', err.message);
    }
  }

  // 3. Fallback: check if python3 has gallery_dl module installed
  if (await runCmd('python3', ['-m', 'gallery_dl', '--version'])) {
    console.log('Detected working Python module gallery_dl. Switching gallery-dl execution mode to python3.');
    config.usePythonGalleryDl = true;
    return;
  }

  // 4. Try installing gallery-dl via pip if python3 is available
  if (await runCmd('python3', ['--version'])) {
    console.log('Attempting to install gallery-dl via pip (python3 -m pip install gallery-dl)...');
    const pipSuccess = await runCmd('python3', ['-m', 'pip', 'install', '-U', 'gallery-dl']);
    if (pipSuccess && (await runCmd('python3', ['-m', 'gallery_dl', '--version']))) {
      console.log('Successfully installed gallery-dl via pip!');
      config.usePythonGalleryDl = true;
      return;
    }
  }

  console.warn('[NOTICE] gallery-dl binary incompatible and Python module fallback unavailable. Static image gallery downloads will fail until `pip install gallery-dl` is run on Wispbyte.');
}

export async function ensureBinaries() {
  const cwd = process.cwd();

  // Check yt-dlp
  const ytdlpWorking = await isBinaryWorking(config.ytdlpPath);
  if (!ytdlpWorking) {
    const targetPath = path.join(cwd, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
    if (!(await isBinaryWorking(targetPath))) {
      console.log('yt-dlp not found on system. Attempting automatic download...');
      try {
        const url = process.platform === 'win32'
          ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
          : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
        await downloadFile(url, targetPath);
        config.ytdlpPath = targetPath;
      } catch (err) {
        console.error('Failed to auto-download yt-dlp:', err.message);
      }
    } else {
      config.ytdlpPath = targetPath;
    }
  }

  // Check gallery-dl setup with GLIBC and Python pip fallbacks
  await handleGalleryDlSetup(cwd);

  // Check ffmpeg and ffprobe
  const ffmpegWorking = await isBinaryWorking(config.ffmpegPath, '-version');
  if (!ffmpegWorking) {
    console.warn(
      `[WARNING] ffmpeg not found or inoperable at "${config.ffmpegPath}". Video compression, thumbnail previews, and stream merging may fail. Please install ffmpeg and add it to your PATH.`
    );
  }

  const ffprobeWorking = await isBinaryWorking(config.ffprobePath, '-version');
  if (!ffprobeWorking) {
    console.warn(
      `[WARNING] ffprobe not found or inoperable at "${config.ffprobePath}". Stream analysis and duration probing may fail. Please install ffprobe and add it to your PATH.`
    );
  }
}

// Remove expired temporary classroom videos and transcription jobs.
//
// The service deletes expired sources when the next upload or capacity check
// happens, and it also runs an internal interval timer. That timer is unref'd,
// so it stops whenever the service process stops. This script gives the
// cleanup its own schedule so stale files are removed even while the service
// is down or restarting.
//
// The expiry rule matches video-source-service.mjs: a source directory is
// expired once it has not been touched for the TTL (6 hours). Transcription
// directories use the same rule. Files that are currently in use are left
// alone: the service marks a directory as busy while a clip is being prepared,
// and a fresh file is never removed because its mtime is recent.
//
// Usage: node tools/cleanup-video-sources.mjs [--ttl-hours N] [--dry-run]
//
// Environment overrides:
//   VIDEO_SOURCE_DIR   directory holding the temporary sources
//   VIDEO_SOURCE_TTL_HOURS  expiry window in hours (default 6)

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(process.env.VIDEO_SOURCE_DIR || path.join(os.tmpdir(), 'teaching-video-sources'));
const validId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const transcriptPattern = /^transcript-[a-f0-9-]+$/;

const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) return fallback;
  return Number(args[index + 1]);
};
const dryRun = args.includes('--dry-run');
const ttlMs = readArg('--ttl-hours', Number(process.env.VIDEO_SOURCE_TTL_HOURS) || 6) * 60 * 60 * 1000;

const bytesIn = async dir => {
  let total = 0;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  for (const item of entries) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) total += await bytesIn(file);
    else if (item.isFile()) { try { total += (await fs.stat(file)).size; } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  return total;
};

const run = async () => {
  const now = Date.now();
  let removed = 0, kept = 0, freed = 0;
  const removedNames = [];

  let entries = [];
  try {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  for (const item of entries) {
    if (!item.isDirectory()) continue;
    const isSource = validId.test(item.name);
    const isTranscript = transcriptPattern.test(item.name);
    if (!isSource && !isTranscript) continue;

    const dir = path.join(root, item.name);
    let stat;
    try { stat = await fs.stat(dir); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const age = now - stat.mtimeMs;
    if (age <= ttlMs) { kept++; continue; }

    const size = await bytesIn(dir);
    if (!dryRun) {
      try { await fs.rm(dir, { recursive: true, force: true }); } catch (error) {
        if (error.code === 'ENOENT') continue;
        console.error(`failed to remove ${item.name}: ${error.message}`);
        kept++;
        continue;
      }
    }
    removed++; freed += size; removedNames.push(item.name);
  }

  const summary = {
    root, ttl_hours: ttlMs / 3600000, dry_run: dryRun,
    removed, kept, freed_bytes: freed, freed_mb: Math.round(freed / 1024 / 1024),
    removed_names: removedNames,
  };
  console.log(JSON.stringify(summary));
};

run().catch(error => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});

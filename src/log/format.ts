/**
 * IEC powers of 1024, upstream-style suffixes (`B/KB/MB/GB`).
 * Threshold-picks the largest unit where the rounded value is >= 1.
 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m${s}s`;
}

/** Returns empty string when duration < 50 ms (measurement noise floor). */
export function formatSpeed(bytes: number, ms: number): string {
  if (ms < 50) return "";
  const bytesPerSec = bytes / (ms / 1000);
  return `${formatBytes(bytesPerSec)}/s`;
}

/** Returns empty string when uncompressed < 1024 (compression overhead dominates). */
export function formatRatio(uncompressed: number, compressed: number): string {
  if (uncompressed < 1024) return "";
  if (compressed <= 0) return "";
  return `${(uncompressed / compressed).toFixed(1)}x`;
}

export function shortVersion(digest: string): string {
  return digest.length > 12 ? digest.slice(0, 12) : digest;
}

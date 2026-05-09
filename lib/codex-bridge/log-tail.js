/**
 * log-tail.js
 *
 * Bounded log tailing with query interface.
 *
 * Spec: docs/specs/2026-05-08-v0.6.0-live-verification.md § "Log Tailing"
 *
 * Export
 * ──────
 *   tailLogs(sources, options) → tailer
 *
 * sources: Array<{ path: string, allow_absolute?: boolean }>
 *
 * options:
 *   repoRoot                   — used for safe-path checking (required)
 *   max_bytes_per_source       — ring-buffer cap per source (default: 262144)
 *   error_patterns             — list of regex strings for errors_since (default spec list)
 *
 * tailer methods:
 *   tail(path, bytes)                              — last N bytes from buffer
 *   errors_since(path, timestamp)                  — lines matching error_patterns after timestamp
 *   excerpt_around(path, pattern, before, after, maxBytes) — context window around match
 *   sourceInfo(path)                               — { path, available }
 *   close()                                        — stop watching all sources
 *
 * Safety rules (spec § Log Tailing):
 *   - Absolute paths outside repoRoot are rejected unless source has allow_absolute:true
 *   - Missing paths record available:false without throwing
 *
 * Buffer management:
 *   - Each source has a fixed-capacity byte ring buffer
 *   - When new data would exceed capacity, oldest bytes are dropped (FIFO)
 *   - Buffer is stored as a single string; trim from front when overflow
 */

import { existsSync, readFileSync, statSync, watchFile, unwatchFile } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';

// ── Default options ───────────────────────────────────────────────────────────

const DEFAULT_MAX_BYTES = 262144; // 256 KiB per spec
const DEFAULT_ERROR_PATTERNS = ['ERROR', 'Unhandled', 'TypeError', '500'];
const POLL_INTERVAL_MS = 200; // polling interval for file changes

// ── Safe-path check ───────────────────────────────────────────────────────────

/**
 * Returns true if path is safely under repoRoot.
 * @param {string} absPath   resolved absolute path
 * @param {string} repoRoot  resolved absolute repo root
 */
function isSafeUnderRepo(absPath, repoRoot) {
  const root = resolve(repoRoot);
  const normalized = resolve(absPath);
  // Path is safe if it starts with the repo root + separator (or equals it)
  return normalized === root || normalized.startsWith(root + '/');
}

// ── Ring buffer helper ────────────────────────────────────────────────────────

/**
 * Append data to a bounded string buffer.
 * Trims from the front (oldest) if capacity exceeded.
 *
 * @param {string} current   existing buffer content
 * @param {string} incoming  new data to append
 * @param {number} maxBytes  maximum byte length of the returned buffer
 * @returns {string}         new buffer (may be trimmed)
 */
function appendBounded(current, incoming, maxBytes) {
  const combined = current + incoming;
  if (combined.length <= maxBytes) return combined;
  // Drop oldest bytes to fit within maxBytes
  // Use slice from end to keep the most recent data
  return combined.slice(combined.length - maxBytes);
}

// ── tailLogs ──────────────────────────────────────────────────────────────────

/**
 * @param {Array<{path: string, allow_absolute?: boolean}>} sources
 * @param {{repoRoot: string, max_bytes_per_source?: number, error_patterns?: string[]}} options
 * @returns {object}  tailer
 */
export function tailLogs(sources, options = {}) {
  const repoRoot = options.repoRoot;
  if (!repoRoot) throw new Error('tailLogs: options.repoRoot is required');

  const maxBytes = options.max_bytes_per_source || DEFAULT_MAX_BYTES;
  const errorPatterns = options.error_patterns || DEFAULT_ERROR_PATTERNS;
  const errorRegexes = errorPatterns.map((p) => new RegExp(p));

  // Validate paths up front — throw for unsafe absolute paths
  for (const source of sources) {
    const absPath = resolve(source.path);
    if (isAbsolute(source.path) || absPath !== resolve(repoRoot, source.path)) {
      // It's an absolute path or resolves outside — check safety
      if (!isSafeUnderRepo(absPath, repoRoot)) {
        if (!source.allow_absolute) {
          const err = new Error(
            `Log path "${source.path}" resolves to "${absPath}" which is outside repo root "${repoRoot}". ` +
            `Set allow_absolute:true in the source config to allow this.`
          );
          err.code = 'unsafe-log-path';
          throw err;
        }
      }
    }
  }

  // Per-source state
  const buffers = new Map();    // path → string buffer
  const available = new Map();  // path → boolean
  const lastSize = new Map();   // path → last known file size (for polling)
  const watchers = new Map();   // path → intervalId (polling)

  // Initialize sources
  for (const source of sources) {
    const absPath = resolve(source.path);
    buffers.set(absPath, '');

    if (!existsSync(absPath)) {
      available.set(absPath, false);
      continue;
    }

    available.set(absPath, true);

    // Initial read
    try {
      const content = readFileSync(absPath, 'utf8');
      buffers.set(absPath, appendBounded('', content, maxBytes));
      lastSize.set(absPath, Buffer.byteLength(content, 'utf8'));
    } catch {
      // File might have been removed between existsSync and read
      available.set(absPath, false);
    }

    // Poll for changes
    const intervalId = setInterval(() => {
      if (!existsSync(absPath)) {
        available.set(absPath, false);
        return;
      }
      try {
        const stat = statSync(absPath);
        const currentSize = stat.size;
        const knownSize = lastSize.get(absPath) || 0;
        if (currentSize > knownSize) {
          // Read full file and rebuild buffer (simple approach for small logs)
          const content = readFileSync(absPath, 'utf8');
          buffers.set(absPath, appendBounded('', content, maxBytes));
          lastSize.set(absPath, currentSize);
          available.set(absPath, true);
        }
      } catch {
        // Ignore transient errors
      }
    }, POLL_INTERVAL_MS);

    watchers.set(absPath, intervalId);
  }

  // ── Tailer interface ────────────────────────────────────────────────────────

  const tailer = {
    /**
     * Returns last N bytes from the buffer for the given source path.
     * @param {string} path
     * @param {number} bytes
     * @returns {string}
     */
    tail(path, bytes) {
      const absPath = resolve(path);
      const buf = buffers.get(absPath) || '';
      if (buf.length <= bytes) return buf;
      return buf.slice(buf.length - bytes);
    },

    /**
     * Returns lines from the buffer that match any error pattern AND
     * whose embedded ISO timestamp (if present) is after the given cutoff.
     *
     * Lines without a parseable timestamp are included when they match an error pattern.
     *
     * @param {string} path
     * @param {Date} timestamp
     * @returns {string[]}
     */
    errors_since(path, timestamp) {
      const absPath = resolve(path);
      const buf = buffers.get(absPath) || '';
      const lines = buf.split('\n').filter((l) => l.length > 0);
      const cutoffMs = timestamp instanceof Date ? timestamp.getTime() : Number(timestamp);

      return lines.filter((line) => {
        // Check if line matches any error pattern
        const matchesPattern = errorRegexes.some((re) => re.test(line));
        if (!matchesPattern) return false;

        // Try to parse an ISO timestamp from the start of the line
        // Pattern: YYYY-MM-DDTHH:MM:SS.sssZ or similar
        const isoMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/);
        if (isoMatch) {
          const lineTime = new Date(isoMatch[1]).getTime();
          if (!isNaN(lineTime)) {
            return lineTime > cutoffMs;
          }
        }
        // No parseable timestamp — include the line if it matches error pattern
        return true;
      });
    },

    /**
     * Returns context lines around the first match for pattern,
     * bounded to maxBytes.
     *
     * @param {string} path
     * @param {string} pattern       regex pattern string
     * @param {number} beforeLines   lines to include before match
     * @param {number} afterLines    lines to include after match
     * @param {number} maxBytes      maximum byte length of result
     * @returns {string}
     */
    excerpt_around(path, pattern, beforeLines, afterLines, maxBytes) {
      const absPath = resolve(path);
      const buf = buffers.get(absPath) || '';
      const lines = buf.split('\n');
      const re = new RegExp(pattern);

      const matchIdx = lines.findIndex((l) => re.test(l));
      if (matchIdx === -1) return '';

      const start = Math.max(0, matchIdx - beforeLines);
      const end = Math.min(lines.length, matchIdx + afterLines + 1);
      const excerpt = lines.slice(start, end).join('\n');

      if (excerpt.length <= maxBytes) return excerpt;
      // Truncate to maxBytes from the end (keep most relevant / most recent)
      return excerpt.slice(excerpt.length - maxBytes);
    },

    /**
     * Returns source info for the given path.
     * @param {string} path
     * @returns {{ path: string, available: boolean }}
     */
    sourceInfo(path) {
      const absPath = resolve(path);
      return {
        path: absPath,
        available: available.get(absPath) !== false,
      };
    },

    /**
     * Stop polling all sources.
     */
    close() {
      for (const [_path, intervalId] of watchers) {
        clearInterval(intervalId);
      }
      watchers.clear();
    },
  };

  return tailer;
}

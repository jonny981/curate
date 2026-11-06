// Vitest global setup. Readers keep a stored index in the user's cache
// folder by default, so every test run points XDG_CACHE_HOME at a fresh
// temporary folder and removes it afterwards. A test that sets its own
// folder still wins.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default function setup() {
  const folder = mkdtempSync(join(tmpdir(), 'curate-test-cache-'));
  process.env.XDG_CACHE_HOME = folder;
  return () => rmSync(folder, { recursive: true, force: true });
}

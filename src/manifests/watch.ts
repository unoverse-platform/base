/**
 * Watch node manifests and reload them on change. Development only.
 *
 * A manifest is data, so editing one should behave like editing design/ — save the file,
 * see the change. Needing a restart would make the format feel worse than the code it
 * replaces, when the whole argument for it is that data can move without a deploy.
 *
 * NOT enabled in production: there, manifests arrive through the marketplace or a
 * database row, both of which already call the loader themselves. A filesystem watcher
 * on a server nobody edits by hand is a way to reload half-written files.
 *
 * Uses node:fs.watch, which is native and free. No dependency for a dev nicety.
 */
import * as fs from "fs";
import { loadManifests } from "./index.js";
import { NODES_HOME } from "../paths.js";
import { boot } from "../boot.js";

let watcher: fs.FSWatcher | null = null;
let pending: NodeJS.Timeout | null = null;

/**
 * Start watching, unless already watching or in production.
 *
 * `onReloaded` is where the engine's catalog snapshot gets refreshed — without it the
 * server has the new node and Canvas still shows the old catalog, which reads as "the
 * reload did not work".
 */
export function watchManifests(onReloaded?: () => Promise<void> | void): void {
  if (watcher || process.env.NODE_ENV === "production") return;
  if (!fs.existsSync(NODES_HOME)) return;

  try {
    watcher = fs.watch(NODES_HOME, { recursive: true }, (_event, filename) => {
      if (!filename || !/\.ya?ml$/.test(filename)) return;

      // Editors write a file in several operations (temp file, rename, truncate), so a
      // single save fires repeatedly. Debounce, or a reload reads a half-written file.
      if (pending) clearTimeout(pending);
      pending = setTimeout(async () => {
        pending = null;
        try {
          const result = await loadManifests();
          console.log(`[unoverse:manifests] reloaded after ${filename}: ${result.nodes} node(s)`);
          for (const e of result.errors) console.warn(`  ⚠ ${e}`);
          await onReloaded?.();
        } catch (err: any) {
          // A reload must never take the server down: a half-typed manifest is a
          // normal state while someone is editing one.
          console.warn(`[unoverse:manifests] reload failed: ${err?.message ?? err}`);
        }
      }, 250);
    });
    boot.watching(NODES_HOME);
  } catch (err: any) {
    // recursive:true is unsupported on some platforms; a missing watcher is a lost dev
    // nicety, never a failure to boot.
    console.warn(`[unoverse:manifests] could not watch for changes: ${err?.message ?? err}`);
  }
}

export function stopWatchingManifests(): void {
  watcher?.close();
  watcher = null;
  if (pending) clearTimeout(pending);
  pending = null;
}

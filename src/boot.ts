/**
 * Boot report — ONE readout at the end of startup, instead of a line per thing loaded.
 *
 * Boot used to narrate itself: 84 node ticks, 24 credential ticks, 27 "local wins"
 * lines, each registration announcing itself as it happened. Two problems with that.
 * It reads as noise rather than as a product, and a real failure (the plugin-state
 * fetch that fails silently below) sits in the middle of it styled exactly like a
 * success tick, so nobody sees it.
 *
 * The rule here: COUNT the healthy, NAME the anomalous. A node that loaded is a
 * number; a node that was skipped, shadowed, disabled or missing metadata is a line
 * with its name on it. Nothing diagnostic is lost, because the per-item detail is
 * still emitted at debug level (LOG_LEVEL=debug) and the full catalog is one
 * `GET /nodes` away.
 *
 * Collect from anywhere during boot, print once from index.ts.
 */

const DEBUG = (process.env.LOG_LEVEL ?? "").toLowerCase() === "debug";

type Notice = { level: "warn" | "error"; text: string };
type Endpoint = { label: string; url: string; note?: string };

const state = {
  startedAt: Date.now(),
  packages: 0,
  nodes: [] as string[],
  credentials: [] as string[],
  credentialsSkipped: 0,
  components: null as { node: string; count: number } | null,
  manifests: null as { nodes: number; credentials: number; shadowed: string[]; disabled: string[] } | null,
  pluginStates: 0,
  pluginStateError: null as string | null,
  pluginsLocalWin: [] as string[],
  pluginsFromNpm: [] as string[],
  pluginsDisabled: [] as string[],
  auth: null as string | null,
  redis: null as string | null,
  engine: null as string | null,
  watching: null as string | null,
  endpoints: [] as Endpoint[],
  notices: [] as Notice[],
  printed: false,
};

/** Per-item detail, kept for LOG_LEVEL=debug. Silent otherwise. */
function detail(line: string): void {
  if (DEBUG) console.log(line);
}

export const boot = {
  packages(n: number) {
    state.packages = n;
    detail(`[boot] discovered ${n} node packages`);
  },

  node(type: string) {
    state.nodes.push(type);
    detail(`[boot]   node ${type}`);
  },

  credential(name: string, skipped = false) {
    if (skipped) {
      // First-wins is the DESIGNED behaviour for a shared credential (several AWS
      // packages legitimately declare awsCredential), so it is not a warning and
      // never belonged in the readout. It was 48 warning lines a boot.
      state.credentialsSkipped++;
      detail(`[boot]   credential ${name} already registered, kept the first`);
      return;
    }
    state.credentials.push(name);
    detail(`[boot]   credential ${name}`);
  },

  components(node: string, count: number) {
    state.components = { node, count };
  },

  manifests(m: { nodes: number; credentials: number; shadowed: string[]; disabled: string[] }) {
    state.manifests = m;
  },

  pluginStates(n: number) {
    // Loaded once at boot and again after the engine comes up; the count is the same
    // fact both times, so the report holds one of it rather than printing twice.
    state.pluginStates = n;
  },

  /**
   * A failed read of the plugin state table. Not a notice on its own: in merged mode the
   * first read races the engine binding :4101 and is retried. It becomes a notice only
   * if no state was ever loaded, which is the case where plugins really are missing.
   */
  pluginStateFetchFailed(message: string) {
    state.pluginStateError = message;
    detail(`[boot]   plugin state read failed: ${message}`);
  },

  pluginLocalWin(name: string, installedVersion?: string) {
    state.pluginsLocalWin.push(name);
    detail(`[boot]   ${name}: local source wins over npm${installedVersion ? ` (npm has ${installedVersion})` : ""}`);
  },

  pluginFromNpm(name: string, source = "npm") {
    state.pluginsFromNpm.push(name);
    detail(`[boot]   ${name}: loaded from ${source}`);
  },

  pluginDisabled(name: string) {
    state.pluginsDisabled.push(name);
  },

  auth(posture: string) {
    state.auth = posture;
  },

  redis(status: string) {
    state.redis = status;
  },

  engine(where: string) {
    state.engine = where;
  },

  /** Manifest hot reload is a dev affordance worth one line, because it changes what a save does. */
  watching(dir: string) {
    state.watching = dir;
  },

  endpoint(label: string, url: string, note?: string) {
    state.endpoints.push({ label, url, note });
  },

  /**
   * Addresses are listed in the order someone reaches for them, not the order the
   * listeners happened to bind. Studio is what a person opens; the internal runtime is
   * what a machine calls.
   */
  endpointOrder: ["Studio", "MCP", "Runtime", "Builder MCP"],

  notice(level: "warn" | "error", text: string) {
    state.notices.push({ level, text });
  },

  /**
   * True until the report prints. Loaders that run BOTH at boot and later (the manifest
   * watcher, install/uninstall) ask this: during boot they hand their result to the
   * report, afterwards they log it themselves, because a reload with nothing else on
   * screen is a real event and should say so.
   */
  isBooting() {
    return !state.printed;
  },

  /** Everything the report knows, for a status route or a test. */
  snapshot() {
    return { ...state };
  },

  print() {
    if (state.printed) return;
    state.printed = true;
    const ready = ((Date.now() - state.startedAt) / 1000).toFixed(1);

    const rows: Array<[string, string]> = [];
    rows.push(["Nodes", `${state.nodes.length} registered from ${state.packages} packages`]);
    if (state.manifests) {
      const m = state.manifests;
      const parts = [`${m.nodes} loaded`];
      if (m.shadowed.length) parts.push(`${m.shadowed.length} shadowed by code`);
      if (m.disabled.length) parts.push(`${m.disabled.length} disabled`);
      rows.push(["Manifests", parts.join(", ")]);
    }
    // The skipped count is every re-declaration of a credential that already exists,
    // which is the shared-credential design working. It is a debug fact, not a headline.
    rows.push(["Credentials", `${state.credentials.length} types`]);
    if (state.components) rows.push(["Components", `${state.components.count} in one ${state.components.node} node`]);
    if (state.pluginStates) {
      const parts = [`${state.pluginStates} states`];
      if (state.pluginsLocalWin.length) parts.push(`${state.pluginsLocalWin.length} local over npm`);
      if (state.pluginsFromNpm.length) parts.push(`${state.pluginsFromNpm.length} from npm`);
      if (state.pluginsDisabled.length) parts.push(`${state.pluginsDisabled.length} disabled`);
      rows.push(["Plugins", parts.join(", ")]);
    }
    if (state.engine) rows.push(["Engine", state.engine]);
    if (state.redis) rows.push(["Redis", state.redis]);
    // Last row before the addresses, because it qualifies every one of them.
    if (state.auth) rows.push(["Auth", state.auth]);
    // Trimmed to the repo-relative path: absolute would be the longest string in the
    // block, and the identifying part is the tail. cwd is not usable for this because
    // the server is started from several directories (turbo, docker, the CLI).
    if (state.watching)
      rows.push(["Watching", `${state.watching.replace(/^.*?(?=apps\/)/, "")}, manifests reload on save`]);

    const labelWidth = Math.max(...rows.map((r) => r[0].length), ...state.endpoints.map((e) => e.label.length));
    const urlWidth = Math.max(0, ...state.endpoints.map((e) => e.url.length));
    const out: string[] = ["", `  unoverse    ready in ${ready}s`, ""];
    for (const [label, value] of rows) out.push(`  ${label.padEnd(labelWidth)}   ${value}`);
    if (state.endpoints.length) {
      const rank = (l: string) => {
        const i = boot.endpointOrder.indexOf(l);
        return i === -1 ? boot.endpointOrder.length : i;
      };
      state.endpoints.sort((a, b) => rank(a.label) - rank(b.label));
      out.push("");
      for (const e of state.endpoints) {
        out.push(`  ${e.label.padEnd(labelWidth)}   ${e.note ? e.url.padEnd(urlWidth) : e.url}${e.note ? `   ${e.note}` : ""}`);
      }
    }

    // Anomalies are the point of the readout, so they sit at the bottom where the eye
    // lands and they are the only thing here that is not a count.
    if (state.pluginStateError && !state.pluginStates)
      state.notices.push({
        level: "error",
        text: `no plugin state could be read (${state.pluginStateError}), so npm-installed packages did not load`,
      });

    const anomalies = [
      ...state.notices.map((n) => `  ${n.level === "error" ? "✗" : "!"}  ${n.text}`),
      ...(state.manifests?.shadowed.length
        ? [`  !  code wins over manifest for: ${state.manifests.shadowed.join(", ")}`]
        : []),
      ...(state.pluginsDisabled.length ? [`  !  disabled, so not loaded: ${state.pluginsDisabled.join(", ")}`] : []),
    ];
    if (anomalies.length) out.push("", ...anomalies);
    out.push("");
    if (!DEBUG) out.push("  LOG_LEVEL=debug lists every node, credential and package as it loads.", "");
    console.log(out.join("\n"));
  },
};

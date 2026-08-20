/**
 * Publishing a project: collect, lint, compare, send.
 *
 * The shape is deliberate. NOTHING LEAVES THE MACHINE until the rules pass, because the
 * cheapest place to catch a malformed definition is where the developer can fix it. The
 * universe validates again on receipt (it must not trust a client), but a developer should
 * never learn about a raw hex value from an HTTP error.
 *
 * Then a COMPARISON before a write. "What am I about to do" is answered by fingerprints:
 * new, changed, unchanged, or refused because the name belongs to someone else. Publishing
 * blind is how a project half-lands and nobody can tell by looking.
 *
 * See docs/architecture/DECLARATIVE_NODES.md §9.
 */
import { collectProject, type CollectedItem } from "./collect.js";

/** One lint finding. `error` blocks a publish; `warn` and `hint` inform. */
export interface Finding {
  level: string;
  file: string;
  line?: number;
  msg: string;
}

/** What publishing WOULD do, per item. `refused` carries the reason. */
export interface PublishPlan {
  create: CollectedItem[];
  update: CollectedItem[];
  unchanged: CollectedItem[];
  refused: Array<CollectedItem & { why: string }>;
}

/**
 * Lint a project, returning findings. Errors mean nothing is sent.
 *
 * The design linter needs the whole design home, not one project: a developer's components are
 * built ON TOP of the design system, so linting a project in isolation resolves every
 * shared atom against nothing. It reports on all projects; we keep the findings for this
 * one, plus anything about the tree itself.
 */
export async function lintForPublish(designRoot: string, project: string): Promise<{ problems: Finding[]; errors: Finding[] }> {
  const { lintDefinitions } = await import("../lint/design/index.mjs");
  const result = lintDefinitions(designRoot);
  const mine = result.problems.filter((p: Finding) => !p.file || p.file.includes(`/${project}/`) || !p.file.includes("/design/"));
  return { problems: mine, errors: mine.filter((p: Finding) => p.level === "error") };
}

/**
 * What publishing WOULD do, without doing it.
 *
 * Compares each collected item against the universe's current fingerprint for the same
 * (kind, name). Four outcomes, and the fourth is the one worth surfacing early: a name
 * owned by another publisher is refused, and finding that out before a publish beats
 * finding it out halfway through one.
 */
export async function planPublish(
  items: CollectedItem[],
  universe: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishPlan> {
  const plan: PublishPlan = { create: [], update: [], unchanged: [], refused: [] };

  for (const item of items) {
    // ASK THE GATE, not the item store. `/api/items` is deliberately shut (§9.10), so a
    // publisher cannot read rows directly; and asking the publish route means the plan is
    // produced by exactly the code that will act on it.
    let verdict: any;
    try {
      const res = await fetchImpl(`${universe}/publish`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...item, dryRun: true }),
      });
      verdict = await res.json().catch(() => ({}));
      if (res.status === 409) {
        plan.refused.push({ ...item, why: verdict?.error ?? "refused" });
        continue;
      }
      if (!res.ok) throw new Error(verdict?.error ?? `HTTP ${res.status}`);
    } catch (e: any) {
      throw new Error(`Could not reach ${universe}. ${e?.message ?? ""}`.trim());
    }

    if (verdict.unchanged) plan.unchanged.push(item);
    else if (verdict.mode === "update") plan.update.push(item);
    else plan.create.push(item);
  }

  return plan;
}

/**
 * Send what the plan says to send. Unchanged items are skipped rather than written: a
 * redeploy of something nobody edited must not read as a change to anyone reviewing.
 */
export async function sendPublish(
  plan: PublishPlan,
  universe: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ sent: Array<CollectedItem & { mode?: string }>; failed: Array<CollectedItem & { why: string }> }> {
  const sent: Array<CollectedItem & { mode?: string }> = [];
  const failed: Array<CollectedItem & { why: string }> = [];

  for (const item of [...plan.create, ...plan.update]) {
    const res = await fetchImpl(`${universe}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(item),
    });
    const body = (await res.json().catch(() => ({}))) as { mode?: string; error?: string };
    if (res.ok) sent.push({ ...item, mode: body.mode });
    // The server's refusal message is written to be read; do not paraphrase it.
    else failed.push({ ...item, why: body.error ?? `HTTP ${res.status}` });
  }
  return { sent, failed };
}

export { collectProject };

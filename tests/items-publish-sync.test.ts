/**
 * DEPLOY IS A SYNC — and the two rules that keep a sync from being a footgun.
 *
 * 1. AN EMPTY WORKSPACE REMOVES NOTHING. A fresh clone missing its files, or the wrong
 *    folder entirely, collects zero items; syncing that against a full universe would
 *    propose deleting everything the project ever published. Removals are proposed only
 *    when the workspace holds at least one item.
 *
 * 2. AN OLDER UNIVERSE DEGRADES TO ADDITIVE. A universe that predates the list op
 *    answers it with an error; the plan then proposes no removals — the exact behavior
 *    every deploy had before the sync existed — rather than failing the deploy.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { planPublish } from "../src/items/publish.js";

const item = (name: string) => ({ kind: "component", name, definition: { name } }) as any;

/** A universe holding two rows for the project; verdicts always "create". */
function universeFetch(listStatus = 200) {
  return (async (_url: any, init?: any) => {
    const body = JSON.parse(init?.body ?? "{}");
    if (body.op === "list") {
      return new Response(
        listStatus === 200
          ? JSON.stringify({ items: [{ kind: "component", name: "org/kept" }, { kind: "component", name: "org/gone" }] })
          : JSON.stringify({ error: "unknown op" }),
        { status: listStatus, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ ok: true, mode: "create" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("a stale bare-named template (the pre-org era, the rename-strand case) is caught", async () => {
  // The exact live incident: lyceum-chat-layout, bare name, no org column, published
  // before the current flow. The server's list matches the org-qualified-by-convention
  // prefix, so the sync proposes it; the current apps in the workspace are untouched.
  const fetchImpl = (async (_url: any, init?: any) => {
    const body = JSON.parse(init?.body ?? "{}");
    if (body.op === "list")
      return new Response(
        JSON.stringify({ items: [{ kind: "template", name: "org-chat" }, { kind: "template", name: "org-chat-layout" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    return new Response(JSON.stringify({ ok: true, mode: "create" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const plan = await planPublish([{ kind: "template", name: "org-chat", definition: {} } as any], "https://u.example", "tok", "org", fetchImpl);
  assert.deepEqual(plan.remove, [{ kind: "template", name: "org-chat-layout" }]);
});

test("what left the workspace joins the plan as a removal", async () => {
  const plan = await planPublish([item("org/kept")], "https://u.example", "tok", "org", universeFetch());
  assert.deepEqual(plan.remove, [{ kind: "component", name: "org/gone" }]);
});

test("an empty workspace proposes NO removals, whatever the universe holds", async () => {
  const plan = await planPublish([], "https://u.example", "tok", "org", universeFetch());
  assert.deepEqual(plan.remove, []);
});

test("a universe that does not know the list op degrades to additive, not to failure", async () => {
  const plan = await planPublish([item("org/kept")], "https://u.example", "tok", "org", universeFetch(400));
  assert.deepEqual(plan.remove, []);
  assert.equal(plan.create.length, 1, "the deploy itself must still plan normally");
});

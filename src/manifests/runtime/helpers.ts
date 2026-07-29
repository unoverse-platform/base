/**
 * NAMED HELPERS, bound for the duration of one run.
 *
 * A package declares functions under `helpers:` in any shared/ file; every expression in
 * every node of that package can then call them by name. What this module solves is getting
 * the bag into scope: `evaluate` is called from 50-odd places, each building its own small
 * scope object ({ response }, { call }, { tool }, ...), and adding a `helpers` key to every
 * one of them would guarantee that someone adds the fifty-first without it. A helper that
 * works in `returns` and not in an events row is worse than no helpers at all.
 *
 * AsyncLocalStorage instead, bound once where a run begins. It is the platform primitive for
 * exactly this and it is concurrency-safe: two nodes running at once each see their own bag,
 * which a module-level "current package" variable would not give.
 *
 * NOT bound means an expression naming `helpers` fails with `unknown identifier 'helpers'`
 * from the sandbox — loud, and pointing at the expression. There is deliberately no empty-bag
 * fallback: a helper call that silently returned undefined would be the same class of quiet
 * wrong answer as the shallow $ref merge.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { makeHelpers } from "../../template/SafeExpression.js";
import type { ComposedNode } from "../compose.js";

type Bag = Record<string, (...a: unknown[]) => unknown>;

const STORE = new AsyncLocalStorage<Bag>();

/**
 * Built ONCE per composed node and cached against it.
 *
 * Each helper parses its body eagerly, so rebuilding the bag on every call would re-parse
 * every helper on every request. Keyed by the composed node object, which the loader
 * replaces wholesale when a package reloads, so a stale bag cannot outlive its source.
 */
const CACHE = new WeakMap<ComposedNode, Bag>();

function bagFor(node: ComposedNode): Bag {
  const hit = CACHE.get(node);
  if (hit) return hit;
  const built = makeHelpers(node.helpers ?? {});
  CACHE.set(node, built);
  return built;
}

/** Run `fn` with this node's helpers in scope for every expression it evaluates. */
export function withHelpers<T>(node: ComposedNode, fn: () => Promise<T>): Promise<T> {
  return STORE.run(bagFor(node), fn);
}

/** The bag bound to the current run, or undefined outside one. */
export function currentHelpers(): Bag | undefined {
  return STORE.getStore();
}

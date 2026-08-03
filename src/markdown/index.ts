/**
 * UNOVERSE MARKDOWN — a document is an ordered list of components from the design system,
 * each filled with content. See docs/unoverse/UNOVERSE_MARKDOWN.md.
 *
 * TWO WAYS TO PRODUCE ONE, same vocabulary, same renderer, same output:
 *
 *   Unoverse Markdown           the model CHOOSES the components   → compose.ts
 *   Unoverse Markdown Template  a designer chose them; the model
 *                               fills them                          → compile.ts
 *
 * THIS FILE IS THE PUBLIC SURFACE and nothing else. The rest is split by JOB, the way
 * `agent-mcp/` is, so a reader looking for how a part is judged is not scrolling past
 * schema compilation to find it.
 *
 *   types       the shapes, no behaviour
 *   collect     walk a definition, gather its briefs
 *   compile     gathered briefs → JSON Schema
 *   compose     every `category: markdown` atom → the menu a model composes from
 *   referee     judge what came back, one part at a time
 *   hydration   which fields the SERVER fills from a row, never the model
 *   gaps        what a page still owes
 *
 * IN `packages/base` BECAUSE EVERY PRODUCER NEEDS IT: a promoted page, an agent writing
 * mid-conversation, an email, a report. It lived in `server/src/mcp/`, which the engine
 * cannot import from, and that is the mechanical reason the content pipeline grew a
 * private hand-written copy of the same idea.
 *
 * NO SITUATION IS BAKED IN. `grounding` is the caller's: the compiler once defaulted to
 * one situation (a guest's live page, composed from spatial search) and every caller
 * inherited it, including a promotion that had run no searches at all.
 */

export type { BriefTag, DefNode, ComponentDefLike, Collected } from "./types.js";
export { collect, tag, boundField } from "./collect.js";
export { refName, compileBriefSchema, type CompileOptions } from "./compile.js";
export { MARKDOWN_CATEGORY, markdownComponentTypes, compileDocumentSchema, type ComponentType } from "./compose.js";
export { validateBriefPart, validateBriefArgs } from "./referee.js";
export { collectBriefHydration, type HydrationField, type HydrationLevel } from "./hydration.js";
export { listBriefGaps } from "./gaps.js";

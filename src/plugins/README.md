# plugins/ — LEGACY. Nothing new goes here.

This folder loads **JavaScript** nodes: a package with a `src/`, a `setup(api)` call, and
classes extending `PromiseNode` or `CallbackNode`. Every node becomes a YAML manifest
(`../manifests/`), so this whole folder is scheduled for deletion.

**Do not add to it. Do not tidy it. Do not move it.** Work spent here is work spent twice.

## What is still holding it open

17 packages still ship `src/`. Most are vendor integrations and are pure migration work,
but three are platform capability and are why this cannot simply be switched off:

| Package | Why it matters |
|---|---|
| `flow` | `IfElse`, `LoopStart`, `LoopEnd`, `Code`, `Context`, `FieldValidator`. **Control flow.** Deleting this folder today breaks every workflow with a loop or a condition |
| `ingest` | the content pipeline (document parsing, sheets, connectors) |
| `spatial` | `SpatialSearch` |

Two of the remaining ones also need the executor to grow first
(`DECLARATIVE_NODES.md` §10): a socket transport with audio framing for `openai-realtime`
and the streaming half of `elevenlabs`, and catalog matching for the hubspot and salesforce
attribute pull. Everything else is conversion, not invention.

## The folder is two jobs, dying on two timelines

```
discovery.ts  loader.ts  redis.ts     ← code-node loading. Dies with the last src/ package
install.ts  startup.ts  state.ts      ← npm acquisition. Dies when installs become rows
```

The second half looks permanent and is not. `013_items.sql` is explicit: "Installing
something from the marketplace is an INSERT... no npm, no image, no rsync, no restart."
Rows replace npm for content exactly as manifests replace code for nodes.

One thing to know before touching it: `startup.ts` installs `@unoverse-platform/marketplace`
at boot (`CORE_PACKAGES`), and the design system resolves out of that package
(`definitions/definitions.ts`). So the two halves must be switched off SEPARATELY. Killing
`plugins/` wholesale takes the design system with it.

## How it ends

No flag day. Each package that converts to YAML removes one reason for this folder to exist.
When no package ships `src/`, delete `discovery.ts`, `loader.ts`, `redis.ts` and
`../pluginBase.ts`. When installs are rows, delete the rest and the folder with it.

The two Vite warnings a developer sees when starting Studio come from `discovery.ts` and
`loader.ts` (dynamic `import()` of a package by name). They are correct, they are
unfixable while this folder exists, and they leave when it does.

See `docs/architecture/DECLARATIVE_NODES.md` §7a and §10.

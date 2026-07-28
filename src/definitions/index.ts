/**
 * rx DEFINITIONS: components, templates, atoms, themes.
 *
 * The other half of "read the YAML and make it mean something". `manifests/` turns node
 * YAML into a runnable node; this turns rx YAML into the components, templates and tokens
 * an interface is assembled from.
 *
 * IT LIVES HERE SO STUDIO CAN BE PUBLISHED. These four files sat in the platform server, so
 * anything outside this monorepo that wanted to list or render rx content had to reach into
 * `apps/unoverse/server/src` — which nothing installed from npm can do. Studio was blocked
 * on exactly that.
 *
 * READING, not rendering. These read rx off disk; `@unoverse/sdk` renders it. The split
 * matters: the SDK is a dumb renderer and must stay one.
 */
export { resolveStringTemplate } from "../template/StringTemplateResolver.js";
export * from "./definitions.js";
export * from "./theme.js";
export * from "./inputs.js";

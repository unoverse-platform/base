/**
 * The per-node structural walk: primitives, style keys, conditions, dimensions, slots.
 *
 * This is the hot path of the linter. Every node of every definition passes through it,
 * and it is where LAW 1 (tokens only, never a raw px or hex) and the closed style
 * vocabulary are enforced.
 *

 * These rules close over the run: the design-system location, the token scale, which refs
 * resolve, which app sizes exist. Rather than thread ten parameters through a recursive
 * walk, each module exports a MAKER that takes the context once and returns the function.
 *
 * The context is created per run by index.mjs, so nothing survives between runs.
 */
import { existsSync, statSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname, basename, relative, sep } from "node:path";
import { PRIMITIVES, CONDITION_KEYS, STYLE_KEYS, RAW_VALUE, CHILD_NODE_KEYS, PARTIAL_DIRS, DIMENSION_KEYS } from "./vocabulary.mjs";
import { isDefFile, defName, defPath, readDef } from "./defs.mjs";

export function makeWalkNode(ctx) {
  const { report, checkCondition, checkDimension, appSizesForFile, componentNamesForFile, refResolves, atomsDirExists, stepList, spaceSteps, isTemplatePath, defRoot } = ctx;

function walkNode(node, file, root, widthCap = null, isLayoutRoot = false) {
  if (Array.isArray(node)) return node.forEach((n) => walkNode(n, file, root, widthCap));
  if (!node || typeof node !== "object") return;

  // $include — resolves against the DEFINITION ROOT (layouts/ states/ components/…)
  if (typeof node.$include === "string") {
    const a = defPath(root, node.$include);
    const b = join(root, node.$include);
    if (!a && !existsSync(b))
      report("error", file, `$include "${node.$include}" does not resolve under ${relative(process.cwd(), root)}/ (docs/design/03)`);
    return; // the included file is linted on its own
  }

  const t = node.type;
  if (typeof t !== "string")
    report("error", file, `node without "type" (and no $include). Every node names a primitive (docs/design/02)`);
  else if (!PRIMITIVES.has(t))
    report("error", file, `unknown primitive "${t}". The set is closed; compose, don't invent (docs/design/02)`);

  if (t === "Switch") {
    if (typeof node.on !== "string" || !node.cases || typeof node.cases !== "object")
      report("error", file, `Switch needs "on" (the discriminant field) + "cases" (docs/design/04)`);
    else
      for (const [caseKey, branch] of Object.entries(node.cases)) {
        const vw = branch && typeof branch === "object" ? branch.visibleWhen : undefined;
        const guarded = typeof vw === "string" ? vw : vw && typeof vw === "object" ? vw.field : null;
        if (guarded === node.on)
          report("error", file, `Switch on "${node.on}" → case "${caseKey}" re-guards its own discriminant. A layer never guards itself; delete the visibleWhen (docs/design/03)`);
      }
  }
  // Each: a `template` + a list — EITHER a literal `items:[]` (hardcoded content,
  // the microapp default) OR `bind.items` (a workflow-fed array).
  if (t === "Each") {
    const hasList = Array.isArray(node.items) || (node.bind && typeof node.bind === "object" && node.bind.items);
    if (!node.template || !hasList)
      report("error", file, `Each needs "template" + a list. Literal "items": [...] or "bind": { "items": "<field>" } (docs/design/03)`);
  }
  if (t === "Ref") {
    if (typeof node.ref !== "string")
      report("error", file, `Ref needs "ref": "<atom name>" (docs/design/03)`);
    else if (atomsDirExists && !refResolves(node.ref))
      report("error", file, `Ref "${node.ref}". No matching atom (rx/marketplace/atoms) or shared component (rx/marketplace/components); lookup is case-insensitive by name`);
  }
  if (t === "ComponentSlot") {
    if (!node.select || typeof node.select !== "object")
      report("error", file, `ComponentSlot needs "select" ({} for the conversation flow) (docs/design/05)`);
    else if (node.select.from === "all" && !node.select.type && !node.select.where)
      report("warn", file, `global ComponentSlot (from:"all") with no "type" and no "where". Selects OLDEST-first; a trap in a multi-turn surface. Filter by "where" (the reaction contract, §5b) or pin "type", unless the shell is deliberately catch-all (docs/design/05)`);
    // STATE-SELECTED UI (STATE_MODEL §5b): a reaction surface reacts to the component's
    // VIEW — the `defaultState` discriminant — never to a component's internal state
    // (step/phase/…) which is private to the component. Selecting on any other field
    // reaches past the view boundary the whole model rests on.
    else if (node.select.where && node.select.where.field && node.select.where.field !== "defaultState")
      report("warn", file, `reaction surface selects on "${node.select.where.field}". A template reacts to a component's VIEW ("defaultState"), never its internal state (that is private to the component). Select on "defaultState" (STATE_MODEL §5b)`);
    // ONE STATE AT A TIME (docs/design/04): the active state is THE latest surfaced
    // view, so a surface must claim exactly ONE view by `eq` — `ne`/`in`/bare selects
    // make "which state is the template in?" ambiguous.
    else if (node.select.where && node.select.where.field === "defaultState" && typeof node.select.where.eq !== "string")
      report("error", file, `a reaction surface claims exactly ONE view: select.where needs "eq": "<view>": ne/in/bare make the template's active state ambiguous (docs/design/04)`);
  }

  // STATE-OWNED SIZING (docs/design/05): every PANEL states its width once via
  // `appWidth`; the app is the sum of the open ones. A plain node = always open (the
  // core chat column); a reaction-surface ComponentSlot = open while occupied; a
  // visibleWhen pane = open while its condition matches.
  if (node.appWidth !== undefined) {
    if (typeof node.appWidth !== "string" || node.appWidth.trim() === "")
      report("error", file, `"appWidth" must be a CSS width string ("360px", "min(50vw, 760px)") or a named app size ("chat", "rail", "panel") (docs/design/05)`);
    // `flex` is contract vocabulary, not a token: the surface takes the REMAINING
    // host space (the SDK reports a full-width app while it is active).
    // Any other bare name is a STANDARD SIZE — it must exist in the org's
    // styles/semantic/app-sizes (or the inherited marketplace set); the server
    // resolves it at serve time, and an unknown name resolves to NOTHING silently.
    else if (node.appWidth !== "flex" && /^[a-z][a-z0-9-]*$/i.test(node.appWidth)) {
      const sizes = appSizesForFile(file);
      if (sizes && !(node.appWidth in sizes))
        report("error", file, `"appWidth": "${node.appWidth}" names no app size. Use "flex", a CSS width, or a name from styles/semantic/app-sizes (known: ${Object.keys(sizes).join(", ") || "none"}) (docs/design/05)`);
    }
    if (t === "ComponentSlot" && !(node.select && node.select.where))
      report("error", file, `"appWidth" on a ComponentSlot without select.where. Only a reaction surface can slide out; the flow slot never sizes the app (docs/design/05)`);
    // ONE declaration per panel: the SDK sizes the frame FROM appWidth (width +
    // flex: 0 0 auto) — a frame width/flex alongside it is dead duplication that
    // can silently disagree.
    if (t === "ComponentSlot" && node.frame && node.frame.style) {
      for (const dup of ["width", "flex"])
        if (node.frame.style[dup] !== undefined)
          report("error", file, `panel frame declares style.${dup} alongside appWidth. The panel states its width ONCE; the SDK sizes the frame from appWidth. Remove the frame ${dup} (docs/design/05)`);
    }
  }

  // BRIEFED COMPONENTS (the composer): a `brief` sits on the node that renders what it
  // describes and compiles into the component's MCP tool schema (server briefSchema →
  // registry metadata.inputSchema → the minted tool). Shape is a closed contract —
  // a typo'd key or misplaced constraint silently weakens the compiled schema.
  if (node.brief !== undefined) {
    const b = node.brief;
    if (typeof b !== "string" && (typeof b !== "object" || b === null || Array.isArray(b)))
      report("error", file, `"brief" must be a string (the description) or { description, maxLength | minItems/maxItems } (docs/design/03)`);
    else if (typeof b === "object") {
      // description/maxLength/minItems/maxItems COMPILE into the tool inputSchema. `hydrate` is a
      // NON-schema brief annotation (a hydration hook naming what to hydrate) — a valid brief key
      // that does NOT compile into the schema; allowed here so it doesn't read as a typo.
      // `optional` marks a field the model may omit: a brief saying "empty when the source
      // gives none" must not compile to a required, minLength-1 string, or the model has to
      // invent a value to satisfy the schema.
      const BRIEF_KEYS = new Set(["description", "maxLength", "minItems", "maxItems", "hydrate", "optional"]);
      for (const k of Object.keys(b))
        if (!BRIEF_KEYS.has(k))
          report("error", file, `brief.${k} is not part of the brief contract. Only description / maxLength / minItems / maxItems / optional (schema) or hydrate (hydration hook) are allowed (docs/design/03)`);
      if (b.description !== undefined && typeof b.description !== "string")
        report("error", file, `brief.description must be a string. It IS the schema field's description (docs/design/03)`);
      if (b.optional !== undefined && typeof b.optional !== "boolean")
        report("error", file, `brief.optional must be a boolean (docs/design/03)`);
      if (b.hydrate !== undefined && typeof b.hydrate !== "string")
        report("error", file, `brief.hydrate must be a string (names the field/source to hydrate) (docs/design/03)`);
      for (const nk of ["maxLength", "minItems", "maxItems"])
        if (b[nk] !== undefined && (typeof b[nk] !== "number" || b[nk] < 0 || !Number.isInteger(b[nk])))
          report("error", file, `brief.${nk} must be a non-negative integer. It compiles to the native JSON Schema keyword (docs/design/03)`);
      if (typeof b.minItems === "number" && typeof b.maxItems === "number" && b.minItems > b.maxItems)
        report("error", file, `brief.minItems (${b.minItems}) > maxItems (${b.maxItems}). No composition can satisfy this schema (docs/design/03)`);
      const bound = node.bind && (node.bind.value || node.bind.src);
      const isEach = t === "Each" && node.bind && node.bind.items;
      if (b.maxLength !== undefined && !bound)
        report("warn", file, `brief.maxLength on a node with no bind. A length cap only compiles when the brief sits next to the bound field it governs (docs/design/03)`);
      if ((b.minItems !== undefined || b.maxItems !== undefined) && !isEach)
        report("warn", file, `brief.minItems/maxItems on a non-Each node. Item counts only compile on the Each that binds the array (docs/design/03)`);
    }
  }

  if (node.visibleWhen !== undefined) checkCondition(node.visibleWhen, file, t || "node");

  // deprecated FOCUS BRIDGE (STATE_MODEL §5b): nothing writes a template `defaultState`
  // key anymore — a component writes only its own slice; templates react via select.where.
  // (Legit panel/draft setTemplateValue writes a DIFFERENT key and is untouched.)
  const scanAction = (a) => {
    if (!a || typeof a !== "object") return;
    if (a.type === "setTemplateValue") {
      // A COMPONENT writes only its own slice — ANY template-state write from the
      // shared component home is the deprecated bridge (STATE_MODEL §5b). Template-
      // local partials (composer, suggestions) legitimately write template chrome.
      if (!isTemplatePath(file))
        report("error", file, `a component never writes template state: setTemplateValue is the deprecated bridge; change the view with setValue and let the template react via select.where (STATE_MODEL §5b)`);
      else if (Array.isArray(a.values) && a.values.some((v) => v && v.key === "defaultState"))
        report("warn", file, `setTemplateValue writing "defaultState" is the deprecated focus bridge. A component writes only its own slice; templates react via ComponentSlot.select.where (STATE_MODEL §5b)`);
    }
    if (a.then) scanAction(a.then);
  };
  if (node.action) scanAction(node.action);

  // style — closed KEY vocabulary + real space-scale VALUES (both cross-platform contracts)
  if (node.style && typeof node.style === "object") {
    // a container query the element's own layout can never satisfy — the threshold is
    // at/above an ancestor's maxWidth cap, so visibility is decided by the HOST surface,
    // not the design (shows in a wide studio stage, vanishes in a chat column)
    const mw = node.style.maxWidth;
    if (typeof mw === "string" && /^\d+$/.test(mw))
      widthCap = widthCap == null ? Number(mw) : Math.min(widthCap, Number(mw));
    const hb = node.style.hideBelow;
    if (typeof hb === "string" && /^\d+$/.test(hb) && widthCap != null && Number(hb) >= widthCap)
      report("warn", file, `hideBelow "${hb}" ≥ an ancestor maxWidth "${widthCap}". The query can only be satisfied by the surrounding surface, so visibility depends on the host, not the card; lower the threshold below the card's own max width (docs/design/06)`);
    const checkKeys = (obj, where) => {
      for (const k of Object.keys(obj)) {
        if (k === "when") continue; // validated below
        if (!STYLE_KEYS.has(k))
          report("error", file, `${where}: unknown style key "${k}". The style vocabulary is closed (the cross-platform contract). Typo, or a web-ism that won't port (docs/design/06)`);
        else if ((k === "hover" || k === "active") && obj[k] && typeof obj[k] === "object")
          checkKeys(obj[k], `${where}.${k}`);
        else if (DIMENSION_KEYS.has(k)) checkDimension(file, where, k, obj[k]);
      }
    };
    checkKeys(node.style, `${t}.style`);
    // style.when = [{ field, eq|ne|in?, apply:{…} }, …]
    if (node.style.when !== undefined) {
      const w = node.style.when;
      if (!Array.isArray(w))
        report("error", file, `${t}.style.when must be an array of { field, eq|ne|in, apply } entries (docs/design/04)`);
      else
        for (const e of w) {
          if (!e || typeof e !== "object" || typeof e.field !== "string" || !e.apply)
            report("error", file, `${t}.style.when entry needs "field" + "apply" (docs/design/04)`);
          else {
            const extra = Object.keys(e).filter((k) => !CONDITION_KEYS.has(k) && k !== "apply");
            if (extra.length)
              report("error", file, `${t}.style.when: illegal key(s) ${extra.join(", ")}. Conditions are eq/ne/in/truthy only (docs/design/04)`);
            if (typeof e.apply === "object") checkKeys(e.apply, `${t}.style.when.apply`);
          }
        }
    }
  }

  for (const key of CHILD_NODE_KEYS) if (node[key] !== undefined) walkNode(node[key], file, root, widthCap);
  if (t === "Switch" && node.cases && typeof node.cases === "object")
    for (const branch of Object.values(node.cases)) walkNode(branch, file, root, widthCap);
}

// ── stateOrder ⇄ states/ folder cross-check ──

  return walkNode;
}

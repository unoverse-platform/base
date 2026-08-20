/**
 * The per-FILE rules: what a definition must declare about itself.
 *
 * Manifests (discovery meta, whenToUse shape), faces (a Switch on defaultState reaching
 * layouts/<state>), state ordering, microapp discipline (props are inputs, state is scalar
 * view-state). Everything that is about the file as a whole rather than a node within it.
 *

 * These rules close over the run: the design-system location, the token scale, which refs
 * resolve, which app sizes exist. Rather than thread ten parameters through a recursive
 * walk, each module exports a MAKER that takes the context once and returns the function.
 *
 * The context is created per run by index.mjs, so nothing survives between runs.
 */
import { existsSync, statSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname, basename, relative, sep } from "node:path";
import { RAW_VALUE, PARTIAL_DIRS } from "./vocabulary.mjs";
import { isDefFile, defName, defPath, readDef, parseDef } from "./defs.mjs";

export function makeLintFile(ctx) {
  const { report, walkNode, isFixture, isHook, isManifest, isTemplatePath, defRoot, componentNamesForFile, DS, orgDirs, RX, readText } = ctx;

function checkStateOrder(order, rootFolder, file, includeLayouts = false) {
  if (!Array.isArray(order)) return;
  const dirNames = (sub) => {
    const d = join(rootFolder, sub);
    return existsSync(d)
      ? readdirSync(d).filter(isDefFile).map(defName)
      : [];
  };
  // TEMPLATES: stateOrder lists LOCAL states + LAYOUTS in picker order (docs/design/05) —
  // a layout name (the view a component enters) is a valid entry. COMPONENTS: states only.
  const stateNames = dirNames("states");
  const onDisk = new Set([...stateNames, ...(includeLayouts ? dirNames("layouts") : [])]);
  for (const name of order)
    if (typeof name === "string" && !onDisk.has(name))
      report("error", file, `stateOrder lists "${name}" but no states/${name}${includeLayouts ? ` or layouts/${name}` : ""} definition exists (docs/design/${includeLayouts ? "05" : "03"})`);
  // Only STATES must appear in stateOrder to lock the picker order; the default layout is
  // legitimately omitted, so never warn on layouts.
  for (const name of stateNames)
    if (!order.includes(name))
      report("warn", file, `states/${name}.json is not in stateOrder. It falls to the end of the picker; add it to lock the order (docs/design/07)`);
}

// ── lint one file ──
function lintFile(file) {
  // `readText` is disk unless the caller supplied an overlay for this path (index.mjs).
  // Studio's editor lints unsaved text through exactly these rules that way.
  const src = readText(file);

  // LAW 1 — tokens only (skip manifest + fixture; styles/ is never in a def home).
  // Exempt: `appWidth` — the HOST-facing outer width (state-owned sizing, docs/design/05).
  // It is raw CSS the embed host applies to the app panel ("min(50vw, 760px)", "360px"),
  // never a style the SDK resolves — token law governs the inside, not the envelope.
  if (!isFixture(file) && !isHook(file) && !isManifest(file))
    src.split("\n").forEach((line, i) => {
      if (RAW_VALUE.test(line) && !/^\s*"?appWidth"?\s*:/.test(line))
        report("error", file, `raw value. Token names only; add/scale a token in the org styles instead (LAW 1, docs/design/06): ${line.trim()}`, i + 1);
    });

  let json;
  try {
    json = parseDef(src, file);
  } catch (e) {
    report("error", file, `invalid ${file.endsWith(".yaml") ? "YAML" : "JSON"}: ${e.message}`);
    return;
  }

  if (isFixture(file)) return; // legacy fixture, unused: don't choke
  if (isHook(file)) return;    // a lifecycle hook: calls + a projection, not a UI tree

  if (isManifest(file)) {
    const root = dirname(file);
    if (isTemplatePath(file)) {
      // TEMPLATE manifest = the envelope. Requires binding + a resolvable root.
      for (const req of ["name", "whenToUse"])
        if (!json[req]) report("warn", file, `template manifest missing "${req}": ${req === "whenToUse" ? "the AI selects the app by it" : "the display name"} (docs/design/05)`);
      if (!(json.binding && json.binding.workflow))
        report("warn", file, `template manifest has no binding.workflow. The app owns its workflow binding (docs/design/05)`);
      // Two valid roots (definitions.ts:229): the STANDARD manifest-only form (root =
      // layouts/<layout>), OR a `<name>` envelope OVERRIDE (its own root). Only the
      // manifest-only form must resolve a layout; an envelope-form template supplies its own.
      const hasEnvelope = !!defPath(root, basename(root));
      if (!hasEnvelope) {
        const layoutName = json.layout ?? "main";
        if (!defPath(join(root, "layouts"), layoutName))
          report("error", file, `manifest.layout "${layoutName}" → layouts/${layoutName} does not exist (and no <name> envelope) (docs/design/05)`);
      }
      // THE TEMPLATE TREE (STATE_MODEL v2, checkpoint 2026-08-08): a manifest
      // `states:` block declares the whole machine — validate the DECLARATION:
      //   top-level order is the ladder (base first by convention, named for the
      //   default layout); every non-base top-level state needs its arrangement
      //   (layouts/<name>); every base substate needs its state file
      //   (states/<name>); a name cannot be both; an authored stateOrder is
      //   superseded and should be deleted.
      if (json.states !== undefined) {
        if (!json.states || typeof json.states !== "object" || Array.isArray(json.states)) {
          report("error", file, `manifest "states" must be an object — the template tree: { <base>: { states: {…} }, <reaction>: {}, … } (STATE_MODEL §5)`);
        } else {
          const names = Object.keys(json.states);
          const base = json.layout ?? "main";
          if (!names.includes(base))
            report("error", file, `the template tree must include the BASE state "${base}" (named for the default layout) — the ladder derives as the top level minus it (STATE_MODEL §5)`);
          const subs = [];
          for (const [n, s] of Object.entries(json.states)) {
            if (s !== null && (typeof s !== "object" || Array.isArray(s)))
              report("error", file, `tree state "${n}" must be an object ({} is a complete state) (STATE_MODEL §5)`);
            if (n !== base && !defPath(join(root, "layouts"), n) && !defPath(join(root, "states"), n))
              report("error", file, `tree state "${n}" has no layouts/${n} and no states/${n}. A reaction state needs its drawing — a full arrangement (layouts/) or a STACKED overlay (states/, LAYERS §6) (STATE_MODEL §5)`);
            const nested = s && typeof s === "object" ? s.states : undefined;
            if (nested && typeof nested === "object" && !Array.isArray(nested))
              for (const sub of Object.keys(nested)) {
                subs.push(sub);
                if (!defPath(join(root, "states"), sub))
                  report("error", file, `substate "${sub}" (under "${n}") has no states/${sub} file — a contained substate is a state file the base includes (STATE_MODEL §5)`);
              }
          }
          for (const sub of subs)
            if (names.includes(sub))
              report("error", file, `"${sub}" is declared both as a top-level state and a substate — nesting IS containment; a name lives at exactly one level (STATE_MODEL §5)`);
          if (json.stateOrder !== undefined)
            report("warn", file, `"stateOrder" is superseded by the "states" tree (the ladder derives from the top level minus the base) — delete it (STATE_MODEL §5)`);
        }
      } else checkStateOrder(json.stateOrder, root, file, /* includeLayouts */ true);
      // ONE STATE AT A TIME (docs/design/04): the active state is derived from the
      // latest surfaced VIEW, so no two surfaces in one template may claim the same
      // view — the active surface would be ambiguous.
      {
        const claims = new Map(); // view -> first file
        const collectClaims = (n, from) => {
          if (Array.isArray(n)) return n.forEach((c) => collectClaims(c, from));
          if (!n || typeof n !== "object") return;
          const w = n.type === "ComponentSlot" ? n.select?.where : null;
          if ((w?.field === "view" || w?.field === "defaultState") && typeof w.eq === "string") {
            if (claims.has(w.eq))
              report("error", file, `two reaction surfaces claim the view "${w.eq}" (${claims.get(w.eq)} and ${from}). A template is in ONE state at a time; each view has exactly one surface (docs/design/04)`);
            else claims.set(w.eq, from);
          }
          for (const v of Object.values(n)) if (v && typeof v === "object") collectClaims(v, from);
        };
        for (const sub of ["layouts", "states", "components"]) {
          const d = join(root, sub);
          if (!existsSync(d)) continue;
          for (const f of readdirSync(d).filter(isDefFile)) {
            try {
              collectClaims(readDef(join(d, f)), `${sub}/${f}`);
            } catch {
              /* that file lints separately */
            }
          }
        }
      }
      if (json.mode !== undefined && json.defaultState === undefined)
        report("warn", file, `"mode" was renamed to "defaultState". Still read as a fallback, but rename it (docs/design/04)`);
      // `preview` — the per-state MOCK map ({ "<state>": ["course-card", …] }): each key
      // must be a states/ file, each name a real component. A repeated name seeds
      // several instances (a card rail).
      if (json.preview !== undefined) {
        if (!json.preview || typeof json.preview !== "object" || Array.isArray(json.preview))
          report("error", file, `"preview" must be an object mapping state names to component-name arrays (docs/design/07)`);
        else {
          // preview keys are per-LAYOUT (the component view Studio mocks) or a local state
          // (docs/design/05) — resolve against states/ ∪ layouts/, same as stateOrder.
          const viewsIn = (sub) => {
            const d = join(root, sub);
            return existsSync(d)
              ? readdirSync(d).filter(isDefFile).map(defName)
              : [];
          };
          const states = new Set([...viewsIn("states"), ...viewsIn("layouts")]);
          const comps = componentNamesForFile(file);
          for (const [state, list] of Object.entries(json.preview)) {
            if (!states.has(state))
              report("error", file, `preview."${state}". No states/${state}.json or layouts/${state}.json in this template (docs/design/07)`);
            // An OBJECT entry is authored TEMPLATE-STATE mock data (what the workflow
            // would have echoed — comments, a discriminant, an anchor), merged verbatim
            // when the state's pill is picked. Only the two shapes; anything else errors.
            if (list && typeof list === "object" && !Array.isArray(list)) continue;
            if (!Array.isArray(list) || list.some((c) => typeof c !== "string")) {
              report("error", file, `preview."${state}" must be an array of component names, or an object of template-state mock data`);
              continue;
            }
            for (const c of list)
              if (comps && !comps.has(String(c).toLowerCase()))
                report("error", file, `preview."${state}" names unknown component "${c}". No match in rx/components/ or this org's components/ (org-privacy: another org's components are out of reach; lookup is case-insensitive)`);
          }
        }
      }
      // Sizing is STATE-OWNED (docs/design/05): the layout root's `appWidth` is the core
      // surface's constant width; a panel slot's `appWidth` slides out on top. Manifest
      // width/focusWidth are DEAD — nothing reads them; there is no fallback.
      for (const dep of ["width", "focusWidth"])
        if (json[dep] !== undefined)
          report("error", file, `manifest "${dep}" is dead. Nothing reads it. Sizing is state-owned: \`appWidth\` on the layout root (constant core width) or on a panel (slide-out width) (docs/design/05)`);
    } else {
      // COMPONENT manifest = OPTIONAL spatial discovery. No binding. Mirrors the
      // discovery-meta assertions in server/src/runtime/microapp-structure.test.ts.
      const desc = typeof json.description === "string" ? json.description.trim() : "";
      if (desc.length < 20)
        report("error", file, `discovery manifest.description missing/too short. One line (≥20 chars) saying what the component IS (docs/design/03a)`);
      else if (desc.length > 120)
        report("error", file, `discovery manifest.description is ${desc.length} chars: it's the listing subtitle (≤120); move detail into whenToUse (docs/design/03a)`);
      const wtu = typeof json.whenToUse === "string" ? json.whenToUse.trim() : "";
      if (wtu.length < 20)
        report("error", file, `discovery manifest.whenToUse missing/too short. The utterance-shaped selection text findIntent ranks on (docs/design/03a)`);
      else if (/\b(pick when|use (this|when)|when the user|the user (asks|wants|needs)|select (this|when))\b/i.test(wtu))
        report("error", file, `discovery manifest.whenToUse is selector-shaped. Write the words the USER would say, not instructions about the user (docs/design/03a)`);
      if (json.binding)
        report("warn", file, `a component discovery manifest has no workflow. Drop "binding" (a component is streamed or node-hydrated) (docs/design/03a)`);
      // `lifetime` — OPTIONAL render lifetime (docs/design/04 §Two lifetimes). Closed set:
      // "turn" (default — the universal new-turn reset) | "conversation" (durable
      // conversation-scoped surface: conversation-keyed instance, exempt from the
      // new-turn reset, retired only by replacement, self-close, or a template swap).
      if (json.lifetime !== undefined && json.lifetime !== "turn" && json.lifetime !== "conversation")
        report("error", file, `manifest "lifetime" must be "turn" (default) or "conversation". Got ${JSON.stringify(json.lifetime)} (docs/design/04 §Two lifetimes)`);
    }
    return;
  }

  const isEnvelope = typeof json.unoverse === "string";
  const root = defRoot(file);

  if (isEnvelope) {
    // COMPONENT envelope (templates have no envelope — their manifest is it).
    for (const req of ["kind", "name", "root"])
      if (json[req] === undefined) report("error", file, `envelope missing "${req}" (docs/design/02)`);
    if (json.kind && !["component", "template", "atom"].includes(json.kind))
      report("error", file, `unknown kind "${json.kind}"`);
    if (json.kind === "component" && !json.category)
      report("warn", file, `component has no "category". Used to group it in the palette (docs/design/02)`);
    if (json.root) walkNode(json.root, file, root);

    // ── the contained-microapp discipline (mirrors microapp-structure.test.ts) ──
    if (json.kind === "component") {
      const hasLayouts = existsSync(join(root, "layouts"));
      const statesDir = join(root, "states");
      const stateFiles = existsSync(statesDir)
        ? readdirSync(statesDir).filter(isDefFile).map(defName).sort()
        : [];
      const hasStateBlock = json.state && typeof json.state === "object";

      // the discovery manifest is the single home for description/whenToUse — no dup
      if (defPath(root, "manifest"))
        for (const k of ["description", "whenToUse"])
          if (json[k] !== undefined)
            report("error", file, `envelope duplicates manifest meta "${k}". The discovery manifest is the single home (docs/design/03a)`);

      // deprecated bridge: a top-level `defaultState` triggers the component node TEMPLATE_DATA emit
      if (json.defaultState !== undefined)
        report("warn", file, `top-level "defaultState" is the deprecated bridge (component-node TEMPLATE_DATA emit). The master state lives in the \`state\` block; templates react via ComponentSlot.select.where (STATE_MODEL §5b)`);

      // only components that ADOPTED the structure are held to the full discipline
      if (hasLayouts || stateFiles.length || hasStateBlock) {
        const nonInput = Object.entries(json.props ?? {})
          .filter(([, v]) => !(v && typeof v === "object" && v.input === true))
          .map(([k]) => k);
        if (nonInput.length)
          report("error", file, `microapp props [${nonInput.join(", ")}] are not input:true. Hardcode content in the layout, or move mutable keys into the \`state\` block (docs/design/03)`);

        // STATE MODEL v2 (UNOVERSE_STATE_MODEL §5): an authored `state.view` TREE is
        // the component's state machine — the ONE object the scalar rule admits.
        // Well-formed = { initial?: string, states: { <name>: { layout?/layouts?/on?/
        // initial?/states? } } }. A malformed tree is still an error.
        const isViewTree = (v) => {
          if (!v || typeof v !== "object" || Array.isArray(v)) return false;
          if (v.initial !== undefined && typeof v.initial !== "string") return false;
          if (!v.states || typeof v.states !== "object" || Array.isArray(v.states)) return false;
          return Object.values(v.states).every(
            (s) => s && typeof s === "object" && !Array.isArray(s) &&
              (s.on === undefined || typeof s.on === "string") &&
              (s.initial === undefined || typeof s.initial === "string") &&
              (s.layout === undefined || typeof s.layout === "string"),
          );
        };
        const viewTree = hasStateBlock && isViewTree(json.state.view) ? json.state.view : null;

        // the state block holds SCALAR internal view-state ONLY — an array/object (a
        // finder's result rows) or a URL is content/data slop: hardcode it in the layout,
        // or move workflow-fed data to props (input:true) (AUTHORING §3). The one
        // exception: a well-formed v2 `state.view` tree (STATE_MODEL §5 rule 1).
        if (hasStateBlock)
          for (const [k, v] of Object.entries(json.state)) {
            if (k === "view" && viewTree) continue;
            if (Array.isArray(v) || (v && typeof v === "object"))
              report("error", file, `state.${k} is an ${Array.isArray(v) ? "array" : "object"}. The state block is SCALAR view-state only (the one object allowed is a well-formed v2 \`state.view\` tree); workflow-fed data → props (input:true), static content → hardcode in the layout (docs/design/03)`);
            else if (typeof v === "string" && /^https?:\/\//.test(v))
              report("error", file, `state.${k} is a URL. Content, not view-state; hardcode it in the layout (or props input:true if workflow-fed) (docs/design/03)`);
          }

        if (hasLayouts) {
          const raw = JSON.stringify(json.root ?? {}).replace(/\s/g, "");
          if (viewTree) {
            // v2: the tree owns the states; the root switches the PUBLIC axis (`view`).
            if (!raw.includes('"on":"view"') || !/"\$include":"layouts\//.test(raw))
              report("error", file, `a v2 component (state.view tree) must root-Switch on "view" → $include layouts/<layout> (each state owns its layout; same-name by convention) (STATE_MODEL §5)`);
          } else if (!raw.includes('"on":"defaultState"') || !/"\$include":"layouts\//.test(raw))
            report("error", file, `a faced component's root must Switch on defaultState → $include layouts/<state> (legacy; or declare a v2 state.view tree and Switch on "view") (docs/design/03)`);

          // ── face set ⇄ layouts/ cross-check (OPEN name set — inline/focused/<any>) ──
          // The FACES are the root Switch's cases; Studio's face toggle and the render
          // path both derive from them, so cases and layout files must agree exactly.
          const axis = viewTree ? "view" : "defaultState";
          const findFaceSwitch = (n) => {
            if (!n || typeof n !== "object") return null;
            if (Array.isArray(n)) { for (const c of n) { const r = findFaceSwitch(c); if (r) return r; } return null; }
            if (n.type === "Switch" && n.on === axis && n.cases && typeof n.cases === "object") return n;
            for (const v of Object.values(n)) { const r = findFaceSwitch(v); if (r) return r; }
            return null;
          };
          const faceSwitch = findFaceSwitch(json.root);
          if (faceSwitch) {
            const cases = faceSwitch.cases;
            const caseNames = Object.keys(cases).filter((k) => k !== "default");
            // inline is the UNIVERSAL default face: an unknown/absent defaultState must
            // render SOMETHING — require an `inline` case or an explicit `default`.
            // EXCEPTION — a SURFACE-ONLY component (docs/design/03): its manifest
            // declares a SURFACED arrival (defaultState naming one of its cases, not
            // inline), and it deliberately renders NOTHING while unsurfaced (e.g. a
            // rail card retired by a new turn). Then omitting inline/default is the
            // point, not a mistake.
            if (!caseNames.includes("inline") && cases.default === undefined) {
              // v2: the tree's `initial` IS the declared base — the component always
              // has somewhere to rest, so no inline/default case is required as long
              // as the initial names a real case.
              const treeInitial = viewTree ? (viewTree.initial ?? Object.keys(viewTree.states)[0]) : undefined;
              let arrival;
              try {
                const mp = defPath(root, "manifest");
                if (mp) arrival = readDef(mp).defaultState;
              } catch { /* linted separately */ }
              const surfaceOnly = typeof arrival === "string" && arrival !== "inline" && caseNames.includes(arrival);
              const v2Based = typeof treeInitial === "string" && caseNames.includes(treeInitial);
              if (!surfaceOnly && !v2Based)
                report("error", file, `faced component's Switch has no "inline" case and no "default". Inline is the universal default face; a component with neither disappears for unknown states. (v2: the state.view tree's \`initial\` naming a case also satisfies this; legacy surface-only: manifest.defaultState naming one of its cases.) (STATE_MODEL §5)`);
            }
            // Each named case's layout include must MATCH the case name — the layout
            // filename IS the state name (Studio writes defaultState=<case>).
            const usedLayouts = new Set();
            for (const [name, body] of Object.entries(cases)) {
              const inc = body && typeof body === "object" ? body.$include : undefined;
              if (typeof inc !== "string" || !inc.startsWith("layouts/")) continue;
              const layoutName = inc.slice("layouts/".length);
              usedLayouts.add(layoutName);
              // v2: the STATE owns its layout — the tree's declaration decides which
              // file draws it (same-name by default). Legacy: same-name is the law.
              const expected = viewTree?.states?.[name]?.layout ?? name;
              if (name !== "default" && layoutName !== expected)
                report("error", file, viewTree
                  ? `state "${name}" declares layout "${expected}" but its case includes layouts/${layoutName} — the tree's declaration and the case must agree (STATE_MODEL §5 rule 1)`
                  : `face case "${name}" includes layouts/${layoutName}. The layout FILENAME is the state name; rename one so they match (docs/design/03)`);
            }
            // v2: tree-declared layouts (including nested substates' and variants') are
            // reachable by declaration — seed them so the orphan check knows them.
            if (viewTree) {
              const seed = (states) => {
                for (const s of Object.values(states ?? {})) {
                  if (!s || typeof s !== "object") continue;
                  if (typeof s.layout === "string") usedLayouts.add(s.layout);
                  if (s.layouts && typeof s.layouts === "object")
                    for (const l of Object.values(s.layouts)) if (typeof l === "string") usedLayouts.add(l);
                  if (s.states) seed(s.states);
                }
              };
              seed(viewTree.states);
            }
            // Orphan faces: a layouts/*.json no case references is invisible — Studio's
            // face toggle and the renderer only know the Switch's cases.
            //
            // REACHABILITY IS TRANSITIVE. A face may itself be a Switch on some other key
            // (a `course` face switching on `step` into `course-detail` and `course-apply`),
            // and those layouts are reached only from inside it. Counting the outer cases
            // alone called them orphans and told the developer to delete two live files.
            //
            // So follow every include from the faces outward, to a fixed point. Anything
            // still unreached is genuinely unreachable.
            const layoutsDir = join(root, "layouts");
            const includesIn = (node, into) => {
              if (!node || typeof node !== "object") return into;
              if (Array.isArray(node)) { for (const v of node) includesIn(v, into); return into; }
              if (typeof node.$include === "string" && node.$include.startsWith("layouts/"))
                into.add(node.$include.slice("layouts/".length));
              for (const v of Object.values(node)) includesIn(v, into);
              return into;
            };
            for (const queue = [...usedLayouts]; queue.length; ) {
              const lp = defPath(layoutsDir, queue.pop());
              if (!lp) continue;
              let body;
              try { body = readDef(lp); } catch { continue; /* linted as its own file */ }
              for (const next of includesIn(body, new Set()))
                if (!usedLayouts.has(next)) { usedLayouts.add(next); queue.push(next); }
            }

            if (existsSync(layoutsDir))
              for (const lf of readdirSync(layoutsDir).filter(isDefFile)) {
                const lname = defName(lf);
                if (!usedLayouts.has(lname))
                  report("warn", file, `layouts/${lf} is not referenced by any Switch case. An orphan face is unreachable (add a case "${lname}" or delete the file) (docs/design/03)`);
              }
          }
          // v2 STRAGGLER NUDGE: inside a component that declares a tree, every
          // public-axis write must use `view` — a leftover setValue on
          // "defaultState" still works through the alias but dies with it.
          if (viewTree) {
            for (const sub of ["layouts", "components"]) {
              const d = join(root, sub);
              if (!existsSync(d)) continue;
              for (const lf of readdirSync(d).filter(isDefFile)) {
                try {
                  if (/"key":"defaultState"/.test(JSON.stringify(readDef(join(d, lf)))))
                    report("warn", file, `${sub}/${lf} writes setValue "defaultState" but this component declares a v2 tree — write "view" (the alias is scheduled for deletion) (STATE_MODEL §2)`);
                } catch { /* that file lints separately */ }
              }
            }
          }
          // arrival state: the manifest is the render-contract home (default "inline"); the
          // state block is the legacy fallback.
          let mDefault;
          try {
            const mp = defPath(root, "manifest");
            if (mp) mDefault = readDef(mp).defaultState;
          } catch { /* linted separately */ }
          const arrival = viewTree
            ? (viewTree.initial ?? Object.keys(viewTree.states)[0])
            : (mDefault ?? (hasStateBlock ? json.state.defaultState : undefined));
          if (typeof arrival !== "string")
            report("error", file, `a faced component must declare its base state — a v2 state.view tree \`initial\`, or (legacy) manifest.defaultState / state.defaultState (docs/design/03)`);
        }
        if (stateFiles.length) {
          const order = Array.isArray(json.stateOrder) ? [...json.stateOrder].sort() : null;
          if (!order || !order.length)
            report("error", file, `has states/ but no stateOrder in the envelope (docs/design/03)`);
          else if (JSON.stringify(order) !== JSON.stringify(stateFiles))
            report("error", file, `stateOrder and states/*.json must name the same set (docs/design/03)`);
        }
      }
    } else {
      checkStateOrder(json.stateOrder, root, file); // non-component envelopes (rare)
    }
  } else {
    // bare partial (layouts/ states/ components/ blocks/, or an atom). A template
    // layout's TOP-LEVEL node is the app's layout root — the one non-slot home for
    // `appWidth` (state-owned sizing, docs/design/05).
    walkNode(json, file, root, null, /[\\/]layouts[\\/][^\\/]+\.(json|yaml)$/.test(file) && isTemplatePath(file));
  }
}


  return lintFile;
}

/**
 * The CLOSED SETS. This file is the linter's ground truth.
 *
 * Mirrors rx/_schema/unoverse.schema.json and the server guards, and UNOVERSE_CONFORMANCE
 * §5 makes keeping them equal a maintenance rule: "One source for each closed set... Keep
 * them equal or they disagree silently."
 *
 * They are closed on purpose. An invented primitive has no renderer; an invented style key
 * is silently dropped cross-platform. Compose from what exists, do not extend these
 * without extending the schema and the SDK in the same change.
 */

// ── ground truth (mirrors rx/_schema/unoverse.schema.json + server guards) ──
export const PRIMITIVES = new Set([
  "Box", "Stack", "Row", "Column", "Each", "Switch", "ComponentSlot", "Timeline",
  "Text", "Image", "Button", "Input", "Markdown", "Skeleton", "Icon", "Ref",
]);
export const CONDITION_KEYS = new Set(["field", "eq", "ne", "in"]);
// the portable style vocabulary — every key the SDK interpreter maps (sdk/style.ts).
// Each is a neutral intent every native renderer (iOS/Android/RN/Flutter) implements;
// an unknown key is a typo or a web-ism that renders nowhere.
export const STYLE_KEYS = new Set([
  "width", "height", "maxWidth", "minWidth", "minHeight", "maxHeight", "flex",
  "padding", "margin", "gap", "overflow",
  "position", "inset", "top", "right", "bottom", "left", "zIndex",
  "direction", "wrap", "align", "justify", "display", "columns", "span", "stackBelow", "container", "hideBelow", "hideAbove",
  "background", "radial", "border", "borderTop", "borderRight", "borderBottom", "borderLeft",
  "outline", "shadow", "radius", "radiusTopLeft", "radiusTopRight", "radiusBottomLeft", "radiusBottomRight",
  "font", "weight", "lineHeight", "color", "textAlign", "fit",
  "transform", "transition", "animation", "animationDelay", "cursor",
  "hover", "active", "when",
]);
// exact regex from server/src/runtime/definition-tokens.test.ts
export const RAW_VALUE = /#[0-9a-fA-F]{3,8}\b|\b\d*\.?\d+(px|rem|em)\b/;
// nodes reachable through these keys (data keys like `items`/`cases` handled explicitly)
export const CHILD_NODE_KEYS = ["children", "template", "fallback", "user", "assistant"];
// folders that hold BARE PARTIALS one level under the definition root
export const PARTIAL_DIRS = new Set(["layouts", "states", "components", "blocks"]);

/** Style keys whose value is a dimension, so it must be a space-scale step. */
export const DIMENSION_KEYS = new Set([
  "width", "height", "maxWidth", "minWidth", "minHeight", "maxHeight",
  "gap", "padding", "margin", "top", "right", "bottom", "left", "inset",
  // width THRESHOLDS, named on the same scale as any other width
  "hideBelow", "hideAbove", "stackBelow",
]);

/**
 * WHICH THEME BUCKET EACH STYLE KEY RESOLVES AGAINST — mirrors sdk/style.ts `computeCss`,
 * which is the only place that decides it. Dimensions are absent because the space scale
 * has its own check (`checkDimension`); `border*` is absent because its value is a PAIR
 * (an optional width token + a colour token) and is destructured separately.
 *
 * A key the interpreter passes straight through (`overflow`, `outline`, `cursor`,
 * `transform`, `transition`, `position`, `display`, …) is absent on purpose: there is no
 * bucket to check it against, so there is nothing here to be wrong about.
 */
export const TOKEN_KEYS = {
  background: "color",
  color: "color",
  shadow: "shadow",
  radius: "radius",
  radiusTopLeft: "radius",
  radiusTopRight: "radius",
  radiusBottomLeft: "radius",
  radiusBottomRight: "radius",
  font: "text",
  lineHeight: "lineHeight",
};

/**
 * CSS keywords a token key may legitimately carry instead of a token name. Kept tiny on
 * purpose: every one of these is a value with no token equivalent, and anything else that
 * "just works in CSS" is precisely the web-ism the closed vocabulary exists to keep out.
 */
export const LITERAL_VALUES = new Set(["none", "transparent", "inherit", "currentColor", "unset", "initial", "auto"]);

/**
 * CSS sizing keywords a dimension may carry that are NOT scale steps. `full` and `auto`
 * are already seeded into the scale itself (the SDK special-cases `full` → 100%); these
 * are the intrinsic-sizing words a layout legitimately needs and no token can express.
 */
export const DIMENSION_LITERALS = new Set([
  "auto", "full", "none", "inherit", "unset", "initial",
  "fit-content", "min-content", "max-content",
]);

/**
 * `weight` used to be the exception here: the SDK held the scale as a literal four-name
 * map, so this file had to mirror THAT rather than the tokens. It now resolves from
 * `theme.weight` like every other value, so it is an ordinary entry above and this note
 * only survives to say why one is not needed.
 */

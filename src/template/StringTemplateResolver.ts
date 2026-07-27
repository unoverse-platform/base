/**
 * String Template Resolver using Handlebars
 * For handling template string mode with ${variable} syntax
 */

import Handlebars from "handlebars";
import memoizeImport from "fast-memoize";
/**
 * fast-memoize ships CommonJS (`module.exports = memoize`) with ESM-shaped typings
 * (`export default`). Under NodeNext those disagree: the runtime value IS the function,
 * but TypeScript types the default import as the module namespace and calls it uncallable.
 * Verified at runtime before casting, rather than assuming.
 */
type Memoizer = <F extends (...args: any[]) => any>(fn: F) => F;
const memoize = memoizeImport as unknown as Memoizer;

/**
 * The data a template renders against. DECLARED HERE rather than imported from the engine's
 * TemplateResolver, which is where it used to live: this module is the lower layer of the
 * two, and pointing it back up at its own consumer is what tied the whole template folder
 * to the engine. Structurally identical, so nothing that already passes a context changes.
 */
export interface TemplateContext {
  input?: any;
  workflow?: any;
  [key: string]: any;
}

// Register custom helpers
Handlebars.registerHelper("toJSON", function (context) {
  return JSON.stringify(context, null, 2);
});

// Register a "filter" helper
Handlebars.registerHelper("filter", function (array, key, value) {
  if (!Array.isArray(array)) return [];
  return array.filter((item) => item && item[key] === value);
});

// Register equality helper for conditionals
Handlebars.registerHelper("eq", function (a, b) {
  return a === b;
});

// Register contains helper for string matching
Handlebars.registerHelper("contains", function (str, substring) {
  if (typeof str !== "string" || typeof substring !== "string") return false;
  return str.toLowerCase().includes(substring.toLowerCase());
});

// Create a memoized template compiler for performance
const compileTemplate = memoize((template: string) => {
  // Disable HTML escaping to prevent issues like "I'll" becoming "I&#x27;ll"
  return Handlebars.compile(template, { noEscape: true });
});

export function resolveStringTemplate(template: string, context: TemplateContext, logger: any): any {
  try {
    // Template processing

    // Compile and execute the template
    const compiledTemplate = compileTemplate(template);
    const result = compiledTemplate(context);

    // Template processed
    return result;
  } catch (error) {
    logger.debug("Failed to resolve string template", {
      error: error instanceof Error ? error.message : String(error),
      template: template.substring(0, 200) + (template.length > 200 ? "..." : ""),
    });

    throw error;
  }
}

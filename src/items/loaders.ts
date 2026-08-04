/**
 * Reading authored content off disk: prompt blocks and skills.
 *
 * THE LOADERS, NOT THE ROUTES. These moved out of the server so the catalogue can be
 * built in two places from one implementation: inside a universe, and at package build
 * time when the marketplace publishes its catalogue. The HTTP handlers stayed where they
 * were, because serving is the server's job and reading a file is not.
 *
 * The parsing is unchanged from the server's copies, deliberately. The skill content hash
 * in particular MUST keep its exact formula: stored hashes are compared against it, so a
 * cosmetic change here would re-ingest every skill in every universe.
 */
import * as fs from "fs";
import * as path from "path";
import crypto from "crypto";
import matter from "gray-matter";
import { PROMPT_BLOCKS_HOME, SKILLS_HOME, INSTALLED_HOME, databaseOnly } from "../paths.js";

/**
 * The same two homes, HYDRATED FROM INSTALLED ROWS (items/hydrate.ts).
 *
 * Read AFTER the on-disk homes, never instead of them: a skill being edited in the
 * monorepo must beat the database's copy, the same rule the definition resolver and the
 * node loader both apply. A deployed universe has nothing in the on-disk homes, so these
 * are the only ones with content — which is why `/prompt-blocks` answered with an empty
 * list on a universe that had published blocks sitting in its database.
 */
const INSTALLED_BLOCKS = path.join(INSTALLED_HOME, "prompts", "blocks");
const INSTALLED_SKILLS = path.join(INSTALLED_HOME, "skills");

export interface PromptBlock {
  id: string;
  name: string;
  description?: string;
  content: string;
  tags: string[];
  category?: string;
}

export interface ParsedSkill {
  name: string;
  title?: string;
  description: string;
  whenToUse?: string;
  version?: string;
  category?: string;
  triggers?: string[];
  icon?: string;
  instructions: string;
  contentHash: string;
}

interface SkillFrontmatter {
  name: string;
  title?: string;
  description: string;
  whenToUse?: string;
  version?: string;
  category?: string;
  triggers?: string[];
  icon?: string;
}

// Cached disk scan, cleared by the server's reload route. Enabled state is layered on
// per request by the caller, since a registry toggle changes it without a re-scan.
let cachedBlocks: PromptBlock[] | null = null;

/** Drop the cached scan so the next read comes from disk. */
export function clearPromptBlockCache(): void {
  cachedBlocks = null;
}

/** Recursively scan PROMPT_BLOCKS_HOME for .md blocks; category = immediate subdir. */
export function loadPromptBlocks(): PromptBlock[] {
  if (cachedBlocks) return cachedBlocks;

  const homes = (databaseOnly() ? [INSTALLED_BLOCKS] : [PROMPT_BLOCKS_HOME, INSTALLED_BLOCKS]).filter((d) => fs.existsSync(d));
  if (!homes.length) {
    console.warn(`[unoverse:prompt-blocks] no content dir: neither ${PROMPT_BLOCKS_HOME} nor ${INSTALLED_BLOCKS}`);
    cachedBlocks = [];
    return cachedBlocks;
  }

  const blocks: PromptBlock[] = [];
  const walk = (dir: string, category?: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, entry.name);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        try {
          const { data, content } = matter(fs.readFileSync(fullPath, "utf-8"));
          const id = entry.name.replace(/\.md$/, "");
          blocks.push({
            id,
            name: data.name || id,
            description: data.description,
            content: content.trim(),
            tags: Array.isArray(data.tags) ? data.tags : [],
            category,
          });
        } catch (error) {
          console.error(`[unoverse:prompt-blocks] failed to parse: ${fullPath}`, error);
        }
      }
    }
  };

  // On-disk first, so an id present in both keeps the authored copy and the installed one
  // is dropped rather than appended twice.
  for (const home of homes) walk(home);
  const seen = new Set<string>();
  cachedBlocks = blocks.filter((b) => !seen.has(b.id) && seen.add(b.id));
  console.log(`[unoverse:prompt-blocks] loaded ${cachedBlocks.length} prompt blocks`);
  return cachedBlocks;
}

/** Parse a SKILL.md file into a structured skill plus content hash, or null if invalid. */
function parseSkillFile(filePath: string): ParsedSkill | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const { data, content: markdownBody } = matter(content);
    const frontmatter = data as SkillFrontmatter;

    if (!frontmatter.name || !frontmatter.description) return null;

    // Hash content for change detection. The formula MUST NOT change: stored hashes are
    // compared against it, and `undefined` dropping out of JSON.stringify is what keeps
    // skills without these fields on their historical hash.
    const hashContent = JSON.stringify({
      name: frontmatter.name,
      description: frontmatter.description,
      instructions: markdownBody.trim(),
      version: frontmatter.version,
      whenToUse: frontmatter.whenToUse,
      title: frontmatter.title,
      icon: frontmatter.icon,
    });
    const contentHash = crypto.createHash("sha256").update(hashContent).digest("hex");

    return {
      name: frontmatter.name,
      title: frontmatter.title,
      description: frontmatter.description,
      whenToUse: frontmatter.whenToUse,
      version: frontmatter.version,
      category: frontmatter.category,
      triggers: frontmatter.triggers,
      icon: frontmatter.icon,
      instructions: markdownBody.trim(),
      contentHash,
    };
  } catch (error) {
    console.error(`[unoverse:skills] failed to parse skill file: ${filePath}`, error);
    return null;
  }
}

/** One parsed skill by name, or null when the folder holds no readable SKILL.md. */
export function loadParsedSkill(name: string): ParsedSkill | null {
  for (const home of databaseOnly() ? [INSTALLED_SKILLS] : [SKILLS_HOME, INSTALLED_SKILLS]) {
    const skillFilePath = path.join(home, name, "SKILL.md");
    if (fs.existsSync(skillFilePath)) return parseSkillFile(skillFilePath);
  }
  return null;
}

/** Every skill name this universe has, from both homes. The on-disk one wins a clash,
 *  which is what `loadParsedSkill` does when it reads them back. */
export function listSkillNames(): string[] {
  const names = new Set<string>();
  for (const home of databaseOnly() ? [INSTALLED_SKILLS] : [SKILLS_HOME, INSTALLED_SKILLS]) {
    if (!fs.existsSync(home)) continue;
    for (const e of fs.readdirSync(home, { withFileTypes: true })) if (e.isDirectory()) names.add(e.name);
  }
  return [...names].sort();
}

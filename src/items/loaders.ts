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
import { PROMPT_BLOCKS_HOME, SKILLS_HOME } from "../paths.js";

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

  if (!fs.existsSync(PROMPT_BLOCKS_HOME)) {
    console.warn(`[unoverse:prompt-blocks] content dir not found: ${PROMPT_BLOCKS_HOME}`);
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

  walk(PROMPT_BLOCKS_HOME);
  cachedBlocks = blocks;
  console.log(`[unoverse:prompt-blocks] loaded ${blocks.length} prompt blocks`);
  return blocks;
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
  const skillFilePath = path.join(SKILLS_HOME, name, "SKILL.md");
  if (!fs.existsSync(skillFilePath)) return null;
  return parseSkillFile(skillFilePath);
}

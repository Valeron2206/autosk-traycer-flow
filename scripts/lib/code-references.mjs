/**
 * Where an identifier is used in code, measured by reading the text.
 *
 * A use is the identifier as a whole word outside a comment: a file that calls
 * it, passes it on (as a callback to `map`), aliases, imports or re-exports
 * it, or writes it into a module it generates from a template literal uses
 * it. A comment, a prose code span (the name between backticks) and a quoted
 * name do not. This is a text measurement, not a parse: TypeScript sources
 * and modules held in template literals are read the same way, which a
 * JavaScript parser could not do.
 *
 * The panel package (who hands the workflow graph an evaluator) and the
 * doctor tests (who calls the daemon capability preflight) share it, so the
 * two measurements cannot count differently (debt 11c, review L1).
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** The source files read: JavaScript and TypeScript modules of every flavour. */
export const CODE_EXTENSIONS = /\.(?:mjs|cjs|js|mts|cts|ts)$/u;

/**
 * The text with its comments blanked. A `//` right after a `:` belongs to a
 * URL and is kept; a block comment is cut to its first close.
 */
export function withoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/gmu, '$1');
}

/** Whether the text uses the identifier in code, as above. */
export function usesIdentifier(text, identifier) {
  const name = identifier.replaceAll('$', '\\$');
  const word = new RegExp(`(?<![\\w$\`'"])${name}(?![\\w$'"])`, 'u');
  return word.test(withoutComments(text));
}

/**
 * The files under `dirs` (relative to `root`) whose code uses the identifier,
 * repository-relative and sorted; the files named in `exclude` — the one that
 * defines it — are left out, and a directory that does not exist reads as
 * empty.
 */
export async function filesUsing({ root, dirs, identifier, exclude = [] }) {
  const users = [];
  const walk = async (relative) => {
    let entries;
    try {
      entries = await readdir(path.join(root, relative), { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && CODE_EXTENSIONS.test(entry.name) && !exclude.includes(child)
        && usesIdentifier(await readFile(path.join(root, child), 'utf8'), identifier)) users.push(child);
    }
  };
  for (const dir of dirs) await walk(dir);
  return users.sort();
}

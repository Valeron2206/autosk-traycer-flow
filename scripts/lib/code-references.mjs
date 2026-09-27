/**
 * Where an identifier is used in code, measured by reading the text.
 *
 * A use is the identifier as a whole word in code: a file that calls it,
 * passes it on (as a callback to `map`), aliases, imports or re-exports it, or
 * writes it into a module it generates from a template literal uses it. A
 * comment, a prose code span (the name between backticks) and a name inside a
 * quoted string do not. This is a lexical measurement, not a parse: comment
 * and string delimiters count only where they are code (a `//` inside a
 * string opens no comment), template literals are read as the modules they
 * generate, and TypeScript sources are read the same way, which a JavaScript
 * parser could not do.
 *
 * The panel package (who hands the workflow graph an evaluator) and the
 * doctor tests (who calls the daemon capability preflight) share it, so the
 * two measurements cannot count differently (debt 11c, review L1).
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** The source files read: JavaScript and TypeScript modules of every flavour. */
export const CODE_EXTENSIONS = /\.(?:mjs|cjs|js|mts|cts|ts)$/u;

/** A `/` after one of these (or at the start) opens a regular expression, not a division. */
const REGEX_AFTER = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

/** …and so does a `/` after one of these keywords. */
const REGEX_AFTER_KEYWORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/** The identifier the output ends with, read backwards from its end only. */
function lastWord(out) {
  let end = out.length;
  while (end > 0 && /\s/u.test(out[end - 1])) end -= 1;
  let start = end;
  while (start > 0 && /[\w$]/u.test(out[start - 1])) start -= 1;
  return out.slice(start, end);
}

/**
 * The text with its comments and its quoted strings' contents blanked, read
 * lexically: a comment opens only in code, a quoted string keeps its quotes
 * and loses its contents, a regular-expression literal is skipped whole, and
 * a template literal is kept as the module it generates — its `${…}`
 * expressions are read as code again (CodeRabbit on #268).
 */
export function codeText(text) {
  let out = '';
  let index = 0;
  let previous = '';
  const templates = []; // brace depth at each open `${`, innermost last
  let braces = 0;
  const blank = (from, to) => text.slice(from, to).replace(/[^\n]/gu, ' ');
  const inTemplate = (start) => {
    // Template text up to the closing backtick or the next `${`.
    let at = start;
    while (at < text.length) {
      if (text[at] === '\\') { at += 2; continue; }
      if (text[at] === '`') return { end: at + 1, closed: true };
      if (text[at] === '$' && text[at + 1] === '{') return { end: at + 2, closed: false };
      at += 1;
    }
    return { end: text.length, closed: true };
  };
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '/' && next === '/') {
      const end = text.indexOf('\n', index);
      const stop = end === -1 ? text.length : end;
      out += blank(index, stop);
      index = stop;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += blank(index, stop);
      index = stop;
      continue;
    }
    if (char === '"' || char === "'") {
      let at = index + 1;
      while (at < text.length && text[at] !== char && text[at] !== '\n') at += text[at] === '\\' ? 2 : 1;
      const stop = Math.min(at + 1, text.length);
      out += char + blank(index + 1, stop - 1) + (text[stop - 1] === char ? char : '');
      index = stop;
      previous = char;
      continue;
    }
    if (char === '`') {
      const part = inTemplate(index + 1);
      out += text.slice(index, part.end);
      index = part.end;
      if (!part.closed) templates.push(braces);
      previous = '`';
      continue;
    }
    if (char === '/' && (REGEX_AFTER.has(previous) || (previous === 'w' && REGEX_AFTER_KEYWORD.has(lastWord(out))))) {
      let at = index + 1;
      let inClass = false;
      while (at < text.length && text[at] !== '\n') {
        if (text[at] === '\\') { at += 2; continue; }
        if (text[at] === '[') inClass = true;
        else if (text[at] === ']') inClass = false;
        else if (text[at] === '/' && !inClass) break;
        at += 1;
      }
      let stop = Math.min(at + 1, text.length);
      while (stop < text.length && /[a-z]/u.test(text[stop])) stop += 1;
      out += blank(index, stop);
      index = stop;
      previous = ')';
      continue;
    }
    if (char === '{') braces += 1;
    if (char === '}') {
      if (templates.length > 0 && templates.at(-1) === braces) {
        // The `}` closing a `${` returns to the template's text.
        templates.pop();
        const part = inTemplate(index + 1);
        out += text.slice(index, part.end);
        index = part.end;
        if (!part.closed) templates.push(braces);
        previous = '`';
        continue;
      }
      braces -= 1;
    }
    out += char;
    if (!/\s/u.test(char)) previous = /[\w$]/u.test(char) ? 'w' : char;
    index += 1;
  }
  return out;
}

/** The text with its comments blanked, read as {@link codeText} reads it. */
export function withoutComments(text) {
  return codeText(text);
}

/** Whether the text uses the identifier in code, as above. */
export function usesIdentifier(text, identifier) {
  const name = identifier.replaceAll('$', '\\$');
  const word = new RegExp(`(?<![\\w$\`'"])${name}(?![\\w$'"])`, 'u');
  return word.test(codeText(text));
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

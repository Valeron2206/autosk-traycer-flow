/**
 * Tests for the code-reference measurement that the panel package and the
 * doctor tests share (debt 11c, review L1).
 *
 * A caller counted only where it writes `name(` in a `.mjs` file misses a
 * TypeScript entry point and a caller that passes the function on. The
 * measurement reads the identifier as a word in code; a comment, a prose code
 * span and a quoted name are not uses.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CODE_EXTENSIONS, filesUsing, usesIdentifier } from "../scripts/lib/code-references.mjs";

test("a call, an alias, a callback, an import, a re-export and a generated module use the identifier", () => {
  for (const text of [
    "buildWorkflow(graph, { evaluate });",
    "const build = buildWorkflow;",
    "documents.map(buildWorkflow);",
    'import { buildWorkflow } from "./workflow-factory.mjs";',
    "export const emitters = { index, buildWorkflow };",
    "emitters.buildWorkflow(doc, { evaluate: () => false });",
    "const source = `autosk.registerWorkflow(buildWorkflow(document, { evaluate }));`;",
  ]) {
    assert.equal(usesIdentifier(text, "buildWorkflow"), true, text);
  }
});

test("a comment, a prose code span, a quoted name and a longer identifier are not uses", () => {
  for (const text of [
    "// buildWorkflow(graph) is the factory",
    "const x = 1; // buildWorkflow(graph)",
    "/* the evaluator buildWorkflow applies */",
    "/**\n * shipped buildWorkflow: the counted edge\n */",
    "const prose = `\\`buildWorkflow\\` takes the caller's evaluator`;",
    "const FACTORY_EXPORT = 'buildWorkflow';",
    'const name = "buildWorkflow";',
    "rebuildWorkflows(graph); buildWorkflowCache.clear();",
  ]) {
    assert.equal(usesIdentifier(text, "buildWorkflow"), false, text);
  }
  // A `//` that belongs to a URL is not a comment, so what follows it is read.
  assert.equal(usesIdentifier("const url = 'https://example.test'; buildWorkflow(graph);", "buildWorkflow"), true);
});

test("comment and string delimiters count only where they are code (CodeRabbit on #268)", () => {
  // A `//` or `/*` inside a string opens no comment, so the call after it is read.
  for (const text of [
    'const marker = "//"; buildWorkflow(graph);',
    "const marker = '//'; buildWorkflow(graph);",
    "const open = '/* not a comment'; buildWorkflow(graph); const close = '*/';",
    "const s = 'it\\'s'; buildWorkflow(graph);",
    "const re = /['\"]/u; buildWorkflow(graph);",
    "function quote() { return /['\"]/u; } buildWorkflow(graph);",
    "const ratio = a / b; buildWorkflow(graph); const half = c / 2;",
    "const src = `https://example.test ${base}`; buildWorkflow(graph);",
    "const src = `${buildWorkflow(document, { evaluate })}`;",
  ]) {
    assert.equal(usesIdentifier(text, "buildWorkflow"), true, text);
  }
  // The name inside an ordinary quoted string is prose, not a use.
  for (const text of [
    'const description = "Use buildWorkflow(graph) here";',
    "const description = 'see buildWorkflow(graph) for the factory';",
  ]) {
    assert.equal(usesIdentifier(text, "buildWorkflow"), false, text);
  }
});

test("every code extension is read, TypeScript included, and a named module is left out", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "code-references-"));
  const write = (relative, text) => {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), text);
  };
  try {
    write("src/host/extension.ts", "export default (autosk) => autosk.registerWorkflow(buildWorkflow(graph, { evaluate }));\n");
    write("src/host/entry.mts", "const built = graphs.map(buildWorkflow);\n");
    write("src/host/legacy.cts", "module.exports = { buildWorkflow };\n");
    write("src/host/workflow-factory.mjs", "export function buildWorkflow(document) { return document; }\n");
    write("scripts/verify.mjs", "import { buildWorkflow } from './workflow-factory.mjs';\n");
    write("scripts/notes.mjs", "// buildWorkflow is documented elsewhere\nconst text = '`buildWorkflow`';\n");
    write("scripts/readme.md", "buildWorkflow(graph)\n");
    const users = await filesUsing({ root, dirs: ["scripts", "src"], identifier: "buildWorkflow", exclude: ["src/host/workflow-factory.mjs"] });
    assert.deepEqual(users, ["scripts/verify.mjs", "src/host/entry.mts", "src/host/extension.ts", "src/host/legacy.cts"]);
    // A directory that does not exist is read as empty, not as an error.
    assert.deepEqual(await filesUsing({ root, dirs: ["lib"], identifier: "buildWorkflow" }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  for (const name of ["a.mjs", "a.cjs", "a.js", "a.ts", "a.mts", "a.cts"]) assert.ok(CODE_EXTENSIONS.test(name), name);
  for (const name of ["a.md", "a.json", "a.d.ts.map"]) assert.ok(!CODE_EXTENSIONS.test(name), name);
});

/**
 * Normative prose counts, rebound to the documents they measure.
 *
 * The failure this closes is drift by hand: a contract states a measured count,
 * the document it measures changes, and the sentence keeps saying the old
 * number. "221 parking edges" survived the graph's growth because nothing read
 * the literal back against the count. Each claim below is one sentence carrying
 * a number: the literal is extracted from the contract text and compared with
 * the count recomputed from the document it measures — `workflow-graph.v1.json`,
 * `refusal-vocabulary.v1.json`, the plan's chain blocks, or the canonical
 * reference. A literal that cannot be found is drift too: the sentence was
 * reworded and the claim can no longer be read.
 *
 * A number that encodes a premise carries the premise in the claim's own text,
 * because the same paragraph measures different pairs under different
 * definitions: "an edge out of every step the row names" is 207/327 over
 * `parks_at ∪ handled_at` and 218/316 over `parks_at` alone, and "unreachable"
 * is 13 seeded from `first_step` alone but 0 once `entry_steps` join the seeds.
 *
 * One test, not many: the ticket requires the same test to recompute both red
 * operands, and collecting every drift before asserting is what lets a single
 * run show all of them.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { REFUSALS } from "../src/host/workflow-factory.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");
// Claims that read a script read its code, not its commentary: a comment is
// not a construct, and a `slice` or `document.x` inside one must not count.
// Limitation, accepted for ticket 5: this strips comments, it does not parse —
// a numeral-shaped literal inside a STRING (`const x = `slice(0, 3)``) is
// still read as code, so a claim bound to a script is only as precise as
// that. Distinguishing string data needs a JavaScript tokenizer, which is out
// of proportion for a shape no current script carries.
const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const readCode = (relative) => stripComments(read(relative));

// Claims that read a contract read its PLAIN PROSE, not its markdown source:
// the corpus is markdown, and "two", "`two`", "[two](#x)", "*two*", "_two_",
// "**_two_**" are the same sentence written seven ways. Normalising once —
// instead of teaching every pattern to see through decoration — is what keeps
// a footnote label ("sixty-eight[^69]") or a stray emphasis run from changing
// what the sentence counts. So a claim's sentence is the NORMALISED sentence,
// not the raw bytes: a pattern that does not match the file verbatim is not
// necessarily a reworded claim.
//
// A delimiter is removed only when it is provably decoration — anything
// ambiguous stays put (refuse what you cannot prove):
// - a footnote marker "[^label]" disappears; a "[^label]:" definition line
//   keeps its marker (the "(?!:)" guard) and its body stays prose;
// - "[text](target)" reduces to "text"; the target may carry one level of
//   balanced parentheses, deeper nesting leaves the link untouched rather
//   than half-reducing it;
// - "[text][ref]" and a bare "[label]" reduce only when a matching "[ref]:" /
//   "[label]:" definition exists, which is why "steps[]" and
//   "step_visits[step]" survive untouched — they are subscript/enum
//   notation, not links;
// - "`", "*" and "_" runs reduce only as matched pairs of equal length —
//   a lone "*" stays a literal asterisk, so "2*0" never becomes "20";
// - "_" pairs must additionally sit at word boundaries, which is why
//   "park_reason" keeps its underscore;
// - a paren or quote pair unwraps only when its whole content is one
//   numeral run — "(534)" and "\"534\"" state 534 — while a pair holding
//   anything else is prose punctuation and stays;
// - no construct crosses a paragraph break: a mark that has to reach past
//   "\n\n" for its mate is two unrelated marks.
//
// And one last guard on every reduction: it is refused when it would fuse
// digits into a numeral the parts did not state — deleting "`8`5"'s
// backticks would manufacture "85", and a "." or "," between digits fuses
// only when a digit sits on its far side ("(534).5" must never become
// "534.5", while "(534)." unwraps to the "534." a sentence writes).
// Whatever this pass leaves that still touches a numeral span is pulled
// into the span by numeralSpan and refused by the parser instead of being
// silently ignored.
const normalizeProse = (text) => {
  // A shortcut reference "[label]" is decoration only against a definition
  // the document actually carries — "[label]: target" at a line start.
  const defined = new Set(
    [...text.matchAll(/^\[([^\]]+)\]:/gm)].map((match) => match[1].toLowerCase()),
  );
  // A reduction is refused when it would fuse digits into a numeral the
  // parts did not state: deleting "`8`5"'s backticks must never read as
  // "85", unwrapping "4,(5)6" must never become "4,56", unwrapping
  // "(534).5" must never become "534.5". The fuse needs a digit on both
  // sides of the junction with at most one "." or "," inside it, so
  // "(534)." unwraps to the same "534." a plain sentence writes — nothing
  // follows the dot. Whatever stays because of that still sits glued to
  // the numeral, and numeralSpan pulls the residue into the span so the
  // parser refuses it rather than reading the readable half.
  const fuse = (leftTail, rightHead) => (
    /\d$/.test(leftTail) && (/^\d/.test(rightHead) || /^[.,]\d/.test(rightHead))
    || /\d[.,]$/.test(leftTail) && /^\d/.test(rightHead)
  );
  const keep = (match, inner, offset, s) => {
    const left = s.slice(Math.max(0, offset - 2), offset);
    const after = s.slice(offset + match.length, offset + match.length + 2);
    return fuse(left, (inner + after).slice(0, 2))
        || fuse((left + inner).slice(-2), after)
      ? match
      : inner;
  };
  const strip = (match, offset, s) => (
    fuse(s.slice(Math.max(0, offset - 2), offset),
      s.slice(offset + match.length, offset + match.length + 2)) ? match : ""
  );
  // Nothing here crosses a paragraph break: a delimiter that has to reach
  // past "\n\n" for its mate is not decoration, it is two unrelated marks.
  // An inline-link target may carry one level of balanced parentheses.
  const innerText = String.raw`(?:(?!\n\n)[^\]])*`;
  const innerTextPlus = String.raw`(?:(?!\n\n)[^\]])+`;
  const target = String.raw`\((?:(?!\n\n)[^()]|(?:\((?:(?!\n\n)[^()])*\)))*\)`;
  return text
    .replace(new RegExp(`\\[\\^${innerText}\\](?!:)`, "g"), strip)
    .replace(new RegExp(`\\[(${innerText})\\]${target}`, "g"), keep)
    .replace(new RegExp(`\\[(${innerText})\\]\\[(${innerText})\\]`, "g"),
      (match, inner, ref, offset, s) => (
        defined.has((ref || inner).toLowerCase()) ? keep(match, inner, offset, s) : match
      ))
    .replace(new RegExp(`\\[(${innerTextPlus})\\](?!:)`, "g"),
      (match, label, offset, s) => (
        defined.has(label.toLowerCase()) ? keep(match, label, offset, s) : match
      ))
    // "(534)" and "\"534\"" state 534: a paren or quote pair whose whole
    // content is one numeral run is quoting the count itself, so it unwraps.
    // A pair holding anything else — "(see section 5)", "'t …'" — is prose
    // and stays, and the same seam guard applies, so "4(5)6" can never
    // become "456". Single quotes sit at word boundaries: "reason's" holds
    // an apostrophe, not an opener, and must not swallow the next "'".
    .replace(/\(((?:(?!\n\n)[^()])+)\)|"((?:(?!\n\n)[^"])+)"|(?<!\w)'((?:(?!\n\n)[^'])+)'(?!\w)|“((?:(?!\n\n)[^”])+)”|(?<!\w)‘((?:(?!\n\n)[^’])+)’(?!\w)/g,
      (match, paren, dq, sq, cq, csq, offset, s) => {
        const inner = paren ?? dq ?? sq ?? cq ?? csq;
        return new RegExp(`^${NUMERAL_RUN}$`, "i").test(inner)
          ? keep(match, inner, offset, s)
          : match;
      })
    .replace(/(`+)(\S(?:(?!\n\n)[^`])*?\S|\S)\1/g,
      (match, _marks, inner, offset, s) => keep(match, inner, offset, s))
    .replace(/(\*+)(\S(?:(?!\n\n)[^*])*?\S|\S)\1/g,
      (match, _marks, inner, offset, s) => keep(match, inner, offset, s))
    .replace(/(?<!\w)(_+)(\S(?:(?!\n\n)[^_])*?\S|\S)\1(?!\w)/g,
      (match, _marks, inner, offset, s) => keep(match, inner, offset, s));
};

const UNITS = {
  zero: 0, one: 1, two: 2, both: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALE = { hundred: 100, thousand: 1e3, million: 1e6, billion: 1e9 };
const FRACTION = { half: 0.5, halves: 0.5, quarter: 0.25, quarters: 0.25 };
const JOINERS = new Set(["and", "a", "an"]);
// Words a numeral may be spelled out of — including ones the parser refuses
// (minus, negative): they belong to the span so "minus two" reads as one
// numeral the suite cannot value, not as "two" quietly agreeing.
const NUMERAL_WORDS = new Set([
  ...Object.keys(UNITS), ...Object.keys(TENS), ...Object.keys(SCALE),
  ...Object.keys(FRACTION), "point", "minus", "negative", ...JOINERS,
]);
// A numeral slot in a claim pattern is a run of numeral-vocabulary tokens —
// "five hundred thirty-four", "sixty-nine", "2.5" — so a numeral spelled in
// several words still matches when the pattern's anchor surrounds the slot,
// while a prose word can never widen it. Longest alternatives first, so
// "sixty" is not read as "six" + a stray "ty". "and" is admitted BETWEEN two
// numeral tokens only when a scale word precedes it within the run —
// "five hundred and thirty-four", "one thousand and twenty" — because that
// is the one position English puts "and" inside a count; "two and one" is a
// clause, not a numeral, and stays two tokens (the same line numeralSpan's
// extension draws). "a"/"an" stay out of the run entirely — whether they
// belong is conditional on a fraction following, and numeralSpan's extension
// already decides that for the captured span.
const NUMERAL_TOKEN = `(?:${[...NUMERAL_WORDS]
  .filter((word) => !JOINERS.has(word))
  .sort((a, b) => b.length - a.length)
  .join("|")}|\\d+(?:[.,]\\d+)*)`;
const NUMERAL_RUN = `${NUMERAL_TOKEN}(?:[\\s-]+(?:and[\\s-]+(?<=(?:${Object.keys(SCALE).join("|")})[\\s-]+and[\\s-]+))?${NUMERAL_TOKEN})*`;

// The claim layer's two steps before the reader runs, shared by the corpus
// test and the claim-shaped fixtures below so a row pins the shipped rule
// and not a copy of it. A claim's numeral slot "([\w,-]+)" is widened to
// NUMERAL_RUN — a run of numeral-vocabulary tokens — so a number spelled in
// several words still matches under a pattern whose anchor surrounds the
// slot; without it a respelled "five hundred and thirty-four" goes unread.
const widenNumeralSlot = (source) =>
  source.replace(/\(\[\\w,-\]\+\)/g, () => `(${NUMERAL_RUN})`);

// The sentence a claim anchors on must occur exactly once: `match` alone
// reads the first hit and would pass a document that carries the same
// sentence twice with the second copy drifted. Zero occurrences means the
// prose was reworded; two means a duplicate, and neither may pass.
// Case-insensitive: a numeral at the head of a sentence capitalizes
// ("Sixty-nine"), and the claim is about the count, not the case.
const claimMatch = (text, source) => {
  const matches = [...text.matchAll(new RegExp(source, "gdi"))];
  if (matches.length === 0) return { state: "not-found" };
  if (matches.length > 1) return { state: "not-unique", count: matches.length };
  return { state: "unique", match: matches[0] };
};

/**
 * The numeral a sentence states is a SPAN, not a token: a capture reads one
 * position, and the count may continue to either side — "one hundred twenty",
 * "sixty nine", "two\nhundred", "2.5", "two and a half". Given a capture's
 * [start, end) in the text, this returns the whole span: the capture plus any
 * run of numeral-vocabulary tokens joined by whitespace (spaces, newlines,
 * non-breaking spaces) or by a decimal point attaching digits. Two joiners are
 * conditional: "and" extends only inside a compound (a scale word before it,
 * or "a half" after it) so an enumeration like "eight, and nine" does not
 * merge, and "a"/"an" extend only before a fraction word.
 */
function numeralSpan(text, start, end) {
  const isNumericRun = (word) => /^\d[\d.,]*$/.test(word);
  const isNumeralToken = (word) => isNumericRun(word)
    || word.toLowerCase().split("-").every((part) => NUMERAL_WORDS.has(part));
  const after = (from) => /^(\s+)([\w-]+)/.exec(text.slice(from));
  const before = (upto) => /([\w-]+)(\s+)$/.exec(text.slice(0, upto));

  // Punctuation that cannot occur inside a numeral terminates it. A capture
  // may have taken a trailing comma along ("two, one of which") — the numeral
  // is what remains without it, and the comma keeps the extension from
  // crossing into the next clause.
  while (end > start && text[end - 1] === ",") end -= 1;
  while (start < end && text[start] === ",") start += 1;

  const decimalTail = /^\.\d+/.exec(text.slice(end));
  if (decimalTail) end += decimalTail[0].length;

  let lastWord = null;
  for (;;) {
    const next = after(end);
    if (!next) break;
    const word = next[2].toLowerCase();
    if (word === "and") {
      const beyond = after(end + next[0].length);
      const compound = lastWord && SCALE[lastWord] !== undefined;
      const fractionLead = beyond && JOINERS.has(beyond[2].toLowerCase());
      if (!compound && !fractionLead) break;
    } else if (JOINERS.has(word)) {
      const beyond = after(end + next[0].length);
      if (!beyond || FRACTION[beyond[2].toLowerCase()] === undefined) break;
    } else if (!isNumeralToken(next[2])) break;
    end += next[0].length;
    lastWord = word;
  }
  for (;;) {
    const prev = before(start);
    if (!prev) break;
    const word = prev[1].toLowerCase();
    if (word === "and") {
      const earlier = before(start - prev[0].length);
      if (!earlier || SCALE[earlier[1].toLowerCase()] === undefined) break;
    } else if (!isNumeralToken(prev[1])) break;
    start -= prev[0].length;
  }
  // A glyph glued to a numeral is unsupported unless an earlier rule
  // already owned that occurrence — refusal is the default, not a list of
  // blessed classes, so a unit or operator nobody named ("‰", "‱", "°",
  // "^") is refused rather than waiting for the set to catch up. The
  // owned occurrences are few and all positional: whitespace bounds the
  // span, a run of sentence marks and closing brackets is owned when the
  // whole run proves sentence-final, and the dash
  // keeps its compound-versus-sign rule below. Everything else pulls in
  // and refuses: a letter or digit of any script ("2x", "xtwo", "2é",
  // "2½"), a decoration or delimiter the normaliser could not prove —
  // "two*", "`two", "4[^x]5", "[two]" with no definition, and the quotes
  // and parens that survived it ("2'000", '2"') — plus every symbol class:
  // \p{Sm}, \p{Sc}, \p{So}, \p{Sk} and the operator members of \p{Po}
  // ("−69", "±69", "$5", "5%", "138/69"). A sign or mark separated from
  // the numeral by whitespace is deliberately out of reach — "− 69" is
  // prose with a dash, not a signed number; closing that would reopen
  // "two and one" as a clause. The span is whitespace-bounded, and that
  // is the boundary.
  const dashFarSide = (dashAt, dir) => {
    const glued = dir > 0 ? text[dashAt + 1] : text[dashAt - 1];
    if (!glued || !/[\p{L}\p{N}_]/u.test(glued)) return true;
    const word = dir > 0
      ? /^[\p{L}\p{N}_-]+/u.exec(text.slice(dashAt + 1))[0]
      : /[\p{L}\p{N}_-]+$/u.exec(text.slice(0, dashAt))[0];
    return isNumeralToken(word);
  };
  // OWNED holds only what is positional and conditional, because every
  // provable pair is already gone: normalisation ran first, so a quote or
  // bracket still standing is by construction one no rule owned — unpaired,
  // or declined by the unwrapper — and it is pulled and refused like any
  // other unsupported glyph ("2'000", '2"', "2″"). The exclusions are
  // positional, not class-level: whitespace bounds the span; on the left a
  // sentence mark is never owned (a count can end a sentence with a mark
  // but cannot start with one stuck on — ".20", ",534"); and \p{Pd} is
  // owned by the dash rule.
  const OWNED = /[\s,.:;!?…\p{Pd}]/u;
  const SENTENCE_MARK = /[,.:;!?…]/u;
  // What may follow a numeral without joining it is a RUN, not one
  // character: sentence marks and closing brackets, in any order. A \p{Pe}
  // glyph can never open anything, so it can only ever be trailing — which
  // is why a clause's own closer is allowed here ("(… entered by two) and
  // a cap.") while a quote is not: a quote glyph is not provably a closing
  // one, and round 11 settled that it must earn its keep. The run is owned
  // only when the whole of it is sentence-final — terminated by whitespace
  // or the end of the text ("two...", "two!!", "two.)" read the numeral).
  // Any other follower pulls the edge character in — "534.foo", "534,foo",
  // and residue nobody enumerated ("2.**5**", '2,"000"', "2.^3", "2.)5") —
  // and one pulled character is already enough for the parser to refuse.
  const TRAILING = /[,.:;!?…\p{Pe}]/u;
  if (end < text.length) {
    let pull;
    if (TRAILING.test(text[end])) {
      let runEnd = end;
      while (runEnd < text.length && TRAILING.test(text[runEnd])) runEnd += 1;
      pull = runEnd < text.length && !/\s/u.test(text[runEnd]);
    } else {
      pull = !OWNED.test(text[end])
        || (/\p{Pd}/u.test(text[end]) && dashFarSide(end, 1));
    }
    if (pull) end += 1;
  }
  if (start > 0 && (!OWNED.test(text[start - 1]) || SENTENCE_MARK.test(text[start - 1])
    || (/\p{Pd}/u.test(text[start - 1]) && dashFarSide(start - 1, -1)))) {
    start -= 1;
  }
  return text.slice(start, end);
}

/**
 * Parses a whole numeral span — and only a plainly readable one. Word forms
 * follow the scale grammar: each scale-group is at most one unit-or-ten, an
 * optional hundred, and an optional ten-or-unit ("one hundred twenty five",
 * "sixty nine", "sixty-nine"), groups separated by thousand/million/billion,
 * "and" skipped, "a"/"an" reading as one. Digits parse alone or with a single
 * decimal point ("1,000", "2.5"). Anything else — a range ("2-3", "2–3"), a
 * sign ("-2", "minus two"), a fraction ("two and a half"), a unit after a
 * unit ("two three"), a garbled compound ("twenty-one-hundred") — returns
 * undefined and the caller records it as drift. A numeral that half-parses
 * must never read as agreement.
 */
function parseCount(span) {
  const cleaned = span.toLowerCase().trim();
  // Digit forms: plain digits, one decimal point ("2.5"), or commas in
  // thousands position only ("6,035"). A comma anywhere else ("5,34",
  // "1,2") is a malformed numeral — refuse it rather than silently reading
  // the digits.
  if (/^[\d.,]+$/.test(cleaned)) {
    if (/^\d+(\.\d+)?$/.test(cleaned)) return Number(cleaned);
    if (/^\d{1,3}(,\d{3})+$/.test(cleaned)) return Number(cleaned.replace(/,/g, ""));
    return undefined;
  }
  if (/\d/.test(cleaned)) return undefined;
  // A hyphen at the edge is a sign or a truncated compound — "-two" is a
  // signed number the same way "-2" is, and "two-" is a numeral cut mid-word.
  if (cleaned.startsWith("-") || cleaned.endsWith("-")) return undefined;
  // Hyphenated tokens follow the dash rule: every segment a numeral word makes
  // a numeral chain ("twenty-one" -> twenty one; "two-three" -> refused by the
  // grammar below as two units); a chain that opens with numeral words and
  // ends in a plain word is a hyphenated compound whose numeral is the leading
  // part ("six-document" -> six); a chain opening with a plain word is no
  // numeral at all ("document-six" -> unreadable).
  const words = [];
  for (const token of cleaned.split(/\s+/).filter(Boolean)) {
    const parts = token.split("-").filter(Boolean);
    const cut = parts.findIndex((part) => !NUMERAL_WORDS.has(part));
    if (cut === 0) return undefined;
    words.push(...(cut === -1 ? parts : parts.slice(0, cut)));
  }
  // A scale-group is the part of a numeral under one thousand/million/billion:
  // an optional unit-or-ten, an optional hundred, an optional ten-or-unit.
  // "u u" ("two three"), "u t" ("one twenty"), "t u h" ("twenty-one-hundred")
  // are not that shape, so the numeral they came from is not plainly readable.
  const group = [];
  const flushGroup = () => {
    if (!/^([ut]?h)?(tu?|u)?$/.test(group.map(([cls]) => cls).join(""))) return undefined;
    let value = 0;
    for (const [cls, num] of group) {
      if (cls === "h") value = (value || 1) * 100; else value += num;
    }
    return value;
  };
  let total = 0;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (UNITS[word] !== undefined) {
      group.push(["u", UNITS[word]]);
    } else if (TENS[word] !== undefined) {
      group.push(["t", TENS[word]]);
    } else if (word === "hundred") {
      group.push(["h", 0]);
    } else if (SCALE[word] !== undefined) {
      const value = flushGroup();
      if (value === undefined) return undefined;
      total += (value || 1) * SCALE[word];
      group.length = 0;
    } else if (word === "and") {
      continue;
    } else if ((word === "a" || word === "an") && FRACTION[words[i + 1]] === undefined) {
      group.push(["u", 1]);
    } else {
      return undefined;
    }
  }
  const last = flushGroup();
  return last === undefined ? undefined : total + last;
}

// The corpus binds every claim to a measurement, but the reader's own
// rules were each bought by a review round and no corpus sentence
// exercises most of them — no claim ends in an ellipsis, carries a
// clause-closing bracket, or glues a prime to a digit. Each row below is
// one defect a review actually found: the sentence a claim could sit in,
// the capture its pattern would land, and the span the reader must
// return. Two guarantees are pinned here and stay distinct: a row
// exercises the reader on a given range, and — verified mechanically —
// numeralSpan reaches the same final range from the row's seed as from
// the NUMERAL_RUN match covering the seed's position, in either
// direction, so the range is the one the widened slot produces. The
// seed itself need not equal that match and in six rows does not —
// "two" inside "two hundred" (twice), "five" inside "one hundred and
// five" and "five hundred and thirty-four", "two" inside "minus two",
// "two," over "two" — those rows exist to exercise extension from a
// partial seed. A free NUMERAL_RUN search is not any claim's restricted
// pattern, so the check says nothing about what a given pattern
// captures. A span carrying a pulled residue or parsing to
// the wrong number is the red direction; a span that is exactly the
// numeral and parses is the green. Claim-layer behaviour — a missing or
// duplicated sentence, the widened anchor slot, the numeral grammar,
// comment-stripped script reads — is pinned by the claim-shaped fixture
// test that follows.
test("the numeral reader's edge rules hold on byte-exact strings", () => {
  const spanFor = (text, needle) => {
    const norm = normalizeProse(text);
    const at = norm.indexOf(needle);
    assert.notEqual(at, -1, `capture ${JSON.stringify(needle)} vanished`);
    return numeralSpan(norm, at, at + needle.length);
  };
  const rows = [
    // a captured position once agreed where the whole run did not —
    // "two hundred" read as "two"; and decoration made claims unreadable
    // until the text was normalised before it was matched: "`two`",
    // "*two*", "**_two_**", "[two](#x)", "[two][n]" and a bare "[two]"
    // against a definition, "two[^1]"
    ["a cap is entered by two hundred.", "two", "two hundred", 200],
    ["a cap is entered by `two`.", "two", "two", 2],
    ["a cap is entered by *two*.", "two", "two", 2],
    ["a cap is entered by **_two_**.", "two", "two", 2],
    ["a cap is entered by [two](#x).", "two", "two", 2],
    ["a cap is entered by [two][n].\n\n[n]: a note", "two", "two", 2],
    ["a cap is entered by [two].\n\n[two]: a note", "two", "two", 2],
    ["a cap is entered by two[^1].\n\n[^1]: a note", "two", "two", 2],
    // the span once merged across a clause boundary — "and" joins a
    // numeral only inside a compound ("five hundred and thirty-four"),
    // "a" only before a fraction; "two and one" is a clause, and the same
    // gate holds the left edge: "one" stays one, "five" extends through
    // "hundred and"
    ["a cap is entered by two and one of those.", "two", "two", 2],
    ["a cap is entered by two, and one of those.", "two", "two", 2],
    ["the cap covers two and one of them.", "one", "one", 1],
    ["of the one hundred and five entries.", "five", "one hundred and five", 105],
    ["a cap is entered by six and seven.", "six", "six", 6],
    ["a cap is entered by five hundred and thirty-four.", "five", "five hundred and thirty-four", 534],
    ["a cap is entered by two and a half.", "two", "two and a half", undefined],
    ["a cap is entered by two.5 of them.", "two", "two.5", undefined],
    // the normaliser once deleted a lone asterisk — "2*0" must never
    // read as "20", and an unpaired mark stays literal and pulls ("*two")
    ["a cap is entered by 2*0.", "2", "2*", undefined],
    ["a cap is entered by *two.", "two", "*two", undefined],
    // a glued sign or operator was read past and the numeral quietly
    // agreed ("-2", "minus two", "−69", "±69", "138/69", ".20", ",534",
    // "2×69", "two–three"); only whitespace keeps a sign out of the span
    // ("− 69"), and a dash joins either a numeral pair (a range —
    // refused) or a plain word (a compound — the numeral stands); a bare
    // hyphen edge is a sign or a cut compound ("-two", "two-"), and a
    // chain running into digits is no numeral ("two-2")
    ["a cap is entered by -2.", "2", "-2", undefined],
    ["a cap is entered by minus two.", "two", "minus two", undefined],
    ["of the reasons −69 hold.", "69", "−69", undefined],
    ["of the reasons ±69 hold.", "69", "±69", undefined],
    ["of the reasons 138/69 hold.", "69", "/69", undefined],
    ["of the reasons .20 hold.", "20", ".20", undefined],
    ["of the reasons ,534 hold.", "534", ",534", undefined],
    ["of the reasons 2×69 hold.", "69", "×69", undefined],
    ["of the reasons − 69 hold.", "69", "69", 69],
    ["the six-document cap holds.", "six", "six", 6],
    ["the document-six cap holds.", "six", "six", 6],
    ["a cap is entered by two–three.", "two", "two–", undefined],
    ["a cap is entered by -two.", "two", "-two", undefined],
    ["a cap is entered by two-.", "two", "two-", undefined],
    ["a cap is entered by two-2.", "two-2", "two-2", undefined],
    // a count inside a paren or quote pair was invisible — the unwrapper
    // owns a pair whose whole content is one numeral run ("(two)",
    // "\"two\"", "(534)"), and the seam guard keeps it from fusing digits
    // it never stated ("4(5)6", "(534).5", "4[^x]5")
    ["a cap is entered by (two).", "two", "two", 2],
    ["a cap is entered by \"two\".", "two", "two", 2],
    ["a cap is entered by 'two'.", "two", "two", 2],
    ["a cap is entered by (534).", "534", "534", 534],
    ["a cap is entered by 4(5)6.", "4", "4(", undefined],
    ["a cap is entered by (534).5.", "534", "(534)", undefined],
    ["a cap is entered by 4[^x]5.", "4", "4[", undefined],
    ["a cap is entered by two.foo of them.", "two", "two.", undefined],
    ["a cap is entered by $2.", "2", "$2", undefined],
    ["a cap is entered by 2%.", "2", "2%", undefined],
    ["a cap is entered by [two](#unclosed.", "two", "[two]", undefined],
    ["a cap is entered by [two].", "two", "[two", undefined],
    ["sixty-eight[^69] of the reasons hold.", "sixty-eight", "sixty-eight", 68],
    ["a cap is entered by [sixty-eight](#x).", "sixty-eight", "sixty-eight", 68],
    ["a cap is entered by **two** hundred.", "two", "two hundred", 200],
    // the exclusion was a list of blessed classes — an unnamed glued
    // glyph now refuses by default rather than waiting for the list
    // ("2‰", "2‱", "2°", "2^3")
    ["a cap is entered by 2‰.", "2", "2‰", undefined],
    ["a cap is entered by 2‱.", "2", "2‱", undefined],
    ["a cap is entered by 2°.", "2", "2°", undefined],
    ["a cap is entered by 2^3.", "2", "2^", undefined],
    // quotes and brackets were excluded by character class — a residue
    // the unwrapper did not prove is unsupported and pulls ("2'000",
    // "2’000", "2\"", "2″")
    ["a cap is entered by 2'000.", "2", "2'", undefined],
    ["a cap is entered by 2’000.", "2", "2’", undefined],
    ["a cap is entered by 2\".", "2", "2\"", undefined],
    ["a cap is entered by 2″.", "2", "2″", undefined],
    // the mark asked what followed it — residue between the mark and
    // the digit slipped past a one-character lookahead; the mark must
    // now prove it is sentence-final ("2.**5**", "2,**000**", "2.`5`",
    // "2.[5](#x)", "2,\"000\"", "2.^3")
    ["a cap is entered by 2.**5**.", "2", "2.", undefined],
    ["a cap is entered by 2,**000**.", "2", "2,", undefined],
    ["a cap is entered by 2.`5`.", "2", "2.", undefined],
    ["a cap is entered by 2.[5](#x).", "2", "2.", undefined],
    ["a cap is entered by 2,\"000\".", "2", "2,", undefined],
    ["a cap is entered by 2.^3.", "2", "2.", undefined],
    ["a cap is entered by two.", "two", "two", 2],
    // the mark proved final one character in — a run of marks, or a
    // clause's own closing bracket, falsely refused; the run is owned
    // only when whitespace or the end of the text terminates it
    // ("two...", "two.)", "(… two).", "(… two) and a cap.", "534)")
    ["a cap is entered by two...", "two", "two", 2],
    ["a cap is entered by two..", "two", "two", 2],
    ["a cap is entered by two!!", "two", "two", 2],
    ["a cap is entered by two?!", "two", "two", 2],
    ["a cap is entered by two;;", "two", "two", 2],
    ["a cap is entered by two.)", "two", "two", 2],
    ["a cap is entered by two.]", "two", "two", 2],
    ["a cap is entered by two.}", "two", "two", 2],
    ["a cap is entered by two) rest.", "two", "two", 2],
    ["a cap is entered by two] rest.", "two", "two", 2],
    ["a cap is entered by two).", "two", "two", 2],
    ["a cap is entered by two…", "two", "two", 2],
    ["a cap is entered by two!", "two", "two", 2],
    ["(a cap is entered by two).", "two", "two", 2],
    ["(a cap is entered by two) and a cap.", "two", "two", 2],
    ["of the reasons 534) hold.", "534", "534", 534],
    ["a cap is entered by 2.)5.", "2", "2.", undefined],
    ["a cap is entered by two,000 of them.", "two", "two,", undefined],
    // hazards found while building: a comma outside thousands position
    // ("5,34") beside a real thousands comma ("1,000"), a comma the
    // capture carried along ("two,"), "a" as a unit before a scale word
    // ("a hundred"), a non-ASCII letter glued to a digit ("2é", "2½"),
    // and the apostrophe gate — "reason's" must never open a quote pair
    ["a cap is entered by 5,34 of them.", "5,34", "5,34", undefined],
    ["a cap is entered by two, one of which.", "two,", "two", 2],
    ["a cap is entered by 1,000.", "1,000", "1,000", 1000],
    ["a cap of a hundred holds.", "hundred", "a hundred", 100],
    ["a cap is entered by 2x.", "2", "2x", undefined],
    ["a cap is entered by 2é.", "2", "2é", undefined],
    ["a cap is entered by 2½.", "2", "2½", undefined],
    ["the reason's fix is entered by 'two'.", "two", "two", 2],
  ];
  for (const [text, needle, span, value] of rows) {
    assert.equal(spanFor(text, needle), span, `span for ${JSON.stringify(text)}`);
    assert.equal(parseCount(span), value, `parse for ${JSON.stringify(text)}`);
  }
  // The apostrophe gate in byte-exact terms: 'five' unwraps, while the
  // apostrophes inside "reason's" and "steps'" are never a pair's edges.
  assert.equal(
    normalizeProse("the reason's fix is 'five' and steps' by two."),
    "the reason's fix is five and steps' by two.");
});

// The claim layer's own rules, exercised by claim-shaped fixtures — a
// pattern with a numeral slot, a text, the outcome the layer must reach —
// driving the same widenNumeralSlot/claimMatch the corpus runs. The corpus
// cannot hold these: it writes every count in the shape that needs the
// rule least (digits, once), so each rule below reddens nothing when
// removed — a respelled "five hundred and thirty-four" or a duplicated
// sentence would ship unguarded without these rows.
test("the claim layer's guards hold on claim-shaped fixtures", () => {
  const read = (pattern, text) => {
    const norm = normalizeProse(text);
    const found = claimMatch(norm, widenNumeralSlot(pattern.replace(/`/g, "")));
    if (found.state !== "unique") return found;
    const spans = found.match.indices.slice(1)
      .map(([start, end]) => numeralSpan(norm, start, end));
    return { state: "unique", spans, values: spans.map(parseCount) };
  };
  const rows = [
    // the widened slot: a number spelled in several words still matches
    // where a bare [\w,-]+ would capture "five" and leave the anchor
    // unmatched
    ["all ([\\w,-]+) of them", "all five hundred and thirty-four of them are",
      { state: "unique", spans: ["five hundred and thirty-four"], values: [534] }],
    // a sentence carried twice must refuse — the second copy may be the
    // drifted one
    ["a cap is entered by ([\\w,-]+)", "a cap is entered by two. a cap is entered by three.",
      { state: "not-unique", count: 2 }],
    // the numeral grammar: a unit after a unit is no scale-group, and
    // without the restriction "one-one" would parse as 2
    ["a cap is entered by ([\\w,-]+)", "a cap is entered by one-one.",
      { state: "unique", spans: ["one-one"], values: [undefined] }],
    // a claim whose sentence is absent is drift, not silence
    ["a cap is entered by ([\\w,-]+)", "nothing the claim names is here.",
      { state: "not-found" }],
  ];
  for (const [pattern, text, expected] of rows) {
    assert.deepEqual(read(pattern, text), expected, `claim read for ${JSON.stringify(text)}`);
  }
  // A script claim counts code, not commentary: a `slice` or `document.x`
  // inside a comment must not move a measurement. The corpus's scripts
  // happen to carry no comment-only constructs, so nothing there reddens
  // if the stripping stops — this pins the rule itself.
  assert.equal(
    stripComments("const n = slice(0, 12); // slice(0, 99) in a comment\n/* document.fake */\n"),
    "const n = slice(0, 12); \n\n");
});

test("every count quoted in normative prose recomputes to the number the sentence states", () => {
  const graph = JSON.parse(read("resources/workflow-graph/workflow-graph.v1.json"));
  const vocabulary = JSON.parse(read("resources/refusal-vocabulary/refusal-vocabulary.v1.json"));
  const reference = JSON.parse(read("resources/workflow-graph/canonical-reference.json"));
  const graphContract = normalizeProse(read("docs/contracts/workflow-graph.md"));
  const factoryContract = normalizeProse(read("docs/contracts/workflow-factory.md"));
  const vocabularyContract = normalizeProse(read("docs/contracts/refusal-vocabulary.md"));
  const schemaText = read("resources/workflow-graph/workflow-graph.schema.json");
  const schemaProse = normalizeProse(schemaText);
  const plan = read("03-technical-plan.md");

  const steps = new Map(graph.steps.map((step) => [step.name, step]));
  const guards = new Map((graph.guards ?? []).map((guard) => [guard.id, guard]));
  const outgoing = new Map(graph.steps.map((step) => [
    step.name,
    new Set(graph.transitions.filter((edge) => edge.from === step.name).map((edge) => edge.to)),
  ]));
  const reasonsOn = (edge) => (edge.guards ?? []).map((id) => guards.get(id)?.park_reason).filter(Boolean);

  // A parking edge is an edge into a step whose `status` is `human` — the
  // contract's own definition, so the count covers `human`, `await_alignment`
  // and `await_anchor_impact_approval`, not the step named `human` alone.
  const humanSteps = new Set(graph.steps.filter((step) => step.status === "human").map((step) => step.name));
  const parking = graph.transitions.filter((edge) => humanSteps.has(edge.to));
  const parkingToHuman = parking.filter((edge) => edge.to === "human").length;
  const parkingReasonCounts = [...new Set(parking.map((edge) => reasonsOn(edge).length))].sort();

  const rows = graph.recovery;
  const namedOf = (row) => new Set([...row.parks_at, ...(row.handled_at ?? [])]);
  const handledRows = rows.filter((row) => (row.handled_at ?? []).length > 0);
  const handledEntries = handledRows.reduce((sum, row) => sum + row.handled_at.length, 0);
  const targetEntries = rows.reduce((sum, row) => sum + row.resume_targets.length, 0);

  // The pair the ticket names: (named step, resume target) over all rows, a
  // named step being one the row lists in `parks_at` or `handled_at`, and the
  // second figure counting the pairs where the target is NOT a declared edge
  // out of that step.
  let namedTargetPairs = 0;
  let pairsNotOutgoing = 0;
  for (const row of rows) {
    for (const target of row.resume_targets) {
      for (const step of namedOf(row)) {
        namedTargetPairs += 1;
        if (!outgoing.get(step).has(target)) pairsNotOutgoing += 1;
      }
    }
  }

  // Premise: a step "the row names" is the union of `parks_at` and `handled_at`.
  // Under `parks_at` alone the same measurement reads 218/316 instead.
  const targetsOutOfEveryNamed = rows.reduce((sum, row) => {
    const named = [...namedOf(row)];
    return sum + row.resume_targets.filter((target) => named.every((step) => outgoing.get(step).has(target))).length;
  }, 0);
  const targetsOnHandledOnly = rows.reduce((sum, row) => sum + row.resume_targets.filter((target) =>
    !row.parks_at.some((step) => outgoing.get(step).has(target))
    && (row.handled_at ?? []).some((step) => outgoing.get(step).has(target)),
  ).length, 0);

  const boundary = rows.find((row) => row.reason === "project_boundary_invalid");
  const boundaryHandled = boundary.handled_at ?? [];
  const boundaryUnion = new Set([...boundary.parks_at, ...boundaryHandled]).size;
  const widestHandled = Math.max(...rows.map((row) => (row.handled_at ?? []).length));
  const widestUnion = Math.max(...rows.map((row) => namedOf(row).size));

  // A status reference is a `parks_at` entry naming a step that carries a
  // `status`; the rejected alternative rule would have required it to be the
  // landing of an edge carrying that reason.
  const statusRefs = rows.flatMap((row) =>
    row.parks_at.filter((step) => steps.get(step)?.status).map((step) => ({ reason: row.reason, step })));
  const statusLanded = statusRefs.filter(({ reason, step }) =>
    graph.transitions.some((edge) => edge.to === step && reasonsOn(edge).includes(reason)));

  const intoDone = graph.transitions.filter((edge) => edge.to === "done");
  const rowsNamingDone = rows.filter((row) => row.parks_at.includes("done")).map((row) => row.reason);
  const doneUnderNamed = intoDone.filter((edge) => reasonsOn(edge).some((reason) => rowsNamingDone.includes(reason)));
  const commitOnPassTargets = [...outgoing.get("commit_on_pass")];
  const doneTargetRows = rows.filter((row) => row.resume_targets.includes("done") && !row.parks_at.includes("done"));
  const humanTargetRows = rows.filter((row) => row.resume_targets.includes("human"));
  const ticketDoneRows = rows.filter((row) => row.resume_targets.includes("ticket_done")).map((row) => row.reason).sort();

  // Reachability: a walk over `transitions` seeded only at `first_step` — a
  // seed counts as reached, a step no seed reaches is dead. Adding every
  // `entry_steps[].step` to the seeds is the second premise, under which the
  // document reaches all 72.
  const reachableFrom = (seeds) => {
    const seen = new Set(seeds);
    const queue = [...seeds];
    while (queue.length > 0) {
      const step = queue.pop();
      for (const edge of graph.transitions) {
        if (edge.from === step && !seen.has(edge.to)) {
          seen.add(edge.to);
          queue.push(edge.to);
        }
      }
    }
    return seen;
  };
  const deadFromFirst = graph.steps.length - reachableFrom([graph.first_step]).size;

  // "A workflow that starts somewhere other than `first_step`" is one the
  // document declares an `entry_steps` row for; the registered workflows are
  // the plan's section-2 `### autosk-*` chain blocks, the same extraction
  // `check-workflow-chains.mjs` performs.
  const workflowEntries = graph.entry_steps.filter((entry) => /registered workflow/.test(entry.reason));
  const outOfBandEntries = graph.entry_steps.length - workflowEntries.length;
  const chainBlocks = [...plan.matchAll(/^### (autosk-[\w-]+)/gmu)].length;

  const parkTable = graph.views.find((view) => view.id === "park_table");
  const blockedAnchorRows = parkTable.rows.filter((row) => (row.covers ?? []).includes("blocked_anchor"));
  const arenaCandidateReasons = rows.map((row) => row.reason).filter((reason) => /^arena_candidate_/.test(reason));
  const mostArenaInOneRow = Math.max(...parkTable.rows.map((row) =>
    (row.covers ?? []).filter((reason) => arenaCandidateReasons.includes(reason)).length));

  const intoFixArtifact = graph.transitions.filter((edge) => edge.to === "fix_artifact");
  const fixArtifactSelfLoops = intoFixArtifact.filter((edge) => edge.from === "fix_artifact");
  const intoFix = graph.transitions.filter((edge) => edge.to === "fix");

  // "Alone" means the target is an edge out of `record_aggregate_remediation`
  // and NOT an edge out of any step the row parks at.
  const verifyFailed = rows.find((row) => row.reason === "aggregate_verify_failed");
  const remediationLentAlone = verifyFailed.resume_targets.filter((target) =>
    outgoing.get("record_aggregate_remediation").has(target)
    && !verifyFailed.parks_at.some((step) => outgoing.get(step).has(target)));
  const remediationRequired = rows.find((row) => row.reason === "aggregate_remediation_required");
  const siblingLentByParks = remediationRequired.resume_targets.filter((target) =>
    remediationRequired.parks_at.some((step) => outgoing.get(step).has(target)));

  const outOfScope = rows.find((row) => row.reason === "alignment_policy_out_of_scope");

  const daemonProduced = vocabulary.park_reasons.filter((entry) => entry.producer === "daemon");
  const artifactClosed = vocabulary.park_reasons.filter((entry) => entry.closed_by.startsWith("docs/contracts/"));

  const graphLevelReasons = Object.keys(graph.graph_reasons);
  const closedSetBlock = graphContract.match(/## 9\. Refusal classes[\s\S]*?Closed set: (.*?)\./);
  const closedSet = closedSetBlock ? [...closedSetBlock[1].matchAll(/\w+/g)].map((match) => match[0]) : [];
  const unprefixedClosed = closedSet.filter((code) => !code.startsWith("graph_"));
  const factoryClosedByGraph = REFUSALS.filter((code) => closedSet.includes(code));
  const factoryOwnCodes = REFUSALS.length - factoryClosedByGraph.length;

  // The digest verifier's VARIANTS block: a base document plus one mutation per
  // criterion-2 component. The contract's "six documents" and "five components"
  // are the count of those entries — the script's internal assertion never
  // reads the prose.
  const digestScript = readCode("scripts/verify-autosk-graph-digest.mjs");
  const variantsBlock = digestScript.match(/^const VARIANTS = \{([\s\S]*?)\n\};/m);
  const variantKeys = variantsBlock
    ? [...variantsBlock[1].matchAll(/^ {2}(\w+): \(document\)/gm)].map((match) => match[1])
    : [];
  const nonBaseVariants = variantKeys.filter((key) => key !== "base");
  const componentsPerVariant = variantsBlock
    ? [...new Set(nonBaseVariants.map((key) => {
        const from = variantsBlock[1].indexOf(`${key}: (document)`);
        const next = variantKeys[variantKeys.indexOf(key) + 1];
        const body = variantsBlock[1].slice(from, next ? variantsBlock[1].indexOf(`${next}: (document)`) : undefined);
        return new Set([...body.matchAll(/document\.(\w+)/g)].map((match) => match[1])).size;
      }))]
    : [];

  // The legs table is the one that follows the "three legs" sentence; the legs
  // are its data rows.
  const legsTable = factoryContract.match(new RegExp(`The ${NUMERAL_RUN} legs still hold it up[\\s\\S]*?\\n\\|[^\\n]*\\|\\n\\|[ :|-]+\\|\\n((?:\\|[^\\n]*\\|\\n)+)`));
  const legRows = legsTable ? legsTable[1].trim().split("\n").length : 0;

  // "Two of these" counts the required-tests items a real daemon backs — the
  // scripts the paragraph ascribes to a section. The paragraph's third
  // measurer is the register's own verifier.
  const daemonParagraph = factoryContract.match(/Two of these run against a real daemon[^\n]*/);
  const sectionAscribed = daemonParagraph ? (daemonParagraph[0].match(/for section \d/g) ?? []).length : 0;
  const daemonScriptMentions = daemonParagraph ? (daemonParagraph[0].match(/verify-autosk-[\w-]+\.mjs/g) ?? []).length : 0;

  // The suite's own fixture count: the false-evaluator test drives the first N
  // agent steps, and the prose quotes N. The binding is to that test's body —
  // a `slice` anywhere else in the file (a comment, another test) is not the
  // fixture.
  const factoryTest = readCode("test/runtime-workflow-factory.test.mjs");
  const zeroCandidatesBody = factoryTest.match(/test\("zero candidates parks with the step's own reason[\s\S]*?(?=\ntest\()/);
  const parkedSlice = zeroCandidatesBody?.[0].match(/slice\(0, (\d+)\)/);
  const parkedFixtureCount = parkedSlice ? Number(parkedSlice[1]) : 0;

  // The graph suite proves a code unreachable by naming it in an
  // "is unreachable:" title — the runtime codes that proof covers.
  const graphTest = readCode("test/validate-workflow-graph.test.mjs");
  const unreachableCodes = new Set([...graphTest.matchAll(/^test\("(\w+) is unreachable:/gm)].map((match) => match[1]));

  // The reserved names — the codes the graph issues about itself — are the
  // validator's GRAPH_PARK_REASONS set.
  const validator = readCode("scripts/validate-workflow-graph.mjs");
  const reservedBlock = validator.match(/^export const GRAPH_PARK_REASONS = Object\.freeze\(\[([\s\S]*?)\]\)/m);
  const reservedCodes = reservedBlock ? [...reservedBlock[1].matchAll(/"(\w+)"/g)].map((match) => match[1]) : [];

  // "The three things a row names" are its step-name lists: the array-typed
  // recovery-item fields (`required_state` names a state, not steps).
  const schema = JSON.parse(schemaText);
  const rowListFields = Object.values(schema.properties.recovery.items.properties)
    .filter((property) => property.type === "array").length;

  // "The row no park can reach": a park produces a reason three ways — an edge
  // into a `human`-status step carrying it, a step's `no_transition_reason`, or
  // a cap's `park_reason`. The count is the rows whose reason none produces.
  const parkProduced = new Set();
  for (const edge of parking) reasonsOn(edge).forEach((reason) => parkProduced.add(reason));
  for (const step of graph.steps) if (step.no_transition_reason) parkProduced.add(step.no_transition_reason);
  for (const cap of graph.caps ?? []) if (cap.park_reason) parkProduced.add(cap.park_reason);
  const rowsNoParkReaches = rows.filter((row) => !parkProduced.has(row.reason));

  // The witness in "a reason stopping at nine steps": the distinct `parks_at`
  // sizes the document actually carries.
  const parksAtSizes = [...new Set(rows.map((row) => row.parks_at.length))].sort((a, b) => a - b);

  // "The table" copies the executor stays out of: the recovery table here, the
  // two rendered views, and the vocabulary's extracted table.
  const tableCopies = graph.views.length + 2;

  // The parse names two codes itself: the `graph_*` codes the same sentence
  // goes on to enumerate.
  const parseClause = graphContract.match(/the parse names itself; ([^.]+)\./);
  const parseNamedCodes = parseClause ? (parseClause[1].match(/graph_\w+/g) ?? []).length : 0;

  // A cap's counted transition is a single name — the distinct per-cap arity.
  const capTransitionArity = [...new Set((graph.caps ?? []).map((cap) => typeof cap.counted_transition === "string" ? 1 : 0))];

  const claims = [
    // docs/contracts/workflow-factory.md — section 5 is the ticket's first red
    // operand: the literal is read from the prose, the count recomputed from
    // the graph document.
    {
      id: "factory §5: parking edges — transitions into a step whose `status` is `human`",
      text: factoryContract,
      pattern: /shipped graph draws ([\w,-]+) of those/,
      measured: [parking.length],
    },
    {
      id: "factory §5: parking edges, second occurrence",
      text: factoryContract,
      pattern: /Every one of the ([\w,-]+) parking edges/,
      measured: [parking.length],
    },
    {
      id: "factory §5: reasons each parking edge's guards name — the set of per-edge reason counts",
      text: factoryContract,
      pattern: /guarded by guards naming ([\w,-]+) reason/,
      measured: parkingReasonCounts,
    },
    {
      id: "factory §4: (named step, resume target) pairs over `parks_at ∪ handled_at`, and pairs where the target is not a declared edge out of that step",
      text: factoryContract,
      pattern: /of the ([\w,-]+) `\(named step, resume target\)` pairs [\s\S]*?— ([\w,-]+) are not a declared edge out of that particular step/,
      measured: [namedTargetPairs, pairsNotOutgoing],
    },
    {
      id: "factory §4: `aggregate_verify_failed` targets that are edges out of `record_aggregate_remediation` alone — out of that `handled_at` step and out of no `parks_at` step — and its total",
      text: factoryContract,
      pattern: /([\w,-]+) of its ([\w,-]+) targets are edges out of `record_aggregate_remediation` alone/,
      measured: [remediationLentAlone.length, verifyFailed.resume_targets.length],
    },
    {
      id: "factory §4: `aggregate_remediation_required` permits the same target set, every one lent by an edge out of a `parks_at` step",
      text: factoryContract,
      pattern: /permits the same ([\w,-]+) targets/,
      measured: [remediationRequired.resume_targets.length],
      also: () => {
        assert.deepEqual([...remediationRequired.resume_targets].sort(), [...verifyFailed.resume_targets].sort());
        assert.equal(siblingLentByParks.length, remediationRequired.resume_targets.length);
      },
    },
    {
      id: "factory §4: `alignment_policy_out_of_scope` targets — `clarify_alignment` is a step it parks at and not one it permits",
      text: factoryContract,
      pattern: /`alignment_policy_out_of_scope` permits ([\w,-]+) targets and not `clarify_alignment`/,
      measured: [outOfScope.resume_targets.length],
      also: () => {
        assert.ok(!outOfScope.resume_targets.includes("clarify_alignment"));
        assert.ok(outOfScope.parks_at.includes("clarify_alignment"));
      },
    },
    {
      id: "factory §5: park-reason vocabulary size",
      text: factoryContract,
      pattern: /owner of ([\w,-]+) codes it merely passes on/,
      measured: [vocabulary.park_reasons.length],
    },
    {
      id: "factory §6: edges into `fix_artifact` and how many are self-loops; edges into `fix`",
      text: factoryContract,
      pattern: /`fix_artifact` is entered by ([\w,-]+) declared edges, ([\w,-]+) of them self-loops/,
      measured: [intoFixArtifact.length, fixArtifactSelfLoops.length],
    },
    {
      id: "factory §6: edges into `fix`",
      text: factoryContract,
      pattern: /`fix` is entered by ([\w,-]+)/,
      measured: [intoFix.length],
    },
    {
      id: "factory §2: `graph_reasons` pins two codes",
      text: factoryContract,
      pattern: /pinned by the schema to ([\w,-]+) codes/,
      measured: [graphLevelReasons.length],
    },
    {
      id: "factory §3: steps the daemon enters out of band",
      text: factoryContract,
      pattern: /the ([\w,-]+) steps the daemon enters out of band/,
      measured: [outOfBandEntries],
    },
    {
      id: "factory §9: codes the factory's refusal register carries",
      text: factoryContract,
      pattern: /each of the ([\w,-]+) is closed by exactly one contract/,
      measured: [REFUSALS.length],
    },
    {
      id: "factory §9: codes the factory produces that `workflow-graph.md` owns and closes",
      text: factoryContract,
      pattern: /([\w,-]+) further codes the factory produces are owned and closed by `docs\/contracts\/workflow-graph\.md`/,
      measured: [factoryClosedByGraph.length],
    },
    {
      id: "factory §6: transitions a cap counts — every cap names exactly one",
      text: factoryContract,
      pattern: /counts the taking of ([\w,-]+) named transition/,
      measured: capTransitionArity,
    },
    {
      id: "factory §7: documents the digest verifier builds — VARIANTS entries in `scripts/verify-autosk-graph-digest.mjs`, base included; and the one component each differs by",
      text: factoryContract,
      pattern: /builds ([\w,-]+) documents that differ from a base by exactly ([\w,-]+) component — ([^.—]+)—/,
      pick: [0, 1],
      measured: [variantKeys.length, componentsPerVariant.length === 1 ? componentsPerVariant[0] : -1],
      also: (match) => {
        const named = match[3].split(/,\s*/).map((name) => name.trim()).sort();
        assert.deepEqual(named, [...nonBaseVariants].sort());
      },
    },
    {
      id: "factory §7: distinct digests the verifier reads back",
      text: factoryContract,
      pattern: /([\w,-]+) digests, all distinct/,
      measured: [variantKeys.length],
    },
    {
      id: "factory §7: workflows the digest measurement is not a measurement of — the same VARIANTS count",
      text: factoryContract,
      pattern: /of ([\w,-]+) different workflows/,
      measured: [variantKeys.length],
    },
    {
      id: "factory §7: components the digest moved for — VARIANTS entries other than `base`",
      text: factoryContract,
      pattern: /none of those ([\w,-]+) components/,
      measured: [nonBaseVariants.length],
    },
    {
      id: "factory §7: checks the measurement is not composed out of — the rows of the legs table that follows",
      text: factoryContract,
      pattern: /out of ([\w,-]+) checks that each hold up one leg/,
      measured: [legRows],
    },
    {
      id: "factory §7: legs holding the digest criterion up — the rows of the table that follows",
      text: factoryContract,
      pattern: /The ([\w,-]+) legs still hold it up/,
      measured: [legRows],
    },
    {
      id: "factory §7: components moving the document's `canonical_digest` — VARIANTS entries other than `base`, second site",
      text: factoryContract,
      pattern: /every one of the ([\w,-]+) components moves the document's `canonical_digest`/,
      measured: [nonBaseVariants.length],
    },
    {
      id: "factory §10: components each moving the digest — VARIANTS entries other than `base`, third site",
      text: factoryContract,
      pattern: /each of the ([\w,-]+) components moves the digest/,
      measured: [nonBaseVariants.length],
    },
    {
      id: "factory §10: agent steps the false-evaluator test drives to their own park reason — the suite's `slice(0, N)` fixture bound",
      text: factoryContract,
      pattern: /([\w,-]+) steps park with their own reason/,
      measured: [parkedFixtureCount],
    },
    {
      id: "factory §10: documents pinned to distinct digests by the daemon — VARIANTS entries, base included",
      text: factoryContract,
      pattern: /([\w,-]+) documents differing by ([\w,-]+) component each are pinned to ([\w,-]+) distinct/,
      measured: [variantKeys.length, componentsPerVariant.length === 1 ? componentsPerVariant[0] : -1, variantKeys.length],
    },
    {
      id: "factory §7: documents whose declarations are byte-identical — VARIANTS entries, base included, second site",
      text: factoryContract,
      pattern: /byte-identical in all ([\w,-]+)/,
      measured: [variantKeys.length],
    },
    {
      id: "factory §7: ways the digest moved — VARIANTS entries, base included, third site",
      text: factoryContract,
      pattern: /did not move ([\w,-]+) ways/,
      measured: [variantKeys.length],
    },
    {
      id: "factory §10: the digest case's document count — VARIANTS entries, base included, fourth site",
      text: factoryContract,
      pattern: /the ([\w,-]+)-document digest case/,
      measured: [variantKeys.length],
    },
    {
      id: "factory §10: reasons each parked flow's park names — the set of per-edge reason counts, second site",
      text: factoryContract,
      pattern: /every one of its parks names exactly ([\w,-]+) reason/,
      measured: parkingReasonCounts,
    },
    {
      id: "factory §10: required-tests items a real daemon backs — the paragraph's `for section` ascriptions",
      text: factoryContract,
      pattern: /([\w,-]+) of these run against a real daemon/,
      measured: [sectionAscribed],
      also: () => assert.equal(daemonScriptMentions, 3, "the paragraph should name the two section-backed measurers and the register's third"),
    },
    {
      id: "factory §10: verifiers that install the factory into a real project — the same two daemon-backed items",
      text: factoryContract,
      pattern: /([\w,-]+) verifiers install the factory/,
      measured: [sectionAscribed],
    },
    {
      id: "factory §11: steps the shipped document carries — what nothing here drives",
      text: factoryContract,
      pattern: /drives all ([\w,-]+) steps/,
      measured: [graph.steps.length],
    },

    // docs/contracts/workflow-graph.md — section 4's `project_boundary_invalid`
    // split is the ticket's second red operand.
    {
      id: "graph §3: registered workflows — the plan's section-2 `### autosk-*` chain blocks",
      text: graphContract,
      pattern: /registers ([\w,-]+) workflows/,
      measured: [chainBlocks],
    },
    {
      id: "graph §3: workflows that start somewhere other than `first_step` — those the document declares an `entry_steps` row for",
      text: graphContract,
      pattern: /([\w,-]+) of which start somewhere other than `first_step`/,
      measured: [workflowEntries.length],
    },
    {
      id: "graph §3: repair steps the daemon enters out of band — `entry_steps` rows that name no registered workflow",
      text: graphContract,
      pattern: /enters ([\w,-]+) repair steps out of band/,
      measured: [outOfBandEntries],
    },
    {
      id: "graph §3: steps no walk over `transitions` from `first_step` alone reaches — the seed counting as reached",
      text: graphContract,
      pattern: /([\w,-]+) live steps read as dead/,
      measured: [deadFromFirst],
    },
    {
      id: "graph §4: forks the canonical serialization settles — `canonical-reference.json` cases",
      text: graphContract,
      pattern: /the ([\w,-]+) forks the serialization has to settle/,
      measured: [reference.forks.length],
    },
    {
      id: "graph §7: parking edges and the share landing on the step named `human`",
      text: graphContract,
      pattern: /([\w,-]+) of the ([\w,-]+) such edges move it to `human`/,
      measured: [parkingToHuman, parking.length],
    },
    {
      id: "graph §7: rows naming `handled_at` steps, entries they name between them, total rows, rows naming none",
      text: graphContract,
      pattern: /([\w,-]+) of the ([\w,-]+) rows name ([\w,-]+) such steps between them, and ([\w,-]+) rows name none/,
      measured: [handledRows.length, rows.length, handledEntries, rows.length - handledRows.length],
    },
    {
      id: "graph §7: `project_boundary_invalid` — named steps (`parks_at ∪ handled_at`), steps the graph parks it at, and the handled remainder",
      text: graphContract,
      pattern: /named ([\w,-]+) steps while the graph parks it at ([\w,-]+)[\s\S]*?called the other ([\w,-]+) a defect/,
      measured: [boundaryUnion, boundary.parks_at.length, boundaryHandled.length],
    },
    {
      id: "graph §7: status references — `parks_at` entries naming a step that carries a `status`",
      text: graphContract,
      pattern: /its ([\w,-]+) status references/,
      measured: [statusRefs.length],
    },
    {
      id: "graph §7: under the rejected evidence rule — status references that are the landing of an edge carrying that reason, and those that are not",
      text: graphContract,
      pattern: /accepts ([\w,-]+) of the ([\w,-]+) and refuses ([\w,-]+)/,
      measured: [statusLanded.length, statusRefs.length, statusRefs.length - statusLanded.length],
    },
    {
      id: "graph §7: edges into `done`",
      text: graphContract,
      pattern: /every one of the ([\w,-]+) edges into it carries a park reason/,
      measured: [intoDone.length],
    },
    {
      id: "graph §7: edges into `done` under the reasons whose rows name `done` in `parks_at`, and the count of those rows",
      text: graphContract,
      pattern: /([\w,-]+) of them under the ([\w,-]+) reasons that name `done` here/,
      measured: [doneUnderNamed.length, rowsNamingDone.length],
    },
    {
      id: "graph §7: resume targets `commit_on_pass` lends `ticket_completed` — the distinct steps its edges reach",
      text: graphContract,
      pattern: /one of ([\w,-]+) the schema and the terminal rule admit/,
      measured: [commitOnPassTargets.length],
    },
    {
      id: "graph §7: `resume_targets` entries across all recovery rows",
      text: graphContract,
      pattern: /all ([\w,-]+) of them are/,
      measured: [targetEntries],
    },
    {
      id: "graph §7: resume targets that are an edge out of EVERY step their row names — `parks_at ∪ handled_at`, the union premise — and those that are not; over `parks_at` alone the pair would read 218/316",
      text: graphContract,
      pattern: /([\w,-]+) of the ([\w,-]+) are an edge out of EVERY step their row names and ([\w,-]+) are not/,
      measured: [targetsOutOfEveryNamed, targetEntries, targetEntries - targetsOutOfEveryNamed],
    },
    {
      id: "graph §7: resume targets an edge out of some `handled_at` step alone — out of no `parks_at` step",
      text: graphContract,
      pattern: /([\w,-]+) hang on a `handled_at` step alone/,
      measured: [targetsOnHandledOnly],
    },
    {
      id: "graph §7: rows whose `resume_targets` name `done` while `done` is not one the row parks at",
      text: graphContract,
      pattern: /`done` remains a target of the ([\w,-]+) rows that never park at it/,
      measured: [doneTargetRows.length],
    },
    {
      id: "graph §7: rows whose `resume_targets` name `human`",
      text: graphContract,
      pattern: /`human` of the ([\w,-]+) rows whose park is an ordinary stop/,
      measured: [humanTargetRows.length],
    },
    {
      id: "graph §7: rows whose `resume_targets` name `ticket_done`, and which ones the sentence names",
      text: graphContract,
      pattern: /`ticket_done` stays a target of `(\w+)` and `(\w+)` under the ordinary rule/,
      measured: ticketDoneRows,
      raw: true,
    },
    {
      id: "graph §7: graph-level reasons — the codes `graph_reasons` carries — that no recovery row names",
      text: graphContract,
      pattern: /The ([\w,-]+) graph-level reasons are the exception and carry no row/,
      measured: [graphLevelReasons.filter((reason) => !rows.some((row) => row.reason === reason)).length],
      also: () => assert.equal(graphLevelReasons.length, 2),
    },
    {
      id: "graph §8: `project_boundary_invalid` — the second site stating the same split, steps the graph parks it at and where it is handled",
      text: graphContract,
      pattern: /covers ([\w,-]+) steps the graph parks it at and ([\w,-]+) where it is handled/,
      measured: [boundary.parks_at.length, boundaryHandled.length],
    },
    {
      id: "graph §8: `arena_candidate_*` reasons one park-table row explains behind a single cell",
      text: graphContract,
      pattern: /joins ([\w,-]+) arena candidate failures behind one cell/,
      measured: [mostArenaInOneRow],
    },
    {
      id: "graph §8: park-table rows explaining `blocked_anchor` under different qualifiers",
      text: graphContract,
      pattern: /as `blocked_anchor` does ([\w,-]+) times/,
      measured: [blockedAnchorRows.length],
    },
    {
      id: "graph §8: arrow-chain blocks in the plan's section 2",
      text: graphContract,
      pattern: /Section 2's ([\w,-]+) arrow-chain blocks/,
      measured: [chainBlocks],
    },
    {
      id: "graph §9: closed-set codes without the `graph_` prefix — the runtime park reasons the graph itself issues",
      text: graphContract,
      pattern: /The ([\w,-]+) without the prefix are runtime park reasons/,
      measured: [unprefixedClosed.length],
    },
    {
      id: "graph §8: things a recovery row names — its array-typed fields in the schema (`parks_at`, `handled_at`, `resume_targets`)",
      text: graphContract,
      pattern: /A row names ([\w,-]+) things, and each of the ([\w,-]+) is one statement/,
      measured: [rowListFields, rowListFields],
    },
    {
      id: "graph §8: rows no park can reach — rows whose reason no parking mechanism produces: no edge into a `human`-status step carries it, no step's `no_transition_reason` is it, no cap names it",
      text: graphContract,
      pattern: /the document's ([\w,-]+) row no park can reach/,
      measured: [rowsNoParkReaches.length],
    },
    {
      id: "graph §8: the witness in 'a reason stopping at nine steps permits the edges leaving all nine' — a `parks_at` size the document actually carries",
      text: graphContract,
      pattern: /a reason stopping at ([\w,-]+) steps permits the edges leaving all ([\w,-]+)/,
      measured: parksAtSizes,
      member: true,
    },
    {
      id: "graph §8: copies of the resume table — `recovery` here, the two rendered views, and the vocabulary's extracted table",
      text: graphContract,
      pattern: /out of ([\w,-]+) copies of the table/,
      measured: [tableCopies],
    },
    {
      id: "graph §8: copies of the three prose tables now rendered from this document — the `views[]` entries — against the three copies the sentence enumerates (the two views plus this contract's own `recovery` table)",
      text: graphContract,
      pattern: /([\w,-]+) of the ([\w,-]+) are now rendered from this document/,
      measured: [graph.views.length, graph.views.length + 1],
    },
    {
      id: "graph §9: codes the parse names itself — the `graph_*` codes the same sentence enumerates",
      text: graphContract,
      pattern: /other than the ([\w,-]+) the parse names itself/,
      measured: [parseNamedCodes],
    },
    {
      id: "graph §9: codes this contract owns — the runtime park reasons without the `graph_` prefix, second site",
      text: graphContract,
      pattern: /The ([\w,-]+) codes this contract owns are issued by the graph about itself/,
      measured: [unprefixedClosed.length],
    },
    {
      id: "graph §9: reserved names refused on steps, guards and caps — the validator's `GRAPH_PARK_REASONS` set",
      text: graphContract,
      pattern: /The reserved ([\w,-]+) are refused everywhere/,
      measured: [reservedCodes.length],
    },
    {
      id: "graph §9: runtime park reasons `workflow-factory.mjs` produces — the codes without the `graph_` prefix, third site",
      text: graphContract,
      pattern: /All ([\w,-]+) are produced by `src\/host\/workflow-factory\.mjs`/,
      measured: [unprefixedClosed.length],
    },
    {
      id: "graph §9: codes the factory closes of its own — REFUSALS minus the codes this contract owns",
      text: graphContract,
      pattern: /closes ([\w,-]+) further codes of its own/,
      measured: [factoryOwnCodes],
    },
    {
      id: "graph §10: runtime codes the suite proves unreachable — the distinct codes named in `is unreachable:` test titles",
      text: graphContract,
      pattern: /the ([\w,-]+) runtime codes are proved unreachable/,
      measured: [unreachableCodes.size],
    },
    {
      id: "graph §10: graph-level codes that cannot be renamed — the `graph_reasons` keys",
      text: graphContract,
      pattern: /the ([\w,-]+) graph-level codes cannot be renamed/,
      measured: [graphLevelReasons.length],
    },
    {
      id: "graph §10: forks exercised in the canonical reference — `canonical-reference.json` cases, second site",
      text: graphContract,
      pattern: /each of its ([\w,-]+) forks is exercised/,
      measured: [reference.forks.length],
    },

    // docs/contracts/refusal-vocabulary.md
    {
      id: "vocabulary §6: park reasons an artifact contract closes — `closed_by` naming a document under `docs/contracts/` rather than `03-technical-plan.md` — and the vocabulary's size",
      text: vocabularyContract,
      pattern: /([\w,-]+) of the ([\w,-]+) are additionally closed by the artifact contract/,
      measured: [artifactClosed.length, vocabulary.park_reasons.length],
    },
    {
      id: "vocabulary §9: reasons whose `producer` is `daemon` — parked by `autoskd`",
      text: vocabularyContract,
      pattern: /([\w,-]+) of the reasons are parked by `autoskd`/,
      measured: [daemonProduced.length],
    },

    // resources/workflow-graph/workflow-graph.schema.json — the descriptions
    // quote the same measurements the prose does.
    {
      id: "schema `handled_at`: rows naming none, and the widest row's handled count against `project_boundary_invalid`'s union",
      text: schemaProse,
      pattern: /([\w,-]+) of the ([\w,-]+) rows name none, and the widest holds ([\w,-]+) of project_boundary_invalid's ([\w,-]+)/,
      measured: [rows.length - handledRows.length, rows.length, widestHandled, boundaryUnion],
    },
    {
      id: "schema `parks_at`: the widest a reason's `parks_at ∪ handled_at` union runs",
      text: schemaProse,
      pattern: /one reason can name ([\w,-]+) steps across this field and handled_at together/,
      measured: [widestUnion],
    },
    {
      id: "schema `entry_steps`: registered workflows — the plan's `### autosk-*` chain blocks, second site",
      text: schemaProse,
      pattern: /registers ([\w,-]+) workflows/,
      measured: [chainBlocks],
    },
    {
      id: "schema `entry_steps`: repair steps the daemon enters out of band — `entry_steps` rows naming no registered workflow, second site",
      text: schemaProse,
      pattern: /enters ([\w,-]+) repair steps out of band/,
      measured: [outOfBandEntries],
    },
    {
      id: "schema `caps`: transitions a cap counts — every cap names exactly one, second site",
      text: schemaProse,
      pattern: /counts the taking of ([\w,-]+) named transition/,
      measured: capTransitionArity,
    },
    {
      id: "schema `authority`: components criterion 2 names — the digest verifier's non-base VARIANTS",
      text: schemaProse,
      pattern: /Criterion 2 names ([\w,-]+) components/,
      measured: [nonBaseVariants.length],
    },
  ];

  const drift = [];
  for (const claim of claims) {
    // The claim's text is already plain prose (see normalizeProse); the
    // pattern's only markdown residue is the literal backtick around an
    // identifier, which a normalized sentence no longer carries.
    const source = widenNumeralSlot(claim.pattern.source.replace(/`/g, ""));
    const found = claimMatch(claim.text, source);
    if (found.state === "not-found") {
      drift.push(`${claim.id}: the sentence carrying the count was not found — the claim can no longer be read`);
      continue;
    }
    if (found.state === "not-unique") {
      drift.push(`${claim.id}: the sentence carrying the count is not unique — ${found.count} occurrences`);
      continue;
    }
    // The count a sentence states is a span, not a token: extend each capture
    // over the numeral run on both sides, then parse what the prose actually
    // wrote. A span the parser cannot read is drift; one that reads is
    // compared. Reading a position instead of the span is how "two hundred"
    // once agreed as "two".
    const spans = found.match.indices.slice(1).map(([start, end]) =>
      claim.raw ? claim.text.slice(start, end) : numeralSpan(claim.text, start, end));
    const quoted = claim.pick ? claim.pick.map((index) => spans[index]) : spans;
    const expected = claim.measured;
    if (claim.raw) {
      if (JSON.stringify([...quoted].sort()) !== JSON.stringify([...expected].sort())) {
        drift.push(`${claim.id}: prose says ${quoted.join("/")}, the document measures ${expected.join("/")}`);
        continue;
      }
    } else {
      const parsed = quoted.map(parseCount);
      if (parsed.includes(undefined)) {
        const unreadable = quoted.filter((token) => parseCount(token) === undefined);
        drift.push(`${claim.id}: prose numeral the suite cannot read: ${unreadable.join("/")}`);
        continue;
      }
      if (claim.member) {
        if (!parsed.every((value) => expected.includes(value)) || new Set(parsed).size !== 1) {
          drift.push(`${claim.id}: prose says ${quoted.join("/")}, which no measurement in ${expected.join("/")} witnesses`);
          continue;
        }
      } else if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
        drift.push(`${claim.id}: prose says ${quoted.join("/")}, the document measures ${expected.join("/")}`);
        continue;
      }
    }
    try {
      claim.also?.(found.match);
    } catch (error) {
      drift.push(`${claim.id}: ${error.message}`);
    }
  }

  // The views roster: the contract names the two views and their render
  // targets; the document must carry exactly that set.
  const roster = graphContract.match(/must carry both views, (\w+) rendered into ([\w-]+(?:\.[\w-]+)*) and (\w+) rendered into ([\w-]+(?:\.[\w-]+)*)/);
  if (!roster) {
    drift.push("graph §8: the views-roster sentence was not found — the claim can no longer be read");
  } else {
    const named = [roster[1] + "@" + roster[2], roster[3] + "@" + roster[4]].sort();
    const carried = graph.views.map((view) => `${view.id}@${view.renders_into}`).sort();
    if (JSON.stringify(named) !== JSON.stringify(carried)) {
      drift.push(`graph §8: prose names views ${named.join("/")}, the document carries ${carried.join("/")}`);
    }
  }

  // The tolerated-transition paragraph: every `a -> b` the sentence names is a
  // transition the graph declares, and "those three" counts them.
  const tolerated = graphContract.match(/A drawn path the graph cannot walk[\s\S]*?nothing remains to tolerate\./);
  const toleratedCount = graphContract.match(new RegExp(`those (${NUMERAL_RUN}) transitions are in the graph`, "d"));
  if (!tolerated || !toleratedCount) {
    drift.push("graph §8: the tolerated-transition paragraph was not found — the claim can no longer be read");
  } else {
    const toleratedPairs = [...tolerated[0].matchAll(/(\w+) -> (\w+)/g)].map((match) => [match[1], match[2]]);
    for (const [from, to] of toleratedPairs) {
      if (!graph.transitions.some((edge) => edge.from === from && edge.to === to)) {
        drift.push(`graph §8: the tolerated list names \`${from} -> ${to}\`, which no transition declares`);
      }
    }
    const [countStart, countEnd] = toleratedCount.indices[1];
    const countSpan = numeralSpan(graphContract, countStart, countEnd);
    if (toleratedPairs.length !== parseCount(countSpan)) {
      drift.push(`graph §8: prose says ${countSpan} tolerated transitions settled, the paragraph names ${toleratedPairs.length}`);
    }
  }

  assert.deepEqual(drift, []);
});

import * as fs from "node:fs";
import * as path from "node:path";

type Eol = "\r\n" | "\n";

interface FileState {
  lines: string[];
  eol: Eol;
  endsWithBreak: boolean;
  /** Raw text when the file's bytes are authoritative as-is (e.g. JSON create);
   * null means the lines above define the file. */
  raw: string | null;
}

/** One edit, normalised from any of the four patch formats.
 *  One edit = one unified section / one SEARCH/REPLACE block / one V4A
 *  section / one JSON object, in patch order. */
type FormatName = "unified" | "search-replace" | "v4a" | "json";

type EditKind = "create" | "delete" | "change" | "move" | "insert" | "str-replace";

/** One hunk (unified), one block (SEARCH/REPLACE) or one chunk (V4A). */
interface EditStep {
  oldLines: string[];
  newLines: string[];
  /** For each line of newLines: its index into oldLines when it is a context
   *  line (present in both O and N), else null. */
  newContextOldIndex: (number | null)[];
  /** Unified: 1-based old start A from the hunk header; null otherwise. */
  targetLine: number | null;
  /** V4A: anchor text; null when the chunk has no anchor. */
  anchor: string | null;
  /** V4A: chunk ends at the end of the file (*** End of File). */
  endOfFile: boolean;
  /** Unified: a backslash line follows the hunk's last context or + line. */
  trailingNoBreak: boolean;
}

/** Command data for JSON edits; null for the other formats. */
interface JsonData {
  command: "create" | "str_replace" | "insert";
  fileText: string | null; // create
  oldStr: string | null; // str_replace
  newStr: string | null; // str_replace / insert
  insertLine: number | null; // insert
}

interface NormalizedEdit {
  format: FormatName;
  /** All paths the edit names, old path first, then new path (moves). */
  paths: string[];
  kind: EditKind;
  /** Unified: one step per hunk. SEARCH/REPLACE: one step per block.
   *  V4A: one step per chunk (add: one step holding the file's lines).
   *  JSON: empty. */
  steps: EditStep[];
  json: JsonData | null;
}

function makeStep(
  oldLines: string[],
  newLines: string[],
  newContextOldIndex: (number | null)[],
  opts?: Partial<Pick<EditStep, "targetLine" | "anchor" | "endOfFile" | "trailingNoBreak">>,
): EditStep {
  return {
    oldLines,
    newLines,
    newContextOldIndex,
    targetLine: opts?.targetLine ?? null,
    anchor: opts?.anchor ?? null,
    endOfFile: opts?.endOfFile ?? false,
    trailingNoBreak: opts?.trailingNoBreak ?? false,
  };
}

/** The file's full text: the raw text when present, else its lines joined
 *  with its own break plus a final break when it ends with one. */
function fullText(state: FileState): string {
  if (state.raw !== null) return state.raw;
  if (state.lines.length === 0) return "";
  return state.lines.join(state.eol) + (state.endsWithBreak ? state.eol : "");
}

/** Replace a file's lines; clears the raw-text marker. */
function setFileLines(state: FileState, lines: string[]): void {
  state.lines = lines;
  state.raw = null;
}

/** Replace a file's whole text (re-split into lines, eol and final break). */
function setFileText(state: FileState, text: string): void {
  const next = splitFileLines(text);
  state.lines = next.lines;
  state.eol = next.eol;
  state.endsWithBreak = next.endsWithBreak;
  state.raw = next.raw;
}

function splitPatchLines(text: string): string[] {
  const parts = text.split("\n");
  const lines = parts.map((p) => (p.endsWith("\r") ? p.slice(0, -1) : p));
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function splitFileLines(text: string): FileState {
  if (text === "") return { lines: [], eol: "\n", endsWithBreak: false, raw: "" };
  const firstLf = text.indexOf("\n");
  const eol: Eol = firstLf > 0 && text[firstLf - 1] === "\r" ? "\r\n" : "\n";
  const endsWithBreak = text.endsWith(eol);
  const parts = text.split(eol);
  if (endsWithBreak) parts.pop();
  return { lines: parts, eol, endsWithBreak, raw: text };
}

function trimTrailing(s: string): string {
  return s.replace(/[ \t]+$/, "");
}

function trimBoth(s: string): string {
  return s.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : "";
}

function isSafePath(p: string): boolean {
  if (p === "") return false;
  if (p.startsWith("/")) return false;
  if (p.includes("\\")) return false;
  const segs = p.split("/");
  for (const seg of segs) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  return true;
}

function loadTree(root: string): Map<string, FileState> {
  const tree = new Map<string, FileState>();
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = rel === "" ? entry.name : rel + "/" + entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, relPath);
      } else if (entry.isFile()) {
        const text = fs.readFileSync(full, "utf8");
        tree.set(relPath, splitFileLines(text));
      }
    }
  };
  walk(root, "");
  return tree;
}

function linesEqualAtTier(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrailing(a) === trimTrailing(b);
  return trimBoth(a) === trimBoth(b);
}

interface MatchResult {
  tier: number;
  positions: number[];
}

function findMatchesUpTo(oldLines: string[], fileLines: string[], maxTier: number): MatchResult | null {
  for (let tier = 0; tier <= maxTier; tier++) {
    const positions: number[] = [];
    for (let i = 0; i + oldLines.length <= fileLines.length; i++) {
      let ok = true;
      for (let j = 0; j < oldLines.length; j++) {
        if (!linesEqualAtTier(oldLines[j], fileLines[i + j], tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

function findMatches(oldLines: string[], fileLines: string[]): MatchResult | null {
  return findMatchesUpTo(oldLines, fileLines, 2);
}

/** Like findMatches, but only occurrences at or after `from`. */
function findMatchesFrom(oldLines: string[], fileLines: string[], from: number, maxTier: number): MatchResult | null {
  for (let tier = 0; tier <= maxTier; tier++) {
    const positions: number[] = [];
    for (let i = from; i + oldLines.length <= fileLines.length; i++) {
      let ok = true;
      for (let j = 0; j < oldLines.length; j++) {
        if (!linesEqualAtTier(oldLines[j], fileLines[i + j], tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** First line at or after `from` equal to a single-line anchor, at the first
 *  tier (0, then 1, then 2) where one is; null when there is none. */
function findAnchor(anchor: string, fileLines: string[], from: number, maxTier: number): number | null {
  for (let tier = 0; tier <= maxTier; tier++) {
    for (let i = from; i < fileLines.length; i++) {
      if (linesEqualAtTier(anchor, fileLines[i], tier)) return i;
    }
  }
  return null;
}

/** The occurrence nearest to `target`; of two equally near, the earlier. */
function nearestPosition(positions: number[], target: number): number {
  let best = positions[0];
  for (const p of positions) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  return best;
}

/** Build the replacement lines for a matched step: context lines are the
 *  file's own matched lines; other lines are re-indented at tier 2, and
 *  written as they are at tiers 0 and 1. */
function buildNewLines(step: EditStep, fileLines: string[], pos: number, tier: number): string[] {
  const matched = fileLines.slice(pos, pos + step.oldLines.length);
  const matchedForNew: (string | null)[] = step.newLines.map((_, j) => {
    const oi = step.newContextOldIndex[j];
    return oi === null || oi === undefined ? null : matched[oi];
  });
  if (tier === 2) return reindentTier2(step.oldLines, step.newLines, matched, matchedForNew);
  return step.newLines.map((line, j) => {
    const m = matchedForNew[j];
    return m !== null && m !== undefined ? m : line;
  });
}

/** Compare two paths as UTF-8 bytes. */
function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function reindentTier2(
  oldLines: string[],
  newLines: string[],
  matchedLines: string[],
  matchedForNew: (string | null)[],
): string[] {
  const f = matchedLines.length > 0 ? leadingWs(matchedLines[0]) : "";
  const p = oldLines.length > 0 ? leadingWs(oldLines[0]) : "";
  return newLines.map((line, idx) => {
    const matched = matchedForNew[idx];
    if (matched !== null && matched !== undefined) return matched;
    if (line === "" || trimBoth(line) === "") return line;
    // When P is empty every line starts with it, so replacing the empty
    // prefix with F means prepending F.
    if (line.startsWith(p)) return f + line.slice(p.length);
    return line;
  });
}

const outLines: string[] = [];
let exitCode = 0;

function setExitCode(code: number): void {
  exitCode = code;
}

class UsageError extends Error {}
class NoPatchError extends Error {}
class ParseFault extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function trimEndWs(s: string): string {
  return s.replace(/[ \t]+$/, "");
}

interface CliArgs {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

const FORMAT_NAMES = ["unified", "search-replace", "v4a", "json", "auto"];

function parseArgs(argv: string[]): CliArgs {
  let format = "auto";
  let check = false;
  let strict = false;
  let formatSeen = false;
  let checkSeen = false;
  let strictSeen = false;
  let positional: string | null = null;
  let positionalCount = 0;
  let endOfOptions = false;
  for (const arg of argv) {
    if (!endOfOptions && arg === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && arg.startsWith("-") && arg !== "-") {
      if (arg.startsWith("--format=")) {
        if (formatSeen) throw new UsageError();
        formatSeen = true;
        const value = arg.slice("--format=".length);
        if (!FORMAT_NAMES.includes(value)) throw new UsageError();
        format = value;
      } else if (arg === "--check") {
        if (checkSeen) throw new UsageError();
        checkSeen = true;
        check = true;
      } else if (arg === "--strict") {
        if (strictSeen) throw new UsageError();
        strictSeen = true;
        strict = true;
      } else {
        throw new UsageError();
      }
    } else {
      positionalCount++;
      if (positionalCount > 1) throw new UsageError();
      positional = arg;
    }
  }
  return { format, check, strict, patch: positional };
}

function readPatch(patch: string | null): string {
  if (patch === null || patch === "-") {
    return fs.readFileSync(0, "utf8");
  }
  try {
    return fs.readFileSync(patch, "utf8");
  } catch {
    throw new NoPatchError();
  }
}

function detectFormat(lines: string[]): FormatName | null {
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx === -1) return null;
  const first = lines[firstIdx];
  if (first.trim() === "*** Begin Patch") return "v4a";
  const firstNonWs = first.trimStart()[0];
  if (firstNonWs === "[" || firstNonWs === "{") return "json";
  for (const line of lines) {
    if (trimEndWs(line) === "<<<<<<< SEARCH") return "search-replace";
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("diff --git ")) return "unified";
    if (lines[i].startsWith("--- ") && i + 1 < lines.length && lines[i + 1].startsWith("+++ ")) return "unified";
  }
  return null;
}

function jsonObjectToEdit(value: unknown, lineNo: number): NormalizedEdit {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ParseFault(lineNo);
  const o = value as Record<string, unknown>;
  if (typeof o.path !== "string") throw new ParseFault(lineNo);
  if (typeof o.command !== "string") throw new ParseFault(lineNo);
  const editPath = o.path;
  switch (o.command) {
    case "create": {
      if (typeof o.file_text !== "string") throw new ParseFault(lineNo);
      return {
        format: "json",
        paths: [editPath],
        kind: "create",
        steps: [],
        json: { command: "create", fileText: o.file_text, oldStr: null, newStr: null, insertLine: null },
      };
    }
    case "str_replace": {
      if (typeof o.old_str !== "string" || o.old_str === "") throw new ParseFault(lineNo);
      let newStr = "";
      if ("new_str" in o) {
        if (typeof o.new_str !== "string") throw new ParseFault(lineNo);
        newStr = o.new_str;
      }
      return {
        format: "json",
        paths: [editPath],
        kind: "str-replace",
        steps: [],
        json: { command: "str_replace", fileText: null, oldStr: o.old_str, newStr, insertLine: null },
      };
    }
    case "insert": {
      if (typeof o.insert_line !== "number" || !Number.isInteger(o.insert_line)) throw new ParseFault(lineNo);
      if (typeof o.new_str !== "string") throw new ParseFault(lineNo);
      return {
        format: "json",
        paths: [editPath],
        kind: "insert",
        steps: [],
        json: { command: "insert", fileText: null, oldStr: null, newStr: o.new_str, insertLine: o.insert_line },
      };
    }
    default:
      throw new ParseFault(lineNo);
  }
}

function parseJsonPatch(lines: string[], patchText: string): NormalizedEdit[] {
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx === -1) return [];
  const firstChar = lines[firstIdx].trimStart()[0];
  if (firstChar === "[") {
    // Array form: one JSON array of edit objects; any fault is at the line
    // where the array starts.
    const startLine = firstIdx + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(patchText);
    } catch {
      throw new ParseFault(startLine);
    }
    if (!Array.isArray(parsed)) throw new ParseFault(startLine);
    const edits: NormalizedEdit[] = [];
    for (const item of parsed) edits.push(jsonObjectToEdit(item, startLine));
    return edits;
  }
  // JSON Lines form: one edit object per line, blank lines ignored.
  const edits: NormalizedEdit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line)) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      throw new ParseFault(i + 1);
    }
    edits.push(jsonObjectToEdit(obj, i + 1));
  }
  return edits;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripABPrefix(p: string): string {
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

/** Path from a `--- ` / `+++ ` line: text after the first four characters,
 *  up to the first tab, with surrounding spaces removed, `a/`/`b/` stripped. */
function dashPath(line: string): string {
  const rest = line.slice(4);
  const beforeTab = rest.split("\t")[0];
  return stripABPrefix(beforeTab.trim());
}

function isDiffGitLine(line: string): boolean {
  return line === "diff --git" || line.startsWith("diff --git ") || line.startsWith("diff --git\t");
}

/** Validate a `diff --git` line: exactly two whitespace-separated tokens
 *  after `diff --git`, the first starting with `a/`, the second with `b/`. */
function parseDiffGitLine(line: string): { oldPath: string; newPath: string } | null {
  const rest = line.slice("diff --git".length).trim();
  if (rest === "") return null;
  const tokens = rest.split(/\s+/);
  if (tokens.length !== 2) return null;
  if (!tokens[0].startsWith("a/") || !tokens[1].startsWith("b/")) return null;
  return { oldPath: tokens[0].slice(2), newPath: tokens[1].slice(2) };
}

interface UnifiedBodyLine {
  type: "context" | "old" | "new" | "backslash";
  text: string;
}

/** Scan a hunk body starting at `start` (first line after the hunk header).
 *  Returns the built step and the index of the first line not in the body. */
function parseHunkBody(lines: string[], start: number, targetLine: number): { step: EditStep; next: number } {
  const body: UnifiedBodyLine[] = [];
  let k = start;
  while (k < lines.length) {
    const line = lines[k];
    if (line.startsWith("diff --git ")) break;
    if (line.startsWith("--- ") && k + 1 < lines.length && lines[k + 1].startsWith("+++ ")) break;
    if (line === "") {
      body.push({ type: "context", text: "" });
      k++;
      continue;
    }
    const c = line[0];
    if (c === " ") {
      body.push({ type: "context", text: line.slice(1) });
      k++;
      continue;
    }
    if (c === "-") {
      body.push({ type: "old", text: line.slice(1) });
      k++;
      continue;
    }
    if (c === "+") {
      body.push({ type: "new", text: line.slice(1) });
      k++;
      continue;
    }
    if (c === "\\") {
      body.push({ type: "backslash", text: line.slice(1) });
      k++;
      continue;
    }
    break;
  }
  // Empty lines at the end of a body are not part of it.
  while (body.length > 0) {
    const last = body[body.length - 1];
    if (last.type === "context" && last.text === "") body.pop();
    else break;
  }
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const newContextOldIndex: (number | null)[] = [];
  for (const bl of body) {
    if (bl.type === "context") {
      newContextOldIndex.push(oldLines.length);
      oldLines.push(bl.text);
      newLines.push(bl.text);
    } else if (bl.type === "old") {
      oldLines.push(bl.text);
    } else if (bl.type === "new") {
      newContextOldIndex.push(null);
      newLines.push(bl.text);
    }
  }
  // A backslash line follows the hunk's last context or `+` line.
  let trailingNoBreak = false;
  for (let t = body.length - 1; t >= 0; t--) {
    if (body[t].type === "context" || body[t].type === "new") {
      trailingNoBreak = t + 1 < body.length && body[t + 1].type === "backslash";
      break;
    }
  }
  return {
    step: makeStep(oldLines, newLines, newContextOldIndex, { targetLine, trailingNoBreak }),
    next: k,
  };
}

interface UnifiedSectionState {
  dashOld: string | null;
  dashNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  newFileMode: boolean;
  deletedFileMode: boolean;
  inHeader: boolean;
  hunks: EditStep[];
}

function newUnifiedSection(): UnifiedSectionState {
  return {
    dashOld: null,
    dashNew: null,
    renameOld: null,
    renameNew: null,
    diffOld: null,
    diffNew: null,
    newFileMode: false,
    deletedFileMode: false,
    inHeader: true,
    hunks: [],
  };
}

/** Decide a finished section's edit, in the spec's order: creation, then
 *  deletion, then move, then change. Path sources resolve `---`/`+++` first,
 *  then `rename from`/`rename to`, then `diff --git`. */
function unifiedSectionToEdit(s: UnifiedSectionState): NormalizedEdit | null {
  const oldPath = s.dashOld ?? s.renameOld ?? s.diffOld;
  const newPath = s.dashNew ?? s.renameNew ?? s.diffNew;
  if (oldPath === null && newPath === null) return null;
  const oldP = oldPath ?? (newPath as string);
  const newP = newPath ?? (oldPath as string);
  if (oldP === "/dev/null" || s.newFileMode) {
    return { format: "unified", paths: [newP], kind: "create", steps: s.hunks, json: null };
  }
  if (newP === "/dev/null" || s.deletedFileMode) {
    return { format: "unified", paths: [oldP], kind: "delete", steps: s.hunks, json: null };
  }
  if (oldP !== newP) {
    return { format: "unified", paths: [oldP, newP], kind: "move", steps: s.hunks, json: null };
  }
  return { format: "unified", paths: [oldP], kind: "change", steps: s.hunks, json: null };
}

function parseUnifiedPatch(lines: string[]): NormalizedEdit[] {
  const edits: NormalizedEdit[] = [];
  let section: UnifiedSectionState | null = null;
  const finishSection = (): void => {
    if (section === null) return;
    const edit = unifiedSectionToEdit(section);
    if (edit !== null) edits.push(edit);
    section = null;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isDiffGitLine(line)) {
      const parsed = parseDiffGitLine(line);
      if (parsed === null) throw new ParseFault(i + 1);
      finishSection();
      section = newUnifiedSection();
      section.diffOld = parsed.oldPath;
      section.diffNew = parsed.newPath;
      i++;
      continue;
    }
    if (line.startsWith("--- ")) {
      if (section !== null && section.inHeader) {
        // Part of this section's header: must be followed by a `+++ ` line.
        if (i + 1 >= lines.length || !lines[i + 1].startsWith("+++ ")) {
          throw new ParseFault(i + 2);
        }
        section.dashOld = dashPath(line);
        section.dashNew = dashPath(lines[i + 1]);
        i += 2;
        continue;
      }
      if (i + 1 < lines.length && lines[i + 1].startsWith("+++ ")) {
        finishSection();
        section = newUnifiedSection();
        section.dashOld = dashPath(line);
        section.dashNew = dashPath(lines[i + 1]);
        i += 2;
        continue;
      }
      // A lone `--- ` line outside a header is ignored prose.
      i++;
      continue;
    }
    if (line.startsWith("@@")) {
      if (section === null) throw new ParseFault(i + 1);
      const m = HUNK_HEADER_RE.exec(line);
      if (m === null) throw new ParseFault(i + 1);
      section.inHeader = false;
      const parsed = parseHunkBody(lines, i + 1, Number(m[1]));
      section.hunks.push(parsed.step);
      i = parsed.next;
      continue;
    }
    if (section !== null && section.inHeader) {
      if (line.startsWith("rename from ")) {
        section.renameOld = line.slice("rename from ".length).trim();
      } else if (line.startsWith("rename to ")) {
        section.renameNew = line.slice("rename to ".length).trim();
      } else if (line.startsWith("new file mode")) {
        section.newFileMode = true;
      } else if (line.startsWith("deleted file mode")) {
        section.deletedFileMode = true;
      }
      // Every other header line (index, old/new mode, similarity, ...) is ignored.
      i++;
      continue;
    }
    // Outside bodies and headers, lines are ignored (prose, code fences).
    i++;
  }
  finishSection();
  return edits;
}

function parseSearchReplacePatch(lines: string[]): NormalizedEdit[] {
  const edits: NormalizedEdit[] = [];
  // Index of the previous block's `>>>>>>> REPLACE` line, or -1 before the
  // first block. A block's path line must come after it.
  let prevReplaceIdx = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (trimEndWs(lines[i]) !== "<<<<<<< SEARCH") {
      i++;
      continue;
    }
    const searchLineNo = i + 1;
    // The path is the nearest line before the SEARCH line, and after the
    // previous block's REPLACE line (or the start of the patch), that is
    // not blank and does not start with three backticks once its
    // surrounding whitespace is removed.
    let editPath: string | null = null;
    for (let j = i - 1; j > prevReplaceIdx; j--) {
      const line = lines[j];
      if (isBlank(line)) continue;
      const trimmed = trimBoth(line);
      if (trimmed.startsWith("```")) continue;
      editPath = trimmed;
      break;
    }
    if (editPath === null) {
      if (prevPath !== null) {
        editPath = prevPath;
      } else {
        throw new ParseFault(searchLineNo);
      }
    }
    // A SEARCH line with no `=======` and then `>>>>>>> REPLACE` after it
    // is a parse fault at the SEARCH line.
    let eqIdx = -1;
    for (let k = i + 1; k < lines.length; k++) {
      if (trimEndWs(lines[k]) === "=======") {
        eqIdx = k;
        break;
      }
    }
    if (eqIdx === -1) throw new ParseFault(searchLineNo);
    let repIdx = -1;
    for (let k = eqIdx + 1; k < lines.length; k++) {
      if (trimEndWs(lines[k]) === ">>>>>>> REPLACE") {
        repIdx = k;
        break;
      }
    }
    if (repIdx === -1) throw new ParseFault(searchLineNo);
    const oldLines = lines.slice(i + 1, eqIdx);
    const newLines = lines.slice(eqIdx + 1, repIdx);
    // This format has no context lines, so every new line is re-indented
    // at tier 2 (newContextOldIndex all null).
    const step = makeStep(oldLines, newLines, newLines.map(() => null));
    const kind: EditKind = oldLines.length === 0 ? "create" : "change";
    edits.push({ format: "search-replace", paths: [editPath], kind, steps: [step], json: null });
    prevPath = editPath;
    prevReplaceIdx = repIdx;
    i = repIdx + 1;
  }
  return edits;
}

interface V4aBodyLine {
  type: "context" | "old" | "new";
  text: string;
  /** The raw patch line was blank (empty or only whitespace). */
  rawBlank: boolean;
}

interface V4aChunk {
  anchor: string | null;
  body: V4aBodyLine[];
}

/** A section header line: `*** Add File: PATH`, `*** Delete File: PATH` or
 *  `*** Update File: PATH`. The path is the rest of the line, its
 *  surrounding spaces removed. */
function v4aSectionHeader(line: string): { kind: "add" | "delete" | "update"; path: string } | null {
  const kinds = [
    ["*** Add File: ", "add"],
    ["*** Delete File: ", "delete"],
    ["*** Update File: ", "update"],
  ] as const;
  for (const [prefix, kind] of kinds) {
    if (line.startsWith(prefix)) return { kind, path: line.slice(prefix.length).trim() };
  }
  return null;
}

/** One body line of an Update File chunk: a leading space (context), dash
 *  (old) or plus (new), or an empty line (an empty context line). Null when
 *  the line is none of those. */
function v4aBodyLine(line: string): V4aBodyLine | null {
  if (line === "") return { type: "context", text: "", rawBlank: true };
  const c = line[0];
  if (c === " ") return { type: "context", text: line.slice(1), rawBlank: line.trim() === "" };
  if (c === "-") return { type: "old", text: line.slice(1), rawBlank: false };
  if (c === "+") return { type: "new", text: line.slice(1), rawBlank: false };
  return null;
}

/** Build one EditStep from a parsed chunk: O is its context and `-` lines,
 *  N its context and `+` lines, each in body order. */
function v4aChunkToStep(chunk: V4aChunk, endOfFile: boolean): EditStep {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const newContextOldIndex: (number | null)[] = [];
  for (const bl of chunk.body) {
    if (bl.type === "context") {
      newContextOldIndex.push(oldLines.length);
      oldLines.push(bl.text);
      newLines.push(bl.text);
    } else if (bl.type === "old") {
      oldLines.push(bl.text);
    } else {
      newContextOldIndex.push(null);
      newLines.push(bl.text);
    }
  }
  return makeStep(oldLines, newLines, newContextOldIndex, { anchor: chunk.anchor, endOfFile });
}

function parseV4aPatch(lines: string[]): NormalizedEdit[] {
  // The first non-blank line must be `*** Begin Patch`.
  let beginIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      beginIdx = i;
      break;
    }
  }
  if (beginIdx === -1) throw new ParseFault(1);
  if (lines[beginIdx].trim() !== "*** Begin Patch") throw new ParseFault(beginIdx + 1);
  // The last non-blank line must be `*** End Patch`.
  let endIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i])) {
      endIdx = i;
      break;
    }
  }
  if (lines[endIdx].trim() !== "*** End Patch") throw new ParseFault(lines.length + 1);

  const edits: NormalizedEdit[] = [];
  let i = beginIdx + 1;
  while (i < endIdx) {
    const line = lines[i];
    // Blank lines between sections are ignored.
    if (isBlank(line)) {
      i++;
      continue;
    }
    const header = v4aSectionHeader(line);
    if (header === null) throw new ParseFault(i + 1);

    if (header.kind === "add") {
      // Lines start with `+` (the rest is a line of the file) or are empty
      // (an empty line of the file). Blank lines at the end of the section
      // are not part of it; a trailing `+` line is real content, so only
      // raw-blank lines are dropped.
      const fileLines: { text: string; rawBlank: boolean }[] = [];
      i++;
      while (i < endIdx) {
        const l = lines[i];
        if (v4aSectionHeader(l) !== null) break;
        if (l.startsWith("+")) {
          fileLines.push({ text: l.slice(1), rawBlank: false });
          i++;
        } else if (l === "") {
          fileLines.push({ text: "", rawBlank: true });
          i++;
        } else {
          throw new ParseFault(i + 1);
        }
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1].rawBlank) fileLines.pop();
      const texts = fileLines.map((fl) => fl.text);
      edits.push({
        format: "v4a",
        paths: [header.path],
        kind: "create",
        steps: [makeStep([], texts, texts.map(() => null))],
        json: null,
      });
      continue;
    }

    if (header.kind === "delete") {
      // A Delete File section has no lines; only blank lines may follow it
      // before the next section or `*** End Patch`.
      i++;
      while (i < endIdx) {
        const l = lines[i];
        if (v4aSectionHeader(l) !== null) break;
        if (isBlank(l)) {
          i++;
          continue;
        }
        throw new ParseFault(i + 1);
      }
      edits.push({ format: "v4a", paths: [header.path], kind: "delete", steps: [], json: null });
      continue;
    }

    // Update File section: an optional `*** Move to: PATH` first line,
    // then chunks. A chunk starts at a line starting with `@@` (the text
    // after `@@`, its surrounding spaces removed, is the anchor; an empty
    // text is no anchor) or, for the first chunk, at a body line. A line
    // reading `*** End of File` ends a chunk and anchors it to the end of
    // the file. Blank lines at the end of a chunk (immediately before the
    // next chunk header, an End of File line, or the end of the section)
    // are not part of the chunk.
    const updateLineNo = i + 1;
    i++;
    let moveTo: string | null = null;
    if (i < endIdx && lines[i].startsWith("*** Move to: ")) {
      moveTo = lines[i].slice("*** Move to: ".length).trim();
      i++;
    }
    const steps: EditStep[] = [];
    let cur: V4aChunk | null = null;
    const finishChunk = (endOfFile: boolean): void => {
      if (cur === null) return;
      while (cur.body.length > 0 && cur.body[cur.body.length - 1].rawBlank) cur.body.pop();
      steps.push(v4aChunkToStep(cur, endOfFile));
      cur = null;
    };
    while (i < endIdx) {
      const l = lines[i];
      if (v4aSectionHeader(l) !== null) break;
      if (l.trimEnd() === "*** End of File") {
        if (cur === null) throw new ParseFault(i + 1);
        finishChunk(true);
        i++;
        continue;
      }
      if (l.startsWith("@@")) {
        finishChunk(false);
        const anchorText = l.slice(2).trim();
        cur = { anchor: anchorText === "" ? null : anchorText, body: [] };
        i++;
        continue;
      }
      const bl = v4aBodyLine(l);
      if (bl === null) throw new ParseFault(i + 1);
      if (cur === null) cur = { anchor: null, body: [] };
      cur.body.push(bl);
      i++;
    }
    finishChunk(false);
    if (steps.length === 0 && moveTo === null) throw new ParseFault(updateLineNo);
    edits.push({
      format: "v4a",
      paths: moveTo === null ? [header.path] : [header.path, moveTo],
      kind: moveTo === null ? "change" : "move",
      steps,
      json: null,
    });
  }
  return edits;
}

function parsePatch(format: FormatName, lines: string[], patchText: string): NormalizedEdit[] {
  switch (format) {
    case "unified":
      return parseUnifiedPatch(lines);
    case "search-replace":
      return parseSearchReplacePatch(lines);
    case "v4a":
      return parseV4aPatch(lines);
    case "json":
      return parseJsonPatch(lines, patchText);
  }
}

interface EditFailure {
  code: string;
  path: string;
}

function editFail(code: string, path: string): EditFailure {
  return { code, path };
}

function applyCreate(edit: NormalizedEdit, tree: Map<string, FileState>): EditFailure | null {
  const newPath = edit.paths[0];
  if (tree.has(newPath)) return editFail("exists", newPath);
  if (edit.format === "json" && edit.json !== null) {
    tree.set(newPath, splitFileLines(edit.json.fileText ?? ""));
    return null;
  }
  const lines: string[] = [];
  for (const step of edit.steps) {
    step.newLines.forEach((line, j) => {
      if (step.newContextOldIndex[j] === null) lines.push(line);
    });
  }
  let endsWithBreak: boolean;
  if (lines.length === 0) {
    endsWithBreak = false;
  } else if (edit.format === "unified") {
    let noBreak = false;
    for (let i = edit.steps.length - 1; i >= 0; i--) {
      const step = edit.steps[i];
      if (step.newLines.some((_, j) => step.newContextOldIndex[j] === null)) {
        noBreak = step.trailingNoBreak;
        break;
      }
    }
    endsWithBreak = !noBreak;
  } else {
    endsWithBreak = true;
  }
  tree.set(newPath, { lines, eol: "\n", endsWithBreak, raw: null });
  return null;
}

function applyDelete(edit: NormalizedEdit, tree: Map<string, FileState>): EditFailure | null {
  const editPath = edit.paths[0];
  if (!tree.has(editPath)) return editFail("missing", editPath);
  tree.delete(editPath);
  return null;
}

interface StepResult {
  failure: EditFailure | null;
  lines: string[];
  endsWithBreak: boolean;
}

function applyUnifiedStep(
  step: EditStep,
  fileLines: string[],
  endsWithBreak: boolean,
  d: number,
  maxTier: number,
  filePath: string,
  mode: "unified" | "search-replace",
): StepResult {
  const failRes = (code: string): StepResult => ({ failure: editFail(code, filePath), lines: fileLines, endsWithBreak });
  if (step.oldLines.length === 0) {
    // Unified only (a SEARCH/REPLACE block with empty old lines is a create).
    let pos = (step.targetLine ?? 0) + d;
    if (pos < 0) pos = 0;
    if (pos > fileLines.length) pos = fileLines.length;
    const atEnd = pos === fileLines.length;
    const out = [...fileLines];
    out.splice(pos, 0, ...step.newLines);
    return { failure: null, lines: out, endsWithBreak: atEnd ? !step.trailingNoBreak : endsWithBreak };
  }
  const match = findMatchesUpTo(step.oldLines, fileLines, maxTier);
  if (match === null) return failRes("no-match");
  let pos: number;
  if (mode === "search-replace") {
    if (match.positions.length > 1) return failRes("ambiguous");
    pos = match.positions[0];
  } else {
    const targetPos = (step.targetLine ?? 1) - 1 + d;
    pos = nearestPosition(match.positions, targetPos);
  }
  const atEnd = pos + step.oldLines.length === fileLines.length;
  const built = buildNewLines(step, fileLines, pos, match.tier);
  const out = [...fileLines];
  out.splice(pos, step.oldLines.length, ...built);
  const nextBreak = mode === "unified" && atEnd ? !step.trailingNoBreak : endsWithBreak;
  return { failure: null, lines: out, endsWithBreak: nextBreak };
}

function applyV4aSteps(
  edit: NormalizedEdit,
  fileLines: string[],
  maxTier: number,
  filePath: string,
): { failure: EditFailure | null; lines: string[] } {
  let lines = [...fileLines];
  let cursor = 0;
  for (const step of edit.steps) {
    if (step.anchor !== null) {
      const idx = findAnchor(step.anchor, lines, cursor, maxTier);
      if (idx === null) return { failure: editFail("no-match", filePath), lines };
      cursor = idx + 1;
    }
    if (step.oldLines.length === 0) {
      const pos = step.endOfFile ? lines.length : cursor;
      const out = [...lines];
      out.splice(pos, 0, ...step.newLines);
      lines = out;
      cursor = pos + step.newLines.length;
      continue;
    }
    const match = findMatchesFrom(step.oldLines, lines, cursor, maxTier);
    if (match === null) return { failure: editFail("no-match", filePath), lines };
    let positions = match.positions;
    if (step.endOfFile) {
      positions = positions.filter((p) => p + step.oldLines.length === lines.length);
      if (positions.length === 0) return { failure: editFail("no-match", filePath), lines };
    }
    const pos = positions[0];
    const built = buildNewLines(step, lines, pos, match.tier);
    const out = [...lines];
    out.splice(pos, step.oldLines.length, ...built);
    lines = out;
    cursor = pos + built.length;
  }
  return { failure: null, lines };
}

function applyChange(
  edit: NormalizedEdit,
  tree: Map<string, FileState>,
  maxTier: number,
  isMove: boolean,
): EditFailure | null {
  const oldPath = edit.paths[0];
  const newPath = isMove ? edit.paths[1] : oldPath;
  const state = tree.get(oldPath);
  if (state === undefined) return editFail("missing", oldPath);
  if (isMove && tree.has(newPath)) return editFail("exists", newPath);
  let lines = [...state.lines];
  let endsWithBreak = state.endsWithBreak;
  if (edit.format === "v4a") {
    const res = applyV4aSteps(edit, lines, maxTier, oldPath);
    if (res.failure !== null) return res.failure;
    lines = res.lines;
  } else {
    const mode = edit.format === "search-replace" ? "search-replace" : "unified";
    let d = 0;
    for (const step of edit.steps) {
      const res = applyUnifiedStep(step, lines, endsWithBreak, d, maxTier, oldPath, mode);
      if (res.failure !== null) return res.failure;
      lines = res.lines;
      endsWithBreak = res.endsWithBreak;
      d += step.newLines.length - step.oldLines.length;
    }
  }
  if (isMove) {
    tree.delete(oldPath);
    tree.set(newPath, { lines, eol: state.eol, endsWithBreak, raw: null });
  } else {
    setFileLines(state, lines);
    state.endsWithBreak = endsWithBreak;
  }
  return null;
}

function applyJsonStrReplace(edit: NormalizedEdit, tree: Map<string, FileState>): EditFailure | null {
  const editPath = edit.paths[0];
  const state = tree.get(editPath);
  if (state === undefined) return editFail("missing", editPath);
  const j = edit.json as JsonData;
  const isCrlf = state.eol === "\r\n";
  let hay = fullText(state);
  let needle = j.oldStr as string;
  let replacement = j.newStr ?? "";
  if (isCrlf) {
    hay = hay.replace(/\r\n/g, "\n");
    needle = needle.replace(/\r\n/g, "\n");
    replacement = replacement.replace(/\r\n/g, "\n");
  }
  let count = 0;
  let firstIdx = -1;
  let idx = 0;
  while (true) {
    const i = hay.indexOf(needle, idx);
    if (i < 0) break;
    if (firstIdx < 0) firstIdx = i;
    count++;
    idx = i + 1;
  }
  if (count === 0) return editFail("no-match", editPath);
  if (count > 1) return editFail("ambiguous", editPath);
  let result = hay.slice(0, firstIdx) + replacement + hay.slice(firstIdx + needle.length);
  if (isCrlf) result = result.replace(/\n/g, "\r\n");
  setFileText(state, result);
  return null;
}

function applyJsonInsert(edit: NormalizedEdit, tree: Map<string, FileState>): EditFailure | null {
  const editPath = edit.paths[0];
  const state = tree.get(editPath);
  if (state === undefined) return editFail("missing", editPath);
  const j = edit.json as JsonData;
  const line = j.insertLine as number;
  if (line < 0 || line > state.lines.length) return editFail("no-match", editPath);
  const newLines = splitPatchLines(j.newStr ?? "");
  const lines = [...state.lines];
  lines.splice(line, 0, ...newLines);
  setFileLines(state, lines);
  return null;
}

function applyEdit(edit: NormalizedEdit, tree: Map<string, FileState>, strict: boolean): EditFailure | null {
  // Safety of every path it names first, old path first, then new path.
  for (const p of edit.paths) {
    if (!isSafePath(p)) return editFail("unsafe", p);
  }
  const maxTier = strict ? 0 : 2;
  switch (edit.kind) {
    case "create":
      return applyCreate(edit, tree);
    case "delete":
      return applyDelete(edit, tree);
    case "change":
      return applyChange(edit, tree, maxTier, false);
    case "move":
      return applyChange(edit, tree, maxTier, true);
    case "insert":
      return applyJsonInsert(edit, tree);
    case "str-replace":
      return applyJsonStrReplace(edit, tree);
  }
}

interface MoveRecord {
  oldPath: string;
  newPath: string;
}

function computeChanges(
  original: Map<string, string>,
  tree: Map<string, FileState>,
  moves: MoveRecord[],
): string[] {
  const deleted = new Set<string>();
  const added = new Set<string>();
  const modified = new Set<string>();
  for (const [p, text] of original) {
    const cur = tree.get(p);
    if (cur === undefined) deleted.add(p);
    else if (fullText(cur) !== text) modified.add(p);
  }
  for (const p of tree.keys()) {
    if (!original.has(p)) added.add(p);
  }
  const rLines: MoveRecord[] = [];
  for (const m of moves) {
    if (deleted.has(m.oldPath) && added.has(m.newPath)) {
      deleted.delete(m.oldPath);
      added.delete(m.newPath);
      rLines.push(m);
    }
  }
  const entries: { sortKey: string; line: string }[] = [];
  for (const p of deleted) entries.push({ sortKey: p, line: `D ${p}` });
  for (const p of added) entries.push({ sortKey: p, line: `A ${p}` });
  for (const p of modified) entries.push({ sortKey: p, line: `M ${p}` });
  for (const m of rLines) entries.push({ sortKey: m.newPath, line: `R ${m.oldPath} -> ${m.newPath}` });
  entries.sort((a, b) => compareUtf8(a.sortKey, b.sortKey));
  return entries.map((e) => e.line);
}

function writeChanges(original: Map<string, string>, tree: Map<string, FileState>): void {
  const root = process.cwd();
  for (const [p, state] of tree) {
    const text = fullText(state);
    if (original.get(p) === text) continue;
    const full = path.join(root, p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text, "utf8");
  }
  for (const p of original.keys()) {
    if (!tree.has(p)) {
      try {
        fs.unlinkSync(path.join(root, p));
      } catch {
        // Already gone; nothing to do.
      }
    }
  }
}

function runCli(argv: string[]): void {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      outLines.push("error: usage");
      setExitCode(2);
      return;
    }
    throw e;
  }
  let patchText: string;
  try {
    patchText = readPatch(args.patch);
  } catch (e) {
    if (e instanceof NoPatchError) {
      outLines.push("error: no-patch");
      setExitCode(2);
      return;
    }
    throw e;
  }
  const patchLines = splitPatchLines(patchText);
  let format: FormatName;
  if (args.format === "auto") {
    const detected = detectFormat(patchLines);
    if (detected === null) {
      outLines.push("error: format");
      setExitCode(2);
      return;
    }
    format = detected;
  } else {
    format = args.format as FormatName;
  }
  let edits: NormalizedEdit[];
  try {
    edits = parsePatch(format, patchLines, patchText);
  } catch (e) {
    if (e instanceof ParseFault) {
      outLines.push(`error: parse ${e.line}`);
      setExitCode(2);
      return;
    }
    throw e;
  }
  if (edits.length === 0) {
    outLines.push("error: parse 1");
    setExitCode(2);
    return;
  }
  const root = process.cwd();
  const tree = loadTree(root);
  const original = new Map<string, string>();
  for (const [p, state] of tree) original.set(p, fullText(state));
  const failures: EditFailure[] = [];
  const moves: MoveRecord[] = [];
  for (const edit of edits) {
    const failure = applyEdit(edit, tree, args.strict);
    if (failure !== null) {
      failures.push(failure);
    } else if (edit.kind === "move") {
      moves.push({ oldPath: edit.paths[0], newPath: edit.paths[1] });
    }
  }
  if (failures.length > 0) {
    for (const f of failures) outLines.push(`error: ${f.code} ${f.path}`);
    outLines.push(`failed: ${failures.length} of ${edits.length} edits`);
    setExitCode(1);
    return;
  }
  const changes = computeChanges(original, tree, moves);
  if (!args.check) writeChanges(original, tree);
  for (const c of changes) outLines.push(c);
  outLines.push(changes.length === 1 ? "ok: 1 file" : `ok: ${changes.length} files`);
  setExitCode(0);
}

async function main(): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl !== undefined && envUrl !== "") {
    const runner = await import("./runner.ts");
    await runner.runTrial(envUrl);
    return;
  }
  runCli(process.argv.slice(2));
  if (outLines.length > 0) {
    fs.writeSync(1, outLines.join("\n") + "\n");
  }
  process.exitCode = exitCode;
}

main();

// mend: one patch tool for every AI edit format (SPEC.md version 1).
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers, and writes every change or none. Node 22, standard
// library only. Run as: node main.ts [--format=NAME] [--check] [--strict]
// [PATCH]
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 outcome: the single line it prints. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed from each, and the
 * empty piece after a final \n dropped. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

/** A file as lines: its line break, its lines, and whether it ends with one. */
interface FileModel {
  lines: string[];
  br: string;
  ends: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { lines: parts, br, ends };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.ends ? m.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted),
 * the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** A move edit that succeeded, for the `R old -> new` output line. */
const moves: { old: string; fresh: string }[] = [];

type Edit = (tree: Tree) => void;

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every 0-based position where O occurs in lines at one tier. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once (tier 0 only with
 * --strict), with every occurrence at that tier. */
function findTier(
  lines: string[],
  o: string[],
  strict: boolean,
  from = 0,
  eofOnly = false,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t).filter(
      (i) => i >= from && (!eofOnly || i + o.length === lines.length),
    );
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line) or
 * a new line. oIdx is the line's index in O when it is a context line. */
interface NewLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/** The lines N writes: context lines as the file's own matched lines; at
 * tier 2 every other non-blank line re-indented from O's first line to the
 * file's first matched line; at tiers 0 and 1 as they are. */
function buildNew(
  fileLines: string[],
  pos: number,
  o: string[],
  n: NewLine[],
  tier: number,
): string[] {
  const out: string[] = [];
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadWs(fileLines[pos] ?? '');
    p = leadWs(o[0]!);
  }
  for (const nl of n) {
    if (nl.ctx) {
      out.push(fileLines[pos + nl.oIdx]!);
      continue;
    }
    const t = nl.text;
    if (tier === 2 && t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(p)) out.push(f + t.slice(p.length));
    else out.push(t);
  }
  return out;
}

/** Split a hunk/chunk body into its old lines O and its new lines N, and say
 * whether a `\` line follows the body's last context or `+` line (and,
 * separately, its last `+` line, which is what a creation looks at). */
function splitBody(
  body: { kind: 'ctx' | 'old' | 'new' | 'bs'; text: string }[],
): { o: string[]; n: NewLine[]; bsAfterLast: boolean; bsAfterLastPlus: boolean } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      const idx = o.length;
      o.push(b.text);
      n.push({ text: b.text, ctx: true, oIdx: idx });
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      n.push({ text: b.text, ctx: false, oIdx: -1 });
    }
  }
  let last = -1;
  let lastPlus = -1;
  for (let i = body.length - 1; i >= 0; i--) {
    if (last < 0 && (body[i]!.kind === 'ctx' || body[i]!.kind === 'new')) last = i;
    if (lastPlus < 0 && body[i]!.kind === 'new') lastPlus = i;
    if (last >= 0 && lastPlus >= 0) break;
  }
  const bsAfterLast = last >= 0 && body[last + 1]?.kind === 'bs';
  const bsAfterLastPlus = lastPlus >= 0 && body[lastPlus + 1]?.kind === 'bs';
  return { o, n, bsAfterLast, bsAfterLastPlus };
}

/** Detect the patch's format (SPEC.md section 4), or null when none holds. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unified diffs (section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  /** The hunk header's old start A (1-based). */
  a: number;
  body: { kind: 'ctx' | 'old' | 'new' | 'bs'; text: string }[];
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

/** The path after `--- `/`+++ `: text after the four characters, up to the
 * first tab, with surrounding spaces removed; /dev/null means no file. */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

/** A `diff --git a/<X> b/<Y>` line's paths, or null when not of that form. */
function diffGitPaths(line: string): { old: string; fresh: string } | null {
  const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
  if (m === null) return null;
  return { old: m[1]!, fresh: m[2]! };
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  // Paths named by the header, kept apart so rename lines only count when
  // no ---/+++ pair names a path.
  let pairOld: string | null | undefined;
  let pairNew: string | null | undefined;
  let renameOld: string | undefined;
  let renameNew: string | undefined;
  let diffOld: string | undefined;
  let diffNew: string | undefined;

  const finishSection = (): void => {
    if (cur === null) return;
    cur.oldPath = pairOld !== undefined ? pairOld : renameOld !== undefined ? renameOld : diffOld !== undefined ? diffOld : null;
    cur.newPath = pairNew !== undefined ? pairNew : renameNew !== undefined ? renameNew : diffNew !== undefined ? diffNew : null;
    sections.push(cur);
  };
  const startSection = (): void => {
    finishSection();
    cur = { oldPath: null, newPath: null, create: false, remove: false, hunks: [] };
    pairOld = undefined;
    pairNew = undefined;
    renameOld = undefined;
    renameNew = undefined;
    diffOld = undefined;
    diffNew = undefined;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^diff --git($| )/.test(line)) {
      const paths = diffGitPaths(line);
      if (paths === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection();
      diffOld = paths.old;
      diffNew = paths.fresh;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hunks.length > 0) startSection();
      pairOld = headerPath(line);
      pairNew = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: Hunk['body'] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '') body.push({ kind: 'ctx', text: '' });
        else if (l[0] === ' ') body.push({ kind: 'ctx', text: l.slice(1) });
        else if (l[0] === '-') body.push({ kind: 'old', text: l.slice(1) });
        else if (l[0] === '+') body.push({ kind: 'new', text: l.slice(1) });
        else if (l[0] === '\\') body.push({ kind: 'bs', text: l.slice(1) });
        else break;
        j += 1;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') {
        body.pop();
      }
      cur.hunks.push({ a: Number(m[1]), body });
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.create = true;
      else if (line.startsWith('deleted file mode')) cur.remove = true;
    }
    i += 1;
  }
  finishSection();
  return sections;
}

/** Apply a section's hunks in order to a file model (section 6). */
function applyHunks(model: FileModel, hunks: Hunk[], strict: boolean, path: string): FileModel {
  let lines = [...model.lines];
  let ends = model.ends;
  let d = 0;
  for (const h of hunks) {
    const { o, n, bsAfterLast } = splitBody(h.body);
    if (o.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), lines.length);
      const atEnd = at === lines.length;
      lines.splice(at, 0, ...n.map((x) => x.text));
      if (atEnd) ends = !bsAfterLast;
      d += n.length;
      continue;
    }
    const found = findTier(lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.occ[0]!;
    let best = Math.abs(pos - target);
    for (const q of found.occ) {
      const dist = Math.abs(q - target);
      if (dist < best) {
        best = dist;
        pos = q;
      }
    }
    const atEnd = pos + o.length === lines.length;
    const repl = buildNew(lines, pos, o, n, found.tier);
    lines.splice(pos, o.length, ...repl);
    if (atEnd) ends = !bsAfterLast;
    d += n.length - o.length;
  }
  return { lines, br: model.br, ends };
}

/** One unified section's edit. */
function unifiedEdit(sec: UniSection, strict: boolean): Edit {
  const oldPath = sec.oldPath;
  const newPath = sec.newPath;
  const isCreate = oldPath === null || sec.create;
  const isDelete = !isCreate && (newPath === null || sec.remove);
  const isMove = !isCreate && !isDelete && oldPath !== null && newPath !== null && oldPath !== newPath;
  const path = isCreate ? newPath : oldPath;
  return (tree) => {
    if (isCreate) {
      if (newPath === null || !safe(newPath)) throw new Fail('unsafe', newPath ?? '');
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const plus: string[] = [];
      let lastBs = false;
      for (const h of sec.hunks) {
        const { n, bsAfterLastPlus } = splitBody(h.body);
        if (n.some((x) => !x.ctx)) lastBs = bsAfterLastPlus;
        for (const x of n) {
          if (!x.ctx) plus.push(x.text);
        }
      }
      tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (lastBs ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (oldPath === null || !safe(oldPath)) throw new Fail('unsafe', oldPath ?? '');
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (isMove) {
      const o = oldPath!;
      const nw = newPath!;
      if (!safe(o)) throw new Fail('unsafe', o);
      if (!safe(nw)) throw new Fail('unsafe', nw);
      const before = tree.get(o);
      if (before === null) throw new Fail('missing', o);
      if (tree.get(nw) !== null) throw new Fail('exists', nw);
      const model = applyHunks(splitFile(before), sec.hunks, strict, o);
      tree.now.set(o, null);
      tree.now.set(nw, joinFile(model));
      moves.push({ old: o, fresh: nw });
      return;
    }
    // A change of the one path.
    const p = oldPath!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const model = applyHunks(splitFile(before), sec.hunks, strict, p);
    tree.now.set(p, joinFile(model));
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (section 7)
// ---------------------------------------------------------------------------

const SR_SEARCH = '<<<<<<< SEARCH';
const SR_SEP = '=======';
const SR_END = '>>>>>>> REPLACE';

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1; // index of the previous block's REPLACE line
  let prevPath: string | undefined;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== SR_SEARCH) {
      i += 1;
      continue;
    }
    const searchAt = i;
    // The path: the nearest line before SEARCH, after the previous block's
    // REPLACE line, that is not blank and does not start with three
    // backticks; else the previous block's path.
    let path: string | undefined;
    for (let k = searchAt - 1; k > prevEnd; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trimStart().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === undefined) path = prevPath;
    if (path === undefined) throw new Exit2(`error: parse ${searchAt + 1}`);
    // Old lines up to =======, then new lines up to >>>>>>> REPLACE. A
    // >>>>>>> REPLACE before any ======= is a parse fault at the SEARCH line;
    // any other line (even another SEARCH line) is just a line of the block.
    let j = searchAt + 1;
    const oldLines: string[] = [];
    let sep = -1;
    while (j < lines.length) {
      const l = lines[j]!;
      if (l.trimEnd() === SR_SEP) {
        sep = j;
        break;
      }
      if (l.trimEnd() === SR_END) break;
      oldLines.push(l);
      j += 1;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchAt + 1}`);
    const newLines: string[] = [];
    j = sep + 1;
    let end = -1;
    while (j < lines.length) {
      const l = lines[j]!;
      if (l.trimEnd() === SR_END) {
        end = j;
        break;
      }
      newLines.push(l);
      j += 1;
    }
    if (end < 0) throw new Exit2(`error: parse ${searchAt + 1}`);
    prevEnd = end;
    prevPath = path;
    const p = path;
    const oldLs = oldLines;
    const newLs = newLines;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLs.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLs.length === 0 ? '' : newLs.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const model = splitFile(before);
      const found = findTier(model.lines, oldLs, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const pos = found.occ[0]!;
      const n: NewLine[] = newLs.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
      const repl = buildNew(model.lines, pos, oldLs, n, found.tier);
      const lines2 = [...model.lines];
      lines2.splice(pos, oldLs.length, ...repl);
      tree.now.set(p, joinFile({ lines: lines2, br: model.br, ends: model.ends }));
    });
    i = end + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  body: { kind: 'ctx' | 'old' | 'new'; text: string }[];
  eof: boolean;
}

type V4aSection =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: V4aChunk[] };

function v4aSectionPath(line: string, prefix: string): string {
  return line.slice(prefix.length).trim();
}

/** A line that starts a V4A section (the prefixes carry their space). */
function isV4aSectionStart(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}

function parseV4a(lines: string[]): V4aSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ')) {
      const path = v4aSectionPath(line, '*** Add File: ');
      const raw: string[] = [];
      let j = i + 1;
      while (j < last) {
        const l = lines[j]!;
        if (isV4aSectionStart(l)) break;
        if (l === '') raw.push('');
        else if (l[0] === '+') raw.push(l.slice(1));
        else throw new Exit2(`error: parse ${j + 1}`);
        j += 1;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      sections.push({ kind: 'add', path, lines: raw });
      i = j;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = v4aSectionPath(line, '*** Delete File: ');
      let j = i + 1;
      while (j < last) {
        const l = lines[j]!;
        if (isV4aSectionStart(l)) break;
        if (blank(l)) {
          j += 1;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      sections.push({ kind: 'delete', path });
      i = j;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = v4aSectionPath(line, '*** Update File: ');
      const updateAt = i;
      // The section's raw lines: up to the next section or *** End Patch.
      // Blank lines at the end of the section are not part of it.
      const raw: string[] = [];
      let j = i + 1;
      while (j < last) {
        const l = lines[j]!;
        if (isV4aSectionStart(l)) break;
        raw.push(l);
        j += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      let moveTo: string | null = null;
      let k = 0;
      if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
        moveTo = v4aSectionPath(raw[0]!, '*** Move to: ');
        k = 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      const closeChunk = (): void => {
        if (cur === null) return;
        chunks.push(cur);
        cur = null;
      };
      for (; k < raw.length; k++) {
        const l = raw[k]!;
        const at = i + 1 + k;
        if (l === '*** End of File') {
          if (cur === null) cur = { anchor: null, body: [], eof: true };
          else cur.eof = true;
          closeChunk();
          continue;
        }
        if (l.startsWith('@@')) {
          closeChunk();
          cur = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), body: [], eof: false };
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) cur = { anchor: null, body: [], eof: false };
          if (l === '') cur.body.push({ kind: 'ctx', text: '' });
          else if (l[0] === ' ') cur.body.push({ kind: 'ctx', text: l.slice(1) });
          else if (l[0] === '-') cur.body.push({ kind: 'old', text: l.slice(1) });
          else cur.body.push({ kind: 'new', text: l.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${at + 1}`);
      }
      closeChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateAt + 1}`);
      sections.push({ kind: 'update', path, moveTo, chunks });
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections;
}

/** Apply one V4A chunk to a file model, moving the cursor past what it wrote. */
function applyV4aChunk(
  model: FileModel,
  chunk: V4aChunk,
  cursor: number,
  strict: boolean,
  path: string,
): { model: FileModel; cursor: number } {
  let lines = [...model.lines];
  let cur = cursor;
  if (chunk.anchor !== null) {
    const anchor = chunk.anchor;
    let foundAt = -1;
    for (const t of strict ? [0] : [0, 1, 2]) {
      for (let k = cur; k < lines.length; k++) {
        if (lineEq(lines[k]!, anchor, t)) {
          foundAt = k;
          break;
        }
      }
      if (foundAt >= 0) break;
    }
    if (foundAt < 0) throw new Fail('no-match', path);
    cur = foundAt + 1;
  }
  const body = chunk.body.map((b) => ({ kind: b.kind, text: b.text }));
  const { o, n } = splitBody(body as { kind: 'ctx' | 'old' | 'new' | 'bs'; text: string }[]);
  if (o.length === 0) {
    const at = chunk.eof ? lines.length : cur;
    lines.splice(at, 0, ...n.map((x) => x.text));
    return { model: { lines, br: model.br, ends: model.ends }, cursor: at + n.length };
  }
  const found = findTier(lines, o, strict, cur, chunk.eof);
  if (found === null) throw new Fail('no-match', path);
  const pos = found.occ[0]!;
  const repl = buildNew(lines, pos, o, n, found.tier);
  lines.splice(pos, o.length, ...repl);
  return { model: { lines, br: model.br, ends: model.ends }, cursor: pos + repl.length };
}

function v4aEdit(sec: V4aSection, strict: boolean): Edit {
  if (sec.kind === 'add') {
    const p = sec.path;
    const ls = sec.lines;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, ls.length === 0 ? '' : ls.join('\n') + '\n');
    };
  }
  if (sec.kind === 'delete') {
    const p = sec.path;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  const p = sec.path;
  const moveTo = sec.moveTo;
  const chunks = sec.chunks;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let model = splitFile(before);
    let cursor = 0;
    for (const chunk of chunks) {
      const r = applyV4aChunk(model, chunk, cursor, strict, p);
      model = r.model;
      cursor = r.cursor;
    }
    const text = joinFile(model);
    if (moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(moveTo, text);
      moves.push({ old: p, fresh: moveTo });
    } else {
      tree.now.set(p, text);
    }
  };
}

// ---------------------------------------------------------------------------
// JSON edits (section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object (section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const existing = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = existing(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = existing(tree);
      const model = splitFile(before);
      if (line < 0 || line > model.lines.length) throw new Fail('no-match', p);
      const lines = [...model.lines];
      lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile({ lines, br: model.br, ends: model.ends }));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Running it (sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function parseEdits(kind: string, text: string, lines: string[], strict: boolean): Edit[] {
  if (kind === 'json') return jsonEdits(text, lines);
  if (kind === 'search-replace') return parseSearchReplace(lines, strict);
  if (kind === 'v4a') return parseV4a(lines).map((s) => v4aEdit(s, strict));
  return parseUnified(lines).map((s) => unifiedEdit(s, strict));
}

function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = parseEdits(kind, text, lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  // The rows: A/D/M by path, R by its new path, in byte order of the paths.
  const covered = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const m of moves) {
    const was = tree.original(m.old);
    const isNow = tree.get(m.fresh);
    const wasOldNow = tree.get(m.old);
    if (was !== null && isNow !== null && wasOldNow === null && tree.original(m.fresh) === null) {
      if (!covered.has(m.old) && !covered.has(m.fresh)) {
        covered.add(m.old);
        covered.add(m.fresh);
        rows.push({ key: m.fresh, text: `R ${m.old} -> ${m.fresh}` });
      }
    }
  }
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  const out = [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteOrder)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

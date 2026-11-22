// mend: one patch tool for every AI edit format.
// Node 22 standard library only. See SPEC.md for the contract.

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

class ParseErr extends Error {
  n: number;
  constructor(n: number) {
    super(`parse ${n}`);
    this.n = n;
  }
}

interface FileState {
  lines: string[];
  brk: string;
  ends: boolean;
}

type Tree = Map<string, FileState | null>;

interface Fail {
  code: string;
  path: string;
}

interface EditOutcome {
  fail?: Fail;
  move?: { old: string; nw: string };
}

function out(line: string): void {
  process.stdout.write(line + '\n');
}

// ---------- text / file model ----------

function patchLines(text: string): string[] {
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function parseFileText(text: string): FileState {
  if (text === '') return { lines: [], brk: '\n', ends: false };
  const idx = text.indexOf('\n');
  const brk = idx > 0 && text[idx - 1] === '\r' ? '\r\n' : '\n';
  const ends = text.endsWith(brk);
  const body = ends ? text.slice(0, -brk.length) : text;
  return { lines: body.split(brk), brk, ends };
}

function serialize(fs: FileState): string {
  if (fs.lines.length === 0) return '';
  return fs.lines.join(fs.brk) + (fs.ends ? fs.brk : '');
}

function isSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  for (const s of p.split('/')) {
    if (s === '' || s === '.' || s === '..') return false;
  }
  return true;
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function loadTree(): Map<string, string> {
  const orig = new Map<string, string>();
  const root = process.cwd();
  const walk = (dir: string, prefix: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      const rel = prefix === '' ? name : prefix + '/' + name;
      if (st.isDirectory()) walk(full, rel);
      else if (st.isFile()) {
        try {
          orig.set(rel, readFileSync(full, 'utf8'));
        } catch {
          // unreadable file: leave it out of the model
        }
      }
    }
  };
  walk(root, '');
  return orig;
}

function treeFromOrig(orig: Map<string, string>): Tree {
  const t: Tree = new Map();
  for (const [p, text] of orig) t.set(p, parseFileText(text));
  return t;
}

function cloneTree(t: Tree): Tree {
  const c: Tree = new Map();
  for (const [p, st] of t) {
    c.set(p, st === null ? null : { lines: [...st.lines], brk: st.brk, ends: st.ends });
  }
  return c;
}

function treeExists(t: Tree, p: string): boolean {
  const st = t.get(p);
  return st !== undefined && st !== null;
}

function treeGet(t: Tree, p: string): FileState | null {
  const st = t.get(p);
  return st === undefined ? null : st;
}

// ---------- matching (section 5) ----------

function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function findOcc(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const last = lines.length - o.length;
  for (let i = from; i <= last; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j], tier) !== normLine(o[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(
  lines: string[],
  o: string[],
  strict: boolean,
  from: number,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = findOcc(lines, o, tier, from);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

function leadingOf(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function reindent(line: string, p: string, f: string): string {
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  if (!line.startsWith(p)) return line;
  return f + line.slice(p.length);
}

interface NEntry {
  ctx: boolean;
  oIdx: number;
  text: string;
}

function buildN(entries: NEntry[], fileLines: string[], pos: number, tier: number, o: string[]): string[] {
  const out: string[] = [];
  const p = o.length > 0 ? leadingOf(o[0]) : '';
  const f = pos < fileLines.length ? leadingOf(fileLines[pos]) : '';
  for (const e of entries) {
    if (e.ctx) out.push(fileLines[pos + e.oIdx]);
    else out.push(tier === 2 ? reindent(e.text, p, f) : e.text);
  }
  return out;
}

function countOcc(hay: string, needle: string): number {
  let c = 0;
  let i = 0;
  for (;;) {
    const p = hay.indexOf(needle, i);
    if (p === -1) break;
    c++;
    i = p + 1;
  }
  return c;
}

function replaceOnce(hay: string, needle: string, repl: string): string {
  const p = hay.indexOf(needle);
  return hay.slice(0, p) + repl + hay.slice(p + needle.length);
}

// ---------- unified diffs (section 6) ----------

interface Hunk {
  a: number;
  body: string[];
}

interface UnifiedSection {
  diffOld: string | null;
  diffNew: string | null;
  hdrOld: string | null;
  hdrNew: string | null;
  renFrom: string | null;
  renTo: string | null;
  newFileMode: boolean;
  delFileMode: boolean;
  hunks: Hunk[];
}

interface UnifiedEdit {
  kind: 'unified';
  uKind: 'create' | 'delete' | 'move' | 'change';
  path: string;
  newPath: string | null;
  hunks: Hunk[];
}

const DIFF_RE = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function headerPath(line: string): string {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab !== -1) t = t.slice(0, tab);
  t = t.trim();
  if (t.startsWith('a/')) t = t.slice(2);
  else if (t.startsWith('b/')) t = t.slice(2);
  return t;
}

function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = HUNK_RE.exec(lines[i]);
  if (!m) throw new ParseErr(i + 1);
  const a = parseInt(m[1], 10);
  const body: string[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j];
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && j + 1 < lines.length && lines[j + 1].startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      j++;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return { hunk: { a, body }, next: j };
}

function parseUnifiedHeader(lines: string[], start: number, s: UnifiedSection): number {
  let i = start;
  let headerPair = false;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('@@')) {
      const r = parseHunk(lines, i);
      s.hunks.push(r.hunk);
      i = r.next;
      continue;
    }
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ')) {
      if (i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
        if (!headerPair && s.hunks.length === 0) {
          s.hdrOld = headerPath(line);
          s.hdrNew = headerPath(lines[i + 1]);
          headerPair = true;
          i += 2;
          continue;
        }
        break;
      }
      if (s.hunks.length === 0) throw new ParseErr(i + 2);
      i++;
      continue;
    }
    if (s.hunks.length === 0) {
      if (line.startsWith('rename from ')) s.renFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) s.renTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) s.newFileMode = true;
      else if (line.startsWith('deleted file mode')) s.delFileMode = true;
    }
    i++;
  }
  return i;
}

function parseUnified(lines: string[]): UnifiedEdit[] {
  const sections: UnifiedSection[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(line);
      if (!m) throw new ParseErr(i + 1);
      const s: UnifiedSection = {
        diffOld: m[1],
        diffNew: m[2],
        hdrOld: null,
        hdrNew: null,
        renFrom: null,
        renTo: null,
        newFileMode: false,
        delFileMode: false,
        hunks: [],
      };
      sections.push(s);
      i = parseUnifiedHeader(lines, i + 1, s);
    } else if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      const s: UnifiedSection = {
        diffOld: null,
        diffNew: null,
        hdrOld: null,
        hdrNew: null,
        renFrom: null,
        renTo: null,
        newFileMode: false,
        delFileMode: false,
        hunks: [],
      };
      sections.push(s);
      i = parseUnifiedHeader(lines, i, s);
    } else if (line.startsWith('@@')) {
      throw new ParseErr(i + 1);
    } else {
      i++;
    }
  }
  if (sections.length === 0) throw new ParseErr(1);
  const edits: UnifiedEdit[] = [];
  for (const s of sections) {
    let oldP = s.hdrOld ?? s.renFrom ?? s.diffOld;
    let newP = s.hdrNew ?? s.renTo ?? s.diffNew;
    if (oldP === '/dev/null') oldP = null;
    if (newP === '/dev/null') newP = null;
    const isCreate = s.newFileMode || oldP === null;
    const isDelete = s.delFileMode || newP === null;
    if (isCreate) {
      edits.push({ kind: 'unified', uKind: 'create', path: newP ?? '', newPath: null, hunks: s.hunks });
    } else if (isDelete) {
      edits.push({ kind: 'unified', uKind: 'delete', path: oldP ?? '', newPath: null, hunks: s.hunks });
    } else if (oldP !== null && newP !== null && oldP !== newP) {
      edits.push({ kind: 'unified', uKind: 'move', path: oldP, newPath: newP, hunks: s.hunks });
    } else {
      edits.push({ kind: 'unified', uKind: 'change', path: (oldP ?? newP) ?? '', newPath: null, hunks: s.hunks });
    }
  }
  return edits;
}

function backslashAfterLastCtxPlus(body: string[]): boolean {
  let idx = -1;
  for (let k = 0; k < body.length; k++) {
    const l = body[k];
    if (l === '' || l[0] === ' ' || l[0] === '+') idx = k;
  }
  if (idx === -1) return false;
  return idx + 1 < body.length && body[idx + 1][0] === '\\';
}

function backslashAfterLastPlus(hunks: Hunk[]): boolean {
  for (let h = hunks.length - 1; h >= 0; h--) {
    const body = hunks[h].body;
    for (let k = body.length - 1; k >= 0; k--) {
      if (body[k][0] === '+') {
        return k + 1 < body.length && body[k + 1][0] === '\\';
      }
    }
  }
  return false;
}

function splitHunkBody(body: string[]): { o: string[]; entries: NEntry[] } {
  const o: string[] = [];
  const entries: NEntry[] = [];
  for (const l of body) {
    if (l === '' || l[0] === ' ') {
      o.push(l.slice(1));
      entries.push({ ctx: true, oIdx: o.length - 1, text: '' });
    } else if (l[0] === '-') {
      o.push(l.slice(1));
    } else if (l[0] === '+') {
      entries.push({ ctx: false, oIdx: -1, text: l.slice(1) });
    }
  }
  return { o, entries };
}

// Applies one hunk to work (mutated). Returns the length delta, or a failure.
function applyHunk(work: FileState, hunk: Hunk, d: number, strict: boolean, failPath: string): { delta: number; fail?: Fail } {
  const { o, entries } = splitHunkBody(hunk.body);
  if (o.length === 0) {
    const pos = Math.min(hunk.a + d, work.lines.length);
    const atEnd = pos === work.lines.length;
    const nl = buildN(entries, work.lines, pos, 0, o);
    work.lines.splice(pos, 0, ...nl);
    if (atEnd && nl.length > 0 && backslashAfterLastCtxPlus(hunk.body)) work.ends = false;
    else if (atEnd && nl.length > 0) work.ends = true;
    return { delta: nl.length };
  }
  const found = findTier(work.lines, o, strict, 0);
  if (!found) return { delta: 0, fail: { code: 'no-match', path: failPath } };
  const target = hunk.a - 1 + d;
  let best = found.occ[0];
  let bestDist = Math.abs(best - target);
  for (const p of found.occ) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const pos = best;
  const nl = buildN(entries, work.lines, pos, found.tier, o);
  const toEnd = pos + o.length === work.lines.length;
  work.lines.splice(pos, o.length, ...nl);
  if (toEnd) work.ends = !backslashAfterLastCtxPlus(hunk.body);
  return { delta: nl.length - o.length };
}

function applyUnified(e: UnifiedEdit, tree: Tree, strict: boolean): EditOutcome {
  if (e.uKind === 'create') {
    if (!isSafe(e.path)) return { fail: { code: 'unsafe', path: e.path } };
    if (treeExists(tree, e.path)) return { fail: { code: 'exists', path: e.path } };
    const plus: string[] = [];
    for (const h of e.hunks) {
      for (const l of h.body) if (l[0] === '+') plus.push(l.slice(1));
    }
    const noBreak = backslashAfterLastPlus(e.hunks);
    tree.set(e.path, { lines: plus, brk: '\n', ends: plus.length > 0 && !noBreak });
    return {};
  }
  if (e.uKind === 'delete') {
    if (!isSafe(e.path)) return { fail: { code: 'unsafe', path: e.path } };
    if (!treeExists(tree, e.path)) return { fail: { code: 'missing', path: e.path } };
    tree.set(e.path, null);
    return {};
  }
  // move or change
  if (!isSafe(e.path)) return { fail: { code: 'unsafe', path: e.path } };
  if (e.uKind === 'move' && e.newPath !== null && !isSafe(e.newPath)) {
    return { fail: { code: 'unsafe', path: e.newPath } };
  }
  if (!treeExists(tree, e.path)) return { fail: { code: 'missing', path: e.path } };
  if (e.uKind === 'move' && e.newPath !== null && treeExists(tree, e.newPath)) {
    return { fail: { code: 'exists', path: e.newPath } };
  }
  const st = treeGet(tree, e.path);
  if (st === null) return { fail: { code: 'missing', path: e.path } };
  const work: FileState = { lines: [...st.lines], brk: st.brk, ends: st.ends };
  let d = 0;
  for (const h of e.hunks) {
    const r = applyHunk(work, h, d, strict, e.path);
    if (r.fail) return { fail: r.fail };
    d += r.delta;
  }
  if (e.uKind === 'move' && e.newPath !== null) {
    tree.set(e.newPath, work);
    tree.set(e.path, null);
    return { move: { old: e.path, nw: e.newPath } };
  }
  tree.set(e.path, work);
  return {};
}

// ---------- SEARCH/REPLACE (section 7) ----------

interface SREdit {
  kind: 'search-replace';
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSR(lines: string[]): SREdit[] {
  const edits: SREdit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() === '<<<<<<< SEARCH') {
      const searchIdx = i;
      let eq = -1;
      let rep = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trimEnd();
        if (eq === -1 && t === '=======') {
          eq = j;
          continue;
        }
        if (eq !== -1 && t === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (eq === -1 || rep === -1) throw new ParseErr(searchIdx + 1);
      let path: string | null = null;
      for (let j = i - 1; j > prevReplaceEnd; j--) {
        const t = lines[j].trim();
        if (t === '' || t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new ParseErr(searchIdx + 1);
        path = prevPath;
      }
      edits.push({ kind: 'search-replace', path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
      prevPath = path;
      prevReplaceEnd = rep;
      i = rep + 1;
    } else {
      i++;
    }
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

function applySR(e: SREdit, tree: Tree, strict: boolean): EditOutcome {
  if (!isSafe(e.path)) return { fail: { code: 'unsafe', path: e.path } };
  if (e.oldLines.length === 0) {
    if (treeExists(tree, e.path)) return { fail: { code: 'exists', path: e.path } };
    tree.set(e.path, { lines: [...e.newLines], brk: '\n', ends: e.newLines.length > 0 });
    return {};
  }
  if (!treeExists(tree, e.path)) return { fail: { code: 'missing', path: e.path } };
  const st = treeGet(tree, e.path);
  if (st === null) return { fail: { code: 'missing', path: e.path } };
  const found = findTier(st.lines, e.oldLines, strict, 0);
  if (!found) return { fail: { code: 'no-match', path: e.path } };
  if (found.occ.length > 1) return { fail: { code: 'ambiguous', path: e.path } };
  const pos = found.occ[0];
  const entries: NEntry[] = e.newLines.map((t) => ({ ctx: false, oIdx: -1, text: t }));
  const nl = buildN(entries, st.lines, pos, found.tier, e.oldLines);
  const work: FileState = { lines: [...st.lines], brk: st.brk, ends: st.ends };
  work.lines.splice(pos, e.oldLines.length, ...nl);
  tree.set(e.path, work);
  return {};
}

// ---------- V4A (section 8) ----------

interface VChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

interface VEdit {
  kind: 'v4a';
  vKind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: VChunk[];
}

function isSectionStart(line: string): boolean {
  return line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');
}

function parseV4A(lines: string[]): VEdit[] {
  let first = -1;
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].trim() !== '') {
      first = k;
      break;
    }
  }
  if (first === -1) throw new ParseErr(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseErr(first + 1);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (lines[k].trim() !== '') {
      last = k;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new ParseErr(lines.length + 1);
  const edits: VEdit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const entries: { t: string; blank: boolean }[] = [];
      let j = i + 1;
      while (j < last) {
        const l = lines[j];
        if (isSectionStart(l)) break;
        if (l.trim() === '') {
          entries.push({ t: '', blank: true });
          j++;
          continue;
        }
        if (l[0] === '+') {
          entries.push({ t: l.slice(1), blank: false });
          j++;
          continue;
        }
        throw new ParseErr(j + 1);
      }
      while (entries.length > 0 && entries[entries.length - 1].blank) entries.pop();
      edits.push({ kind: 'v4a', vKind: 'add', path, moveTo: null, addLines: entries.map((e) => e.t), chunks: [] });
      i = j;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      let j = i + 1;
      while (j < last) {
        const l = lines[j];
        if (isSectionStart(l)) break;
        if (l.trim() === '') {
          j++;
          continue;
        }
        throw new ParseErr(j + 1);
      }
      edits.push({ kind: 'v4a', vKind: 'delete', path, moveTo: null, addLines: [], chunks: [] });
      i = j;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      let moveTo: string | null = null;
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let j = i + 1;
      while (j < last) {
        const l = lines[j];
        if (isSectionStart(l)) break;
        if (l.startsWith('*** Move to: ') && cur === null && chunks.length === 0 && moveTo === null) {
          moveTo = l.slice('*** Move to: '.length).trim();
          j++;
          continue;
        }
        if (l.startsWith('@@')) {
          cur = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), body: [], eof: false };
          chunks.push(cur);
          j++;
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) throw new ParseErr(j + 1);
          cur.eof = true;
          cur = null;
          j++;
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new ParseErr(j + 1);
            cur = { anchor: null, body: [], eof: false };
            chunks.push(cur);
          }
          cur.body.push(l);
          j++;
          continue;
        }
        throw new ParseErr(j + 1);
      }
      if (chunks.length > 0) {
        const b = chunks[chunks.length - 1].body;
        if (!chunks[chunks.length - 1].eof) {
          while (b.length > 0 && b[b.length - 1].trim() === '') b.pop();
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseErr(i + 1);
      edits.push({ kind: 'v4a', vKind: 'update', path, moveTo, addLines: [], chunks });
      i = j;
      continue;
    }
    throw new ParseErr(i + 1);
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

function applyV4A(e: VEdit, tree: Tree, strict: boolean): EditOutcome {
  if (!isSafe(e.path)) return { fail: { code: 'unsafe', path: e.path } };
  if (e.vKind === 'add') {
    if (treeExists(tree, e.path)) return { fail: { code: 'exists', path: e.path } };
    tree.set(e.path, { lines: [...e.addLines], brk: '\n', ends: e.addLines.length > 0 });
    return {};
  }
  if (e.vKind === 'delete') {
    if (!treeExists(tree, e.path)) return { fail: { code: 'missing', path: e.path } };
    tree.set(e.path, null);
    return {};
  }
  // update
  if (e.moveTo !== null && !isSafe(e.moveTo)) return { fail: { code: 'unsafe', path: e.moveTo } };
  if (!treeExists(tree, e.path)) return { fail: { code: 'missing', path: e.path } };
  if (e.moveTo !== null && treeExists(tree, e.moveTo)) return { fail: { code: 'exists', path: e.moveTo } };
  const st = treeGet(tree, e.path);
  if (st === null) return { fail: { code: 'missing', path: e.path } };
  const work: FileState = { lines: [...st.lines], brk: st.brk, ends: st.ends };
  let cursor = 0;
  for (const ch of e.chunks) {
    if (ch.anchor !== null) {
      const found = findTier(work.lines, [ch.anchor], strict, cursor);
      if (!found) return { fail: { code: 'no-match', path: e.path } };
      cursor = found.occ[0] + 1;
    }
    const { o, entries } = splitHunkBody(ch.body);
    if (o.length === 0) {
      const pos = ch.eof ? work.lines.length : cursor;
      const nl = buildN(entries, work.lines, pos, 0, o);
      work.lines.splice(pos, 0, ...nl);
      cursor = pos + nl.length;
    } else {
      const found = findTier(work.lines, o, strict, cursor);
      if (!found) return { fail: { code: 'no-match', path: e.path } };
      let pos: number | null = null;
      for (const p of found.occ) {
        if (ch.eof && p + o.length !== work.lines.length) continue;
        pos = p;
        break;
      }
      if (pos === null) return { fail: { code: 'no-match', path: e.path } };
      const nl = buildN(entries, work.lines, pos, found.tier, o);
      work.lines.splice(pos, o.length, ...nl);
      cursor = pos + nl.length;
    }
  }
  if (e.moveTo !== null) {
    tree.set(e.moveTo, work);
    tree.set(e.path, null);
    return { move: { old: e.path, nw: e.moveTo } };
  }
  tree.set(e.path, work);
  return {};
}

// ---------- JSON (section 9) ----------

interface JEdit {
  kind: 'json';
  jCmd: 'create' | 'str_replace' | 'insert';
  path: string;
  fileText: string;
  oldStr: string;
  newStr: string;
  insertLine: number;
}

function validateJsonEdit(el: unknown, lineNo: number): JEdit {
  if (typeof el !== 'object' || el === null || Array.isArray(el)) throw new ParseErr(lineNo);
  const o = el as Record<string, unknown>;
  if (typeof o.path !== 'string' || typeof o.command !== 'string') throw new ParseErr(lineNo);
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') throw new ParseErr(lineNo);
    return { kind: 'json', jCmd: 'create', path: o.path, fileText: o.file_text, oldStr: '', newStr: '', insertLine: 0 };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') throw new ParseErr(lineNo);
    if (o.new_str !== undefined && typeof o.new_str !== 'string') throw new ParseErr(lineNo);
    return {
      kind: 'json',
      jCmd: 'str_replace',
      path: o.path,
      fileText: '',
      oldStr: o.old_str,
      newStr: typeof o.new_str === 'string' ? o.new_str : '',
      insertLine: 0,
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) throw new ParseErr(lineNo);
    if (typeof o.new_str !== 'string') throw new ParseErr(lineNo);
    return { kind: 'json', jCmd: 'insert', path: o.path, fileText: '', oldStr: '', newStr: o.new_str, insertLine: o.insert_line };
  }
  throw new ParseErr(lineNo);
}

function parseJSON(patchText: string, lines: string[]): JEdit[] {
  let idx = 0;
  while (idx < patchText.length && /\s/.test(patchText[idx])) idx++;
  if (idx >= patchText.length) throw new ParseErr(1);
  const startLine = patchText.slice(0, idx).split('\n').length;
  if (patchText[idx] === '[') {
    let arr: unknown;
    try {
      arr = JSON.parse(patchText);
    } catch {
      throw new ParseErr(startLine);
    }
    if (!Array.isArray(arr)) throw new ParseErr(startLine);
    const edits: JEdit[] = [];
    for (const el of arr) edits.push(validateJsonEdit(el, startLine));
    if (edits.length === 0) throw new ParseErr(1);
    return edits;
  }
  const edits: JEdit[] = [];
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k];
    if (l.trim() === '') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(l);
    } catch {
      throw new ParseErr(k + 1);
    }
    edits.push(validateJsonEdit(obj, k + 1));
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

function applyJSON(e: JEdit, tree: Tree): EditOutcome {
  if (!isSafe(e.path)) return { fail: { code: 'unsafe', path: e.path } };
  if (e.jCmd === 'create') {
    if (treeExists(tree, e.path)) return { fail: { code: 'exists', path: e.path } };
    tree.set(e.path, parseFileText(e.fileText));
    return {};
  }
  if (!treeExists(tree, e.path)) return { fail: { code: 'missing', path: e.path } };
  const st = treeGet(tree, e.path);
  if (st === null) return { fail: { code: 'missing', path: e.path } };
  if (e.jCmd === 'str_replace') {
    const text = serialize(st);
    let result: string;
    if (st.brk === '\r\n') {
      const t = text.split('\r\n').join('\n');
      const oldN = e.oldStr.split('\r\n').join('\n');
      const newN = e.newStr.split('\r\n').join('\n');
      const cnt = countOcc(t, oldN);
      if (cnt === 0) return { fail: { code: 'no-match', path: e.path } };
      if (cnt > 1) return { fail: { code: 'ambiguous', path: e.path } };
      result = replaceOnce(t, oldN, newN).split('\n').join('\r\n');
    } else {
      const cnt = countOcc(text, e.oldStr);
      if (cnt === 0) return { fail: { code: 'no-match', path: e.path } };
      if (cnt > 1) return { fail: { code: 'ambiguous', path: e.path } };
      result = replaceOnce(text, e.oldStr, e.newStr);
    }
    tree.set(e.path, parseFileText(result));
    return {};
  }
  // insert
  if (e.insertLine < 0 || e.insertLine > st.lines.length) {
    return { fail: { code: 'no-match', path: e.path } };
  }
  const newLines = e.newStr === '' ? [] : patchLines(e.newStr);
  const work: FileState = { lines: [...st.lines], brk: st.brk, ends: st.ends };
  work.lines.splice(e.insertLine, 0, ...newLines);
  tree.set(e.path, work);
  return {};
}

// ---------- CLI (sections 1, 2, 4, 10) ----------

type AnyEdit = UnifiedEdit | SREdit | VEdit | JEdit;

interface CliArgs {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

function parseArgs(argv: string[]): CliArgs | null {
  let format = 'auto';
  let check = false;
  let strict = false;
  let formatSeen = false;
  let checkSeen = false;
  let strictSeen = false;
  const positionals: string[] = [];
  let endOpts = false;
  for (const a of argv) {
    if (!endOpts && a === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (checkSeen) return null;
        checkSeen = true;
        check = true;
      } else if (a === '--strict') {
        if (strictSeen) return null;
        strictSeen = true;
        strict = true;
      } else if (a.startsWith('--format=')) {
        if (formatSeen) return null;
        formatSeen = true;
        const v = a.slice('--format='.length);
        if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') return null;
        format = v;
      } else {
        return null;
      }
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length > 1) return null;
  return { format, check, strict, patch: positionals.length > 0 ? positionals[0] : null };
}

function detectFormat(lines: string[]): string | null {
  let firstNonBlank: string | undefined;
  for (const l of lines) {
    if (l.trim() !== '') {
      firstNonBlank = l;
      break;
    }
  }
  if (firstNonBlank !== undefined && firstNonBlank.trim() === '*** Begin Patch') return 'v4a';
  if (firstNonBlank !== undefined) {
    const c = firstNonBlank.trimStart()[0];
    if (c === '[' || c === '{') return 'json';
  }
  for (const l of lines) {
    if (l.trimEnd() === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].startsWith('diff --git ')) return 'unified';
    if (lines[k].startsWith('--- ') && k + 1 < lines.length && lines[k + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

function applyEdit(e: AnyEdit, tree: Tree, strict: boolean): EditOutcome {
  if (e.kind === 'unified') return applyUnified(e, tree, strict);
  if (e.kind === 'search-replace') return applySR(e, tree, strict);
  if (e.kind === 'v4a') return applyV4A(e, tree, strict);
  return applyJSON(e, tree);
}

async function runCli(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    out('error: usage');
    return 2;
  }
  let patchText: string;
  if (args.patch === null || args.patch === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(args.patch, 'utf8');
    } catch {
      out('error: no-patch');
      return 2;
    }
  }
  const lines = patchLines(patchText);
  let format = args.format;
  if (format === 'auto') {
    const d = detectFormat(lines);
    if (d === null) {
      out('error: format');
      return 2;
    }
    format = d;
  }
  let edits: AnyEdit[];
  try {
    if (format === 'unified') edits = parseUnified(lines);
    else if (format === 'search-replace') edits = parseSR(lines);
    else if (format === 'v4a') edits = parseV4A(lines);
    else edits = parseJSON(patchText, lines);
  } catch (e) {
    if (e instanceof ParseErr) {
      out(`error: parse ${e.n}`);
      return 2;
    }
    throw e;
  }

  const orig = loadTree();
  let tree = treeFromOrig(orig);
  const failures: Fail[] = [];
  const moves: { old: string; nw: string }[] = [];
  for (const e of edits) {
    const clone = cloneTree(tree);
    const res = applyEdit(e, clone, args.strict);
    if (res.fail) failures.push(res.fail);
    else {
      tree = clone;
      if (res.move) moves.push(res.move);
    }
  }
  if (failures.length > 0) {
    for (const f of failures) out(`error: ${f.code} ${f.path}`);
    out(`failed: ${failures.length} of ${edits.length} edits`);
    return 1;
  }

  // Compute the change list from original vs final tree.
  interface ChangeLine {
    key: string;
    text: string;
  }
  const changeLines: ChangeLine[] = [];
  const allPaths = new Set<string>([...orig.keys(), ...tree.keys()]);
  for (const p of allPaths) {
    const o = orig.get(p);
    const st = tree.get(p);
    const nt = st === null || st === undefined ? null : serialize(st);
    if (o === undefined && nt !== null) changeLines.push({ key: p, text: `A ${p}` });
    else if (o !== undefined && nt === null) changeLines.push({ key: p, text: `D ${p}` });
    else if (o !== undefined && nt !== null && o !== nt) changeLines.push({ key: p, text: `M ${p}` });
  }
  for (const m of moves) {
    const oldFinal = tree.get(m.old);
    const newFinal = tree.get(m.nw);
    if (
      orig.has(m.old) &&
      (oldFinal === null || oldFinal === undefined) &&
      !orig.has(m.nw) &&
      newFinal !== null &&
      newFinal !== undefined
    ) {
      const di = changeLines.findIndex((c) => c.key === m.old && c.text.startsWith('D '));
      const ai = changeLines.findIndex((c) => c.key === m.nw && c.text.startsWith('A '));
      if (di !== -1 && ai !== -1) {
        changeLines.splice(Math.max(di, ai), 1);
        changeLines.splice(Math.min(di, ai), 1);
        changeLines.push({ key: m.nw, text: `R ${m.old} -> ${m.nw}` });
      }
    }
  }
  changeLines.sort((a, b) => byteCompare(a.key, b.key));

  if (!args.check) {
    for (const p of allPaths) {
      const o = orig.get(p);
      const st = tree.get(p);
      const nt = st === null || st === undefined ? null : serialize(st);
      const full = join(process.cwd(), ...p.split('/'));
      if (o === undefined && nt !== null) {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, nt, 'utf8');
      } else if (o !== undefined && nt === null) {
        rmSync(full, { force: true });
      } else if (o !== undefined && nt !== null && o !== nt) {
        writeFileSync(full, nt, 'utf8');
      }
    }
  }

  for (const c of changeLines) out(c.text);
  const n = changeLines.length;
  out(n === 1 ? 'ok: 1 file' : `ok: ${n} files`);
  return 0;
}

// ---------- hand-over (trial) ----------

if (process.env.MAKEFUN_ENV_URL) {
  const { runTrial } = await import('./runner.ts');
  await runTrial(process.env.MAKEFUN_ENV_URL);
} else {
  process.exitCode = await runCli();
}

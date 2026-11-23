// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
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

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
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
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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

/* ---------- section 3: a file as lines ---------- */

interface Split {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): Split {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/* ---------- section 5: matching lines at three tiers ---------- */

const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

interface Match {
  tier: number;
  at: number[];
}

/** Occurrences of O in fileLines at the first tier with any, at positions >= from (and, when eofOnly, ending at the last line). */
function findMatch(fileLines: string[], o: string[], strict: boolean, from = 0, eofOnly = false): Match | null {
  if (o.length === 0) return null;
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const at: number[] = [];
    const oKeys = o.map((l) => tierKey(l, tier));
    for (let i = from; i + o.length <= fileLines.length; i++) {
      if (eofOnly && i + o.length !== fileLines.length) continue;
      let ok = true;
      for (let j = 0; j < o.length; j++) {
        if (tierKey(fileLines[i + j]!, tier) !== oKeys[j]) {
          ok = false;
          break;
        }
      }
      if (ok) at.push(i);
    }
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** One line of N: a context line (oIdx into O) is written as the file's own matched line; any other line is verbatim, re-indented at tier 2. */
interface NItem {
  text: string;
  oIdx: number | null;
}

function buildReplacement(fileLines: string[], pos: number, o: string[], items: NItem[], tier: number): string[] {
  const f = leadWs(fileLines[pos]!);
  const p = leadWs(o[0]!);
  const region = items.map((it) => {
    if (it.oIdx !== null) return fileLines[pos + it.oIdx]!;
    if (tier === 2 && it.text.trim() !== '' && it.text.startsWith(p)) return f + it.text.slice(p.length);
    return it.text;
  });
  return [...fileLines.slice(0, pos), ...region, ...fileLines.slice(pos + o.length)];
}

/** O and N of a body whose lines are ' ' (context), '-' (old) and '+' (new); noBreak: a '\' line follows the last context or '+' line. */
function bodyON(items: { kind: string; text: string }[]): { o: string[]; n: NItem[]; noBreak: boolean | null } {
  const o: string[] = [];
  const n: NItem[] = [];
  let lastN = -1;
  items.forEach((it, k) => {
    if (it.kind === ' ') {
      const oi = o.length;
      o.push(it.text);
      n.push({ text: it.text, oIdx: oi });
      lastN = k;
    } else if (it.kind === '-') o.push(it.text);
    else if (it.kind === '+') {
      n.push({ text: it.text, oIdx: null });
      lastN = k;
    }
  });
  return { o, n, noBreak: lastN < 0 ? null : items[lastN + 1]?.kind === '\\' };
}

/* ---------- section 6: unified diffs ---------- */

interface UHunk {
  a: number;
  items: { kind: string; text: string }[];
}

interface USection {
  gitOld?: string;
  gitNew?: string;
  pairOld?: string | null;
  pairNew?: string | null;
  pairSeen: boolean;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

function diffPath(raw: string): string | null {
  let p = raw.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function unifiedEdit(s: USection, strict: boolean): Edit {
  const oldPath = s.pairSeen ? s.pairOld : s.renameFrom !== undefined ? s.renameFrom : s.gitOld;
  const newPath = s.pairSeen ? s.pairNew : s.renameTo !== undefined ? s.renameTo : s.gitNew;
  const isCreate = oldPath === null || s.newFile;
  const isDelete = !isCreate && (newPath === null || s.delFile);
  return (tree) => {
    if (isCreate) {
      const p = newPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const all = s.hunks.flatMap((h) => h.items);
      const plus = all.filter((it) => it.kind === '+').map((it) => it.text);
      let lastPlus = -1;
      all.forEach((it, k) => {
        if (it.kind === '+') lastPlus = k;
      });
      const noBreak = lastPlus >= 0 && all[lastPlus + 1]?.kind === '\\';
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const src = oldPath!;
    const dst = newPath!;
    if (!safe(src)) throw new Fail('unsafe', src);
    if (dst !== src && !safe(dst)) throw new Fail('unsafe', dst);
    const before = tree.get(src);
    if (before === null) throw new Fail('missing', src);
    if (dst !== src && tree.get(dst) !== null) throw new Fail('exists', dst);
    const sp = splitFile(before);
    let fl = sp.lines;
    let final = sp.final;
    let d = 0;
    for (const h of s.hunks) {
      const { o, n, noBreak } = bodyON(h.items);
      if (o.length === 0) {
        const pos = Math.min(h.a + d, fl.length);
        const ins = n.map((it) => it.text);
        if (pos === fl.length && ins.length > 0) final = noBreak !== true;
        fl = [...fl.slice(0, pos), ...ins, ...fl.slice(pos)];
        d += n.length;
      } else {
        const found = findMatch(fl, o, strict);
        if (found === null) throw new Fail('no-match', src);
        const target = h.a - 1 + d;
        let pos = found.at[0]!;
        let best = Math.abs(pos - target);
        for (const cand of found.at) {
          const dd = Math.abs(cand - target);
          if (dd < best) {
            best = dd;
            pos = cand;
          }
        }
        const toEnd = pos + o.length === fl.length;
        fl = buildReplacement(fl, pos, o, n, found.tier);
        if (toEnd) final = noBreak !== true;
        d += n.length - o.length;
      }
    }
    const text = joinFile(fl, sp.br, final);
    if (dst !== src) {
      tree.now.set(src, null);
      tree.now.set(dst, text);
      tree.moves.push([src, dst]);
    } else tree.now.set(src, text);
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  const fresh = (): USection => ({ pairSeen: false, newFile: false, delFile: false, hunks: [] });
  let cur: USection | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      sections.push(cur);
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (next.startsWith('+++ ')) {
        if (cur === null || cur.hunks.length > 0 || cur.pairSeen) {
          cur = fresh();
          sections.push(cur);
        }
        cur.pairOld = diffPath(line);
        cur.pairNew = diffPath(next);
        cur.pairSeen = true;
        i += 2;
        continue;
      }
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const raw: { kind: string; text: string; empty: boolean }[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '') {
          raw.push({ kind: ' ', text: '', empty: true });
          j++;
          continue;
        }
        const c = l[0]!;
        if (c === ' ' || c === '-' || c === '+' || c === '\\') {
          raw.push({ kind: c, text: l.slice(1), empty: false });
          j++;
          continue;
        }
        break;
      }
      let end = raw.length;
      while (end > 0 && raw[end - 1]!.empty) end--;
      cur.hunks.push({ a: parseInt(m[1]!, 10), items: raw.slice(0, end) });
      i = i + 1 + end;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length);
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

/* ---------- section 7: SEARCH/REPLACE blocks ---------- */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let lastEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    let path: string | null = null;
    for (let j = i - 1; j >= lastEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${i + 1}`);
    let sep = -1;
    for (let k = i + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        sep = k;
        break;
      }
    }
    if (sep < 0) throw new Exit2(`error: parse ${i + 1}`);
    let end = -1;
    for (let k = sep + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${i + 1}`);
    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const sp = splitFile(before);
      const found = findMatch(sp.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.at.length > 1) throw new Fail('ambiguous', p);
      const items: NItem[] = newLines.map((t) => ({ text: t, oIdx: null }));
      tree.now.set(p, joinFile(buildReplacement(sp.lines, found.at[0]!, oldLines, items, found.tier), sp.br, sp.final));
    });
    prevPath = p;
    lastEnd = end + 1;
    i = end + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ---------- section 8: V4A patches ---------- */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: { kind: string; text: string }[];
}

interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  headLine: number;
  addLines?: string[];
  moveTo?: string;
  chunks?: VChunk[];
}

function v4aEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    const p = s.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (s.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const ls = s.addLines!;
      tree.now.set(p, ls.length === 0 ? '' : ls.join('\n') + '\n');
      return;
    }
    if (s.kind === 'del') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const dst = s.moveTo;
    if (dst !== undefined && !safe(dst)) throw new Fail('unsafe', dst);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (dst !== undefined && tree.get(dst) !== null) throw new Fail('exists', dst);
    const sp = splitFile(before);
    let fl = sp.lines;
    let cursor = 0;
    for (const ch of s.chunks!) {
      if (ch.anchor !== null) {
        let foundAt = -1;
        for (const tier of strict ? [0] : [0, 1, 2]) {
          const key = tierKey(ch.anchor, tier);
          for (let k = cursor; k < fl.length; k++) {
            if (tierKey(fl[k]!, tier) === key) {
              foundAt = k;
              break;
            }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new Fail('no-match', p);
        cursor = foundAt + 1;
      }
      const { o, n } = bodyON(ch.items);
      if (o.length === 0) {
        const pos = ch.eof ? fl.length : Math.min(cursor, fl.length);
        const ins = n.map((it) => it.text);
        fl = [...fl.slice(0, pos), ...ins, ...fl.slice(pos)];
        cursor = pos + ins.length;
      } else {
        const found = findMatch(fl, o, strict, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', p);
        const pos = found.at[0]!;
        fl = buildReplacement(fl, pos, o, n, found.tier);
        cursor = pos + n.length;
      }
    }
    const text = joinFile(fl, sp.br, sp.final);
    if (dst !== undefined) {
      tree.now.set(p, null);
      tree.now.set(dst, text);
      tree.moves.push([p, dst]);
    } else tree.now.set(p, text);
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const fb = lines.findIndex((l) => !blank(l));
  if (fb < 0) throw new Exit2('error: parse 1');
  if (lines[fb]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${fb + 1}`);
  let lb = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      lb = k;
      break;
    }
  }
  if (lines[lb]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const startKind = (l: string): 'add' | 'del' | 'upd' | null =>
    l.startsWith('*** Add File:') ? 'add' : l.startsWith('*** Delete File:') ? 'del' : l.startsWith('*** Update File:') ? 'upd' : null;
  const sections: VSection[] = [];
  let i = fb + 1;
  while (i < lb) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const kind = startKind(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const headLine = i + 1;
    const path = line.slice(line.indexOf(':') + 1).trim();
    let j = i + 1;
    while (j < lb && startKind(lines[j]!) === null) j++;
    let be = j;
    while (be > i + 1 && blank(lines[be - 1]!)) be--;
    const body: { line: string; no: number }[] = [];
    for (let k = i + 1; k < be; k++) body.push({ line: lines[k]!, no: k + 1 });
    if (kind === 'add') {
      const content: string[] = [];
      for (const b of body) {
        if (b.line.startsWith('+')) content.push(b.line.slice(1));
        else if (b.line === '') content.push('');
        else throw new Exit2(`error: parse ${b.no}`);
      }
      sections.push({ kind, path, headLine, addLines: content });
    } else if (kind === 'del') {
      for (const b of body) {
        if (!blank(b.line)) throw new Exit2(`error: parse ${b.no}`);
      }
      sections.push({ kind, path, headLine });
    } else {
      let moveTo: string | undefined;
      let bi = 0;
      while (bi < body.length && blank(body[bi]!.line)) bi++;
      if (bi < body.length && body[bi]!.line.startsWith('*** Move to:')) {
        moveTo = body[bi]!.line.slice('*** Move to:'.length).trim();
        bi++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (; bi < body.length; bi++) {
        const b = body[bi]!;
        const l = b.line;
        if (l.startsWith('@@')) {
          cur = { anchor: l.slice(2).trim() || null, eof: false, items: [] };
          chunks.push(cur);
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${b.no}`);
          cur.eof = true;
          cur = null;
          continue;
        }
        if (l === '') {
          if (cur !== null) cur.items.push({ kind: ' ', text: '' });
          continue;
        }
        const c = l[0]!;
        if (c === ' ' || c === '-' || c === '+') {
          if (cur === null) {
            cur = { anchor: null, eof: false, items: [] };
            chunks.push(cur);
          }
          cur.items.push({ kind: c, text: l.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${b.no}`);
      }
      if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${headLine}`);
      sections.push({ kind, path, headLine, moveTo, chunks });
    }
    i = j;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aEdit(s, strict));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const finalOf = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const rByNew = new Map<string, string>();
  for (const [o, n] of tree.moves) {
    if (!rByNew.has(n) && tree.original(o) !== null && finalOf(o) === null && tree.original(n) === null && finalOf(n) !== null) rByNew.set(n, o);
  }
  const rOlds = new Set(rByNew.values());
  const rows: { key: string; text: string }[] = [];
  for (const [n, o] of rByNew) rows.push({ key: n, text: `R ${o} -> ${n}` });
  for (const p of tree.now.keys()) {
    if (rByNew.has(p) || rOlds.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  if (!check) {
    for (const p of tree.now.keys()) {
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
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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

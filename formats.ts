import { blank, Exit2, Fail, safe } from './main.ts';
import type { Edit, Tree } from './main.ts';

type Body = { kind: 'context' | 'old' | 'new'; text: string }[];
type Hunk = { a: number; body: Body; noFinal: boolean };
type Piece = { text: string; source: number | null };

const lead = (s: string): string => s.match(/^[ \t]*/)?.[0] ?? '';
const normalize = (s: string, tier: number): string =>
  tier === 0 ? s : tier === 1 ? s.replace(/[ \t]+$/, '') : s.replace(/^[ \t]+|[ \t]+$/g, '');

function occurrences(lines: string[], old: string[], strict: boolean, from = 0): { tier: number; at: number[] } {
  for (let tier = 0; tier <= (strict ? 0 : 2); tier += 1) {
    const at: number[] = [];
    for (let i = Math.max(0, from); i + old.length <= lines.length; i += 1) {
      if (old.every((line, k) => normalize(lines[i + k]!, tier) === normalize(line, tier))) at.push(i);
    }
    if (at.length > 0) return { tier, at };
  }
  return { tier: 0, at: [] };
}

function pieces(body: Body): { old: string[]; next: Piece[] } {
  const old: string[] = [];
  const next: Piece[] = [];
  for (const row of body) {
    if (row.kind === 'context') {
      next.push({ text: row.text, source: old.length });
      old.push(row.text);
    } else if (row.kind === 'old') old.push(row.text);
    else next.push({ text: row.text, source: null });
  }
  return { old, next };
}

function replace(lines: string[], at: number, old: string[], next: Piece[], tier: number): string[] {
  const out = next.map((p) => p.source === null ? p.text : lines[at + p.source]!);
  if (tier === 2 && old.length > 0) {
    const f = lead(lines[at]!);
    const p = lead(old[0]!);
    for (let i = 0; i < out.length; i += 1) {
      if (next[i]!.source === null && next[i]!.text.trim() !== '' && next[i]!.text.startsWith(p)) {
        out[i] = f + next[i]!.text.slice(p.length);
      }
    }
  }
  return [...lines.slice(0, at), ...out, ...lines.slice(at + old.length)];
}

function fileLines(text: string): { lines: string[]; br: string; final: boolean } {
  const n = text.indexOf('\n');
  const br = n > 0 && text[n - 1] === '\r' ? '\r\n' : '\n';
  const final = text !== '' && text.endsWith(br);
  const lines = text === '' ? [] : text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

const fileText = (lines: string[], br: string, final: boolean): string =>
  lines.length === 0 ? '' : lines.join(br) + (final ? br : '');

function hunkParts(body: Body): { old: string[]; next: Piece[] } {
  return pieces(body);
}

function applyHunks(text: string, hunks: Hunk[], strict: boolean): string {
  const f = fileLines(text);
  let lines = f.lines;
  let final = f.final;
  let delta = 0;
  for (const h of hunks) {
    const { old, next } = hunkParts(h.body);
    let at: number;
    if (old.length === 0) {
      at = Math.min(h.a + delta, lines.length);
    } else {
      const found = occurrences(lines, old, strict);
      if (found.at.length === 0) throw new Fail('no-match', '');
      const target = h.a - 1 + delta;
      at = found.at.reduce((best, x) =>
        Math.abs(x - target) < Math.abs(best - target) || (Math.abs(x - target) === Math.abs(best - target) && x < best) ? x : best,
      found.at[0]!);
      lines = replace(lines, at, old, next, found.tier);
    }
    if (old.length === 0) lines = replace(lines, at, old, next, 0);
    const ends = at + old.length === (lines.length - next.length + old.length);
    if (ends) final = !h.noFinal;
    delta += next.length - old.length;
  }
  return fileText(lines, f.br, final);
}

type Section = {
  line: number;
  diffOld: string | null;
  diffNew: string | null;
  oldPath: string | null;
  newPath: string | null;
  hasPair: boolean;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
};

const parsePath = (line: string): string => {
  const p = line.slice(4).split('\t')[0]!.trim();
  return p === '/dev/null' ? p : p.replace(/^[ab]\//, '');
};

function unifiedSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = { line: i + 1, diffOld: m[1]!, diffNew: m[2]!, oldPath: null, newPath: null, hasPair: false, create: false, remove: false, hunks: [] };
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (!cur || cur.hasPair || cur.hunks.length > 0) {
          cur = { line: i + 1, diffOld: null, diffNew: null, oldPath: null, newPath: null, hasPair: false, create: false, remove: false, hunks: [] };
          sections.push(cur);
        }
        cur.oldPath = parsePath(line);
        cur.newPath = parsePath(lines[i + 1]!);
        cur.hasPair = true;
        i += 2;
        continue;
      }
      if (cur && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:.*)$/.exec(line);
      if (!m || !cur) throw new Exit2(`error: parse ${i + 1}`);
      const body: Body = [];
      const markers: number[] = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ') || (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ '))) break;
        if (b.startsWith('\\')) { markers.push(body.length - 1); continue; }
        if (b.startsWith(' ')) body.push({ kind: 'context', text: b.slice(1) });
        else if (b.startsWith('-')) body.push({ kind: 'old', text: b.slice(1) });
        else if (b.startsWith('+')) body.push({ kind: 'new', text: b.slice(1) });
        else if (b === '') body.push({ kind: 'context', text: '' });
        else break;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === 'context' && body[body.length - 1]!.text === '' && (lines[j - 1] ?? '') === '') body.pop();
      let lastWrite = -1;
      for (let k = body.length - 1; k >= 0; k -= 1) {
        if (body[k]!.kind !== 'old') { lastWrite = k; break; }
      }
      cur.hunks.push({ a: Number(m[1]!), body, noFinal: lastWrite >= 0 && markers.includes(lastWrite) });
      i = j;
      continue;
    }
    if (cur && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.oldPath = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.newPath = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.create = true;
      else if (line.startsWith('deleted file mode')) cur.remove = true;
    }
    i += 1;
  }
  return sections;
}

export function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return unifiedSections(lines).map((s) => (tree: Tree): void => {
    const oldPath = s.oldPath ?? s.diffOld;
    const newPath = s.newPath ?? s.diffNew;
    const create = s.create || oldPath === '/dev/null';
    const remove = s.remove || newPath === '/dev/null';
    const p = create ? newPath : oldPath;
    if (!p || !safe(p)) throw new Fail('unsafe', p ?? '');
    if ((create || remove || oldPath !== newPath) && newPath && newPath !== '/dev/null' && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (create) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const rows = s.hunks.flatMap((h) => h.body.filter((b) => b.kind === 'new').map((b) => b.text));
      const last = s.hunks.at(-1);
      tree.now.set(p, fileText(rows, '\n', !(last?.noFinal ?? false)));
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (remove) { tree.now.set(p, null); return; }
    let after: string;
    try { after = applyHunks(before, s.hunks, strict); }
    catch (e) { if (e instanceof Fail) throw new Fail(e.code, p); throw e; }
    if (newPath && newPath !== '/dev/null' && newPath !== p) {
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      tree.now.set(p, null);
      tree.now.set(newPath, after);
      tree.moves.set(newPath, p);
    } else tree.now.set(p, after);
  });
}

export function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let previousEnd = 0;
  let previousPath: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    let split = -1;
    let end = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (split < 0 && lines[j]!.trimEnd() === '=======') split = j;
      else if (split >= 0 && lines[j]!.trimEnd() === '>>>>>>> REPLACE') { end = j; break; }
    }
    if (split < 0 || end < 0) throw new Exit2(`error: parse ${i + 1}`);
    let path: string | null = null;
    for (let j = i - 1; j >= previousEnd; j -= 1) {
      const p = lines[j]!.trim();
      if (p !== '' && !p.startsWith('```')) { path = p; break; }
    }
    path ??= previousPath;
    if (!path) throw new Exit2(`error: parse ${i + 1}`);
    const old = lines.slice(i + 1, split);
    const next = lines.slice(split + 1, end).map((text) => ({ text, source: null }));
    edits.push((tree: Tree): void => {
      if (!safe(path!)) throw new Fail('unsafe', path!);
      if (old.length === 0) {
        if (tree.get(path!) !== null) throw new Fail('exists', path!);
        tree.now.set(path!, fileText(next.map((p) => p.text), '\n', true));
        return;
      }
      const before = tree.get(path!);
      if (before === null) throw new Fail('missing', path!);
      const f = fileLines(before);
      const found = occurrences(f.lines, old, strict);
      if (found.at.length === 0) throw new Fail('no-match', path!);
      if (found.at.length !== 1) throw new Fail('ambiguous', path!);
      tree.now.set(path!, fileText(replace(f.lines, found.at[0]!, old, next, found.tier), f.br, f.final));
    });
    previousPath = path;
    previousEnd = end + 1;
    i = end;
  }
  return edits;
}

type V4Chunk = { anchor: string | null; eof: boolean; body: Body };
type V4Section = { line: number; kind: 'add' | 'delete' | 'update'; path: string; move: string | null; rows: string[]; chunks: V4Chunk[] };

function v4aSections(lines: string[]): V4Section[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first < 0 ? 1 : first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) if (!blank(lines[i]!)) { last = i; break; }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const out: V4Section[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) { i += 1; continue; }
    const m = /^\*\*\* (Add File|Delete File|Update File): (.*)$/.exec(lines[i]!);
    if (!m) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[1] === 'Add File' ? 'add' : m[1] === 'Delete File' ? 'delete' : 'update';
    const section: V4Section = { line: i + 1, kind, path: m[2]!.trim(), move: null, rows: [], chunks: [] };
    i += 1;
    const start = i;
    while (i < last && !/^\*\*\* (Add File|Delete File|Update File): /.test(lines[i]!)) i += 1;
    let end = i;
    while (end > start && blank(lines[end - 1]!)) end -= 1;
    if (kind === 'update' && end > start && lines[start]!.startsWith('*** Move to: ')) {
      section.move = lines[start]!.slice(13).trim();
      for (let k = start + 1; k < end; k += 1) lines[k] = lines[k]!;
      const contentStart = start + 1;
      parseV4Chunks(lines, contentStart, end, section);
    } else if (kind === 'update') parseV4Chunks(lines, start, end, section);
    else {
      for (let k = start; k < end; k += 1) {
        const row = lines[k]!;
        if (kind === 'add') {
          if (row !== '' && !row.startsWith('+')) throw new Exit2(`error: parse ${k + 1}`);
          section.rows.push(row === '' ? '' : row.slice(1));
        } else throw new Exit2(`error: parse ${k + 1}`);
      }
    }
    if (kind === 'update' && section.chunks.length === 0 && section.move === null) throw new Exit2(`error: parse ${section.line}`);
    out.push(section);
  }
  return out;
}

function parseV4Chunks(lines: string[], start: number, end: number, section: V4Section): void {
  let i = start;
  while (i < end) {
    if (blank(lines[i]!)) { i += 1; continue; }
    let anchor: string | null = null;
    if (lines[i]!.startsWith('@@')) {
      const a = lines[i]!.slice(2).trim();
      anchor = a === '' ? null : a;
      i += 1;
    }
    const body: Body = [];
    let eof = false;
    while (i < end && !lines[i]!.startsWith('@@')) {
      const row = lines[i]!;
      if (row === '*** End of File') { eof = true; i += 1; break; }
      if (row.startsWith(' ')) body.push({ kind: 'context', text: row.slice(1) });
      else if (row.startsWith('-')) body.push({ kind: 'old', text: row.slice(1) });
      else if (row.startsWith('+')) body.push({ kind: 'new', text: row.slice(1) });
      else if (row === '') body.push({ kind: 'context', text: '' });
      else throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
    }
    section.chunks.push({ anchor, eof, body });
    if (eof && i < end && !lines[i]!.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
  }
}

export function v4aEdits(lines: string[], strict: boolean): Edit[] {
  return v4aSections([...lines]).map((s) => (tree: Tree): void => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.move !== null && !safe(s.move)) throw new Fail('unsafe', s.move);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, fileText(s.rows, '\n', true));
      return;
    }
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.kind === 'delete') { tree.now.set(s.path, null); return; }
    if (s.move !== null && tree.get(s.move) !== null) throw new Fail('exists', s.move);
    const f = fileLines(before);
    let work = f.lines;
    let cursor = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null) {
        const found = occurrences(work, [chunk.anchor], strict, cursor);
        if (found.at.length === 0) throw new Fail('no-match', s.path);
        cursor = found.at[0]! + 1;
      }
      const { old, next } = pieces(chunk.body);
      let at = cursor;
      if (old.length > 0) {
        const found = occurrences(work, old, strict, cursor);
        const valid = found.at.filter((x) => !chunk.eof || x + old.length === work.length);
        if (valid.length === 0) throw new Fail('no-match', s.path);
        at = valid[0]!;
        work = replace(work, at, old, next, found.tier);
      } else {
        if (chunk.eof) at = work.length;
        work = replace(work, at, old, next, 0);
      }
      cursor = at + next.length;
    }
    const after = fileText(work, f.br, f.final);
    if (s.move !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.move, after);
      tree.moves.set(s.move, s.path);
    } else tree.now.set(s.path, after);
  });
}

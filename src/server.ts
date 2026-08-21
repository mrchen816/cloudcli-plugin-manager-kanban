/**
 * manager-kanban — backend subprocess.
 *
 * Parses a workbuddy vault. Initiative cards (`initiatives/*.md`) are the only
 * writable state; every write is two-step: POST /preview → diff, POST /commit.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ClientDetail, ClientSummary, DetectResult, DiffHunk, InboxLine, Initiative,
  Status, VaultData, Weekly, WeeklyCheck, WeeklyPerson, WeeklyTopic, WriteAction,
} from './types.js';
import { REQUIRED_BY_STATUS } from './types.js';

const STALE_DAYS = 10;

/* ── vault detection ──────────────────────────────────────────────── */

const REQUIRED = ['initiatives', 'publishers', 'team/people', 'inbox'];

function detect(root: string): DetectResult {
  const checked = REQUIRED.map((rel) => ({ path: rel, ok: fs.existsSync(path.join(root, rel)) }));
  return { isVault: checked.every((c) => c.ok), checked };
}

function assertVault(root: string): void {
  if (!root || !path.isAbsolute(root)) throw new Error('需要绝对路径');
  if (!detect(root).isVault) throw new Error('这不像 workbuddy vault');
}

function read(root: string, rel: string): string {
  try { return fs.readFileSync(path.join(root, rel), 'utf-8'); } catch { return ''; }
}

const TODAY = () => new Date();
const iso = (d: Date) => d.toISOString().slice(0, 10);

function daysBetween(from: string | null, to: string): number | null {
  if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) return null;
  const a = new Date(from + 'T00:00:00Z').getTime();
  const b = new Date(to + 'T00:00:00Z').getTime();
  return Math.round((b - a) / 86400000);
}

/* ── frontmatter ──────────────────────────────────────────────────── */

interface Front { fields: Record<string, string>; bodyStart: number; lines: string[]; }

function parseFront(src: string): Front {
  const lines = src.split('\n');
  const fields: Record<string, string> = {};
  if (lines[0]?.trim() !== '---') return { fields, bodyStart: 0, lines };
  let i = 1;
  for (; i < lines.length; i++) {
    if (lines[i].trim() === '---') { i++; break; }
    const m = lines[i].match(/^([a-z_]+)\s*:\s*(.*)$/i);
    if (m) fields[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return { fields, bodyStart: i, lines };
}

const norm = (v: string | undefined): string | null => {
  const t = (v ?? '').trim();
  return t && t !== 'null' && t !== '-' ? t : null;
};

function parseInitiative(root: string, file: string): Initiative | null {
  const src = read(root, file);
  const { fields, bodyStart, lines } = parseFront(src);
  if (norm(fields.type) !== 'initiative') return null;

  const today = iso(TODAY());
  const status = ((norm(fields.status) || 'idea').toLowerCase() as Status);
  const lastProgress = norm(fields.last_progress);
  const reviewDate = norm(fields.review_date);

  const log: Initiative['log'] = [];
  for (const l of lines.slice(bodyStart)) {
    const m = l.match(/^\s*-\s+(\d{4}-\d{2}-\d{2})\s+(.*)$/);
    if (m) log.push({ date: m[1], text: m[2].trim() });
  }

  const present = (k: string) => !!norm(fields[k]);
  const missing = (REQUIRED_BY_STATUS[status] || []).filter((k) => !present(k));

  return {
    file,
    slug: path.basename(file).replace(/\.md$/, ''),
    title: norm(fields.title) || path.basename(file).replace(/\.md$/, ''),
    status,
    owner: norm(fields.owner),
    publisher: norm(fields.publisher),
    project: norm(fields.project),
    created: norm(fields.created),
    lastProgress,
    reviewDate,
    nextAction: norm(fields.next_action),
    blocker: norm(fields.blocker),
    waitingOn: norm(fields.waiting_on),
    blockedSince: norm(fields.blocked_since),
    staleDays: daysBetween(lastProgress, today),
    reviewIn: reviewDate ? -(daysBetween(reviewDate, today) ?? 0) : null,
    log,
    missing,
  };
}

function listInitiatives(root: string): Initiative[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(path.join(root, 'initiatives'))
      .filter((f) => f.endsWith('.md'));
  } catch { return []; }
  return files
    .map((f) => parseInitiative(root, `initiatives/${f}`))
    .filter((x): x is Initiative => !!x)
    .sort((a, b) => (a.reviewDate || '9999').localeCompare(b.reviewDate || '9999'));
}

function findInitiative(root: string, slug: string): Initiative {
  const hit = listInitiatives(root).find((i) => i.slug === slug);
  if (!hit) throw new Error('找不到 initiative ' + slug);
  return hit;
}

/* ── people / publishers ─────────────────────────────────────────── */

function peopleList(root: string): string[] {
  try {
    return fs.readdirSync(path.join(root, 'team/people'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name.charAt(0).toUpperCase() + e.name.slice(1));
  } catch { return []; }
}

function clientList(root: string, inits: Initiative[]): ClientSummary[] {
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(path.join(root, 'publishers'), { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { /* none */ }

  return dirs.map((slug) => {
    const dir = path.join(root, 'publishers', slug);
    let files: string[] = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { /* none */ }
    const hub = files.find((f) => f.toLowerCase() !== 'timeline.md') || null;
    const hubRel = hub ? `publishers/${slug}/${hub}` : null;
    const tlRel = files.includes('Timeline.md') ? `publishers/${slug}/Timeline.md` : null;
    const heading = hubRel ? (read(root, hubRel).match(/^#\s+(.+)$/m)?.[1] || slug) : slug;
    return {
      slug, name: heading.trim(), hubFile: hubRel, timelineFile: tlRel,
      openCount: inits.filter((i) => i.publisher === slug && i.status !== 'closed').length,
      lastEntry: tlRel ? (read(root, tlRel).match(/^##\s+(.+)$/m)?.[1] || null) : null,
    };
  }).sort((a, b) => b.openCount - a.openCount || a.name.localeCompare(b.name));
}

function sectionBullets(md: string, heading: RegExp): string[] {
  const out: string[] = [];
  let on = false;
  for (const l of md.split('\n')) {
    if (/^##\s/.test(l)) { on = heading.test(l); continue; }
    if (on && /^\s*-\s+/.test(l)) out.push(l.replace(/^\s*-\s+/, '').replace(/\*\*/g, '').trim());
  }
  return out;
}

function clientDetail(root: string, slug: string, inits: Initiative[]): ClientDetail {
  const base = clientList(root, inits).find((c) => c.slug === slug);
  if (!base) throw new Error('未知客户 ' + slug);
  const hub = base.hubFile ? read(root, base.hubFile) : '';
  const tl = base.timelineFile ? read(root, base.timelineFile) : '';

  const timeline: ClientDetail['timeline'] = [];
  for (const b of tl.split(/^##\s+/m).slice(1, 7)) {
    const nl = b.indexOf('\n');
    const head = (nl === -1 ? b : b.slice(0, nl)).trim();
    const rest = nl === -1 ? '' : b.slice(nl + 1);
    timeline.push({
      date: head.match(/(\d{4}-\d{1,2}-\d{1,2})/)?.[1] || head.slice(0, 10),
      title: head.replace(/^\S*\s*—\s*/, '').replace(/\*\*/g, ''),
      body: sectionBullets('## x\n' + rest, /x/).slice(0, 3).join(' '),
    });
  }

  let docs: ClientDetail['docs'] = [];
  try {
    docs = fs.readdirSync(path.join(root, 'publishers', slug))
      .filter((f) => f.endsWith('.md') && f !== 'Timeline.md' && `publishers/${slug}/${f}` !== base.hubFile)
      .map((f) => ({ title: f.replace(/\.md$/, ''), path: `publishers/${slug}/${f}` }));
  } catch { /* none */ }

  return {
    ...base,
    status: sectionBullets(hub, /状态|Status/),
    people: sectionBullets(hub, /关键人|人物|Contacts/),
    product: sectionBullets(hub, /产品|集成|Product/),
    timeline,
    docs,
    initiatives: inits.filter((i) => i.publisher === slug),
  };
}

/* ── inbox ───────────────────────────────────────────────────────── */

function inboxFile(root: string): { file: string; date: string } {
  const today = iso(TODAY());
  if (fs.existsSync(path.join(root, `inbox/${today}.md`))) return { file: `inbox/${today}.md`, date: today };
  let all: string[] = [];
  try {
    all = fs.readdirSync(path.join(root, 'inbox'))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
  } catch { /* none */ }
  const last = all[all.length - 1];
  return last ? { file: `inbox/${last}`, date: last.replace('.md', '') } : { file: `inbox/${today}.md`, date: today };
}

function parseInbox(root: string): VaultData['inbox'] {
  const { file, date } = inboxFile(root);
  const src = read(root, file).split('\n');
  const lines: InboxLine[] = [];
  src.forEach((l, i) => {
    const m = l.match(/^-\s+(?:(\d{1,2}:\d{2})\s*)?(.*)$/);
    if (!m) return;
    const archived: string[] = [];
    for (let j = i + 1; j < src.length && !/^-\s+/.test(src[j]); j++) {
      const a = src[j].match(/→\s*(?:已归档|已建卡)\s*:\s*(.+)$/);
      if (a) archived.push(...a[1].split(/[,，]/).map((x) => x.trim()));
    }
    lines.push({ index: i, time: m[1] || null, text: m[2].trim(), archived });
  });
  return { file, date, lines };
}

/* ── weekly notes ────────────────────────────────────────────────── */

function latestWeekly(root: string): { file: string; date: string } | null {
  let all: string[] = [];
  try {
    all = fs.readdirSync(path.join(root, 'team/meetings/weekly'))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
  } catch { return null; }
  const last = all[all.length - 1];
  return last ? { file: `team/meetings/weekly/${last}`, date: last.replace('.md', '') } : null;
}

function h2Blocks(md: string): { head: string; body: string }[] {
  return md.split(/^##\s+/m).slice(1).map((b) => {
    const nl = b.indexOf('\n');
    return { head: (nl === -1 ? b : b.slice(0, nl)).trim(), body: nl === -1 ? '' : b.slice(nl + 1) };
  });
}

function parseTable(body: string): WeeklyCheck[] {
  const rows = body.split('\n').filter((l) => /^\|/.test(l.trim()) && !/^\|[\s|:-]+\|$/.test(l.trim()));
  if (rows.length < 2) return [];
  return rows.slice(1).map((r) => {
    const cells = r.split('|').slice(1, -1).map((x) => x.replace(/\*\*/g, '').trim());
    return { item: cells[0] || '', who: cells[1] || '', ask: cells[2] || '', criteria: cells[3] || '' };
  }).filter((c) => c.item);
}

function parsePeople(body: string): WeeklyPerson[] {
  return body.split(/^###\s+/m).slice(1).map((b) => {
    const nl = b.indexOf('\n');
    const name = (nl === -1 ? b : b.slice(0, nl)).replace(/（[^）]*）/g, '').trim();
    const rest = nl === -1 ? '' : b.slice(nl + 1);
    const bullets = rest.split('\n').filter((l) => /^\s*-\s+/.test(l))
      .map((l) => l.replace(/^\s*-\s+/, '').replace(/\*\*/g, '').trim());
    const quote = rest.split('\n').find((l) => /^>\s/.test(l));
    return { name, bullets, note: quote ? quote.replace(/^>\s*/, '').replace(/\*\*/g, '').trim() : null };
  }).filter((p) => p.name);
}

function parseTopics(body: string): WeeklyTopic[] {
  const out: WeeklyTopic[] = [];
  let cur: WeeklyTopic | null = null;
  for (const line of body.split('\n')) {
    const m = line.match(/^\d+\.\s+(.*)$/);
    if (m) {
      if (cur) out.push(cur);
      const bold = m[1].match(/\*\*([^*]+)\*\*/);
      cur = { lead: (bold ? bold[1] : m[1].split('：')[0]).trim(), body: m[1].replace(/\*\*/g, '').trim() };
    } else if (cur && line.trim() && !/^#{1,6}\s/.test(line)) {
      cur.body += ' ' + line.replace(/^\s*-\s*/, '').replace(/\*\*/g, '').trim();
    }
  }
  if (cur) out.push(cur);
  return out;
}

function parseWeekly(root: string): Weekly | null {
  const f = latestWeekly(root);
  if (!f) return null;
  const blocks = h2Blocks(read(root, f.file));
  const find = (re: RegExp) => blocks.find((b) => re.test(b.head))?.body ?? '';
  return {
    file: f.file, date: f.date,
    checks: parseTable(find(/^A[.\s]|必查/)),
    people: parsePeople(find(/^B[.\s]|按人过/)),
    topics: parseTopics(find(/^C[.\s]|团队级/)),
  };
}

/* ── writes ──────────────────────────────────────────────────────── */

interface Edit { rel: string; lineNo: number; added: string[]; replace?: boolean; }

function findTimelineInsert(lines: string[], date?: string): number {
  // Timelines are reverse-chronological: insert before the first older block.
  for (let i = 0; i < lines.length; i++) {
    if (!/^##\s/.test(lines[i])) continue;
    if (!date) return i;
    const m = lines[i].match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!m) return i;
    if (`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` <= date) return i;
  }
  return lines.length;
}

/** Patch frontmatter keys in place; append missing ones before the closing ---. */
function patchFront(root: string, rel: string, fields: Record<string, string>): Edit[] {
  const src = read(root, rel).split('\n');
  if (src[0]?.trim() !== '---') throw new Error(rel + ' 没有 frontmatter');
  const edits: Edit[] = [];
  const seen = new Set<string>();
  let close = src.length;
  for (let i = 1; i < src.length; i++) {
    if (src[i].trim() === '---') { close = i; break; }
    const m = src[i].match(/^([a-z_]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (fields[key] === undefined) continue;
    seen.add(key);
    edits.push({ rel, lineNo: i, added: [`${key}: ${fields[key]}`], replace: true });
  }
  const fresh = Object.keys(fields).filter((k) => !seen.has(k));
  if (fresh.length) edits.push({ rel, lineNo: close, added: fresh.map((k) => `${k}: ${fields[k]}`) });
  return edits;
}

/** First body line after the frontmatter — where the newest log line goes. */
function logInsertLine(root: string, rel: string): number {
  const { bodyStart, lines } = parseFront(read(root, rel));
  for (let i = bodyStart; i < lines.length; i++) {
    if (/^\s*-\s+\d{4}-\d{2}-\d{2}\s/.test(lines[i])) return i;   // above existing newest
    if (/^##\s/.test(lines[i])) return i + 1;                      // just under a heading
  }
  return lines.length;
}

function plan(root: string, action: WriteAction): Edit[] {
  const today = iso(TODAY());
  const stamp = new Date().toTimeString().slice(0, 5);

  switch (action.kind) {
    case 'quick-note': {
      const { file } = inboxFile(root);
      const src = read(root, file).split('\n');
      return [{ rel: file, lineNo: src.length, added: [`- ${stamp} ${action.text}`] }];
    }
    case 'archive': {
      const { file } = inboxFile(root);
      const target = read(root, action.targetRel).split('\n');
      return [
        { rel: action.targetRel, lineNo: findTimelineInsert(target, today), added: action.entry.split('\n') },
        { rel: file, lineNo: action.lineIndex + 1, added: [`\t→ 已归档: ${action.targetRel}`] },
      ];
    }
    case 'client-entry': {
      const target = read(root, action.targetRel).split('\n');
      return [{
        rel: action.targetRel,
        lineNo: findTimelineInsert(target, today),
        added: [
          `## ${today} — ${action.title}`,
          ...action.body.split('\n').filter(Boolean).map((l) => `- ${l}`),
          `- 来源 → manager-kanban（${today} ${stamp}）`,
          '',
        ],
      }];
    }
    case 'patch-initiative': {
      const init = findInitiative(root, action.slug);
      const fields = { ...action.fields };
      const nextStatus = (fields.status as Status) || init.status;

      // Hard gate: a status must carry its required fields.
      const value = (k: string) => fields[k] ?? ({
        owner: init.owner, next_action: init.nextAction, review_date: init.reviewDate,
        blocker: init.blocker, waiting_on: init.waitingOn, blocked_since: init.blockedSince,
      } as Record<string, string | null>)[k] ?? null;
      const lacking = (REQUIRED_BY_STATUS[nextStatus] || []).filter((k) => !value(k));
      if (lacking.length) throw new Error(`标 ${nextStatus} 缺字段：${lacking.join('、')}`);

      // Real progress bumps last_progress; a bare status flip does not.
      if (action.log || fields.next_action !== undefined) fields.last_progress = today;

      const edits = patchFront(root, init.file, fields);
      if (action.log) {
        edits.push({ rel: init.file, lineNo: logInsertLine(root, init.file), added: [`- ${today} ${action.log}`] });
      }
      return edits;
    }
  }
}

function toHunks(root: string, edits: Edit[]): DiffHunk[] {
  return edits.map((e) => {
    const src = read(root, e.rel).split('\n');
    const at = Math.min(e.lineNo, src.length);
    const after = e.replace ? at + 1 : at;
    return {
      file: e.rel,
      before: src.slice(Math.max(0, at - 2), at),
      added: e.added,
      after: src.slice(after, after + 2),
    };
  });
}

function apply(root: string, edits: Edit[]): string[] {
  // Apply per file, high line numbers first, so earlier edits keep their offsets.
  const byFile = new Map<string, Edit[]>();
  for (const e of edits) {
    if (!byFile.has(e.rel)) byFile.set(e.rel, []);
    byFile.get(e.rel)!.push(e);
  }
  const touched: string[] = [];
  for (const [rel, list] of byFile) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const src = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8').split('\n') : [];
    for (const e of [...list].sort((a, b) => b.lineNo - a.lineNo)) {
      const at = Math.min(e.lineNo, src.length);
      if (e.replace) src.splice(at, 1, ...e.added);
      else src.splice(at, 0, ...e.added);
    }
    fs.writeFileSync(abs, src.join('\n'), 'utf-8');
    touched.push(rel);
  }
  return touched;
}

/* ── HTTP ────────────────────────────────────────────────────────── */

function body(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const send = (code: number, data: unknown) => { res.writeHead(code); res.end(JSON.stringify(data)); };

  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const root = url.searchParams.get('path') || '';

    if (req.method === 'GET' && url.pathname === '/detect') return send(200, detect(root));

    if (req.method === 'GET' && url.pathname === '/data') {
      assertVault(root);
      const initiatives = listInitiatives(root);
      const data: VaultData = {
        vaultPath: root,
        today: iso(TODAY()),
        initiatives,
        clients: clientList(root, initiatives),
        people: peopleList(root),
        inbox: parseInbox(root),
      };
      return send(200, data);
    }

    if (req.method === 'GET' && url.pathname === '/client') {
      assertVault(root);
      return send(200, clientDetail(root, url.searchParams.get('slug') || '', listInitiatives(root)));
    }

    if (req.method === 'GET' && url.pathname === '/weekly') {
      assertVault(root);
      return send(200, parseWeekly(root) ?? { file: '', date: '', checks: [], people: [], topics: [] });
    }

    if (req.method === 'POST' && (url.pathname === '/preview' || url.pathname === '/commit')) {
      const b = await body(req);
      const r = b.path as string;
      assertVault(r);
      const edits = plan(r, b.action as WriteAction);
      if (url.pathname === '/preview') return send(200, { hunks: toHunks(r, edits) });
      return send(200, { ok: true, files: apply(r, edits) });
    }

    send(404, { error: 'Not found' });
  } catch (err) {
    send(400, { error: (err as Error).message });
  }
});

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  if (addr && typeof addr !== 'string') console.log(JSON.stringify({ ready: true, port: addr.port }));
});

export { STALE_DAYS };

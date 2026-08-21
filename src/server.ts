/**
 * manager-kanban — backend subprocess.
 *
 * Parses a workbuddy vault (markdown) and performs guarded writes.
 * Every write is a two-step flow: POST /preview returns diff hunks,
 * POST /commit applies exactly the same edit.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ClientDetail, ClientSummary, DetectResult, DiffHunk, InboxLine,
  Promise_, Status, VaultData, Weekly, WeeklyCheck, WeeklyPerson, WeeklyTopic, WriteAction,
} from './types.js';

/* ── vault detection ──────────────────────────────────────────────── */

const REQUIRED = ['memory/MEMORY.md', 'publishers', 'team/people', 'inbox'];

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

/* ── date helpers ─────────────────────────────────────────────────── */

const TODAY = () => new Date();
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Collect date candidates; bold ones win, then earliest future. */
function pickDate(body: string): string | null {
  const year = TODAY().getFullYear();
  const found: { date: string; bold: boolean }[] = [];

  const push = (raw: string, bold: boolean) => {
    let d: string | null = null;
    let m = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) d = `${m[1]}-${m[2]}-${m[3]}`;
    if (!d) { m = raw.match(/\b(\d{2})-(\d{2})\b/); if (m) d = `${year}-${m[1]}-${m[2]}`; }
    if (!d) { m = raw.match(/(\d{1,2})\s*\/\s*(\d{1,2})/); if (m) d = `${year}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`; }
    if (!d) {
      m = raw.match(/(\d{1,2})\s*月\s*(\d{1,2})?\s*日?/);
      if (m) d = `${year}-${String(m[1]).padStart(2, '0')}-${String(m[2] || '01').padStart(2, '0')}`;
    }
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) found.push({ date: d, bold });
  };

  for (const b of body.match(/\*\*[^*]+\*\*/g) || []) push(b, true);
  push(body.replace(/\*\*[^*]+\*\*/g, ''), false);

  const t = iso(TODAY());
  const bold = found.filter((f) => f.bold);
  const pool = bold.length ? bold : found;
  const future = pool.filter((f) => f.date >= t).sort((a, b) => a.date.localeCompare(b.date));
  if (future.length) return future[0].date;
  const past = pool.sort((a, b) => b.date.localeCompare(a.date));
  return past.length ? past[0].date : null;
}

function daysLeft(due: string | null): number | null {
  if (!due) return null;
  const a = new Date(iso(TODAY()) + 'T00:00:00Z').getTime();
  const b = new Date(due + 'T00:00:00Z').getTime();
  return Math.round((b - a) / 86400000);
}

/* ── owner + status inference ─────────────────────────────────────── */

function peopleList(root: string): string[] {
  try {
    return fs.readdirSync(path.join(root, 'team/people'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name.charAt(0).toUpperCase() + e.name.slice(1));
  } catch { return []; }
}

function inferOwner(body: string, target: string | null, people: string[]): string {
  if (target) {
    const m = target.match(/team\/people\/([a-z0-9-]+)/i);
    if (m) {
      const hit = people.find((p) => p.toLowerCase() === m[1].toLowerCase());
      if (hit) return hit;
    }
  }
  // explicit owner marker wins over a mere mention
  const explicit = body.match(/owner\s*(?:=|：|:|是)\s*\**([A-Za-z\u4e00-\u9fa5]{2,12})/i);
  if (explicit) {
    const hit = people.find((p) => p.toLowerCase() === explicit[1].toLowerCase());
    if (hit) return hit;
  }
  for (const p of people) {
    if (new RegExp(`\\b${p}\\b`, 'i').test(body)) return p;
  }
  return '我';
}

function inferStatus(body: string): Status {
  if (/卡在|等对方|权限|不在我手上|不在 Jimmy|待对方|依赖/.test(body)) return '卡外部';
  if (/停滞|两周|零回音|无更新|窗口已过|未见成|暂放|hold|停止/.test(body)) return '停滞';
  return '进行';
}

/* ── MEMORY.md parsing ───────────────────────────────────────────── */

const MEMORY = 'memory/MEMORY.md';

interface RawPromise { line: string; lineNo: number; section: 'open' | 'far'; }

function memoryLines(root: string): RawPromise[] {
  const src = read(root, MEMORY).split('\n');
  const out: RawPromise[] = [];
  let section: 'open' | 'far' | null = null;
  src.forEach((line, i) => {
    if (/^##\s*未闭环承诺/.test(line)) { section = 'open'; return; }
    if (/^##\s*远期/.test(line)) { section = 'far'; return; }
    if (/^##\s/.test(line)) { section = null; return; }
    if (section && /^-\s*⏳/.test(line)) out.push({ line, lineNo: i, section });
  });
  return out;
}

function parsePromises(root: string): Promise_[] {
  const people = peopleList(root);
  return memoryLines(root).map(({ line, lineNo, section }) => {
    const link = line.match(/\[([^\]]+)\]\(([^)]+)\)/);
    const title = link ? link[1] : line.replace(/^-\s*⏳\s*/, '').split('—')[0].trim();
    const planFile = link ? path.posix.join('memory', link[2]) : null;
    const arrow = line.split('→');
    const targetPath = arrow.length > 1 ? arrow[arrow.length - 1].trim() : null;
    const body = line.replace(/^-\s*⏳\s*/, '').replace(/\[[^\]]+\]\([^)]+\)/, '').replace(/^\s*—\s*/, '');
    const due = section === 'far' ? pickDate(body) : pickDate(body);
    const scope = targetPath ? (targetPath.match(/publishers\/([^/]+)/)?.[1]
      || targetPath.match(/projects\/([^/]+)/)?.[1]
      || targetPath.match(/team\/people\/([^/]+)/)?.[1]
      || null) : null;
    return {
      id: `m${lineNo}`,
      title,
      body: body.replace(/\*\*/g, '').trim(),
      owner: inferOwner(body, targetPath, people),
      status: inferStatus(body),
      due,
      daysLeft: daysLeft(due),
      scope,
      planFile,
      targetPath,
      section,
    };
  });
}

/* ── publishers ──────────────────────────────────────────────────── */

function clientList(root: string, promises: Promise_[]): ClientSummary[] {
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
    const lastEntry = tlRel ? (read(root, tlRel).match(/^##\s+(.+)$/m)?.[1] || null) : null;
    return {
      slug, name: heading.trim(), hubFile: hubRel, timelineFile: tlRel,
      openCount: promises.filter((p) => p.scope === slug).length,
      lastEntry,
    };
  }).sort((a, b) => b.openCount - a.openCount || a.name.localeCompare(b.name));
}

function sectionBullets(md: string, heading: RegExp): string[] {
  const lines = md.split('\n');
  const out: string[] = [];
  let on = false;
  for (const l of lines) {
    if (/^##\s/.test(l)) { on = heading.test(l); continue; }
    if (on && /^\s*-\s+/.test(l)) out.push(l.replace(/^\s*-\s+/, '').replace(/\*\*/g, '').trim());
  }
  return out;
}

function clientDetail(root: string, slug: string, promises: Promise_[]): ClientDetail {
  const base = clientList(root, promises).find((c) => c.slug === slug);
  if (!base) throw new Error('未知客户 ' + slug);
  const hub = base.hubFile ? read(root, base.hubFile) : '';
  const tl = base.timelineFile ? read(root, base.timelineFile) : '';

  const timeline: ClientDetail['timeline'] = [];
  const blocks = tl.split(/^##\s+/m).slice(1);
  for (const b of blocks.slice(0, 6)) {
    const nl = b.indexOf('\n');
    const head = (nl === -1 ? b : b.slice(0, nl)).trim();
    const rest = nl === -1 ? '' : b.slice(nl + 1);
    const dm = head.match(/(\d{4}-\d{1,2}-\d{1,2})/);
    timeline.push({
      date: dm ? dm[1] : head.slice(0, 10),
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
    promises: promises.filter((p) => p.scope === slug),
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
      const a = src[j].match(/→\s*已归档:\s*(.+)$/);
      if (a) archived.push(...a[1].split(/[,，]/).map((s) => s.trim()));
    }
    lines.push({ index: i, time: m[1] || null, text: m[2].trim(), archived });
  });
  return { file, date, lines };
}

/* ── weekly meeting notes ────────────────────────────────────────── */

function latestWeekly(root: string): { file: string; date: string } | null {
  let all: string[] = [];
  try {
    all = fs.readdirSync(path.join(root, 'team/meetings/weekly'))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
  } catch { return null; }
  const last = all[all.length - 1];
  return last ? { file: `team/meetings/weekly/${last}`, date: last.replace('.md', '') } : null;
}

/** Split a markdown doc into `## X` blocks. */
function h2Blocks(md: string): { head: string; body: string }[] {
  return md.split(/^##\s+/m).slice(1).map((b) => {
    const nl = b.indexOf('\n');
    return { head: (nl === -1 ? b : b.slice(0, nl)).trim(), body: nl === -1 ? '' : b.slice(nl + 1) };
  });
}

function parseTable(body: string): WeeklyCheck[] {
  const rows = body.split('\n')
    .filter((l) => /^\|/.test(l.trim()) && !/^\|[\s|:-]+\|$/.test(l.trim()));
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
    const bullets = rest.split('\n')
      .filter((l) => /^\s*-\s+/.test(l))
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
    file: f.file,
    date: f.date,
    checks: parseTable(find(/^A[.\s]|必查/)),
    people: parsePeople(find(/^B[.\s]|按人过/)),
    topics: parseTopics(find(/^C[.\s]|团队级/)),
  };
}

/* ── writes: preview + commit share one planner ──────────────────── */

function plan(root: string, action: WriteAction, promises: Promise_[]): { rel: string; lineNo: number; added: string[] }[] {
  const stamp = new Date().toTimeString().slice(0, 5);
  const find = (id: string) => {
    const p = promises.find((x) => x.id === id);
    if (!p) throw new Error('找不到这条承诺');
    return p;
  };

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
        { rel: action.targetRel, lineNo: findTimelineInsert(target, iso(TODAY())), added: action.entry.split('\n') },
        { rel: file, lineNo: action.lineIndex + 1, added: [`\t→ 已归档: ${action.targetRel}`] },
      ];
    }
    case 'backfill': {
      const p = find(action.promiseId);
      const target = read(root, action.targetRel).split('\n');
      const edits = [{
        rel: action.targetRel,
        lineNo: findTimelineInsert(target, iso(TODAY())),
        added: [
          `## ${iso(TODAY())} — ${p.title}`,
          `- **结论：** ${action.conclusion}`,
          `- **判据：** ${action.criteria}`,
          `- **下一步：** ${action.next}`,
          `- 来源 → manager-kanban 回填（${iso(TODAY())} ${stamp}）`,
          '',
        ],
      }];
      if (p.planFile) {
        const pf = read(root, p.planFile).split('\n');
        edits.push({ rel: p.planFile, lineNo: pf.length, added: ['', `**${iso(TODAY())} 结案：** ${action.conclusion}（判据：${action.criteria}）`] });
      }
      edits.push(memoryEdit(root, p, (line) => line.replace(/^-\s*⏳/, '- ✅') + `（${iso(TODAY())} 结案 → ${action.targetRel}）`));
      return edits;
    }
    case 'reschedule': {
      const p = find(action.promiseId);
      const edits = [memoryEdit(root, p, (line) =>
        p.due && line.includes(p.due.slice(5))
          ? line.replace(p.due.slice(5), action.review.slice(5))
          : line.replace(/\s*→\s*/, ` **复核 ${action.review}** → `))];
      if (p.planFile) {
        const pf = read(root, p.planFile).split('\n');
        edits.push({ rel: p.planFile, lineNo: pf.length, added: ['', `- 复核日更新为 ${action.review}（${iso(TODAY())}）`] });
      }
      return edits;
    }
    case 'client-entry': {
      const target = read(root, action.targetRel).split('\n');
      return [{
        rel: action.targetRel,
        lineNo: findTimelineInsert(target, iso(TODAY())),
        added: [
          `## ${iso(TODAY())} — ${action.title}`,
          ...action.body.split('\n').filter(Boolean).map((l) => `- ${l}`),
          `- 来源 → manager-kanban（${iso(TODAY())} ${stamp}）`,
          '',
        ],
      }];
    }
    case 'set-owner': {
      const p = find(action.promiseId);
      const edits = [memoryEdit(root, p, (line) => line.replace(/\s*→\s*/, ` **owner=${action.owner}** → `))];
      if (p.planFile) {
        const pf = read(root, p.planFile).split('\n');
        edits.push({ rel: p.planFile, lineNo: pf.length, added: ['', `- owner: ${action.owner}（${iso(TODAY())} 指派）`] });
      }
      return edits;
    }
  }
}

/** Replace a MEMORY.md line in place, expressed as an edit record. */
function memoryEdit(root: string, p: Promise_, transform: (line: string) => string) {
  const src = read(root, MEMORY).split('\n');
  const lineNo = Number(p.id.slice(1));
  const current = src[lineNo] ?? '';
  return { rel: MEMORY, lineNo, added: [transform(current)], replace: true } as any;
}

function findTimelineInsert(lines: string[], date?: string): number {
  // Timelines are reverse-chronological. Insert before the first `##` block
  // whose date is older than `date`; without a date, insert at the top block.
  for (let i = 0; i < lines.length; i++) {
    if (!/^##\s/.test(lines[i])) continue;
    if (!date) return i;
    const m = lines[i].match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!m) return i;
    const norm = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    if (norm <= date) return i;
  }
  return lines.length;
}

function toHunks(root: string, edits: ReturnType<typeof plan>): DiffHunk[] {
  return edits.map((e) => {
    const src = read(root, e.rel).split('\n');
    const at = Math.min(e.lineNo, src.length);
    return {
      file: e.rel,
      before: src.slice(Math.max(0, at - 2), at),
      added: e.added,
      after: src.slice((e as any).replace ? at + 1 : at, ((e as any).replace ? at + 1 : at) + 2),
    };
  });
}

function apply(root: string, edits: ReturnType<typeof plan>): string[] {
  const touched: string[] = [];
  for (const e of edits) {
    const abs = path.join(root, e.rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const src = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8').split('\n') : [];
    const at = Math.min(e.lineNo, src.length);
    if ((e as any).replace) src.splice(at, 1, ...e.added);
    else src.splice(at, 0, ...e.added);
    fs.writeFileSync(abs, src.join('\n'), 'utf-8');
    touched.push(e.rel);
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
      const promises = parsePromises(root);
      const data: VaultData = {
        vaultPath: root,
        today: iso(TODAY()),
        promises,
        clients: clientList(root, promises),
        people: peopleList(root),
        inbox: parseInbox(root),
      };
      return send(200, data);
    }

    if (req.method === 'GET' && url.pathname === '/client') {
      assertVault(root);
      const slug = url.searchParams.get('slug') || '';
      return send(200, clientDetail(root, slug, parsePromises(root)));
    }

    if (req.method === 'GET' && url.pathname === '/weekly') {
      assertVault(root);
      return send(200, parseWeekly(root) ?? { file: '', date: '', checks: [], people: [], topics: [] });
    }

    if (req.method === 'POST' && (url.pathname === '/preview' || url.pathname === '/commit')) {
      const b = await body(req);
      const r = b.path as string;
      assertVault(r);
      const edits = plan(r, b.action as WriteAction, parsePromises(r));
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

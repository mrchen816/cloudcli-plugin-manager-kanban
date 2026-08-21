/**
 * manager-kanban — frontend entry.
 * Vanilla DOM, host-themed. Chip row switches views. Compact rows: click a row
 * to expand its actions (one at a time).
 */

import type {
  ClientDetail, DetectResult, DiffHunk, PluginAPI, PluginContext,
  Promise_, VaultData, Weekly, WriteAction,
} from './types.js';

/* ── theme ───────────────────────────────────────────────────────── */

interface C {
  bg: string; surface: string; raised: string; border: string;
  text: string; muted: string; faint: string;
  accent: string; danger: string; warn: string; ok: string; okBg: string;
}

function colors(dark: boolean): C {
  return dark
    ? { bg: '#0b0d12', surface: '#12151d', raised: '#1a1f2a', border: '#242b38',
        text: '#e6e9f0', muted: '#98a2b5', faint: '#5d6779',
        accent: '#7780ff', danger: '#ff6b6b', warn: '#ffcb05', ok: '#3ddc84', okBg: 'rgba(61,220,132,0.12)' }
    : { bg: '#f8f8fa', surface: '#ffffff', raised: '#f2f3f7', border: '#e2e5ec',
        text: '#273143', muted: '#4a5871', faint: '#95a2bc',
        accent: '#555fff', danger: '#ed0303', warn: '#b58100', ok: '#00893e', okBg: 'rgba(0,137,62,0.10)' };
}

const FONT = 'ui-sans-serif, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

/* ── DOM helpers ─────────────────────────────────────────────────── */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, style?: Partial<CSSStyleDeclaration>, text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (style) Object.assign(n.style, style);
  if (text !== undefined) n.textContent = text;
  return n;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/* ── state ───────────────────────────────────────────────────────── */

type View = 'board' | 'backfill' | 'weekly' | 'clients' | 'inbox' | 'topics';

const VIEWS: [View, string][] = [
  ['board', '承诺'], ['backfill', '待回填'], ['weekly', '周会'],
  ['clients', '客户'], ['inbox', 'Inbox'], ['topics', '议题'],
];

const LS_KEY = 'manager-kanban:vault-path';

interface Picker {
  title: string;
  query: string;
  onPick: (rel: string) => void;
}

interface State {
  view: View;
  data: VaultData | null;
  client: ClientDetail | null;
  error: string | null;
  detect: DetectResult | null;
  loading: boolean;
  expanded: string | null;      // one open row at a time
  form: string | null;          // promise id with backfill form open
  pending: { action: WriteAction; hunks: DiffHunk[] } | null;
  collapsed: Record<string, boolean>;
  picker: Picker | null;
  weekly: Weekly | null;
}

/* ── mount ───────────────────────────────────────────────────────── */

export function mount(container: HTMLElement, api: PluginAPI): void {
  const s: State = {
    view: 'board', data: null, client: null, error: null, detect: null,
    loading: false, expanded: null, form: null, pending: null, collapsed: {}, picker: null,
    weekly: null,
  };

  const root = el('div', {
    height: '100%', overflowY: 'auto', boxSizing: 'border-box',
    fontFamily: FONT, fontSize: '13px', lineHeight: '1.55',
  });
  container.appendChild(root);

  const vaultPath = (ctx: PluginContext): string | null =>
    localStorage.getItem(LS_KEY) || ctx.project?.path || null;

  async function load(): Promise<void> {
    const p = vaultPath(api.context);
    s.error = null; s.detect = null; s.data = null;
    if (!p) { render(); return; }
    s.loading = true; render();
    try {
      const d = (await api.rpc('GET', `detect?path=${encodeURIComponent(p)}`)) as DetectResult;
      s.detect = d;
      if (d.isVault) {
        s.data = (await api.rpc('GET', `data?path=${encodeURIComponent(p)}`)) as VaultData;
        s.weekly = (await api.rpc('GET', `weekly?path=${encodeURIComponent(p)}`)) as Weekly;
      }
    } catch (e) { s.error = (e as Error).message; }
    s.loading = false;
    render();
  }

  async function openClient(slug: string): Promise<void> {
    const p = vaultPath(api.context);
    if (!p) return;
    try {
      s.client = (await api.rpc('GET', `client?path=${encodeURIComponent(p)}&slug=${encodeURIComponent(slug)}`)) as ClientDetail;
      render();
    } catch (e) { s.error = (e as Error).message; render(); }
  }

  async function preview(action: WriteAction): Promise<void> {
    const p = vaultPath(api.context);
    if (!p) return;
    try {
      const r = (await api.rpc('POST', 'preview', { path: p, action })) as { hunks: DiffHunk[] };
      s.pending = { action, hunks: r.hunks };
      s.picker = null;
      render();
    } catch (e) { s.error = (e as Error).message; render(); }
  }

  async function commit(): Promise<void> {
    const p = vaultPath(api.context);
    if (!p || !s.pending) return;
    try {
      await api.rpc('POST', 'commit', { path: p, action: s.pending.action });
      s.pending = null;
      await load();
    } catch (e) { s.error = (e as Error).message; render(); }
  }

  /* ── target suggestion ─────────────────────────────────────────── */

  /** ⏳-line path first, then text match against publishers/projects. */
  function suggestTargets(text: string, fromLine?: string | null): string[] {
    const out: string[] = [];
    if (fromLine && /\.md$/.test(fromLine)) out.push(fromLine);
    const lower = text.toLowerCase();
    for (const c of s.data?.clients ?? []) {
      const hit = lower.includes(c.slug.toLowerCase())
        || (c.name && text.includes(c.name.replace(/\s+\w+$/, '').trim()))
        || c.name.split(/\s+/).some((w) => w.length > 2 && lower.includes(w.toLowerCase()));
      if (hit && c.timelineFile && !out.includes(c.timelineFile)) out.push(c.timelineFile);
    }
    return out.slice(0, 3);
  }

  function pickTarget(title: string, text: string, fromLine: string | null, onPick: (rel: string) => void): void {
    const suggestions = suggestTargets(text, fromLine);
    if (suggestions.length) {
      s.picker = { title, query: '', onPick };
      (s.picker as any).suggestions = suggestions;
    } else {
      s.picker = { title, query: '', onPick };
    }
    render();
  }

  /* ── render ────────────────────────────────────────────────────── */

  function render(): void {
    const c = colors(api.context.theme === 'dark');
    root.style.background = c.bg;
    root.style.color = c.text;
    root.innerHTML = '';
    root.appendChild(chipBar(c));

    const pad = el('div', { padding: '12px 16px 40px', display: 'flex', flexDirection: 'column', gap: '10px' });
    root.appendChild(pad);

    if (s.error) pad.appendChild(banner(c, c.danger, s.error));
    if (s.loading) { pad.appendChild(note(c, '读取 vault…')); return; }
    if (!vaultPath(api.context)) { pad.appendChild(pathPrompt(c, '还没有选中项目 —— 手填 vault 路径。')); return; }
    if (s.detect && !s.detect.isVault) {
      pad.appendChild(pathPrompt(c, '这不像 workbuddy vault：' +
        s.detect.checked.filter((x) => !x.ok).map((x) => x.path).join('、') + ' 不存在。'));
      return;
    }
    if (!s.data) return;

    pad.appendChild(omnibox(c));
    if (s.view === 'board' && !s.client) pad.appendChild(summaryCard(c));
    if (s.pending) pad.appendChild(diffPanel(c, s.pending.hunks));
    if (s.picker) pad.appendChild(pickerPanel(c, s.picker));

    if (s.client) { pad.appendChild(clientView(c, s.client)); return; }

    if (s.view === 'board') boardView(c, pad);
    else if (s.view === 'backfill') backfillView(c, pad);
    else if (s.view === 'weekly') weeklyView(c, pad);
    else if (s.view === 'clients') clientsView(c, pad);
    else if (s.view === 'inbox') inboxView(c, pad);
    else topicsView(c, pad);
  }

  function plusDays(base: string, n: number): string {
    const d = new Date(base + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function dueLabel(p: Promise_): string {
    if (!p.due) return '—';
    if ((p.daysLeft ?? 0) < 0) return `逾期 ${-(p.daysLeft ?? 0)}`;
    if (p.daysLeft === 0) return '今天';
    return `${p.daysLeft}天`;
  }

  function dueColor(c: C, p: Promise_): string {
    return (p.daysLeft ?? 99) <= 0 ? c.danger : c.muted;
  }

  function listBox(c: C): HTMLElement {
    return el('div', {
      display: 'flex', flexDirection: 'column',
      border: `1px solid ${c.border}`, borderRadius: '8px', overflow: 'hidden',
    });
  }

  function stackItem(c: C, first: boolean, extra?: Partial<CSSStyleDeclaration>): HTMLElement {
    return el('div', {
      padding: '8px 0',
      borderTop: first ? 'none' : `1px solid ${c.border}`,
      display: 'flex', flexDirection: 'column', gap: '2px',
      ...(extra || {}),
    });
  }

  /** One line: what today actually demands. Kept to three clauses. */
  function todayLine(): string {
    const open = s.data!.promises.filter((p) => p.section === 'open');
    const overdue = open.filter((p) => (p.daysLeft ?? 99) < 0)
      .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0));
    const today = open.filter((p) => p.daysLeft === 0);
    const stalledOwners = [...new Set(open.filter((p) => p.status === '停滞' && p.owner !== '我').map((p) => p.owner))];

    const parts: string[] = [];
    if (overdue.length) parts.push(`${overdue.length} 项逾期，最久的是「${overdue[0].title}」`);
    if (today.length) parts.push(`${today.length} 项今天到期`);
    if (stalledOwners.length) parts.push(`${stalledOwners.join('、')} 那边有停滞`);
    return parts.length ? parts.join('；') + '。' : '没有到期的事 —— 今天可以做长线。';
  }

  function summaryCard(c: C): HTMLElement {
    const open = s.data!.promises.filter((p) => p.section === 'open');
    const overdue = open.filter((p) => (p.daysLeft ?? 99) < 0).length;
    const box = card(c, {
      gap: '4px',
      borderLeft: `2px solid ${overdue ? c.danger : c.border}`,
    });
    box.appendChild(el('div', { color: c.faint, fontSize: '12px' }, `今日 · ${s.data!.today}`));
    box.appendChild(el('div', { fontSize: '13px', fontWeight: '500', lineHeight: '1.5' }, todayLine()));
    return box;
  }

  function chipBar(c: C): HTMLElement {
    const bar = el('div', {
      position: 'sticky', top: '0', zIndex: '5', background: c.surface,
      borderBottom: `1px solid ${c.border}`, padding: '8px 16px',
      display: 'flex', gap: '8px', overflowX: 'auto', alignItems: 'center',
    });
    for (const [v, label] of VIEWS) {
      const on = s.view === v && !s.client;
      const chip = el('button', {
        padding: '6px 14px', borderRadius: '999px', cursor: 'pointer',
        whiteSpace: 'nowrap', fontFamily: FONT, fontSize: '13px',
        border: `1px solid ${on ? c.accent : c.border}`,
        background: on ? c.accent : 'transparent',
        color: on ? '#fff' : c.muted, fontWeight: on ? '600' : '400',
      }, label);
      chip.onclick = () => { s.view = v; s.client = null; s.expanded = null; s.form = null; render(); };
      bar.appendChild(chip);
    }
    bar.appendChild(el('div', { flex: '1 1 auto' }));
    const refresh = el('button', {
      padding: '6px 12px', borderRadius: '999px', cursor: 'pointer', fontFamily: FONT,
      fontSize: '13px', border: `1px solid ${c.border}`, background: 'transparent', color: c.muted,
    }, '刷新');
    refresh.onclick = () => void load();
    bar.appendChild(refresh);
    return bar;
  }

  function omnibox(c: C): HTMLElement {
    const wrap = card(c, { flexDirection: 'row', alignItems: 'center', gap: '10px', flexWrap: 'wrap' });
    const input = el('input', {
      flex: '1 1 240px', minWidth: '0', border: 'none', outline: 'none',
      background: 'transparent', color: c.text, fontFamily: FONT, fontSize: '13px',
    });
    input.placeholder = '记一句，落到 ' + (s.data?.inbox.file ?? 'inbox');
    const btn = primary(c, '存入 Inbox');
    btn.onclick = () => { if (input.value.trim()) void preview({ kind: 'quick-note', text: input.value.trim() }); };
    input.onkeydown = (e) => { if (e.key === 'Enter') btn.click(); };
    wrap.append(input, btn);
    return wrap;
  }

  /* ── board (compact rows) ──────────────────────────────────────── */

  function boardView(c: C, pad: HTMLElement): void {
    const open = s.data!.promises.filter((p) => p.section === 'open');
    const far = s.data!.promises.filter((p) => p.section === 'far');
    const mine = open.filter((p) => p.owner === '我');
    const others = open.filter((p) => p.owner !== '我');

    group(c, pad, 'mine', `我的承诺 · ${mine.length} 项`,
      `${mine.filter((p) => (p.daysLeft ?? 1) <= 0).length} 逾期`, mine);

    const byOwner = new Map<string, Promise_[]>();
    for (const p of others) {
      if (!byOwner.has(p.owner)) byOwner.set(p.owner, []);
      byOwner.get(p.owner)!.push(p);
    }
    for (const [owner, list] of byOwner) {
      group(c, pad, 'o:' + owner, `${owner} · ${list.length} 项`,
        list.some((p) => p.status === '停滞') ? '有停滞' : '', list);
    }
    group(c, pad, 'far', `远期 / 无日期 · ${far.length} 项`, 'breath 时不提', far, true);
  }

  function group(c: C, pad: HTMLElement, key: string, title: string, meta: string,
                 items: Promise_[], defaultCollapsed = false): void {
    if (s.collapsed[key] === undefined) s.collapsed[key] = defaultCollapsed;
    const h = el('div', {
      display: 'flex', alignItems: 'baseline', gap: '8px', cursor: 'pointer',
      padding: '10px 2px 4px', flexWrap: 'wrap',
    });
    h.append(
      el('div', { fontWeight: '600', fontSize: '12px' }, title),
      el('div', { color: c.faint, fontSize: '12px' }, meta),
      el('div', { marginLeft: 'auto', color: c.faint, fontSize: '12px' }, s.collapsed[key] ? '展开' : '收起'),
    );
    h.onclick = () => { s.collapsed[key] = !s.collapsed[key]; render(); };
    pad.appendChild(h);
    if (s.collapsed[key]) return;

    const list = listBox(c);
    items.forEach((p, i) => list.appendChild(compactRow(c, p, i > 0)));
    pad.appendChild(list);
  }

  function compactRow(c: C, p: Promise_, divider: boolean): HTMLElement {
    const wrap = el('div', {
      background: s.expanded === p.id ? c.raised : c.surface,
      borderTop: divider ? `1px solid ${c.border}` : 'none',
    });

    const row = el('div', {
      display: 'grid', gridTemplateColumns: '52px minmax(0,1fr)',
      gap: '2px 10px', alignItems: 'start', padding: '7px 12px', cursor: 'pointer',
    });
    row.appendChild(el('div', {
      fontWeight: '400', whiteSpace: 'nowrap', fontSize: '12px',
      fontVariantNumeric: 'tabular-nums', color: dueColor(c, p),
    }, dueLabel(p)));

    const mid = el('div', { minWidth: '0', display: 'flex', flexDirection: 'column', gap: '1px' });
    const open = s.expanded === p.id;
    mid.appendChild(el('div', {
      fontWeight: '500', fontSize: '13px',
      whiteSpace: open ? 'normal' : 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    }, p.title));
    const bits = [p.status, p.scope].filter(Boolean).join(' · ');
    if (bits) mid.appendChild(el('div', { color: c.faint, fontSize: '12px' }, bits));
    mid.appendChild(el('div', {
      color: c.faint, fontSize: '12px', whiteSpace: open ? 'normal' : 'nowrap',
      overflow: 'hidden', textOverflow: 'ellipsis',
    }, p.body));
    row.appendChild(mid);

    row.onclick = () => {
      s.expanded = s.expanded === p.id ? null : p.id;
      if (s.form !== p.id) s.form = null;
      render();
    };
    wrap.appendChild(row);

    if (s.expanded === p.id) {
      const box = el('div', { padding: '0 12px 10px', display: 'flex', flexDirection: 'column', gap: '8px' });
      const actions = el('div', { display: 'flex', gap: '8px', flexWrap: 'wrap' });
      const bf = ghost(c, s.form === p.id ? '收起回填' : '回填');
      bf.onclick = (e) => { e.stopPropagation(); s.form = s.form === p.id ? null : p.id; render(); };
      const rs = ghost(c, '改复核日');
      rs.onclick = (e) => {
        e.stopPropagation();
        const v = window.prompt('新的复核日（YYYY-MM-DD）', p.due || s.data!.today);
        if (v) void preview({ kind: 'reschedule', promiseId: p.id, review: v });
      };
      const ow = ghost(c, '标 owner');
      ow.onclick = (e) => {
        e.stopPropagation();
        const v = window.prompt('owner（' + (s.data!.people.join(' / ') || '我') + '）', p.owner);
        if (v) void preview({ kind: 'set-owner', promiseId: p.id, owner: v });
      };
      actions.append(bf, rs, ow);
      if (p.scope) {
        const go = ghost(c, '去 ' + p.scope);
        go.onclick = (e) => { e.stopPropagation(); void openClient(p.scope!); };
        actions.appendChild(go);
      }
      box.appendChild(actions);
      if (p.targetPath) box.appendChild(note(c, '目标 → ' + p.targetPath));
      if (s.form === p.id) box.appendChild(backfillForm(c, p));
      wrap.appendChild(box);
    }
    return wrap;
  }

  function backfillForm(c: C, p: Promise_): HTMLElement {
    const box = el('div', {
      borderTop: `1px solid ${c.border}`, paddingTop: '12px',
      display: 'flex', flexDirection: 'column', gap: '10px',
    });
    box.onclick = (e) => e.stopPropagation();
    const fields: [string, string, string][] = [
      ['conclusion', '结论', '一句话，落进文件的就是这句'],
      ['criteria', '判据', '什么算成/不成 —— 给不出就是倾向不做'],
      ['next', '下一步动作', '谁、做什么'],
      ['review', '下一个复核日', plusDays(s.data!.today, 7)],
    ];
    const inputs: Record<string, HTMLInputElement> = {};
    for (const [k, label, hint] of fields) {
      const l = el('label', { display: 'flex', flexDirection: 'column', gap: '5px' });
      l.appendChild(el('span', { color: c.faint, fontSize: '12px' }, label));
      const i = el('input', {
        border: `1px solid ${c.border}`, borderRadius: '8px', padding: '9px 12px',
        background: c.bg, color: c.text, fontFamily: FONT, fontSize: '13px', outline: 'none',
      });
      i.placeholder = hint;
      if (k === 'review') i.value = plusDays(s.data!.today, 7);
      inputs[k] = i;
      l.appendChild(i);
      box.appendChild(l);
    }
    const go = primary(c, '选目标并预览');
    go.onclick = () => {
      pickTarget('回填写入哪个文件', p.title + ' ' + p.body, p.targetPath, (rel) => {
        void preview({
          kind: 'backfill', promiseId: p.id, targetRel: rel,
          conclusion: inputs.conclusion.value, criteria: inputs.criteria.value,
          next: inputs.next.value, review: inputs.review.value || s.data!.today,
        });
      });
    };
    box.appendChild(go);
    box.appendChild(note(c, '结案 = 结论写进目标文件，这条从未闭环清单消失；之后只在该文件里查得到。'));
    return box;
  }

  /* ── target picker ─────────────────────────────────────────────── */

  function pickerPanel(c: C, pk: Picker): HTMLElement {
    const box = card(c, { borderColor: c.accent, gap: '10px' });
    box.appendChild(el('div', { fontWeight: '600' }, pk.title));

    const suggestions: string[] = (pk as any).suggestions || [];
    if (suggestions.length) {
      box.appendChild(note(c, '推荐'));
      const row = el('div', { display: 'flex', flexWrap: 'wrap', gap: '8px' });
      for (const rel of suggestions) {
        const b = ghost(c, rel);
        b.style.borderColor = c.accent;
        b.style.color = c.text;
        b.onclick = () => pk.onPick(rel);
        row.appendChild(b);
      }
      box.appendChild(row);
    }

    const input = el('input', {
      border: `1px solid ${c.border}`, borderRadius: '8px', padding: '9px 12px',
      background: c.bg, color: c.text, fontFamily: FONT, fontSize: '13px', outline: 'none',
    });
    input.placeholder = '搜 publishers / projects，或直接写相对路径';
    input.value = pk.query;
    const results = el('div', { display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '220px', overflowY: 'auto' });

    const candidates: { label: string; rel: string }[] = [
      ...(s.data!.clients.filter((cl) => cl.timelineFile).map((cl) => ({ label: cl.name + '  ·  ' + cl.slug, rel: cl.timelineFile! }))),
    ];

    const draw = () => {
      results.innerHTML = '';
      const q = input.value.trim().toLowerCase();
      const list = q
        ? candidates.filter((x) => x.label.toLowerCase().includes(q) || x.rel.toLowerCase().includes(q))
        : candidates;
      for (const x of list.slice(0, 40)) {
        const r = el('div', {
          padding: '7px 10px', borderRadius: '8px', cursor: 'pointer',
          background: c.raised, display: 'flex', justifyContent: 'space-between', gap: '10px',
        });
        r.append(el('span', {}, x.label), el('span', { color: c.faint }, x.rel));
        r.onclick = () => pk.onPick(x.rel);
        results.appendChild(r);
      }
      if (q && /\.md$/.test(input.value.trim())) {
        const manual = el('div', { padding: '7px 10px', borderRadius: '8px', cursor: 'pointer', background: c.raised, color: c.accent },
          '用手填路径：' + input.value.trim());
        manual.onclick = () => pk.onPick(input.value.trim());
        results.appendChild(manual);
      }
    };
    input.oninput = () => { pk.query = input.value; draw(); };
    box.append(input, results);
    draw();

    const cancel = ghost(c, '取消');
    cancel.onclick = () => { s.picker = null; render(); };
    box.appendChild(cancel);
    return box;
  }

  /* ── other views ───────────────────────────────────────────────── */

  function backfillView(c: C, pad: HTMLElement): void {
    const stale = s.data!.promises
      .filter((p) => p.section === 'open' && (p.daysLeft ?? 99) <= 3)
      .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0));
    pad.appendChild(banner(c, c.warn, '会前准备强、会后回填弱 —— 拿判据逐条来收。'));
    if (!stale.length) { pad.appendChild(note(c, '没有到期的条目。')); return; }
    const list = listBox(c);
    stale.forEach((p, i) => list.appendChild(compactRow(c, p, i > 0)));
    pad.appendChild(list);
  }

  function weeklyView(c: C, pad: HTMLElement): void {
    const w = s.weekly;
    if (w?.file) {
      pad.appendChild(note(c, `${w.file} · ${w.date}`));
      if (w.checks.length) {
        const box = card(c, { gap: '0' });
        box.appendChild(el('div', { fontWeight: '600', fontSize: '12px', paddingBottom: '6px' }, `必查 · ${w.checks.length} 件`));
        w.checks.forEach((ch, i) => {
          const r = stackItem(c, i === 0);
          r.append(
            el('div', { fontWeight: '500' }, `${ch.item}  ·  ${ch.who}`),
            el('div', { color: c.muted, fontSize: '12px' }, ch.ask),
            el('div', { color: c.faint, fontSize: '12px' }, '判据 · ' + ch.criteria),
          );
          box.appendChild(r);
        });
        pad.appendChild(box);
      }
    }

    const open = s.data!.promises.filter((p) => p.section === 'open');
    const owners = [...new Set([...open.map((p) => p.owner), ...(w?.people ?? []).map((x) => x.name)])];
    for (const o of owners) {
      const items = open.filter((p) => p.owner === o);
      const notes = (w?.people ?? []).find((x) => x.name.toLowerCase() === o.toLowerCase());
      if (!items.length && !notes) continue;
      const box = card(c, { gap: '0' });
      box.appendChild(el('div', { fontWeight: '600', fontSize: '13px', paddingBottom: '6px' },
        `${o} · ${items.length} 项${items.some((p) => p.status === '停滞') ? ' · 有停滞' : ''}`));
      if (notes?.note) box.appendChild(el('div', { color: c.warn, fontSize: '12px', padding: '4px 0' }, notes.note));
      items.forEach((p, i) => {
        const r = stackItem(c, i === 0 && !notes?.note, { cursor: p.scope ? 'pointer' : 'default' });
        r.append(el('div', { fontWeight: '500' }, p.title), el('div', { color: c.faint, fontSize: '12px' }, p.body));
        if (p.scope) {
          r.appendChild(el('div', { color: c.faint, fontSize: '12px' }, p.scope));
          r.onclick = () => void openClient(p.scope!);
        }
        box.appendChild(r);
      });
      if (notes?.bullets.length) {
        box.appendChild(el('div', { color: c.faint, fontSize: '12px', padding: '8px 0 4px' }, '周会笔记里要问的'));
        notes.bullets.forEach((b) => box.appendChild(el('div', { color: c.muted, fontSize: '12px' }, b)));
      }
      pad.appendChild(box);
    }
  }

  function topicsView(c: C, pad: HTMLElement): void {
    const w = s.weekly;
    if (!w?.topics.length) { pad.appendChild(note(c, '最新一份 weekly 里没有解析到团队级议题。')); return; }
    pad.appendChild(note(c, `${w.file} · C 段 · ${w.topics.length} 条`));
    w.topics.forEach((t, i) => {
      const key = 't:' + i;
      const box = card(c, { gap: '8px', cursor: 'pointer' });
      const head = el('div', { display: 'flex', gap: '10px', alignItems: 'baseline', flexWrap: 'wrap' });
      head.append(
        el('div', { flex: '1 1 200px', minWidth: '0', fontWeight: '500' }, t.lead),
        el('div', { color: c.faint }, s.collapsed[key] === false ? '收起' : '展开'),
      );
      box.appendChild(head);
      if (s.collapsed[key] === false) {
        box.appendChild(el('div', { color: c.muted }, t.body));
        const row = el('div', { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' });
        row.appendChild(note(c, '标 owner'));
        for (const person of ['我', ...s.data!.people]) {
          const b = ghost(c, person);
          b.onclick = (e) => {
            e.stopPropagation();
            void preview({ kind: 'quick-note', text: `议题 owner=${person}：${t.lead}（${w.file}）` });
          };
          row.appendChild(b);
        }
        box.appendChild(row);
        box.appendChild(note(c, '只标 owner，不建承诺 —— 会作为一行速记落到 inbox。'));
      }
      box.onclick = () => { s.collapsed[key] = s.collapsed[key] === false; render(); };
      pad.appendChild(box);
    });
  }

  function clientsView(c: C, pad: HTMLElement): void {
    const grid = el('div', { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '10px' });
    for (const cl of s.data!.clients) {
      const b = card(c, { cursor: 'pointer', gap: '5px', padding: '12px 14px' });
      b.appendChild(el('div', { fontWeight: '500' }, cl.name));
      b.appendChild(el('div', { color: c.faint }, `${cl.openCount} 项未闭环${cl.lastEntry ? ' · ' + cl.lastEntry : ''}`));
      b.onclick = () => void openClient(cl.slug);
      grid.appendChild(b);
    }
    pad.appendChild(grid);
  }

  function clientView(c: C, d: ClientDetail): HTMLElement {
    const wrap = el('div', { display: 'flex', flexDirection: 'column', gap: '12px' });
    const back = ghost(c, '← 客户列表');
    back.onclick = () => { s.client = null; render(); };
    wrap.append(back, el('div', { fontSize: '16px', fontWeight: '600' }, d.name));

    const block = (title: string, items: string[]) => {
      if (!items.length) return;
      const b = card(c);
      b.appendChild(el('div', { color: c.faint, fontSize: '12px' }, title));
      items.forEach((i) => b.appendChild(el('div', { color: c.muted }, i)));
      wrap.appendChild(b);
    };
    block('当前状态', d.status);
    block('关键人 / 分工', d.people);
    block('产品 / 集成', d.product);

    if (d.promises.length) {
      const list = listBox(c);
      d.promises.forEach((p, i) => list.appendChild(compactRow(c, p, i > 0)));
      wrap.append(el('div', { color: c.faint, fontSize: '12px' }, `未闭环承诺 · ${d.promises.length}`), list);
    }

    if (d.timelineFile) wrap.appendChild(newEntryForm(c, d.timelineFile));

    if (d.timeline.length) {
      const b = card(c);
      b.appendChild(el('div', { color: c.faint, fontSize: '12px' }, 'Timeline'));
      d.timeline.forEach((t) => {
        const r = el('div', { display: 'flex', flexDirection: 'column', gap: '2px', padding: '8px 0', borderBottom: `1px solid ${c.border}` });
        r.append(
          el('div', { color: c.faint, fontSize: '12px' }, t.date),
          el('div', { fontWeight: '500' }, t.title),
          el('div', { color: c.muted, fontSize: '12px' }, t.body),
        );
        b.appendChild(r);
      });
      wrap.appendChild(b);
    }
    return wrap;
  }

  function newEntryForm(c: C, targetRel: string): HTMLElement {
    const box = card(c, { gap: '10px' });
    box.appendChild(el('div', { fontWeight: '600' }, '写一条 Timeline'));
    const title = el('input', {
      border: `1px solid ${c.border}`, borderRadius: '8px', padding: '9px 12px',
      background: c.bg, color: c.text, fontFamily: FONT, fontSize: '13px', outline: 'none',
    });
    title.placeholder = '标题（会成为 ## 日期 — 标题）';
    const body = el('textarea', {
      border: `1px solid ${c.border}`, borderRadius: '8px', padding: '9px 12px', minHeight: '76px',
      background: c.bg, color: c.text, fontFamily: FONT, fontSize: '13px', outline: 'none', resize: 'vertical',
    });
    body.placeholder = '正文，一行一条 —— 写了就是判据，别写“再看看”';
    const go = primary(c, '预览写入');
    go.onclick = () => {
      if (!title.value.trim()) return;
      void preview({ kind: 'client-entry', targetRel, title: title.value.trim(), body: body.value });
    };
    box.append(title, body, note(c, '→ ' + targetRel), go);
    return box;
  }

  function inboxView(c: C, pad: HTMLElement): void {
    const { file, lines } = s.data!.inbox;
    pad.appendChild(note(c, `${file} · ${lines.length} 行`));
    for (const l of lines) {
      const b = card(c, { gap: '6px' });
      b.appendChild(el('div', {}, (l.time ? l.time + '  ' : '') + l.text));
      if (l.archived.length) {
        b.appendChild(el('div', { color: c.ok }, '已归档 → ' + l.archived.join('、')));
      } else {
        const go = ghost(c, '归档到…');
        go.onclick = () => pickTarget('归档写入哪个文件', l.text, null, (rel) => {
          const entry = `## ${s.data!.today} — ${l.text.slice(0, 24)}\n- ${l.text}\n- 来源 → ${file}${l.time ? '（' + l.time + '）' : ''}\n`;
          void preview({ kind: 'archive', lineIndex: l.index, targetRel: rel, entry });
        });
        b.appendChild(go);
      }
      pad.appendChild(b);
    }
  }

  /* ── diff panel ────────────────────────────────────────────────── */

  function diffPanel(c: C, hunks: DiffHunk[]): HTMLElement {
    const box = card(c, { borderColor: c.accent, gap: '12px' });
    box.appendChild(el('div', { fontWeight: '600' }, '写入预览 —— 确认后才落盘'));
    for (const h of hunks) {
      const b = el('div', { display: 'flex', flexDirection: 'column', gap: '4px' });
      b.appendChild(el('div', { color: c.faint }, h.file));
      const pre = el('pre', {
        margin: '0', padding: '10px 12px', borderRadius: '8px', background: c.raised,
        overflowX: 'auto', fontSize: '13px', lineHeight: '1.7', whiteSpace: 'pre-wrap',
      });
      pre.innerHTML = [
        ...h.before.map((l) => `<span style="color:${c.faint}">  ${esc(l) || ' '}</span>`),
        ...h.added.map((l) => `<span style="display:block;background:${c.okBg};color:${c.text}">+ ${esc(l) || ' '}</span>`),
        ...h.after.map((l) => `<span style="color:${c.faint}">  ${esc(l) || ' '}</span>`),
      ].join('\n');
      b.appendChild(pre);
      box.appendChild(b);
    }
    const row = el('div', { display: 'flex', gap: '8px', flexWrap: 'wrap' });
    const yes = primary(c, '确认写入');
    yes.onclick = () => void commit();
    const no = ghost(c, '取消');
    no.onclick = () => { s.pending = null; render(); };
    row.append(yes, no);
    box.appendChild(row);
    return box;
  }

  /* ── primitives ────────────────────────────────────────────────── */

  function card(c: C, extra?: Partial<CSSStyleDeclaration>): HTMLElement {
    return el('div', {
      background: c.surface, border: `1px solid ${c.border}`, borderRadius: '8px',
      padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px',
      ...(extra || {}),
    });
  }
  function primary(c: C, label: string): HTMLButtonElement {
    return el('button', {
      padding: '7px 14px', borderRadius: '999px', border: 'none', cursor: 'pointer',
      background: c.accent, color: '#fff', fontFamily: FONT, fontSize: '13px',
      fontWeight: '600', alignSelf: 'flex-start',
    }, label);
  }
  function ghost(c: C, label: string): HTMLButtonElement {
    return el('button', {
      padding: '6px 12px', borderRadius: '999px', cursor: 'pointer',
      border: `1px solid ${c.border}`, background: 'transparent', color: c.muted,
      fontFamily: FONT, fontSize: '13px', alignSelf: 'flex-start',
    }, label);
  }
  function note(c: C, text: string): HTMLElement {
    return el('div', { color: c.faint, fontSize: '12px' }, text);
  }
  function banner(c: C, color: string, text: string): HTMLElement {
    const b = card(c, { borderLeft: `2px solid ${color}`, gap: '4px' });
    b.appendChild(el('div', { color: c.text, fontSize: '13px' }, text));
    return b;
  }
  function pathPrompt(c: C, msg: string): HTMLElement {
    const b = card(c, { gap: '10px' });
    b.appendChild(el('div', { color: c.muted }, msg));
    const i = el('input', {
      border: `1px solid ${c.border}`, borderRadius: '6px', padding: '8px 10px',
      background: c.bg, color: c.text, fontFamily: FONT, fontSize: '13px', outline: 'none',
    });
    i.placeholder = '/Users/you/Library/Mobile Documents/…/workbuddy_icloud_vault';
    i.value = localStorage.getItem(LS_KEY) || '';
    const go = primary(c, '用这个路径');
    go.onclick = () => { if (i.value.trim()) { localStorage.setItem(LS_KEY, i.value.trim()); void load(); } };
    const clear = ghost(c, '清除，改用当前项目');
    clear.onclick = () => { localStorage.removeItem(LS_KEY); void load(); };
    b.append(i, go, clear);
    return b;
  }

  void load();
  const unsub = api.onContextChange((ctx) => {
    if (!localStorage.getItem(LS_KEY) && ctx.project?.path !== s.data?.vaultPath) void load();
    else render();
  });
  (container as any)._mkUnsub = unsub;
}

export function unmount(container: HTMLElement): void {
  (container as any)._mkUnsub?.();
  delete (container as any)._mkUnsub;
  container.innerHTML = '';
}

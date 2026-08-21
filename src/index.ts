/**
 * manager-kanban — frontend entry.
 * Vanilla DOM, host-themed. Four chip tabs: 在推 / 周会 / 客户 / Inbox.
 * Initiative cards grouped by publisher; compact rows expand one at a time.
 */

import type {
  ClientDetail, DetectResult, DiffHunk, Initiative, PluginAPI, PluginContext,
  Status, VaultData, Weekly, WriteAction,
} from './types.js';

const STALE_DAYS = 10;

/** Duplicated from types.ts — the host loads this file as a single module, so runtime relative imports fail. */
const REQUIRED_BY_STATUS: Record<Status, string[]> = {
  idea: ['review_date'],
  executing: ['owner', 'next_action', 'review_date'],
  blocked: ['owner', 'blocker', 'waiting_on', 'blocked_since', 'next_action', 'review_date'],
  closed: [],
};

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

const STATUS_LABEL: Record<Status, string> = {
  idea: '💡 idea', executing: '🟢 executing', blocked: '⛔️ blocked', closed: '⚫ closed',
};

const COLUMNS: Status[] = ['idea', 'executing', 'blocked', 'closed'];

const FIELD_LABEL: Record<string, string> = {
  owner: 'owner', next_action: '下一步动作', review_date: '复核日',
  blocker: '卡在什么上', waiting_on: '等谁', blocked_since: '卡住起始日',
};

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

type View = 'board' | 'weekly' | 'clients' | 'inbox';

const VIEWS: [View, string][] = [
  ['board', '在推'], ['weekly', '周会'], ['clients', '客户'], ['inbox', 'Inbox'],
];

const LS_KEY = 'manager-kanban:vault-path';

interface Picker { title: string; query: string; onPick: (rel: string) => void; suggestions?: string[]; }

interface Gate { slug: string; next: Status; fields: string[]; }

interface State {
  view: View;
  data: VaultData | null;
  weekly: Weekly | null;
  client: ClientDetail | null;
  error: string | null;
  detect: DetectResult | null;
  loading: boolean;
  expanded: string | null;
  logFor: string | null;
  pending: { action: WriteAction; hunks: DiffHunk[] } | null;
  collapsed: Record<string, boolean>;
  picker: Picker | null;
  gate: Gate | null;
}

/* ── mount ───────────────────────────────────────────────────────── */

export function mount(container: HTMLElement, api: PluginAPI): void {
  const s: State = {
    view: 'board', data: null, weekly: null, client: null, error: null, detect: null,
    loading: false, expanded: null, logFor: null, pending: null, collapsed: {},
    picker: null, gate: null,
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
      s.picker = null; s.gate = null;
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

  const plusDays = (base: string, n: number): string => {
    const d = new Date(base + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  /* ── status transition (hard gate) ─────────────────────────────── */

  function requestStatus(i: Initiative, next: Status): void {
    if (next === i.status) return;
    const have = (k: string) => ({
      owner: i.owner, next_action: i.nextAction, review_date: i.reviewDate,
      blocker: i.blocker, waiting_on: i.waitingOn, blocked_since: i.blockedSince,
    } as Record<string, string | null>)[k];
    const lacking = (REQUIRED_BY_STATUS[next] || []).filter((k) => !have(k));
    if (next === 'closed') {
      s.gate = { slug: i.slug, next, fields: ['conclusion', 'criteria'] };
      render();
      return;
    }
    if (lacking.length) { s.gate = { slug: i.slug, next, fields: lacking }; render(); return; }
    void preview({ kind: 'patch-initiative', slug: i.slug, fields: { status: next } });
  }

  function gatePanel(c: C, g: Gate): HTMLElement {
    const i = s.data!.initiatives.find((x) => x.slug === g.slug)!;
    const box = card(c, { borderColor: c.warn, gap: '10px' });
    box.appendChild(el('div', { fontWeight: '600' },
      g.next === 'closed' ? `关掉「${i.title}」— 先写结论` : `标 ${STATUS_LABEL[g.next]} 缺字段`));

    const inputs: Record<string, HTMLInputElement> = {};
    const labels: Record<string, string> = {
      ...FIELD_LABEL, conclusion: '结论', criteria: '判据（什么算成/不成）',
    };
    for (const k of g.fields) {
      const l = el('label', { display: 'flex', flexDirection: 'column', gap: '5px' });
      l.appendChild(el('span', { color: c.faint }, labels[k] || k));
      const inp = el('input', {
        border: `1px solid ${c.border}`, borderRadius: '8px', padding: '9px 12px',
        background: c.bg, color: c.text, fontFamily: FONT, fontSize: '13px', outline: 'none',
      });
      if (k === 'review_date') inp.value = plusDays(s.data!.today, 7);
      if (k === 'blocked_since') inp.value = s.data!.today;
      if (k === 'owner') inp.placeholder = s.data!.people.join(' / ');
      inputs[k] = inp;
      l.appendChild(inp);
      box.appendChild(l);
    }

    if (g.fields.includes('review_date') || g.fields.includes('blocked_since')) {
      box.appendChild(note(c, '日期已预填（复核日 = 今天 +7 天），可改。'));
    }
    if (g.next === 'closed') {
      box.appendChild(note(c, '给不出判据就说明真实状态是「倾向不做」—— 那就写成这句。归档留给你自己定期做。'));
    }

    const go = primary(c, '预览写入');
    go.onclick = () => {
      const fields: Record<string, string> = { status: g.next };
      let log: string | undefined;
      for (const k of g.fields) {
        const v = inputs[k].value.trim();
        if (!v) { s.error = `${labels[k] || k} 不能空`; render(); return; }
        if (k === 'conclusion' || k === 'criteria') continue;
        fields[k] = v;
      }
      if (g.next === 'closed') {
        log = `结案：${inputs.conclusion.value.trim()}（判据：${inputs.criteria.value.trim()}）`;
      }
      void preview({ kind: 'patch-initiative', slug: g.slug, fields, log });
    };
    const cancel = ghost(c, '取消');
    cancel.onclick = () => { s.gate = null; render(); };
    const row = el('div', { display: 'flex', gap: '8px', flexWrap: 'wrap' });
    row.append(go, cancel);
    box.appendChild(row);
    return box;
  }

  /* ── target suggestion ─────────────────────────────────────────── */

  function suggestTargets(text: string): string[] {
    const out: string[] = [];
    const lower = text.toLowerCase();
    for (const cl of s.data?.clients ?? []) {
      const hit = lower.includes(cl.slug.toLowerCase())
        || cl.name.split(/\s+/).some((w) => w.length > 1 && text.includes(w));
      if (hit && cl.timelineFile && !out.includes(cl.timelineFile)) out.push(cl.timelineFile);
    }
    return out.slice(0, 3);
  }

  function pickTarget(title: string, text: string, onPick: (rel: string) => void): void {
    s.picker = { title, query: '', onPick, suggestions: suggestTargets(text) };
    render();
  }

  /* ── render ────────────────────────────────────────────────────── */

  function render(): void {
    const c = colors(api.context.theme === 'dark');
    root.style.background = c.bg;
    root.style.color = c.text;
    root.innerHTML = '';
    root.appendChild(chipBar(c));

    const pad = el('div', { padding: '14px 16px 40px', display: 'flex', flexDirection: 'column', gap: '12px' });
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
    if (s.pending) pad.appendChild(diffPanel(c, s.pending.hunks));
    if (s.gate) pad.appendChild(gatePanel(c, s.gate));
    if (s.picker) pad.appendChild(pickerPanel(c, s.picker));

    if (s.client) { pad.appendChild(clientView(c, s.client)); return; }

    if (s.view === 'board') boardView(c, pad);
    else if (s.view === 'weekly') weeklyView(c, pad);
    else if (s.view === 'clients') clientsView(c, pad);
    else inboxView(c, pad);
  }

  function chipBar(c: C): HTMLElement {
    const bar = el('div', {
      position: 'sticky', top: '0', zIndex: '5', background: c.surface,
      borderBottom: `1px solid ${c.border}`, padding: '10px 16px',
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
      chip.onclick = () => { s.view = v; s.client = null; s.expanded = null; s.logFor = null; render(); };
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

  /* ── board: publisher groups, executing+blocked first ──────────── */

  function todayLine(): string {
    const live = s.data!.initiatives.filter((i) => i.status === 'executing' || i.status === 'blocked');
    const due = live.filter((i) => (i.reviewIn ?? 99) <= 0)
      .sort((a, b) => (a.reviewIn ?? 0) - (b.reviewIn ?? 0));
    const blocked = live.filter((i) => i.status === 'blocked');
    const stale = live.filter((i) => (i.staleDays ?? 0) > STALE_DAYS);

    const parts: string[] = [];
    if (due.length) parts.push(`${due.length} 张该催了，最久的是「${due[0].title}」`);
    if (blocked.length) parts.push(`${blocked.length} 张卡在外部`);
    if (stale.length) parts.push(`${stale.length} 张超过 ${STALE_DAYS} 天没推进`);
    return parts.length ? parts.join('；') + '。' : '没有到期的卡 —— 今天可以做长线。';
  }

  function statusTint(c: C, st: Status): string {
    return st === 'executing' ? c.ok : st === 'blocked' ? c.warn : st === 'idea' ? c.accent : c.faint;
  }

  function boardView(c: C, pad: HTMLElement): void {
    const all = s.data!.initiatives;
    const live = all.filter((i) => i.status === 'executing' || i.status === 'blocked');
    const due = live.filter((i) => (i.reviewIn ?? 99) <= 0).length;

    const head = card(c, { gap: '6px', borderColor: due ? c.danger : c.border });
    head.appendChild(el('div', { color: c.faint, letterSpacing: '0.1em' }, `今日 · ${s.data!.today}`));
    head.appendChild(el('div', { fontSize: '15px', fontWeight: '600', lineHeight: '1.5' }, todayLine()));
    pad.appendChild(head);

    const board = el('div', {
      display: 'grid', gridAutoFlow: 'column', gridAutoColumns: 'minmax(280px, 1fr)',
      gap: '12px', overflowX: 'auto', alignItems: 'start', paddingBottom: '6px',
    });

    for (const st of COLUMNS) {
      const items = all.filter((i) => i.status === st)
        .sort((a, b) => (a.reviewIn ?? 999) - (b.reviewIn ?? 999));

      const col = el('div', { display: 'flex', flexDirection: 'column', gap: '8px', minWidth: '0' });
      const h = el('div', {
        display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 2px 0',
        borderTop: `2px solid ${statusTint(c, st)}`, paddingTop: '8px',
      });
      h.append(
        el('div', { fontWeight: '600', color: statusTint(c, st) }, STATUS_LABEL[st]),
        el('div', { marginLeft: 'auto', color: c.faint }, String(items.length)),
      );
      col.appendChild(h);

      if (!items.length) {
        col.appendChild(el('div', {
          border: `1px dashed ${c.border}`, borderRadius: '10px', padding: '14px',
          color: c.faint, textAlign: 'center',
        }, '空'));
      }
      for (const i of items) col.appendChild(kanbanCard(c, i));
      board.appendChild(col);
    }
    pad.appendChild(board);
  }

  function kanbanCard(c: C, i: Initiative): HTMLElement {
    const open = s.expanded === i.slug;
    const overdue = (i.reviewIn ?? 99) <= 0 && i.status !== 'closed';
    const stale = (i.staleDays ?? 0) > STALE_DAYS && i.status !== 'closed';
    const entity = i.publisher || i.project;

    const wrap = el('div', {
      background: open ? c.raised : c.surface,
      border: `1px solid ${overdue ? c.danger : c.border}`,
      borderLeft: `3px solid ${statusTint(c, i.status)}`,
      borderRadius: '10px', cursor: 'pointer', overflow: 'hidden',
    });

    const body = el('div', { padding: '11px 13px', display: 'flex', flexDirection: 'column', gap: '6px' });

    if (entity) {
      const ent = el('div', { color: c.faint, letterSpacing: '0.08em', display: 'flex', gap: '6px', flexWrap: 'wrap' });
      const name = s.data!.clients.find((cl) => cl.slug === entity)?.name || entity;
      ent.appendChild(el('span', {}, name));
      if (i.owner) ent.appendChild(el('span', {}, '· ' + i.owner));
      body.appendChild(ent);
    }

    body.appendChild(el('div', {
      fontWeight: '600', lineHeight: '1.45',
      display: open ? 'block' : '-webkit-box', overflow: 'hidden',
      ...(open ? {} : { WebkitLineClamp: '2', WebkitBoxOrient: 'vertical' } as any),
    }, i.title));

    const sub = i.status === 'blocked'
      ? `卡在 ${i.blocker || '?'}${i.waitingOn ? ' · 等 ' + i.waitingOn : ''}`
      : i.status === 'closed' ? (i.log[0]?.text || '已关闭')
      : (i.nextAction || '没写下一步');
    body.appendChild(el('div', {
      color: i.status === 'blocked' ? c.warn : c.faint, lineHeight: '1.45',
      display: open ? 'block' : '-webkit-box', overflow: 'hidden',
      ...(open ? {} : { WebkitLineClamp: '2', WebkitBoxOrient: 'vertical' } as any),
    }, sub));

    const foot = el('div', { display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' });
    if (i.status !== 'closed') {
      foot.appendChild(el('span', {
        fontWeight: '600',
        color: overdue ? c.danger : (i.reviewIn ?? 99) <= 3 ? c.warn : c.faint,
      }, i.reviewDate
        ? ((i.reviewIn ?? 0) < 0 ? `逾期 ${-(i.reviewIn ?? 0)}天` : (i.reviewIn === 0 ? '今天到期' : `${i.reviewIn}天`))
        : '无复核日'));
    }
    if (stale) foot.appendChild(el('span', { color: c.warn }, `${i.staleDays}天未推`));
    if (i.missing.length) foot.appendChild(el('span', { color: c.danger }, '缺字段'));
    if (i.status === 'blocked' && i.blockedSince) foot.appendChild(el('span', { color: c.faint }, '自 ' + i.blockedSince));
    if (foot.childElementCount) body.appendChild(foot);

    wrap.appendChild(body);
    wrap.onclick = () => {
      s.expanded = open ? null : i.slug;
      if (s.logFor !== i.slug) s.logFor = null;
      render();
    };
    if (open) wrap.appendChild(initDetail(c, i));
    return wrap;
  }

  function initRow(c: C, i: Initiative, divider: boolean): HTMLElement {
    const open = s.expanded === i.slug;
    const wrap = el('div', {
      background: open ? c.raised : c.surface,
      borderTop: divider ? `1px solid ${c.border}` : 'none',
    });

    const overdue = (i.reviewIn ?? 99) <= 0;
    const stale = (i.staleDays ?? 0) > STALE_DAYS;

    const row = el('div', {
      display: 'grid', gridTemplateColumns: '70px minmax(0,1fr) auto',
      gap: '4px 12px', alignItems: 'center', padding: '9px 14px', cursor: 'pointer',
    });
    row.appendChild(el('div', {
      fontWeight: '600', whiteSpace: 'nowrap',
      color: overdue ? c.danger : (i.reviewIn ?? 99) <= 3 ? c.warn : c.muted,
    }, i.reviewDate
      ? ((i.reviewIn ?? 0) < 0 ? `逾期 ${-(i.reviewIn ?? 0)}` : (i.reviewIn === 0 ? '今天' : `${i.reviewIn}天`))
      : '无日期'));

    const mid = el('div', { minWidth: '0', display: 'flex', flexDirection: 'column', gap: '1px' });
    mid.appendChild(el('div', {
      whiteSpace: open ? 'normal' : 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      fontWeight: i.status === 'blocked' ? '600' : '400',
    }, i.title));
    const sub = i.status === 'blocked'
      ? `卡在 ${i.blocker || '?'}${i.waitingOn ? ' · 等 ' + i.waitingOn : ''}`
      : (i.nextAction || '没写下一步');
    mid.appendChild(el('div', {
      color: i.status === 'blocked' ? c.warn : c.faint,
      whiteSpace: open ? 'normal' : 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    }, sub));
    row.appendChild(mid);

    const right = el('div', { display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' });
    if (i.owner) right.appendChild(el('span', { color: c.faint }, i.owner));
    right.appendChild(el('span', {
      padding: '2px 9px', borderRadius: '999px', border: `1px solid ${c.border}`,
      color: i.status === 'executing' ? c.ok : i.status === 'blocked' ? c.warn : c.faint,
    }, STATUS_LABEL[i.status]));
    if (stale) right.appendChild(el('span', { color: c.warn }, `${i.staleDays}天未推`));
    if (i.missing.length) right.appendChild(el('span', { color: c.danger }, '缺字段'));
    row.appendChild(right);

    row.onclick = () => {
      s.expanded = open ? null : i.slug;
      if (s.logFor !== i.slug) s.logFor = null;
      render();
    };
    wrap.appendChild(row);

    if (open) wrap.appendChild(initDetail(c, i));
    return wrap;
  }

  function initDetail(c: C, i: Initiative): HTMLElement {
    const box = el('div', { padding: '0 14px 12px', display: 'flex', flexDirection: 'column', gap: '10px' });
    box.onclick = (e) => e.stopPropagation();

    const meta: string[] = [];
    if (i.blockedSince) meta.push(`卡住起始 ${i.blockedSince}`);
    if (i.lastProgress) meta.push(`最后推进 ${i.lastProgress}`);
    if (i.created) meta.push(`建卡 ${i.created}`);
    meta.push(i.file);
    box.appendChild(note(c, meta.join('  ·  ')));

    if (i.missing.length) {
      box.appendChild(el('div', { color: c.danger },
        `${STATUS_LABEL[i.status]} 缺：${i.missing.map((k) => FIELD_LABEL[k] || k).join('、')}`));
    }

    // status buttons
    const sRow = el('div', { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' });
    sRow.appendChild(note(c, '改状态'));
    for (const st of ['idea', 'executing', 'blocked', 'closed'] as Status[]) {
      const on = st === i.status;
      const b = el('button', {
        padding: '6px 12px', borderRadius: '999px', cursor: on ? 'default' : 'pointer',
        border: `1px solid ${on ? c.accent : c.border}`,
        background: on ? c.accent : 'transparent',
        color: on ? '#fff' : c.muted, fontFamily: FONT, fontSize: '13px',
      }, STATUS_LABEL[st]);
      if (!on) b.onclick = () => requestStatus(i, st);
      sRow.appendChild(b);
    }
    box.appendChild(sRow);

    const actions = el('div', { display: 'flex', gap: '8px', flexWrap: 'wrap' });
    const logBtn = ghost(c, s.logFor === i.slug ? '收起' : '记一次推进');
    logBtn.onclick = () => { s.logFor = s.logFor === i.slug ? null : i.slug; render(); };
    const dateBtn = ghost(c, '改复核日');
    dateBtn.onclick = () => {
      const v = window.prompt('新的复核日（YYYY-MM-DD）', i.reviewDate || plusDays(s.data!.today, 7));
      if (v) void preview({ kind: 'patch-initiative', slug: i.slug, fields: { review_date: v } });
    };
    const ownerBtn = ghost(c, '改 owner');
    ownerBtn.onclick = () => {
      const v = window.prompt('owner（' + s.data!.people.join(' / ') + '）', i.owner || '');
      if (v) void preview({ kind: 'patch-initiative', slug: i.slug, fields: { owner: v } });
    };
    actions.append(logBtn, dateBtn, ownerBtn);
    if (i.publisher) {
      const go = ghost(c, '去 ' + i.publisher);
      go.onclick = () => void openClient(i.publisher!);
      actions.appendChild(go);
    }
    box.appendChild(actions);

    if (s.logFor === i.slug) box.appendChild(logForm(c, i));

    if (i.log.length) {
      const lg = el('div', { display: 'flex', flexDirection: 'column', gap: '3px', paddingTop: '4px' });
      lg.appendChild(note(c, '日志'));
      for (const entry of i.log.slice(0, 5)) {
        lg.appendChild(el('div', { color: c.muted }, `${entry.date}  ${entry.text}`));
      }
      box.appendChild(lg);
    }
    return box;
  }

  function logForm(c: C, i: Initiative): HTMLElement {
    const box = el('div', {
      borderTop: `1px solid ${c.border}`, paddingTop: '10px',
      display: 'flex', flexDirection: 'column', gap: '8px',
    });
    const text = el('input', {
      border: `1px solid ${c.border}`, borderRadius: '8px', padding: '9px 12px',
      background: c.bg, color: c.text, fontFamily: FONT, fontSize: '13px', outline: 'none',
    });
    text.placeholder = '这次真的推进了什么';
    const next = el('input', {
      border: `1px solid ${c.border}`, borderRadius: '8px', padding: '9px 12px',
      background: c.bg, color: c.text, fontFamily: FONT, fontSize: '13px', outline: 'none',
    });
    next.placeholder = '新的 next_action（留空则不改）';
    next.value = i.nextAction || '';
    const review = el('input', {
      border: `1px solid ${c.border}`, borderRadius: '8px', padding: '9px 12px',
      background: c.bg, color: c.text, fontFamily: FONT, fontSize: '13px', outline: 'none',
    });
    review.value = plusDays(s.data!.today, 7);

    const go = primary(c, '预览写入');
    go.onclick = () => {
      if (!text.value.trim()) { s.error = '日志内容不能空'; render(); return; }
      const fields: Record<string, string> = { review_date: review.value.trim() };
      if (next.value.trim() && next.value.trim() !== (i.nextAction || '')) fields.next_action = next.value.trim();
      void preview({ kind: 'patch-initiative', slug: i.slug, fields, log: text.value.trim() });
    };
    box.append(text, next, review, note(c, 'last_progress 会更新为今天，日志插到最上面。'), go);
    return box;
  }

  /* ── target picker ─────────────────────────────────────────────── */

  function pickerPanel(c: C, pk: Picker): HTMLElement {
    const box = card(c, { borderColor: c.accent, gap: '10px' });
    box.appendChild(el('div', { fontWeight: '600' }, pk.title));

    if (pk.suggestions?.length) {
      box.appendChild(note(c, '推荐'));
      const row = el('div', { display: 'flex', flexWrap: 'wrap', gap: '8px' });
      for (const rel of pk.suggestions) {
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
    input.placeholder = '搜客户，或直接写相对路径';
    input.value = pk.query;
    const results = el('div', { display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '220px', overflowY: 'auto' });
    const candidates = s.data!.clients.filter((cl) => cl.timelineFile)
      .map((cl) => ({ label: `${cl.name}  ·  ${cl.slug}`, rel: cl.timelineFile! }));

    const draw = () => {
      results.innerHTML = '';
      const q = input.value.trim().toLowerCase();
      const list = q ? candidates.filter((x) => (x.label + x.rel).toLowerCase().includes(q)) : candidates;
      for (const x of list.slice(0, 40)) {
        const r = el('div', {
          padding: '7px 10px', borderRadius: '8px', cursor: 'pointer', background: c.raised,
          display: 'flex', justifyContent: 'space-between', gap: '10px',
        });
        r.append(el('span', {}, x.label), el('span', { color: c.faint }, x.rel));
        r.onclick = () => pk.onPick(x.rel);
        results.appendChild(r);
      }
      if (q && /\.md$/.test(input.value.trim())) {
        const manual = el('div', {
          padding: '7px 10px', borderRadius: '8px', cursor: 'pointer', background: c.raised, color: c.accent,
        }, '用手填路径：' + input.value.trim());
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

  /* ── weekly ────────────────────────────────────────────────────── */

  function weeklyView(c: C, pad: HTMLElement): void {
    const w = s.weekly;
    if (w?.file) {
      pad.appendChild(note(c, `${w.file} · ${w.date}`));
      if (w.checks.length) {
        const box = card(c, { gap: '10px' });
        box.appendChild(el('div', { fontWeight: '600' }, `必查 · ${w.checks.length} 件`));
        for (const ch of w.checks) {
          const r = el('div', {
            background: c.raised, border: `1px solid ${c.border}`, borderRadius: '8px',
            padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '4px',
          });
          r.append(
            el('div', { fontWeight: '600' }, `${ch.item}  ·  ${ch.who}`),
            el('div', { color: c.muted }, ch.ask),
            el('div', { color: c.faint }, '判据 · ' + ch.criteria),
          );
          box.appendChild(r);
        }
        pad.appendChild(box);
      }
    }

    const live = s.data!.initiatives.filter((i) => i.status === 'executing' || i.status === 'blocked');
    const owners = [...new Set([...live.map((i) => i.owner || '未指派'), ...(w?.people ?? []).map((x) => x.name)])];
    for (const o of owners) {
      const items = live.filter((i) => (i.owner || '未指派') === o);
      const notes = (w?.people ?? []).find((x) => x.name.toLowerCase() === o.toLowerCase());
      if (!items.length && !notes) continue;
      const box = card(c, { gap: '10px' });
      box.appendChild(el('div', { fontWeight: '600', fontSize: '15px' },
        `${o} · ${items.length} 张${items.some((i) => i.status === 'blocked') ? ' · 有 blocked' : ''}`));
      if (notes?.note) box.appendChild(el('div', { color: c.warn }, notes.note));
      for (const i of items) {
        const r = el('div', {
          background: c.raised, border: `1px solid ${c.border}`, borderRadius: '8px',
          padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '4px',
          cursor: i.publisher ? 'pointer' : 'default',
        });
        r.append(
          el('div', {}, i.title),
          el('div', { color: c.muted }, i.status === 'blocked'
            ? `卡在 ${i.blocker || '?'}${i.waitingOn ? ' · 等 ' + i.waitingOn : ''}`
            : (i.nextAction || '没写下一步')),
        );
        if (i.publisher) {
          r.appendChild(el('div', { color: c.accent }, '→ ' + i.publisher));
          r.onclick = () => void openClient(i.publisher!);
        }
        box.appendChild(r);
      }
      if (notes?.bullets.length) {
        box.appendChild(note(c, '周会笔记里要问的'));
        notes.bullets.forEach((b) => box.appendChild(el('div', { color: c.muted }, b)));
      }
      pad.appendChild(box);
    }

    if (w?.topics.length) {
      const box = card(c, { gap: '8px' });
      box.appendChild(el('div', { fontWeight: '600' }, '团队级议题 · 我来讲'));
      w.topics.forEach((t) => {
        const r = el('div', { display: 'flex', flexDirection: 'column', gap: '3px', paddingBottom: '8px', borderBottom: `1px solid ${c.border}` });
        r.append(el('div', { fontWeight: '600' }, t.lead), el('div', { color: c.muted }, t.body));
        box.appendChild(r);
      });
      pad.appendChild(box);
    }
  }

  /* ── clients ───────────────────────────────────────────────────── */

  function clientsView(c: C, pad: HTMLElement): void {
    const grid = el('div', { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '10px' });
    for (const cl of s.data!.clients) {
      const b = card(c, { cursor: 'pointer', gap: '5px', padding: '12px 14px' });
      b.appendChild(el('div', { fontWeight: '600' }, cl.name));
      b.appendChild(el('div', { color: c.faint }, `${cl.openCount} 张在推${cl.lastEntry ? ' · ' + cl.lastEntry : ''}`));
      b.onclick = () => void openClient(cl.slug);
      grid.appendChild(b);
    }
    pad.appendChild(grid);
  }

  function clientView(c: C, d: ClientDetail): HTMLElement {
    const wrap = el('div', { display: 'flex', flexDirection: 'column', gap: '12px' });
    const back = ghost(c, '← 客户列表');
    back.onclick = () => { s.client = null; render(); };
    wrap.append(back, el('div', { fontSize: '17px', fontWeight: '600' }, d.name));

    const block = (title: string, items: string[]) => {
      if (!items.length) return;
      const b = card(c);
      b.appendChild(el('div', { color: c.faint, letterSpacing: '0.1em' }, title));
      items.forEach((i) => b.appendChild(el('div', { color: c.muted }, i)));
      wrap.appendChild(b);
    };
    block('当前状态', d.status);
    block('关键人 / 分工', d.people);
    block('产品 / 集成', d.product);

    const live = d.initiatives.filter((i) => i.status !== 'closed');
    if (live.length) {
      const list = el('div', {
        display: 'flex', flexDirection: 'column',
        border: `1px solid ${c.border}`, borderRadius: '10px', overflow: 'hidden',
      });
      live.forEach((i, n) => list.appendChild(initRow(c, i, n > 0)));
      wrap.append(el('div', { color: c.faint, letterSpacing: '0.1em' }, `在推 · ${live.length} 张`), list);
    }

    if (d.timelineFile) wrap.appendChild(newEntryForm(c, d.timelineFile));

    if (d.timeline.length) {
      const b = card(c);
      b.appendChild(el('div', { color: c.faint, letterSpacing: '0.1em' }, 'Timeline'));
      d.timeline.forEach((t) => {
        const r = el('div', { display: 'flex', flexDirection: 'column', gap: '3px', paddingBottom: '8px', borderBottom: `1px solid ${c.border}` });
        r.append(
          el('div', { color: c.faint }, t.date),
          el('div', { fontWeight: '600' }, t.title),
          el('div', { color: c.muted }, t.body),
        );
        b.appendChild(r);
      });
      wrap.appendChild(b);
    }
    return wrap;
  }

  function newEntryForm(c: C, targetRel: string): HTMLElement {
    const box = card(c, { gap: '10px' });
    box.appendChild(el('div', { fontWeight: '600' }, '写一条 Timeline（已发生的事实）'));
    const title = el('input', {
      border: `1px solid ${c.border}`, borderRadius: '8px', padding: '9px 12px',
      background: c.bg, color: c.text, fontFamily: FONT, fontSize: '13px', outline: 'none',
    });
    title.placeholder = '标题（会成为 ## 日期 — 标题）';
    const body = el('textarea', {
      border: `1px solid ${c.border}`, borderRadius: '8px', padding: '9px 12px', minHeight: '76px',
      background: c.bg, color: c.text, fontFamily: FONT, fontSize: '13px', outline: 'none', resize: 'vertical',
    });
    body.placeholder = '正文，一行一条 —— 只写已发生的事实，状态归 initiative 卡';
    const go = primary(c, '预览写入');
    go.onclick = () => {
      if (!title.value.trim()) return;
      void preview({ kind: 'client-entry', targetRel, title: title.value.trim(), body: body.value });
    };
    box.append(title, body, note(c, '→ ' + targetRel), go);
    return box;
  }

  /* ── inbox ─────────────────────────────────────────────────────── */

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
        go.onclick = () => pickTarget('归档写入哪个文件', l.text, (rel) => {
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
      background: c.surface, border: `1px solid ${c.border}`, borderRadius: '10px',
      padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '8px',
      ...(extra || {}),
    });
  }
  function primary(c: C, label: string): HTMLButtonElement {
    return el('button', {
      padding: '8px 16px', borderRadius: '999px', border: 'none', cursor: 'pointer',
      background: c.accent, color: '#fff', fontFamily: FONT, fontSize: '13px',
      fontWeight: '600', alignSelf: 'flex-start',
    }, label);
  }
  function ghost(c: C, label: string): HTMLButtonElement {
    return el('button', {
      padding: '7px 14px', borderRadius: '999px', cursor: 'pointer',
      border: `1px solid ${c.border}`, background: 'transparent', color: c.muted,
      fontFamily: FONT, fontSize: '13px', alignSelf: 'flex-start',
    }, label);
  }
  function note(c: C, text: string): HTMLElement {
    return el('div', { color: c.faint }, text);
  }
  function banner(c: C, color: string, text: string): HTMLElement {
    const b = card(c, { borderColor: color });
    b.appendChild(el('div', { color }, text));
    return b;
  }
  function pathPrompt(c: C, msg: string): HTMLElement {
    const b = card(c, { gap: '10px' });
    b.appendChild(el('div', { color: c.muted }, msg));
    const i = el('input', {
      border: `1px solid ${c.border}`, borderRadius: '8px', padding: '9px 12px',
      background: c.bg, color: c.text, fontFamily: FONT, fontSize: '13px', outline: 'none',
    });
    i.placeholder = '/Users/you/workbuddy_icloud_vault';
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

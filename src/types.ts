/** CloudCLI plugin API types (copied from cloudcli-plugin-starter). */

export interface PluginContext {
  theme: 'dark' | 'light';
  project: { name: string; path: string } | null;
  session: { id: string; title: string } | null;
}

export interface PluginAPI {
  readonly context: PluginContext;
  onContextChange(callback: (ctx: PluginContext) => void): () => void;
  rpc(method: string, path: string, body?: unknown): Promise<unknown>;
}

export interface PluginModule {
  mount(container: HTMLElement, api: PluginAPI): void | Promise<void>;
  unmount?(container: HTMLElement): void;
}

/* ── domain ─────────────────────────────────────────────────────── */

export type Status = 'idea' | 'executing' | 'blocked' | 'closed';

/** One initiative card = `initiatives/<slug>.md`. Status lives here only. */
export interface Initiative {
  file: string;
  slug: string;
  title: string;
  status: Status;
  owner: string | null;
  publisher: string | null;
  project: string | null;
  created: string | null;
  lastProgress: string | null;
  reviewDate: string | null;
  nextAction: string | null;
  blocker: string | null;
  waitingOn: string | null;
  blockedSince: string | null;
  /** Days since last_progress; null when the field is missing. */
  staleDays: number | null;
  /** Days until review_date; negative = overdue. */
  reviewIn: number | null;
  log: { date: string; text: string }[];
  /** Fields required by `status` that are currently empty. */
  missing: string[];
}

export interface ClientSummary {
  slug: string;
  name: string;
  hubFile: string | null;
  timelineFile: string | null;
  openCount: number;
  lastEntry: string | null;
}

export interface ClientDetail extends ClientSummary {
  status: string[];
  people: string[];
  product: string[];
  timeline: { date: string; title: string; body: string }[];
  docs: { title: string; path: string }[];
  initiatives: Initiative[];
}

export interface InboxLine {
  index: number;
  time: string | null;
  text: string;
  archived: string[];
}

export interface WeeklyCheck { item: string; who: string; ask: string; criteria: string; }
export interface WeeklyPerson { name: string; bullets: string[]; note: string | null; }
export interface WeeklyTopic { lead: string; body: string; }
export interface Weekly {
  file: string; date: string;
  checks: WeeklyCheck[]; people: WeeklyPerson[]; topics: WeeklyTopic[];
}

export interface VaultData {
  vaultPath: string;
  today: string;
  initiatives: Initiative[];
  clients: ClientSummary[];
  people: string[];
  inbox: { file: string; date: string; lines: InboxLine[] };
}

export interface DetectResult {
  isVault: boolean;
  checked: { path: string; ok: boolean }[];
}

/** Required fields per status — the plugin refuses a transition without them. */
export const REQUIRED_BY_STATUS: Record<Status, string[]> = {
  idea: ['review_date'],
  executing: ['owner', 'next_action', 'review_date'],
  blocked: ['owner', 'blocker', 'waiting_on', 'blocked_since', 'next_action', 'review_date'],
  closed: [],
};

export type WriteAction =
  | { kind: 'quick-note'; text: string }
  | { kind: 'archive'; lineIndex: number; targetRel: string; entry: string }
  /** Patch frontmatter fields; `log` prepends a dated line and bumps last_progress. */
  | { kind: 'patch-initiative'; slug: string; fields: Record<string, string>; log?: string }
  | { kind: 'client-entry'; targetRel: string; title: string; body: string };

export interface DiffHunk {
  file: string;
  before: string[];
  added: string[];
  after: string[];
}

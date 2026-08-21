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

/* ── Domain types shared by frontend and server ─────────────────────── */

export type Status = '进行' | '停滞' | '卡外部';

export interface Promise_ {
  id: string;
  title: string;
  body: string;
  owner: string;
  status: Status;
  due: string | null;
  daysLeft: number | null;
  scope: string | null;
  planFile: string | null;
  targetPath: string | null;
  section: 'open' | 'far';
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
  promises: Promise_[];
}

export interface InboxLine {
  index: number;
  time: string | null;
  text: string;
  archived: string[];
}

export interface WeeklyCheck {
  item: string;
  who: string;
  ask: string;
  criteria: string;
}

export interface WeeklyPerson {
  name: string;
  bullets: string[];
  note: string | null;
}

export interface WeeklyTopic {
  lead: string;
  body: string;
}

export interface Weekly {
  file: string;
  date: string;
  checks: WeeklyCheck[];
  people: WeeklyPerson[];
  topics: WeeklyTopic[];
}

export interface VaultData {
  vaultPath: string;
  today: string;
  promises: Promise_[];
  clients: ClientSummary[];
  people: string[];
  inbox: { file: string; date: string; lines: InboxLine[] };
}

export interface DetectResult {
  isVault: boolean;
  checked: { path: string; ok: boolean }[];
}

export type WriteAction =
  | { kind: 'quick-note'; text: string }
  | { kind: 'archive'; lineIndex: number; targetRel: string; entry: string }
  | { kind: 'backfill'; promiseId: string; conclusion: string; criteria: string; next: string; review: string; targetRel: string }
  | { kind: 'reschedule'; promiseId: string; review: string }
  | { kind: 'set-owner'; promiseId: string; owner: string }
  | { kind: 'client-entry'; targetRel: string; title: string; body: string };

export interface DiffHunk {
  file: string;
  before: string[];
  added: string[];
  after: string[];
}

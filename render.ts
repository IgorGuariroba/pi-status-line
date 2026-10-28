// Pure rendering logic for the status line. No pi imports so it can be unit-tested with plain Node.

export type Color = "accent" | "success" | "warning" | "error" | "muted" | "dim" | "text";

export interface Painter {
	fg(color: Color, text: string): string;
	bold(text: string): string;
}

export interface StatusState {
	cwd: string;
	home?: string;
	branch: string | null;
	dirty: boolean;
	model?: string;
	thinking?: string;
	contextPercent: number | null;
	cost: number;
	running: boolean;
	turns: number;
	extensionStatuses: string[];
}

/** Width measurement and truncation are injected (pi-tui in production, a simple fallback in tests). */
export interface Measure {
	width(text: string): number;
	truncate(text: string, width: number, ellipsis?: string): string;
}

const SEP = "  │  ";

/** Last `parts` path segments, prefixed with `~` when inside home. */
export function shortPath(cwd: string, home?: string, parts = 2): string {
	let p = cwd.replace(/\/+$/, "") || "/";
	let prefix = "";
	if (home && (p === home || p.startsWith(`${home}/`))) {
		p = p.slice(home.length);
		prefix = "~";
		if (!p) return "~";
	}
	const segs = p.split("/").filter(Boolean);
	if (segs.length <= parts) return `${prefix}/${segs.join("/")}`.replace(/^\/$/, "/");
	return segs.slice(-parts).join("/");
}

const NOT_ISSUE_PREFIXES = new Set(["release", "hotfix", "feature", "feat", "fix", "bugfix", "chore", "v", "rc"]);

/** Extracts a Jira-style key (e.g. FRSN-1234) from a branch name such as `feature/frsn-1234-ajuste`. */
export function issueKey(branch: string | null | undefined): string | undefined {
	if (!branch) return undefined;
	const re = /(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9})-(\d+)(?![A-Za-z])/g;
	for (let m = re.exec(branch); m; m = re.exec(branch)) {
		if (NOT_ISSUE_PREFIXES.has(m[1].toLowerCase())) continue;
		return `${m[1].toUpperCase()}-${m[2]}`;
	}
	return undefined;
}

/** Compact model id: `claude-opus-5-5` → `opus-5-5`, `moonshotai/kimi-k2.6` → `kimi-k2.6`, drops date suffixes. */
export function shortModel(id: string): string {
	return id
		.replace(/^.*\//, "")
		.replace(/^claude-/, "")
		.replace(/-\d{8}$/, "")
		.replace(/-latest$/, "");
}

export function contextColor(percent: number): Color {
	if (percent >= 85) return "error";
	if (percent >= 60) return "warning";
	return "success";
}

export function contextBar(percent: number | null, p: Painter, cells = 8): string {
	if (percent === null || Number.isNaN(percent)) return p.fg("dim", "ctx ?");
	const clamped = Math.max(0, Math.min(100, percent));
	// Any usage shows at least one cell, so the bar never looks empty while context is in use.
	const filled = clamped > 0 ? Math.max(1, Math.round((clamped / 100) * cells)) : 0;
	const color = contextColor(clamped);
	const bar = p.fg(color, "█".repeat(filled)) + p.fg("dim", "░".repeat(cells - filled));
	return `${p.fg("dim", "ctx")} ${bar} ${p.fg(color, `${Math.round(clamped)}%`)}`;
}

export function formatCost(cost: number): string | undefined {
	if (!cost || cost <= 0) return undefined;
	return cost < 10 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(1)}`;
}

export function sanitize(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

interface Segment {
	text: string;
	/** Lower = dropped first when the line does not fit. Undefined = never dropped. */
	dropPriority?: number;
}

export function buildSegments(s: StatusState, p: Painter): Segment[] {
	const segs: Segment[] = [];

	segs.push({ text: p.fg("accent", shortPath(s.cwd, s.home)) });

	if (s.branch) {
		const key = issueKey(s.branch);
		const label = key ?? s.branch;
		const dirty = s.dirty ? ` ${p.fg("warning", "●")}` : "";
		segs.push({ text: `${p.fg("text", label)}${dirty}` });
	}

	if (s.model) {
		const thinking = s.thinking && s.thinking !== "off" ? p.fg("muted", ` · ${s.thinking}`) : "";
		segs.push({ text: `${p.fg("muted", shortModel(s.model))}${thinking}`, dropPriority: 3 });
	}

	segs.push({ text: contextBar(s.contextPercent, p) });

	const cost = formatCost(s.cost);
	if (cost) segs.push({ text: p.fg("muted", cost), dropPriority: 2 });

	if (s.running) segs.push({ text: p.fg("accent", "● rodando"), dropPriority: 1 });
	else if (s.turns > 0) segs.push({ text: `${p.fg("success", "✓")}${p.fg("dim", ` turno ${s.turns}`)}`, dropPriority: 1 });

	for (const status of s.extensionStatuses) {
		const clean = sanitize(status);
		if (clean) segs.push({ text: clean, dropPriority: 0 });
	}

	return segs;
}

/** Joins segments, dropping low-priority ones until the line fits, then truncating as a last resort. */
export function renderLine(s: StatusState, p: Painter, m: Measure, width: number): string {
	let segs = buildSegments(s, p);
	const sep = p.fg("dim", SEP);
	const join = (list: Segment[]) => ` ${list.map((x) => x.text).join(sep)}`;

	let line = join(segs);
	while (m.width(line) > width) {
		const droppable = segs.filter((x) => x.dropPriority !== undefined);
		if (droppable.length === 0) break;
		const min = Math.min(...droppable.map((x) => x.dropPriority as number));
		// Drop the right-most segment with the lowest priority.
		const idx = segs.map((x) => x.dropPriority).lastIndexOf(min);
		segs = segs.filter((_, i) => i !== idx);
		line = join(segs);
	}
	return m.width(line) > width ? m.truncate(line, width, p.fg("dim", "…")) : line;
}

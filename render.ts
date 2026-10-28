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
	/** Tokens currently in context; null when unknown (e.g. right after compaction). */
	contextTokens: number | null;
	/** Model context window; 0 when unknown. */
	contextWindow: number;
	contextPercent: number | null;
	cost: number;
	running: boolean;
	/** User prompts across the whole session (current branch), survives reload/resume. */
	turns: number;
	/** Output speed: live estimate while streaming, last response's exact value when idle. */
	tokensPerSecond?: number;
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

/** Compact token count: 950, 12k, 480k, 1M, 1.5M. */
export function formatTokens(n: number): string {
	if (n < 1000) return `${Math.round(n)}`;
	if (n < 1_000_000) {
		const k = n / 1000;
		return k < 10 ? `${trim(k.toFixed(1))}k` : `${Math.round(k)}k`;
	}
	return `${trim((n / 1_000_000).toFixed(1))}M`;
}

function trim(s: string): string {
	return s.replace(/\.0$/, "");
}

/**
 * Chars-per-token ratio learned from the last finished message (streamed chars vs reported output
 * tokens), smoothed and clamped. Hidden reasoning makes the ratio low, which is what we want: the
 * live estimate then tracks the provider's real output rate.
 */
export function calibrate(prev: number, chars: number, outputTokens: number): number {
	if (!(chars > 0) || !(outputTokens > 0)) return prev;
	const ratio = Math.max(0.5, Math.min(8, chars / outputTokens));
	return prev * 0.3 + ratio * 0.7;
}

/** Tokens per second; undefined when the sample is too short to be meaningful. */
export function tokensPerSecond(tokens: number, ms: number): number | undefined {
	if (!(tokens > 0) || !(ms >= 250)) return undefined;
	return tokens / (ms / 1000);
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

/** Context block. `full`: `ctx ████░░░░ 480k/1M 48%`; compact: `ctx ████░░░░ 1M 48%`. */
export function contextSegment(s: StatusState, p: Painter, full = true): string {
	const bar = contextBar(s.contextPercent, p);
	if (!s.contextWindow) return bar;
	const window = formatTokens(s.contextWindow);
	if (s.contextPercent === null || Number.isNaN(s.contextPercent)) {
		// Unknown usage (e.g. right after compaction): empty bar, size only.
		return `${p.fg("dim", "ctx")} ${p.fg("dim", "░".repeat(8))} ${p.fg("dim", full ? `?/${window}` : window)}`;
	}
	const size = full ? `${s.contextTokens === null ? "?" : formatTokens(s.contextTokens)}/${window}` : window;
	// Insert the size between the bar and the percentage.
	const idx = bar.lastIndexOf(" ");
	return idx < 0 ? `${bar} ${p.fg("dim", size)}` : `${bar.slice(0, idx)} ${p.fg("dim", size)}${bar.slice(idx)}`;
}

export function formatCost(cost: number): string | undefined {
	if (!cost || cost < 0.005) return undefined;
	return cost < 10 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(1)}`;
}

export function sanitize(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

interface Segment {
	text: string;
	/** Lower = shrunk first when the line does not fit. Undefined = never dropped. */
	dropPriority?: number;
	/** Shorter variant tried before dropping; uses `compactPriority` in the same ordering. */
	compact?: string;
	compactPriority?: number;
}

function turnSegment(s: StatusState, p: Painter): Segment | undefined {
	const speed = s.tokensPerSecond ? `${Math.round(s.tokensPerSecond)} tk/s` : undefined;
	if (s.running) {
		const text = p.fg("accent", "●") + p.fg("accent", speed ? ` ${speed}` : " rodando");
		return { text, dropPriority: 1 };
	}
	if (s.turns <= 0 && !speed) return undefined;
	const parts = [s.turns > 0 ? `turno ${s.turns}` : undefined, speed].filter(Boolean).join(" · ");
	return {
		text: `${p.fg("success", "✓")}${p.fg("dim", ` ${parts}`)}`,
		dropPriority: 1,
		compact: speed && s.turns > 0 ? `${p.fg("success", "✓")}${p.fg("dim", ` turno ${s.turns}`)}` : undefined,
		compactPriority: 0.5,
	};
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

	segs.push({ text: contextSegment(s, p, true), compact: contextSegment(s, p, false), compactPriority: 1.5 });

	const cost = formatCost(s.cost);
	if (cost) segs.push({ text: p.fg("muted", cost), dropPriority: 2 });

	const turn = turnSegment(s, p);
	if (turn) segs.push(turn);

	for (const status of s.extensionStatuses) {
		const clean = sanitize(status);
		if (clean) segs.push({ text: clean, dropPriority: 0 });
	}

	return segs;
}

/**
 * Joins segments; while the line does not fit, applies the cheapest reduction first
 * (compact variant or drop, by priority), then truncates as a last resort.
 */
export function renderLine(s: StatusState, p: Painter, m: Measure, width: number): string {
	let segs = buildSegments(s, p);
	const sep = p.fg("dim", SEP);
	const join = (list: Segment[]) => ` ${list.map((x) => x.text).join(sep)}`;

	let line = join(segs);
	while (m.width(line) > width) {
		let best: { idx: number; prio: number; compact: boolean } | undefined;
		segs.forEach((x, idx) => {
			const options: Array<[number | undefined, boolean]> = [
				[x.compact !== undefined ? x.compactPriority : undefined, true],
				[x.dropPriority, false],
			];
			for (const [prio, compact] of options) {
				if (prio === undefined) continue;
				// Ties go to the right-most segment.
				if (!best || prio < best.prio || (prio === best.prio && idx > best.idx)) best = { idx, prio, compact };
			}
		});
		if (!best) break;
		const { idx, compact } = best;
		segs = compact
			? segs.map((x, i) => (i === idx ? { ...x, text: x.compact as string, compact: undefined } : x))
			: segs.filter((_, i) => i !== idx);
		line = join(segs);
	}
	return m.width(line) > width ? m.truncate(line, width, p.fg("dim", "…")) : line;
}

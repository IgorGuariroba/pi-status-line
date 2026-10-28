import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { calibrate, type Measure, type Painter, renderLine, tokensPerSecond } from "./render.ts";

const measure: Measure = {
	width: visibleWidth,
	truncate: (text, width, ellipsis) => truncateToWidth(text, width, ellipsis),
};

/** Session cost, same sources as pi's built-in footer. */
function sessionCost(ctx: ExtensionContext): number {
	let cost = 0;
	for (const e of ctx.sessionManager.getEntries() as any[]) {
		const usage =
			e.type === "usage"
				? e.usage
				: e.type === "message" && (e.message?.role === "assistant" || e.message?.role === "toolResult")
					? e.message.usage
					: (e.type === "branch_summary" || e.type === "compaction") ? e.usage : undefined;
		cost += usage?.cost?.total ?? 0;
	}
	return cost;
}

/** User prompts on the current session branch (includes entries before compaction). */
function sessionTurns(ctx: ExtensionContext): number {
	let n = 0;
	for (const e of ctx.sessionManager.getBranch() as any[]) {
		if (e.type === "message" && e.message?.role === "user") n++;
	}
	return n;
}

/** Characters streamed in a delta event (text, thinking or tool-call arguments). */
function deltaChars(ev: any): number {
	return typeof ev?.delta === "string" ? ev.delta.length : 0;
}

export default function statusLine(pi: ExtensionAPI) {
	let enabled = true;
	let ctxRef: ExtensionContext | undefined;
	let requestRender: (() => void) | undefined;
	let running = false;
	// Speed of the assistant message being streamed, and of the last finished one.
	let stream: { firstDeltaAt?: number; chars: number } | undefined;
	let liveTps: number | undefined;
	let lastTps: number | undefined;
	let lastSpeedRender = 0;
	let charsPerToken = 4;
	let dirty = false;
	let dirtyTimer: ReturnType<typeof setTimeout> | undefined;
	let costCache = { key: "", value: 0 };
	let turnsCache = { key: "", value: 0 };

	const rerender = () => requestRender?.();

	const refreshDirty = (delay = 300) => {
		if (dirtyTimer) clearTimeout(dirtyTimer);
		dirtyTimer = setTimeout(async () => {
			const ctx = ctxRef;
			if (!ctx) return;
			try {
				const r = await pi.exec("git", ["status", "--porcelain", "--untracked-files=normal"], {
					cwd: ctx.cwd,
					timeout: 3000,
				});
				const next = r.code === 0 && r.stdout.trim().length > 0;
				if (next !== dirty) {
					dirty = next;
					rerender();
				}
			} catch {
				// not a repo / git missing: keep previous value
			}
		}, delay);
		dirtyTimer.unref?.();
	};

	const cost = (ctx: ExtensionContext) => {
		const key = `${ctx.sessionManager.getSessionId()}:${ctx.sessionManager.getLeafId()}`;
		if (costCache.key !== key) costCache = { key, value: sessionCost(ctx) };
		return costCache.value;
	};

	const turns = (ctx: ExtensionContext) => {
		const key = `${ctx.sessionManager.getSessionId()}:${ctx.sessionManager.getLeafId()}`;
		if (turnsCache.key !== key) turnsCache = { key, value: sessionTurns(ctx) };
		return turnsCache.value;
	};

	const install = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsubBranch = footerData.onBranchChange(() => {
				refreshDirty(0);
				tui.requestRender();
			});
			const painter: Painter = {
				fg: (color, text) => theme.fg(color, text),
				bold: (text) => theme.bold(text),
			};
			return {
				dispose() {
					unsubBranch();
					requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const c = ctxRef ?? ctx;
					const statuses = [...footerData.getExtensionStatuses().entries()]
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => text);
					const usage = c.getContextUsage();
					const line = renderLine(
						{
							cwd: c.cwd,
							home: process.env.HOME,
							branch: footerData.getGitBranch(),
							dirty,
							model: c.model?.id,
							thinking: c.model?.reasoning ? pi.getThinkingLevel() : undefined,
							contextTokens: usage ? usage.tokens : null,
							contextWindow: usage?.contextWindow ?? c.model?.contextWindow ?? 0,
							contextPercent: usage?.percent ?? null,
							cost: cost(c),
							running,
							turns: turns(c),
							tokensPerSecond: running ? (liveTps ?? lastTps) : lastTps,
							extensionStatuses: statuses,
						},
						painter,
						measure,
						width,
					);
					return [line];
				},
			};
		});
	};

	pi.on("session_start", async (_e, ctx) => {
		ctxRef = ctx;
		running = false;
		stream = undefined;
		liveTps = undefined;
		lastTps = undefined;
		if (enabled) install(ctx);
		refreshDirty(0);
	});

	pi.on("agent_start", async (_e, ctx) => {
		ctxRef = ctx;
		running = true;
		rerender();
	});

	pi.on("agent_end", async (_e, ctx) => {
		ctxRef = ctx;
		running = false;
		refreshDirty(0);
		rerender();
	});

	pi.on("message_start", async (e) => {
		if ((e.message as any)?.role === "assistant") {
			stream = { chars: 0 };
			liveTps = undefined;
		}
	});

	pi.on("message_update", async (e) => {
		if (!stream) return;
		const chars = deltaChars(e.assistantMessageEvent);
		if (!chars) return;
		const now = Date.now();
		stream.firstDeltaAt ??= now;
		stream.chars += chars;
		// Chars-per-token learned from previous messages; refresh the footer at most every 500ms.
		const est = tokensPerSecond(stream.chars / charsPerToken, now - stream.firstDeltaAt);
		if (est !== undefined) liveTps = est;
		if (now - lastSpeedRender >= 500) {
			lastSpeedRender = now;
			rerender();
		}
	});

	pi.on("message_end", async (e) => {
		const msg = e.message as any;
		if (msg?.role !== "assistant" || !stream) return;
		const output = msg.usage?.output ?? 0;
		const exact = stream.firstDeltaAt ? tokensPerSecond(output, Date.now() - stream.firstDeltaAt) : undefined;
		lastTps = exact ?? liveTps ?? lastTps;
		charsPerToken = calibrate(charsPerToken, stream.chars, output);
		liveTps = undefined;
		stream = undefined;
		rerender();
	});

	pi.on("tool_execution_end", async () => refreshDirty());
	pi.on("user_bash", async () => refreshDirty(1000));
	pi.on("turn_end", async () => rerender());
	pi.on("model_select", async () => rerender());
	pi.on("thinking_level_select", async () => rerender());
	pi.on("session_compact", async () => rerender());

	pi.on("session_shutdown", async () => {
		if (dirtyTimer) clearTimeout(dirtyTimer);
		requestRender = undefined;
	});

	pi.registerCommand("status-line", {
		description: "Alterna entre a status line do pi-status-line e o footer padrão",
		handler: async (_args, ctx) => {
			ctxRef = ctx;
			enabled = !enabled;
			if (enabled) {
				install(ctx);
				refreshDirty(0);
				ctx.ui.notify("Status line ativada", "info");
			} else {
				ctx.ui.setFooter(undefined);
				requestRender = undefined;
				ctx.ui.notify("Footer padrão restaurado", "info");
			}
		},
	});
}

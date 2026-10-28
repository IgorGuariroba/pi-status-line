import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type Measure, type Painter, renderLine } from "./render.ts";

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

export default function statusLine(pi: ExtensionAPI) {
	let enabled = true;
	let ctxRef: ExtensionContext | undefined;
	let requestRender: (() => void) | undefined;
	let running = false;
	let turns = 0;
	let dirty = false;
	let dirtyTimer: ReturnType<typeof setTimeout> | undefined;
	let costCache = { key: "", value: 0 };

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
					const line = renderLine(
						{
							cwd: c.cwd,
							home: process.env.HOME,
							branch: footerData.getGitBranch(),
							dirty,
							model: c.model?.id,
							thinking: c.model?.reasoning ? pi.getThinkingLevel() : undefined,
							contextPercent: c.getContextUsage()?.percent ?? null,
							cost: cost(c),
							running,
							turns,
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
		turns = 0;
		if (enabled) install(ctx);
		refreshDirty(0);
	});

	pi.on("agent_start", async (_e, ctx) => {
		ctxRef = ctx;
		running = true;
		turns++;
		rerender();
	});

	pi.on("agent_end", async (_e, ctx) => {
		ctxRef = ctx;
		running = false;
		refreshDirty(0);
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

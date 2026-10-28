import assert from "node:assert/strict";
import { test } from "node:test";
import { contextBar, contextColor, formatCost, issueKey, renderLine, shortModel, shortPath } from "../render.ts";

const plain = { fg: (_c, t) => t, bold: (t) => t };
const tagged = { fg: (c, t) => `<${c}>${t}</${c}>`, bold: (t) => t };
const measure = {
	width: (t) => [...t].length,
	truncate: (t, w, e = "") => [...t].slice(0, w - [...e].length).join("") + e,
};

const base = {
	cwd: "/home/u/projetos/vetor-api",
	home: "/home/u",
	branch: "feature/FRSN-1234-ajuste-filtro",
	dirty: true,
	model: "claude-opus-5-5",
	thinking: "high",
	contextPercent: 48,
	cost: 0.8421,
	running: false,
	turns: 7,
	extensionStatuses: [],
};

test("shortPath keeps the last two segments", () => {
	assert.equal(shortPath("/home/u/projetos/vetor-api", "/home/u"), "~/projetos/vetor-api");
	assert.equal(shortPath("/home/u/projetos/a/vetor-api", "/home/u"), "a/vetor-api");
	assert.equal(shortPath("/home/u/projetos", "/home/u"), "~/projetos");
	assert.equal(shortPath("/home/u", "/home/u"), "~");
	assert.equal(shortPath("/tmp", "/home/u"), "/tmp");
	assert.equal(shortPath("/", "/home/u"), "/");
});

test("issueKey extracts Jira keys from branch names", () => {
	assert.equal(issueKey("feature/FRSN-1234-ajuste"), "FRSN-1234");
	assert.equal(issueKey("snpsm-88"), "SNPSM-88");
	assert.equal(issueKey("bugfix/frsn-7_x"), "FRSN-7");
	assert.equal(issueKey("release-2024"), undefined);
	assert.equal(issueKey("hotfix-12/GMUD-5"), "GMUD-5");
	assert.equal(issueKey("main"), undefined);
	assert.equal(issueKey(null), undefined);
});

test("shortModel drops vendor prefixes and date suffixes", () => {
	assert.equal(shortModel("claude-opus-5-5"), "opus-5-5");
	assert.equal(shortModel("moonshotai/kimi-k2.6"), "kimi-k2.6");
	assert.equal(shortModel("claude-sonnet-4-20250514"), "sonnet-4");
	assert.equal(shortModel("gpt-5"), "gpt-5");
});

test("context colors follow 60/85 thresholds", () => {
	assert.equal(contextColor(10), "success");
	assert.equal(contextColor(60), "warning");
	assert.equal(contextColor(85), "error");
});

test("contextBar renders 8 cells and unknown state", () => {
	assert.equal(contextBar(50, plain), "ctx ████░░░░ 50%");
	assert.equal(contextBar(null, plain), "ctx ?");
	assert.equal(contextBar(0, plain), "ctx ░░░░░░░░ 0%");
	assert.equal(contextBar(6, plain), "ctx █░░░░░░░ 6%");
	assert.match(contextBar(90, tagged), /<error>90%<\/error>/);
});

test("formatCost hides zero", () => {
	assert.equal(formatCost(0), undefined);
	assert.equal(formatCost(0.8421), "$0.84");
	assert.equal(formatCost(12.34), "$12.3");
});

test("full line", () => {
	const line = renderLine(base, plain, measure, 200);
	assert.equal(line, " ~/projetos/vetor-api  │  FRSN-1234 ●  │  opus-5-5 · high  │  ctx ████░░░░ 48%  │  $0.84  │  ✓ turno 7");
});

test("running state and extension statuses", () => {
	const line = renderLine({ ...base, running: true, extensionStatuses: ["herdr\nok"] }, plain, measure, 200);
	assert.match(line, /● rodando  │  herdr ok$/);
});

test("branch without key shows the branch; no repo hides it", () => {
	assert.match(renderLine({ ...base, branch: "main", dirty: false }, plain, measure, 200), /│  main  │/);
	assert.doesNotMatch(renderLine({ ...base, branch: null }, plain, measure, 200), /FRSN/);
});

test("narrow width drops turn, cost, model in that order, keeps path/branch/context", () => {
	const full = renderLine(base, plain, measure, 200);
	const w = measure.width(full);
	assert.doesNotMatch(renderLine(base, plain, measure, w - 1), /turno/);
	const essential = " ~/projetos/vetor-api  │  FRSN-1234 ●  │  ctx ████░░░░ 48%";
	assert.equal(renderLine(base, plain, measure, measure.width(essential)), essential);
	const tiny = renderLine(base, plain, measure, 20);
	assert.equal(measure.width(tiny), 20);
	assert.ok(tiny.endsWith("…"));
});

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	SCHEDULED_RUN_ACTIONS,
	createScheduledRunManager,
	isScheduledRunAction,
	listScheduledRunSummaries,
	parseScheduleInterval,
	parseScheduledRunTime,
	scheduledRunStorePath,
	scheduledRunsEnabled,
	type ScheduledRunManager,
} from "../../src/runs/background/scheduled-runs.ts";
import type { ExtensionConfig } from "../../src/shared/types.ts";

type Timer = { callback: () => void; delay: number };
class FakeTimers {
	readonly values = new Map<number, Timer>();
	private id = 0;
	setTimeout = (callback: () => void, delay: number) => {
		const id = ++this.id;
		this.values.set(id, { callback, delay });
		return id as unknown as ReturnType<typeof setTimeout>;
	};
	clearTimeout = (id: ReturnType<typeof setTimeout>) => void this.values.delete(id as unknown as number);
	fireAll(): void {
		const pending = [...this.values.entries()];
		for (const [id, timer] of pending) {
			this.values.delete(id);
			timer.callback();
		}
	}
}

type Launch = {
	params: Record<string, unknown>;
	resolve(result: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError?: boolean }): void;
};

type Harness = {
	manager: ScheduledRunManager;
	ctx: ExtensionContext;
	clock: { now: number };
	timers: FakeTimers;
	launches: Launch[];
	root: string;
};

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function context(cwd: string, sessionId = "session-a"): ExtensionContext {
	return {
		cwd,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => path.join(cwd, `${sessionId}.jsonl`),
		},
	} as unknown as ExtensionContext;
}

function harness(options: { cwd?: string; sessionId?: string; now?: number; config?: ExtensionConfig } = {}): Harness {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-schedule-test-"));
	roots.push(root);
	const project = options.cwd ?? path.join(root, "project");
	fs.mkdirSync(project, { recursive: true });
	const ctx = context(project, options.sessionId);
	const clock = { now: options.now ?? Date.parse("2030-01-01T00:00:00Z") };
	const timers = new FakeTimers();
	const launches: Launch[] = [];
	let id = 0;
	const manager = createScheduledRunManager({
		config: options.config ?? { scheduledRuns: { enabled: true } },
		storeRoot: path.join(root, "stores"),
		now: () => clock.now,
		randomId: () => `id-${++id}`,
		timers,
		launch: (params) => new Promise((resolve) => launches.push({ params: params as Record<string, unknown>, resolve: resolve as Launch["resolve"] })) as never,
	});
	manager.bindSession(ctx);
	return { manager, ctx, clock, timers, launches, root };
}

function text(result: Awaited<ReturnType<ScheduledRunManager["handleToolCall"]>>): string {
	return result.content[0]?.type === "text" ? result.content[0].text : "";
}

async function flush(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("schedule helpers", () => {
	it("recognizes only the dot-action schedule API", () => {
		assert.deepEqual(SCHEDULED_RUN_ACTIONS, ["schedule.create", "schedule.list", "schedule.show", "schedule.history", "schedule.pause", "schedule.resume", "schedule.run", "schedule.run-due", "schedule.delete"]);
		assert.equal(isScheduledRunAction("schedule.create"), true);
		assert.equal(isScheduledRunAction("schedule"), false);
	});

	it("uses a stable project store independent of session id", () => {
		const root = path.join("tmp", "schedules");
		assert.equal(scheduledRunStorePath("project", "a", root), scheduledRunStorePath("project", "b", root));
		assert.notEqual(scheduledRunStorePath("project", "a", root), scheduledRunStorePath("other", "a", root));
		assert.equal(scheduledRunStorePath("/project"), path.join("/project", ".pi-subagents", "schedules"));
	});

	it("parses one-shot and fixed interval forms strictly", () => {
		const now = Date.parse("2030-01-01T00:00:00Z");
		assert.equal(parseScheduledRunTime("+10m", now), now + 600_000);
		assert.equal(parseScheduledRunTime("2030-01-02T00:00:00Z", now), now + 86_400_000);
		assert.equal(parseScheduledRunTime("2030-01-02T09:00:00+05:30", now), Date.parse("2030-01-02T09:00:00+05:30"));
		assert.equal(parseScheduleInterval("30m"), 1_800_000);
		assert.equal(parseScheduleInterval("2w"), 1_209_600_000);
		assert.throws(() => parseScheduleInterval("day"), /fixed intervals/);
		assert.throws(() => parseScheduledRunTime("2030-01-01T00:00:00", now), /timezone/);
	});

	it("honors the explicit feature opt-out", () => {
		assert.equal(scheduledRunsEnabled({}), true);
		assert.equal(scheduledRunsEnabled({ scheduledRuns: { enabled: false } }), false);
	});
});

describe("project schedule management", () => {
	it("creates a project one-shot schedule and restores it in another session", async () => {
		const first = harness();
		const result = await first.manager.handleToolCall({ action: "schedule.create", id: "night-review", name: "Night review", at: "+10m", agent: "reviewer", task: "Review the diff" }, first.ctx);
		assert.equal(result.isError, undefined);
		assert.match(text(result), /Created schedule night-review/);
		assert.equal(first.timers.values.size, 1);
		const records = listScheduledRunSummaries(first.ctx.cwd, path.join(first.root, "stores"));
		assert.equal(records[0]?.name, "Night review");
		assert.equal(records[0]?.cwd, first.ctx.cwd);

		first.manager.stop();
		const secondTimers = new FakeTimers();
		const second = createScheduledRunManager({
			config: { scheduledRuns: { enabled: true } },
			storeRoot: path.join(first.root, "stores"),
			now: () => first.clock.now,
			timers: secondTimers,
			launch: async () => ({ content: [{ type: "text", text: "unused" }], details: { mode: "management", results: [] } }),
		});
		second.bindSession(context(first.ctx.cwd, "session-b"));
		assert.equal(secondTimers.values.size, 1, "a different session restores the project schedule");
		const shown = await second.handleToolCall({ action: "schedule.show", id: "night-review" }, context(first.ctx.cwd, "session-b"));
		assert.match(text(shown), /Night review/);
	});

	it("stores explicit cwd schedules in the target project", async () => {
		const h = harness();
		const target = path.join(h.root, "other-project");
		fs.mkdirSync(target);
		await h.manager.handleToolCall({ action: "schedule.create", id: "other", cwd: target, every: "1h", agent: "worker" }, h.ctx);
		assert.equal(listScheduledRunSummaries(h.ctx.cwd, path.join(h.root, "stores")).length, 0);
		assert.equal(listScheduledRunSummaries(target, path.join(h.root, "stores"))[0]?.cwd, target);
		const listed = await h.manager.handleToolCall({ action: "schedule.list", cwd: target }, h.ctx);
		assert.match(text(listed), /other/);
	});

	it("supports workflowScript targets and rejects unsafe or deferred shapes", async () => {
		const h = harness();
		const workflow = await h.manager.handleToolCall({ action: "schedule.create", id: "workflow", every: "6h", workflowScript: "return await runs.run('review', {agent:'reviewer'})" }, h.ctx);
		assert.equal(workflow.isError, undefined);
		assert.match(text(workflow), /workflowScript/);
		for (const params of [
			{ action: "schedule.create", id: "../escape", every: "1h", agent: "worker" },
			{ action: "schedule.create", id: "both", at: "+1h", every: "1h", agent: "worker" },
			{ action: "schedule.create", id: "calendar", every: "day", at: "09:00", timezone: "UTC", agent: "worker" },
			{ action: "schedule.create", id: "two-targets", every: "1h", agent: "worker", workflowScript: "return 1" },
			{ action: "schedule.create", id: "fork", every: "1h", agent: "worker", context: "fork" },
		] as const) {
			const result = await h.manager.handleToolCall(params, h.ctx);
			assert.equal(result.isError, true, JSON.stringify(params));
		}
	});

	it("pauses, resumes, lists, and deletes an inactive schedule", async () => {
		const h = harness();
		await h.manager.handleToolCall({ action: "schedule.create", id: "maintenance", every: "1h", agent: "worker" }, h.ctx);
		assert.match(text(await h.manager.handleToolCall({ action: "schedule.list" }, h.ctx)), /maintenance/);
		assert.match(text(await h.manager.handleToolCall({ action: "schedule.pause", id: "maintenance" }, h.ctx)), /Paused/);
		assert.equal(h.timers.values.size, 0);
		assert.match(text(await h.manager.handleToolCall({ action: "schedule.resume", id: "maintenance" }, h.ctx)), /Resumed/);
		assert.equal(h.timers.values.size, 1);
		assert.match(text(await h.manager.handleToolCall({ action: "schedule.delete", id: "maintenance" }, h.ctx)), /Deleted/);
		assert.match(text(await h.manager.handleToolCall({ action: "schedule.list" }, h.ctx)), /No project schedules/);
	});

	it("reports corrupt project schedule records instead of dropping them", async () => {
		const h = harness();
		const root = scheduledRunStorePath(h.ctx.cwd, undefined, path.join(h.root, "stores"));
		const dir = path.join(root, "broken");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "schedule.json"), "{ bad", "utf-8");
		const result = await h.manager.handleToolCall({ action: "schedule.list" }, h.ctx);
		assert.equal(result.isError, true);
		assert.match(text(result), /Failed to read schedule record/);
	});
});

describe("recurring schedule execution", () => {
	it("launches a fixed interval from its planned time and records durable history/events", async () => {
		const h = harness();
		await h.manager.handleToolCall({ action: "schedule.create", id: "hourly", every: "1h", agent: "worker", task: "Maintain backlog", missionId: "mission-1" }, h.ctx);
		h.clock.now += 3_600_000;
		h.timers.fireAll();
		assert.equal(h.launches.length, 1);
		assert.deepEqual(h.launches[0]?.params, { agent: "worker", task: "Maintain backlog", async: true, clarify: false, context: "fresh", cwd: h.ctx.cwd, missionId: "mission-1" });
		h.launches[0]!.resolve({ content: [{ type: "text", text: "Async worker" }], details: { mode: "single", results: [], asyncId: "async-1", asyncDir: "/tmp/async-1" } });
		await flush();

		let history = await h.manager.handleToolCall({ action: "schedule.history", id: "hourly" }, h.ctx);
		assert.match(text(history), /running.*async async-1/);
		const scheduleRoot = scheduledRunStorePath(h.ctx.cwd, undefined, path.join(h.root, "stores"));
		const dir = path.join(scheduleRoot, "hourly");
		assert.equal(fs.existsSync(path.join(dir, "history.json")), true);
		assert.equal(fs.existsSync(path.join(dir, "events.jsonl")), true);
		assert.equal(fs.readdirSync(path.join(dir, "runs")).length, 1);

		h.manager.handleAsyncCompletion({ runId: "async-1", success: true, summary: "Done" });
		history = await h.manager.handleToolCall({ action: "schedule.history", id: "hourly" }, h.ctx);
		assert.match(text(history), /completed.*async async-1/);
		assert.equal(fs.existsSync(path.join(dir, "active.lock")), false);
		const shown = await h.manager.handleToolCall({ action: "schedule.show", id: "hourly" }, h.ctx);
		assert.match(text(shown), /2030-01-01T02:00:00.000Z/, "next occurrence advances from the planned time without completion drift");
	});

	it("run-due launches the latest missed occurrence while catchUp none records a miss", async () => {
		const latest = harness();
		await latest.manager.handleToolCall({ action: "schedule.create", id: "latest", every: "1h", catchUp: "latest", agent: "worker" }, latest.ctx);
		latest.manager.stop();
		latest.clock.now += 3 * 3_600_000;
		latest.manager.bindSession(latest.ctx);
		const duePromise = latest.manager.handleToolCall({ action: "schedule.run-due" }, latest.ctx);
		await flush();
		assert.equal(latest.launches.length, 1);
		latest.launches[0]!.resolve({ content: [{ type: "text", text: "Async" }], details: { mode: "single", results: [], asyncId: "late-1" } });
		assert.match(text(await duePromise), /Ran 1 due schedule/);
		assert.match(text(await latest.manager.handleToolCall({ action: "schedule.history", id: "latest" }, latest.ctx)), /2030-01-01T03:00:00.000Z/, "latest catch-up selects the latest missed slot");

		const none = harness();
		await none.manager.handleToolCall({ action: "schedule.create", id: "none", every: "1h", catchUp: "none", agent: "worker" }, none.ctx);
		none.manager.stop();
		none.clock.now += 3 * 3_600_000;
		none.manager.bindSession(none.ctx);
		assert.match(text(await none.manager.handleToolCall({ action: "schedule.history", id: "none" }, none.ctx)), /missed/);
		assert.equal(none.launches.length, 0);
	});

	it("manual run uses the normal async target and overlap skip prevents a second launch", async () => {
		const h = harness();
		await h.manager.handleToolCall({ action: "schedule.create", id: "manual", every: "1h", workflowScript: "return 1" }, h.ctx);
		const firstPromise = h.manager.handleToolCall({ action: "schedule.run", id: "manual" }, h.ctx);
		await flush();
		assert.equal(h.launches.length, 1);
		h.launches[0]!.resolve({ content: [{ type: "text", text: "Async" }], details: { mode: "workflow", results: [], asyncId: "workflow-1" } });
		assert.match(text(await firstPromise), /async workflow-1/);
		const second = await h.manager.handleToolCall({ action: "schedule.run", id: "manual" }, h.ctx);
		assert.match(text(second), /skipped/);
		assert.equal(h.launches.length, 1);
	});

	it("distinguishes failed launch from failed async completion", async () => {
		const h = harness();
		await h.manager.handleToolCall({ action: "schedule.create", id: "failures", every: "1h", agent: "worker" }, h.ctx);
		const first = h.manager.handleToolCall({ action: "schedule.run", id: "failures" }, h.ctx);
		await flush();
		h.launches[0]!.resolve({ content: [{ type: "text", text: "spawn failed" }], details: { mode: "management", results: [] }, isError: true });
		assert.match(text(await first), /failed_launch/);

		const second = h.manager.handleToolCall({ action: "schedule.run", id: "failures" }, h.ctx);
		await flush();
		h.launches[1]!.resolve({ content: [{ type: "text", text: "Async" }], details: { mode: "single", results: [], asyncId: "async-fail" } });
		await second;
		h.manager.handleAsyncCompletion({ id: "async-fail", success: false, summary: "child failed" });
		const history = await h.manager.handleToolCall({ action: "schedule.history", id: "failures" }, h.ctx);
		assert.match(text(history), /failed_run.*async async-fail/);
		assert.match(text(history), /failed_launch/);
	});
});

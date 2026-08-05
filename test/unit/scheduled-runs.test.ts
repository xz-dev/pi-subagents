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
	ctx: ExtensionContext;
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
		launch: (params, launchCtx) => new Promise((resolve) => launches.push({ params: params as Record<string, unknown>, ctx: launchCtx, resolve: resolve as Launch["resolve"] })) as never,
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
		assert.equal(scheduledRunStorePath("/project"), path.join(path.resolve("/project"), ".pi-subagents", "schedules"));
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
			{ action: "schedule.create", id: "mission-id", every: "1h", agent: "worker", missionId: "mission-1" },
			{ action: "schedule.create", id: "mission-off", every: "1h", agent: "worker", mission: false },
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

	it("rejects schedule directories that escape through a symlink", async () => {
		const h = harness();
		const root = scheduledRunStorePath(h.ctx.cwd, undefined, path.join(h.root, "stores"));
		const outside = path.join(h.root, "outside");
		fs.mkdirSync(root, { recursive: true });
		fs.mkdirSync(outside);
		fs.symlinkSync(outside, path.join(root, "escaped"), process.platform === "win32" ? "junction" : "dir");
		const result = await h.manager.handleToolCall({ action: "schedule.create", id: "escaped", every: "1h", agent: "worker" }, h.ctx);
		assert.equal(result.isError, true);
		assert.match(text(result), /must be a real directory/);
		assert.equal(fs.existsSync(path.join(outside, "schedule.json")), false);
	});
});

describe("recurring schedule execution", () => {
	it("launches a fixed interval from its planned time and records durable history/events", async () => {
		const h = harness();
		await h.manager.handleToolCall({ action: "schedule.create", id: "hourly", every: "1h", agent: "worker", task: "Maintain backlog" }, h.ctx);
		h.clock.now += 3_600_000;
		h.timers.fireAll();
		assert.equal(h.launches.length, 1);
		assert.deepEqual(h.launches[0]?.params, { agent: "worker", task: "Maintain backlog", async: true, clarify: false, context: "fresh", cwd: h.ctx.cwd, mission: false });
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
		assert.match(text(await duePromise), /Processed 1 due schedule/);
		assert.match(text(await latest.manager.handleToolCall({ action: "schedule.history", id: "latest" }, latest.ctx)), /2030-01-01T03:00:00.000Z/, "latest catch-up selects the latest missed slot");

		const none = harness();
		await none.manager.handleToolCall({ action: "schedule.create", id: "none", every: "1h", catchUp: "none", agent: "worker" }, none.ctx);
		none.manager.stop();
		none.clock.now += 3 * 3_600_000;
		none.manager.bindSession(none.ctx);
		assert.match(text(await none.manager.handleToolCall({ action: "schedule.history", id: "none" }, none.ctx)), /missed/);
		assert.equal(none.launches.length, 0);
	});

	it("keeps project timers, contexts, and completion ownership when another project is selected", async () => {
		const h = harness();
		await h.manager.handleToolCall({ action: "schedule.create", id: "project-a", every: "1h", agent: "worker" }, h.ctx);

		const projectB = path.join(h.root, "project-b");
		fs.mkdirSync(projectB);
		const projectBCtx = context(projectB, "session-b");
		await h.manager.handleToolCall({ action: "schedule.create", id: "project-b", every: "1h", agent: "worker" }, projectBCtx);
		assert.equal(h.timers.values.size, 2, "both project timers remain armed");

		h.clock.now += 3_600_000;
		h.timers.fireAll();
		await flush();
		assert.equal(h.launches.length, 2);
		assert.equal(h.launches[0]!.ctx.cwd, h.ctx.cwd);
		assert.equal(h.launches[0]!.ctx.sessionManager.getSessionId(), "session-a");
		assert.equal(h.launches[1]!.ctx.cwd, projectB);
		assert.equal(h.launches[1]!.ctx.sessionManager.getSessionId(), "session-b");
		h.launches[0]!.resolve({ content: [{ type: "text", text: "Async" }], details: { mode: "single", results: [], asyncId: "async-a" } });
		h.launches[1]!.resolve({ content: [{ type: "text", text: "Async" }], details: { mode: "single", results: [], asyncId: "async-b" } });
		await flush();

		h.manager.handleAsyncCompletion({ runId: "async-a", success: true });
		const history = await h.manager.handleToolCall({ action: "schedule.history", id: "project-a" }, h.ctx);
		assert.match(text(history), /completed.*async async-a/);
		const projectARoot = scheduledRunStorePath(h.ctx.cwd, undefined, path.join(h.root, "stores"));
		assert.equal(fs.existsSync(path.join(projectARoot, "project-a", "active.lock")), false);
	});

	it("reconciles a terminal async status after a new session binds", async () => {
		const h = harness();
		await h.manager.handleToolCall({ action: "schedule.create", id: "restart", every: "1h", agent: "worker" }, h.ctx);
		h.clock.now += 3_600_000;
		h.timers.fireAll();
		const asyncDir = path.join(h.root, "async-restart");
		fs.mkdirSync(asyncDir);
		h.launches[0]!.resolve({ content: [{ type: "text", text: "Async" }], details: { mode: "single", results: [], asyncId: "async-restart", asyncDir } });
		await flush();
		h.manager.stop();
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: "async-restart", mode: "single", state: "complete", startedAt: h.clock.now, endedAt: h.clock.now }), "utf-8");

		const next = createScheduledRunManager({
			config: { scheduledRuns: { enabled: true } },
			storeRoot: path.join(h.root, "stores"),
			now: () => h.clock.now,
			randomId: () => "reconciled-id",
			timers: new FakeTimers(),
			launch: async () => ({ content: [{ type: "text", text: "unused" }], details: { mode: "management", results: [] } }),
		});
		const nextCtx = context(h.ctx.cwd, "session-b");
		next.bindSession(nextCtx);
		const history = await next.handleToolCall({ action: "schedule.history", id: "restart" }, nextCtx);
		assert.match(text(history), /completed.*async async-restart/);
	});

	it("records elapsed overlap and catch-up-none slots without an immediate rerun", async () => {
		const latest = harness();
		await latest.manager.handleToolCall({ action: "schedule.create", id: "overlap", every: "1h", catchUp: "latest", agent: "worker" }, latest.ctx);
		latest.clock.now += 3_600_000;
		latest.timers.fireAll();
		latest.launches[0]!.resolve({ content: [{ type: "text", text: "Async" }], details: { mode: "single", results: [], asyncId: "long-run" } });
		await flush();
		latest.clock.now += 3 * 3_600_000;
		latest.timers.fireAll();
		assert.equal(latest.launches.length, 1, "an overlapping occurrence is skipped instead of queued");
		latest.manager.handleAsyncCompletion({ runId: "long-run", success: true });
		const latestHistory = await latest.manager.handleToolCall({ action: "schedule.history", id: "overlap" }, latest.ctx);
		assert.match(text(latestHistory), /skipped/);
		assert.match(text(latestHistory), /completed.*async long-run/);
		assert.match(text(await latest.manager.handleToolCall({ action: "schedule.show", id: "overlap" }, latest.ctx)), /2030-01-01T05:00:00.000Z/);

		const none = harness();
		await none.manager.handleToolCall({ action: "schedule.create", id: "none-overlap", every: "1h", catchUp: "none", agent: "worker" }, none.ctx);
		none.clock.now += 3_600_000;
		none.timers.fireAll();
		none.launches[0]!.resolve({ content: [{ type: "text", text: "Async" }], details: { mode: "single", results: [], asyncId: "none-long-run" } });
		await flush();
		none.clock.now += 3 * 3_600_000;
		none.timers.fireAll();
		assert.equal(none.launches.length, 1);
		none.manager.handleAsyncCompletion({ runId: "none-long-run", success: true });
		assert.match(text(await none.manager.handleToolCall({ action: "schedule.history", id: "none-overlap" }, none.ctx)), /skipped/);
		assert.match(text(await none.manager.handleToolCall({ action: "schedule.show", id: "none-overlap" }, none.ctx)), /2030-01-01T05:00:00.000Z/);
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

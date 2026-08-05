import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { shortenPath } from "../../shared/formatters.ts";
import type { Details, ExtensionConfig } from "../../shared/types.ts";
import type { SubagentParamsLike } from "../foreground/subagent-executor.ts";
import { validateExecutionAcceptance } from "../shared/acceptance.ts";
import type { ResolvedSubagentCapabilityCeiling } from "../shared/capability-ceiling.ts";

export const SCHEDULED_RUN_ACTIONS = [
	"schedule.create",
	"schedule.list",
	"schedule.show",
	"schedule.history",
	"schedule.pause",
	"schedule.resume",
	"schedule.run",
	"schedule.run-due",
	"schedule.delete",
] as const;

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_MAX_PENDING = 20;
const MAX_HISTORY = 100;
const STALE_LAUNCH_CLAIM_MS = 5 * 60_000;
const SCHEDULE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

type ScheduledRunTimers = Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
export type ScheduledRunAction = typeof SCHEDULED_RUN_ACTIONS[number];
export type ScheduleRunState = "running" | "skipped" | "missed" | "completed" | "failed_launch" | "failed_run";
export type ScheduleTrigger =
	| { kind: "once"; at: string; nextRunAt?: string }
	| { kind: "interval"; every: string; everyMs: number; anchorAt: string; nextRunAt: string };
export type ScheduleTarget = { workflowScript: string } | { agent: string; task?: string };

export interface ScheduleRecord {
	schemaVersion: 1;
	id: string;
	name: string;
	cwd: string;
	trigger: ScheduleTrigger;
	target: ScheduleTarget;
	overlap: "skip";
	catchUp: "none" | "latest";
	timeoutMs?: number;
	missionId?: string;
	paused: boolean;
	createdAt: string;
	updatedAt: string;
	activeRunId?: string;
	lastRunId?: string;
}

export interface ScheduleRunRecord {
	schemaVersion: 1;
	id: string;
	scheduleId: string;
	plannedAt: string;
	dueReason: "timer" | "run-due" | "manual";
	state: ScheduleRunState;
	startedAt?: string;
	completedAt?: string;
	asyncId?: string;
	asyncDir?: string;
	missionId?: string;
	error?: string;
}

type ScheduledRunManagerDeps = {
	config: ExtensionConfig;
	launch(params: SubagentParamsLike, ctx: ExtensionContext, signal: AbortSignal): Promise<AgentToolResult<Details>>;
	storeRoot?: string;
	now?: () => number;
	randomId?: () => string;
	resolveCapabilityCeiling?: (sessionId: string) => ResolvedSubagentCapabilityCeiling | undefined;
	timers?: ScheduledRunTimers;
};

export function isScheduledRunAction(action: unknown): action is ScheduledRunAction {
	return typeof action === "string" && (SCHEDULED_RUN_ACTIONS as readonly string[]).includes(action);
}

export function scheduledRunsEnabled(config: ExtensionConfig): boolean {
	return config.scheduledRuns?.enabled !== false;
}

export function scheduledRunStorePath(cwd: string, _sessionId?: string, root?: string): string {
	if (!root) return path.join(path.resolve(cwd), ".pi-subagents", "schedules");
	const projectKey = createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 20);
	return path.join(root, projectKey);
}

export function parseScheduledRunTime(at: string, now = Date.now()): number {
	const trimmed = at.trim();
	const relative = trimmed.match(/^\+(\d+)(s|m|h|d)$/);
	if (relative) {
		const amount = Number(relative[1]);
		if (!Number.isSafeInteger(amount) || amount < 1) throw new Error(`Invalid at value "${at}". Relative delays must be positive, such as "+10m".`);
		const unitMs = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2] as "s" | "m" | "h" | "d"];
		const result = now + amount * unitMs;
		if (!Number.isSafeInteger(result)) throw new Error(`Invalid at value "${at}". Relative delay is too large.`);
		return result;
	}
	const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/);
	if (!iso) throw new Error(`Invalid at value "${at}". Use a one-shot delay such as "+10m" or an ISO timestamp with timezone.`);
	const year = Number(iso[1]);
	const month = Number(iso[2]);
	const day = Number(iso[3]);
	const hour = Number(iso[4]);
	const minute = Number(iso[5]);
	const second = iso[6] === undefined ? 0 : Number(iso[6]);
	const zone = iso[7]!;
	const offsetHour = zone === "Z" ? 0 : Number(zone.slice(1, 3));
	const offsetMinute = zone === "Z" ? 0 : Number(zone.slice(4, 6));
	const daysInMonth = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
	const parsed = Date.parse(trimmed);
	if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59 || !Number.isFinite(parsed)) throw new Error(`Invalid at value "${at}". Use a valid ISO timestamp.`);
	if (parsed <= now) throw new Error(`Scheduled time ${new Date(parsed).toISOString()} is in the past.`);
	return parsed;
}

export function parseScheduleInterval(every: string): number {
	const match = every.trim().match(/^(\d+)(m|h|d|w)$/);
	if (!match) throw new Error(`Invalid every value "${every}". This first recurring slice supports fixed intervals such as "30m", "6h", "2d", or "2w".`);
	const amount = Number(match[1]);
	if (!Number.isSafeInteger(amount) || amount < 1) throw new Error(`Invalid every value "${every}". Interval must be positive.`);
	const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2] as "m" | "h" | "d" | "w"];
	const result = amount * unitMs;
	if (!Number.isSafeInteger(result)) throw new Error(`Invalid every value "${every}". Interval is too large.`);
	return result;
}

function timestamp(value: number): string {
	return new Date(value).toISOString();
}

function validateScheduleId(id: string): string {
	if (!SCHEDULE_ID.test(id)) throw new Error("Schedule id must be 1-64 characters and contain only letters, numbers, '.', '_', or '-'.");
	return id;
}

function scheduleDir(root: string, id: string): string {
	return path.join(root, validateScheduleId(id));
}

function readJson(file: string, label: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch (error) {
		throw new Error(`Failed to read ${label} '${file}': ${error instanceof Error ? error.message : String(error)}`, { cause: error instanceof Error ? error : undefined });
	}
}

function parseSchedule(value: unknown, file: string): ScheduleRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Schedule record '${file}' must be a JSON object.`);
	const record = value as Partial<ScheduleRecord>;
	if (record.schemaVersion !== 1 || typeof record.id !== "string" || typeof record.name !== "string" || typeof record.cwd !== "string" || typeof record.createdAt !== "string" || typeof record.updatedAt !== "string" || typeof record.paused !== "boolean") throw new Error(`Schedule record '${file}' has invalid required fields.`);
	validateScheduleId(record.id);
	if (!record.trigger || typeof record.trigger !== "object" || !record.target || typeof record.target !== "object") throw new Error(`Schedule record '${file}' has invalid trigger or target.`);
	if (record.overlap !== "skip" || (record.catchUp !== "none" && record.catchUp !== "latest")) throw new Error(`Schedule record '${file}' has unsupported policy fields.`);
	if (record.trigger.kind === "once") {
		if (typeof record.trigger.at !== "string" || (record.trigger.nextRunAt !== undefined && typeof record.trigger.nextRunAt !== "string")) throw new Error(`Schedule record '${file}' has an invalid one-shot trigger.`);
	} else if (record.trigger.kind === "interval") {
		if (typeof record.trigger.every !== "string" || typeof record.trigger.everyMs !== "number" || typeof record.trigger.anchorAt !== "string" || typeof record.trigger.nextRunAt !== "string") throw new Error(`Schedule record '${file}' has an invalid interval trigger.`);
	} else throw new Error(`Schedule record '${file}' has an unsupported trigger.`);
	const workflow = "workflowScript" in record.target && typeof record.target.workflowScript === "string";
	const agent = "agent" in record.target && typeof record.target.agent === "string";
	if (workflow === agent) throw new Error(`Schedule record '${file}' has an invalid target.`);
	return record as ScheduleRecord;
}

class ScheduleStore {
	readonly root: string;

	constructor(root: string) {
		this.root = root;
	}

	list(): ScheduleRecord[] {
		if (!fs.existsSync(this.root)) return [];
		return fs.readdirSync(this.root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && SCHEDULE_ID.test(entry.name))
			.map((entry) => this.get(entry.name));
	}

	get(id: string): ScheduleRecord {
		const file = path.join(scheduleDir(this.root, id), "schedule.json");
		if (!fs.existsSync(file)) throw new Error(`Schedule '${id}' not found.`);
		return parseSchedule(readJson(file, "schedule record"), file);
	}

	write(record: ScheduleRecord): void {
		writePrivateAtomicJson(path.join(scheduleDir(this.root, record.id), "schedule.json"), record);
	}

	delete(id: string): void {
		fs.rmSync(scheduleDir(this.root, id), { recursive: true, force: true });
	}

	history(id: string): ScheduleRunRecord[] {
		const file = path.join(scheduleDir(this.root, id), "history.json");
		if (!fs.existsSync(file)) return [];
		const value = readJson(file, "schedule history") as { schemaVersion?: unknown; runs?: unknown };
		if (value?.schemaVersion !== 1 || !Array.isArray(value.runs)) throw new Error(`Schedule history '${file}' has invalid fields.`);
		return value.runs as ScheduleRunRecord[];
	}

	writeRun(schedule: ScheduleRecord, run: ScheduleRunRecord, event: string): void {
		const dir = scheduleDir(this.root, schedule.id);
		writePrivateAtomicJson(path.join(dir, "runs", `${run.id}.json`), run);
		const runs = [run, ...this.history(schedule.id).filter((item) => item.id !== run.id)].slice(0, MAX_HISTORY);
		writePrivateAtomicJson(path.join(dir, "history.json"), { schemaVersion: 1, runs });
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		fs.appendFileSync(path.join(dir, "events.jsonl"), `${JSON.stringify({ schemaVersion: 1, timestamp: new Date().toISOString(), event, scheduleId: schedule.id, runId: run.id, state: run.state })}\n`, { encoding: "utf-8", mode: 0o600 });
	}

	appendEvent(schedule: ScheduleRecord, event: string): void {
		const dir = scheduleDir(this.root, schedule.id);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		fs.appendFileSync(path.join(dir, "events.jsonl"), `${JSON.stringify({ schemaVersion: 1, timestamp: new Date().toISOString(), event, scheduleId: schedule.id })}\n`, { encoding: "utf-8", mode: 0o600 });
	}
}

function resolveMaxPending(config: ExtensionConfig): number {
	const value = config.scheduledRuns?.maxPending;
	return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : DEFAULT_MAX_PENDING;
}

function nextAfter(trigger: ScheduleTrigger, plannedAt: number, now: number): string | undefined {
	if (trigger.kind === "once") return undefined;
	let next = plannedAt + trigger.everyMs;
	while (next <= now) next += trigger.everyMs;
	return timestamp(next);
}

function nextRunAt(schedule: ScheduleRecord): number | undefined {
	const value = schedule.trigger.nextRunAt;
	if (!value) return undefined;
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) throw new Error(`Schedule '${schedule.id}' has invalid nextRunAt.`);
	return parsed;
}

function duePlannedAt(schedule: ScheduleRecord, now: number): number | undefined {
	const next = nextRunAt(schedule);
	if (next === undefined || next > now || schedule.catchUp !== "latest" || schedule.trigger.kind !== "interval") return next;
	return next + Math.floor((now - next) / schedule.trigger.everyMs) * schedule.trigger.everyMs;
}

function textResult(text: string, schedules?: ScheduleRecord[], runs?: ScheduleRunRecord[], isError = false): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text }],
		...(isError ? { isError: true } : {}),
		details: { mode: "management", results: [], schedules: { ...(schedules ? { records: schedules } : {}), ...(runs ? { runs } : {}) } },
	};
}

function targetLabel(target: ScheduleTarget): string {
	return "workflowScript" in target ? "workflowScript" : `agent ${target.agent}`;
}

function sanitizeTarget(params: SubagentParamsLike): { target?: ScheduleTarget; error?: string } {
	if (params.tasks || params.chain) return { error: "Recurring schedules support workflowScript or one agent/task target, not legacy tasks or chain inputs." };
	const hasWorkflow = typeof params.workflowScript === "string" && params.workflowScript.trim().length > 0;
	const hasAgent = typeof params.agent === "string" && params.agent.trim().length > 0;
	if (hasWorkflow === hasAgent) return { error: "schedule.create requires exactly one target: workflowScript or agent with optional task." };
	if (params.context === "fork") return { error: "Scheduled runs require fresh context." };
	if (params.async === false) return { error: "Scheduled runs are always async." };
	if (params.clarify === true) return { error: "Scheduled runs cannot open clarify UI." };
	const acceptanceErrors = validateExecutionAcceptance(params as Parameters<typeof validateExecutionAcceptance>[0]);
	if (acceptanceErrors.length) return { error: acceptanceErrors.join(" ") };
	return hasWorkflow ? { target: { workflowScript: params.workflowScript!.trim() } } : { target: { agent: params.agent!.trim(), ...(params.task === undefined ? {} : { task: params.task }) } };
}

function executionParams(schedule: ScheduleRecord): SubagentParamsLike {
	return {
		...schedule.target,
		async: true,
		clarify: false,
		context: "fresh",
		cwd: schedule.cwd,
		...(schedule.timeoutMs === undefined ? {} : { timeoutMs: schedule.timeoutMs }),
		...(schedule.missionId === undefined ? {} : { missionId: schedule.missionId }),
	};
}

export function listScheduledRunSummaries(cwd: string, root?: string): ScheduleRecord[] {
	return new ScheduleStore(scheduledRunStorePath(cwd, undefined, root)).list();
}

export class ScheduledRunManager {
	private store?: ScheduleStore;
	private ctx?: ExtensionContext;
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly now: () => number;
	private readonly randomId: () => string;
	private readonly timersApi: ScheduledRunTimers;
	private readonly deps: ScheduledRunManagerDeps;

	constructor(deps: ScheduledRunManagerDeps) {
		this.deps = deps;
		this.now = deps.now ?? Date.now;
		this.randomId = deps.randomId ?? (() => randomUUID().slice(0, 8));
		this.timersApi = deps.timers ?? globalThis;
	}

	bindSession(ctx: ExtensionContext): void {
		this.stopTimers();
		this.store = undefined;
		this.ctx = ctx;
		if (!scheduledRunsEnabled(this.deps.config)) return;
		this.selectProject(ctx.cwd);
	}

	stop(): void {
		this.stopTimers();
		this.ctx = undefined;
		this.store = undefined;
	}

	async handleToolCall(params: SubagentParamsLike, ctx: ExtensionContext): Promise<AgentToolResult<Details>> {
		this.ctx = ctx;
		try {
			if (!scheduledRunsEnabled(this.deps.config)) return textResult("Scheduled runs are disabled by scheduledRuns.enabled=false.", undefined, undefined, true);
			this.selectProject(params.cwd ?? ctx.cwd);
			switch (params.action) {
				case "schedule.create": return this.create(params, ctx);
				case "schedule.list": return this.list();
				case "schedule.show": return this.show(params);
				case "schedule.history": return this.history(params);
				case "schedule.pause": return this.pause(params, true);
				case "schedule.resume": return this.pause(params, false);
				case "schedule.run": return await this.runManual(params);
				case "schedule.run-due": return await this.runDue();
				case "schedule.delete": return this.remove(params);
				default: return textResult(`Unknown schedule action: ${params.action}`, undefined, undefined, true);
			}
		} catch (error) {
			return textResult(error instanceof Error ? error.message : String(error), undefined, undefined, true);
		}
	}

	handleAsyncCompletion(payload: unknown): void {
		if (!payload || typeof payload !== "object") return;
		const data = payload as { id?: unknown; runId?: unknown; success?: unknown; state?: unknown; summary?: unknown };
		const asyncId = typeof data.runId === "string" ? data.runId : typeof data.id === "string" ? data.id : undefined;
		if (!asyncId || !this.store) return;
		for (const schedule of this.store.list()) {
			const run = this.store.history(schedule.id).find((item) => item.asyncId === asyncId && item.state === "running");
			if (!run) continue;
			run.state = data.success === true ? "completed" : "failed_run";
			run.completedAt = timestamp(this.now());
			if (run.state === "failed_run" && typeof data.summary === "string") run.error = data.summary;
			schedule.activeRunId = undefined;
			schedule.updatedAt = timestamp(this.now());
			this.store.write(schedule);
			fs.rmSync(path.join(scheduleDir(this.store.root, schedule.id), "active.lock"), { force: true });
			this.store.writeRun(schedule, run, run.state === "completed" ? "schedule.run.completed" : "schedule.run.failed");
			this.arm(schedule);
			return;
		}
	}

	private create(params: SubagentParamsLike, ctx: ExtensionContext): AgentToolResult<Details> {
		const store = this.requireStore();
		const target = sanitizeTarget(params);
		if (target.error) return textResult(target.error, undefined, undefined, true);
		const at = params.at?.trim();
		const every = params.every?.trim();
		if (Boolean(at) === Boolean(every)) return textResult("schedule.create requires exactly one trigger: at or every.", undefined, undefined, true);
		if (params.overlap !== undefined && params.overlap !== "skip") return textResult("This first recurring slice supports overlap='skip' only.", undefined, undefined, true);
		if (params.catchUp !== undefined && params.catchUp !== "none" && params.catchUp !== "latest") return textResult("catchUp must be 'none' or 'latest'.", undefined, undefined, true);
		if (params.on !== undefined || params.timezone !== undefined || every === "day" || every === "week" || every === "month" || every === "year") return textResult("Calendar schedules are deferred from this first safe slice. Use a fixed interval such as every:'24h' or every:'7d'.", undefined, undefined, true);
		const sessionId = ctx.sessionManager.getSessionId() ?? "unknown";
		if (this.deps.resolveCapabilityCeiling?.(sessionId)) return textResult("Cannot persist a schedule while a capability ceiling is active.", undefined, undefined, true);
		if (store.list().length >= resolveMaxPending(this.deps.config)) return textResult(`Schedule limit reached (${resolveMaxPending(this.deps.config)}).`, undefined, undefined, true);
		const id = validateScheduleId((params.id?.trim() || this.randomId()));
		if (store.list().some((item) => item.id === id)) return textResult(`Schedule '${id}' already exists.`, undefined, undefined, true);
		const now = this.now();
		let trigger: ScheduleTrigger;
		if (at) {
			const planned = parseScheduledRunTime(at, now);
			trigger = { kind: "once", at, nextRunAt: timestamp(planned) };
		} else {
			const everyMs = parseScheduleInterval(every!);
			trigger = { kind: "interval", every: every!, everyMs, anchorAt: timestamp(now), nextRunAt: timestamp(now + everyMs) };
		}
		const schedule: ScheduleRecord = {
			schemaVersion: 1,
			id,
			name: params.name?.trim() || params.scheduleName?.trim() || targetLabel(target.target!),
			cwd: path.resolve(params.cwd ?? ctx.cwd),
			trigger,
			target: target.target!,
			overlap: "skip",
			catchUp: params.catchUp ?? "latest",
			...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
			...(params.missionId === undefined ? {} : { missionId: params.missionId }),
			paused: false,
			createdAt: timestamp(now),
			updatedAt: timestamp(now),
		};
		store.write(schedule);
		store.appendEvent(schedule, "schedule.created");
		this.arm(schedule);
		return textResult(`Created schedule ${id}.\nName: ${schedule.name}\nTrigger: ${at ? `at ${at}` : `every ${every}`}\nNext: ${schedule.trigger.nextRunAt}\nTarget: ${targetLabel(schedule.target)}`, [schedule]);
	}

	private list(): AgentToolResult<Details> {
		const schedules = this.requireStore().list().sort((a, b) => (a.trigger.nextRunAt ?? "").localeCompare(b.trigger.nextRunAt ?? ""));
		if (!schedules.length) return textResult("No project schedules.", []);
		return textResult([`Project schedules: ${schedules.length}`, ...schedules.map((item) => `- ${item.id} | ${item.paused ? "paused" : item.activeRunId ? "running" : "scheduled"} | ${item.trigger.nextRunAt ?? "no next run"} | ${item.name}`)].join("\n"), schedules);
	}

	private show(params: SubagentParamsLike): AgentToolResult<Details> {
		const schedule = this.resolve(params);
		return textResult([`Schedule: ${schedule.id}`, `Name: ${schedule.name}`, `State: ${schedule.paused ? "paused" : schedule.activeRunId ? "running" : "scheduled"}`, `Target: ${targetLabel(schedule.target)}`, `CWD: ${shortenPath(schedule.cwd)}`, `Next: ${schedule.trigger.nextRunAt ?? "none"}`, `Catch up: ${schedule.catchUp}`, schedule.activeRunId ? `Active run: ${schedule.activeRunId}` : undefined].filter(Boolean).join("\n"), [schedule]);
	}

	private history(params: SubagentParamsLike): AgentToolResult<Details> {
		const schedule = this.resolve(params);
		const runs = this.requireStore().history(schedule.id);
		return textResult(runs.length ? [`Schedule history: ${schedule.id}`, ...runs.map((run) => `- ${run.id} | ${run.state} | ${run.plannedAt}${run.asyncId ? ` | async ${run.asyncId}` : ""}`)].join("\n") : `No runs recorded for schedule ${schedule.id}.`, [schedule], runs);
	}

	private pause(params: SubagentParamsLike, paused: boolean): AgentToolResult<Details> {
		const schedule = this.resolve(params);
		if (schedule.paused === paused) return textResult(`Schedule ${schedule.id} is already ${paused ? "paused" : "active"}.`, [schedule]);
		schedule.paused = paused;
		schedule.updatedAt = timestamp(this.now());
		this.requireStore().write(schedule);
		this.requireStore().appendEvent(schedule, paused ? "schedule.paused" : "schedule.resumed");
		if (paused) this.clearTimer(schedule.id); else this.restoreOne(schedule);
		return textResult(`${paused ? "Paused" : "Resumed"} schedule ${schedule.id}.`, [schedule]);
	}

	private async runManual(params: SubagentParamsLike): Promise<AgentToolResult<Details>> {
		const schedule = this.resolve(params);
		const run = await this.launch(schedule, this.now(), "manual", false);
		return textResult(`Manual schedule run ${run.id}: ${run.state}${run.asyncId ? ` (async ${run.asyncId})` : ""}.`, [this.requireStore().get(schedule.id)], [run], run.state === "failed_launch");
	}

	private async runDue(): Promise<AgentToolResult<Details>> {
		const due = this.requireStore().list().filter((schedule) => !schedule.paused && nextRunAt(schedule) !== undefined && nextRunAt(schedule)! <= this.now());
		const runs: ScheduleRunRecord[] = [];
		for (const schedule of due) runs.push(await this.launch(schedule, duePlannedAt(schedule, this.now())!, "run-due", true));
		return textResult(runs.length ? `Ran ${runs.length} due schedule(s).` : "No schedules are due.", this.requireStore().list(), runs);
	}

	private remove(params: SubagentParamsLike): AgentToolResult<Details> {
		const schedule = this.resolve(params);
		if (schedule.activeRunId) return textResult(`Schedule ${schedule.id} has active run ${schedule.activeRunId}; stop that run before deleting the schedule.`, [schedule], undefined, true);
		this.clearTimer(schedule.id);
		this.requireStore().appendEvent(schedule, "schedule.deleted");
		this.requireStore().delete(schedule.id);
		return textResult(`Deleted schedule ${schedule.id}.`);
	}

	private restore(): void {
		for (const schedule of this.requireStore().list()) this.restoreOne(schedule);
	}

	private restoreOne(schedule: ScheduleRecord): void {
		if (schedule.activeRunId) {
			const run = this.requireStore().history(schedule.id).find((item) => item.id === schedule.activeRunId);
			const startedAt = run?.startedAt ? Date.parse(run.startedAt) : Number.NaN;
			if (!run || run.state !== "running" || (!run.asyncId && Number.isFinite(startedAt) && startedAt + STALE_LAUNCH_CLAIM_MS <= this.now())) {
				if (run?.state === "running") {
					run.state = "failed_launch";
					run.completedAt = timestamp(this.now());
					run.error = "Recovered a stale launch claim before an async run was attached.";
					this.requireStore().writeRun(schedule, run, "schedule.run.failed");
				}
				schedule.activeRunId = undefined;
				schedule.updatedAt = timestamp(this.now());
				this.requireStore().write(schedule);
				fs.rmSync(path.join(scheduleDir(this.requireStore().root, schedule.id), "active.lock"), { force: true });
			}
		}
		if (schedule.paused || schedule.activeRunId) return;
		const next = nextRunAt(schedule);
		if (next === undefined) return;
		if (next < this.now() && schedule.catchUp === "none") {
			const run: ScheduleRunRecord = { schemaVersion: 1, id: this.randomId(), scheduleId: schedule.id, plannedAt: timestamp(next), dueReason: "timer", state: "missed", completedAt: timestamp(this.now()) };
			schedule.trigger.nextRunAt = nextAfter(schedule.trigger, next, this.now());
			schedule.updatedAt = timestamp(this.now());
			this.requireStore().write(schedule);
			this.requireStore().writeRun(schedule, run, "schedule.missed");
		}
		this.arm(schedule);
	}

	private arm(schedule: ScheduleRecord): void {
		this.clearTimer(schedule.id);
		if (schedule.paused || schedule.activeRunId) return;
		const next = nextRunAt(schedule);
		if (next === undefined) return;
		const timer = this.timersApi.setTimeout(() => void this.fire(schedule.id), Math.min(Math.max(0, next - this.now()), MAX_TIMER_DELAY_MS));
		timer.unref?.();
		this.timers.set(schedule.id, timer);
	}

	private async fire(id: string): Promise<void> {
		this.clearTimer(id);
		const schedule = this.requireStore().get(id);
		const planned = duePlannedAt(schedule, this.now());
		if (planned === undefined || schedule.paused || schedule.activeRunId) return;
		if (planned > this.now()) return this.arm(schedule);
		await this.launch(schedule, planned, "timer", true);
	}

	private async launch(schedule: ScheduleRecord, planned: number, dueReason: ScheduleRunRecord["dueReason"], advance: boolean): Promise<ScheduleRunRecord> {
		const store = this.requireStore();
		const now = this.now();
		const run: ScheduleRunRecord = { schemaVersion: 1, id: this.randomId(), scheduleId: schedule.id, plannedAt: timestamp(planned), dueReason, state: "running", startedAt: timestamp(now), ...(schedule.missionId ? { missionId: schedule.missionId } : {}) };
		if (schedule.activeRunId) {
			run.state = "skipped";
			run.completedAt = timestamp(now);
			if (advance) {
				schedule.trigger.nextRunAt = nextAfter(schedule.trigger, planned, now);
				schedule.updatedAt = timestamp(now);
				store.write(schedule);
			}
			store.writeRun(schedule, run, "schedule.skipped_overlap");
			return run;
		}
		const lockPath = path.join(scheduleDir(store.root, schedule.id), "active.lock");
		fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
		let lock: number;
		try {
			lock = fs.openSync(lockPath, "wx", 0o600);
			fs.writeFileSync(lock, run.id, "utf-8");
			fs.closeSync(lock);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			run.state = "skipped";
			run.completedAt = timestamp(now);
			if (advance) {
				schedule.trigger.nextRunAt = nextAfter(schedule.trigger, planned, now);
				schedule.updatedAt = timestamp(now);
				store.write(schedule);
			}
			store.writeRun(schedule, run, "schedule.skipped_overlap");
			return run;
		}
		schedule.activeRunId = run.id;
		schedule.lastRunId = run.id;
		if (advance) schedule.trigger.nextRunAt = nextAfter(schedule.trigger, planned, now);
		schedule.updatedAt = timestamp(now);
		store.write(schedule);
		store.writeRun(schedule, run, "schedule.run.started");
		try {
			const result = await this.deps.launch(executionParams(schedule), this.requireContext(), new AbortController().signal);
			const asyncId = result.details?.asyncId ?? result.details?.runId;
			if (result.isError || !asyncId) throw new Error(result.content.find((item) => item.type === "text")?.text ?? "Scheduled launch failed.");
			run.asyncId = asyncId;
			run.asyncDir = result.details?.asyncDir;
			store.writeRun(schedule, run, "schedule.run.attached_async");
			this.arm(schedule);
			return run;
		} catch (error) {
			run.state = "failed_launch";
			run.completedAt = timestamp(this.now());
			run.error = error instanceof Error ? error.message : String(error);
			schedule.activeRunId = undefined;
			schedule.updatedAt = timestamp(this.now());
			store.write(schedule);
			store.writeRun(schedule, run, "schedule.run.failed");
			fs.rmSync(lockPath, { force: true });
			this.arm(schedule);
			return run;
		}
	}

	private selectProject(cwd: string): void {
		const root = scheduledRunStorePath(cwd, undefined, this.deps.storeRoot);
		if (this.store?.root === root) return;
		this.stopTimers();
		this.store = new ScheduleStore(root);
		this.restore();
	}

	private resolve(params: SubagentParamsLike): ScheduleRecord {
		const id = params.id?.trim();
		if (!id) throw new Error(`${params.action} requires id.`);
		return this.requireStore().get(id);
	}

	private requireStore(): ScheduleStore {
		if (!this.store) throw new Error("Schedule store is unavailable.");
		return this.store;
	}

	private requireContext(): ExtensionContext {
		if (!this.ctx) throw new Error("Schedule runtime context is unavailable.");
		return this.ctx;
	}

	private clearTimer(id: string): void {
		const timer = this.timers.get(id);
		if (!timer) return;
		this.timersApi.clearTimeout(timer);
		this.timers.delete(id);
	}

	private stopTimers(): void {
		for (const timer of this.timers.values()) this.timersApi.clearTimeout(timer);
		this.timers.clear();
	}
}

export function createScheduledRunManager(deps: ScheduledRunManagerDeps): ScheduledRunManager {
	return new ScheduledRunManager(deps);
}

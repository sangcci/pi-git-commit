import { exec, execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { complete, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
const CONFIG_FILE = "pi-git-commit.json";
const PROJECT_CONFIG_PATH = join(".pi", CONFIG_FILE);
const GLOBAL_CONFIG_PATH = join(homedir(), ".pi", "agent", CONFIG_FILE);
const MAX_DIFF_CHARS = 40000;

const SYSTEM_PROMPT = `You are pi-git-commit, an expert Git commit planner.
Analyze repository changes and return ONLY JSON. No markdown fences.

Return shape:
{
  "commits": [
    {
      "message": "type(scope): concise subject",
      "body": "optional longer explanation, or empty string",
      "footer": "optional footer such as BREAKING CHANGE or issue refs, or empty string",
      "files": ["path"],
      "rationale": "why this boundary makes sense"
    }
  ]
}

Rules:
- Split changes into sensible commit units.
- Prefer conventional commit messages when lint config asks for it.
- Respect allowed types, scopes, required scope, and max header length.
- Respect allowBody and allowFooter. If disabled, return empty strings.
- If mode is staged-only, plan commits from staged files only.
- If mode is all-changes, plan commits from all changed working tree files.
- Use only files listed in allowedFiles.
- Do not invent files.
- Keep subject specific, imperative, and concise.
- Use the configured message language for subject, body, and footer.
- Keep conventional commit type and scope tokens in English, even when message language is not English.
- If user instruction notes are present, adjust the proposal to satisfy them.`;

type CommitLintConfig = {
	conventional?: boolean;
	types?: string[];
	scopes?: string[];
	requireScope?: boolean;
	maxHeaderLength?: number;
	maxSubjectLength?: number;
	allowBody?: boolean;
	allowFooter?: boolean;
};

type GitCommitConfig = {
	message?: {
		language?: string;
	};
	lint?: CommitLintConfig;
	commands?: { sem?: string };
};

type CommitMode = "staged-only" | "all-changes";

type GitState = {
	cwd: string;
	branch: string;
	status: string;
	diff: string;
	stagedDiff: string;
	recentLog: string;
	sem?: string;
};

type CommitPlan = {
	message: string;
	body?: string;
	footer?: string;
	files: string[];
	rationale: string;
};

type CommitProposal = {
	commits: CommitPlan[];
	notes: string[];
	mode: CommitMode;
	source: "ai" | "heuristic";
	fallbackReason?: string;
};

type CommitResult =
	| { ok: true; stdout: string; stderr: string; summaries: string[] }
	| { ok: false; stdout: string; stderr: string; reason: "lint" | "hook" | "git" | "unknown" };

type ShellResult = { ok: boolean; stdout: string; stderr: string; exitCode?: number };
type UserAction = "proceed" | "edit" | "regenerate" | "cancel";
type ProgressStepState = "pending" | "active" | "done" | "failed";
type ProgressStep = { label: string; state: ProgressStepState; detail?: string };
type ProgressView = { title: string; steps: ProgressStep[] };

export default function piGitCommit(pi: ExtensionAPI) {
	pi.registerCommand("commit", {
		description: "Plan and run git commits with user approval",
		handler: async (_args, ctx) => runCommitWizard(ctx),
	});
}

function setProgressWidget(ctx: ExtensionCommandContext, view?: ProgressView) {
	ctx.ui.setWidget("pi-git-commit", view ? renderProgressView(view) : undefined);
}

function renderProgressView(view: ProgressView) {
	return [
		`pi-git-commit — ${view.title}`,
		...view.steps.map((step) => `${progressIcon(step.state)} ${step.label}${step.detail ? `\n  ${step.detail}` : ""}`),
	];
}

function progressIcon(state: ProgressStepState) {
	if (state === "done") return "✓";
	if (state === "active") return "⟳";
	if (state === "failed") return "✗";
	return "○";
}

async function runCommitWizard(ctx: ExtensionCommandContext) {
	if (!ctx.hasUI) return ctx.ui.notify("/commit requires an interactive UI.", "error");

	try {
		const cwd = ctx.cwd;
		setProgressWidget(ctx, { title: "Starting", steps: [{ label: "Check Git repository", state: "active" }] });
		const repoCheck = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
		if (!repoCheck.ok || repoCheck.stdout.trim() !== "true") return ctx.ui.notify("Not inside a Git repository.", "error");

		const config = await loadConfig(cwd, ctx);
		const notes: string[] = [];
		let proposal: CommitProposal | undefined;
		let selectedMode: CommitMode | undefined;

		while (true) {
			setProgressWidget(ctx, { title: "Collecting Git state", steps: [{ label: "Collect Git status, diff, staged diff, and recent log", state: "active" }] });
			const state = await collectGitState(cwd, config);
			if (!state.status.trim()) return ctx.ui.notify("No changes to commit.", "info");

			if (!selectedMode) {
				setProgressWidget(ctx, { title: "Choosing commit scope", steps: [{ label: "Git state collected", state: "done" }, { label: "Choose staged-only or all working tree changes", state: "active" }] });
				selectedMode = await chooseCommitMode(ctx, state);
				if (!selectedMode) return ctx.ui.notify("Commit cancelled.", "info");
			}

			if (!proposal) proposal = await buildProposal(ctx, state, config, notes, selectedMode);
			if (proposal.commits.length === 0) return ctx.ui.notify("Could not build a commit proposal from the current changes.", "warning");

			setProgressWidget(ctx, { title: "Waiting for approval", steps: [{ label: "Commit proposal generated", state: "done", detail: `${proposal.commits.length} commit(s), ${proposal.source}` }, { label: "Review proposal", state: "active" }] });
			const action = await askUser(ctx, proposal);
			if (action === "cancel") return ctx.ui.notify("Commit cancelled.", "info");
			if (action === "edit") {
				proposal = await editCommitMessages(ctx, proposal);
				continue;
			}
			if (action === "regenerate") {
				const note = await ctx.ui.editor("Regenerate with instruction", "");
				if (note?.trim()) notes.push(note.trim());
				proposal = undefined;
				continue;
			}

			const result = await executeCommits(cwd, proposal, (view) => setProgressWidget(ctx, view));
			if (result.ok) {
				setProgressWidget(ctx, { title: "Done", steps: result.summaries.map((summary) => ({ label: summary, state: "done" })) });
				ctx.ui.notify(`Commit created:\n${result.summaries.map((summary) => `* ${summary}`).join("\n")}`, "info");
				return;
			}

			setProgressWidget(ctx, { title: "Failed", steps: [{ label: `Commit failed (${result.reason})`, state: "failed" }] });
			ctx.ui.notify(formatCommitFailureNotification(result), "error");
			return;
		}
	} finally {
		setProgressWidget(ctx);
	}
}

async function chooseCommitMode(ctx: ExtensionCommandContext, state: GitState): Promise<CommitMode | undefined> {
	const hasStaged = state.stagedDiff.trim().length > 0;
	const hasUnstaged = state.diff.trim().length > 0 || state.status.split("\n").some((line) => line.startsWith("??"));
	if (!hasStaged) return "all-changes";
	if (!hasUnstaged) return "staged-only";

	const mixedFiles = findMixedFiles(state.status);
	const warning = mixedFiles.length
		? `\n\nWarning: these files have both staged and unstaged changes. "Use all" will stage entire files:\n${mixedFiles.map((file) => `- ${file}`).join("\n")}`
		: "";
	const choice = await ctx.ui.select(`Staged and unstaged changes detected.${warning}`, ["Use staged changes only", "Use all working tree changes", "Cancel"]);
	if (choice === "Use staged changes only") return "staged-only";
	if (choice === "Use all working tree changes") return "all-changes";
	return undefined;
}

async function loadConfig(cwd: string, ctx: ExtensionCommandContext): Promise<GitCommitConfig> {
	const projectConfigPath = join(cwd, PROJECT_CONFIG_PATH);
	const projectConfig = await readConfigFile(projectConfigPath, ctx);
	if (projectConfig !== undefined) return projectConfig;

	const globalConfig = await readConfigFile(GLOBAL_CONFIG_PATH, ctx);
	return globalConfig ?? {};
}

async function readConfigFile(path: string, ctx: ExtensionCommandContext): Promise<GitCommitConfig | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as GitCommitConfig;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		ctx.ui.notify(`Failed to read ${path}; using defaults.`, "warning");
		return {};
	}
}

async function collectGitState(cwd: string, config: GitCommitConfig): Promise<GitState> {
	const [branch, status, diff, stagedDiff, recentLog] = await Promise.all([
		git(cwd, ["branch", "--show-current"]),
		git(cwd, ["status", "--porcelain=v1"]),
		git(cwd, ["diff", "--"]),
		git(cwd, ["diff", "--staged", "--"]),
		git(cwd, ["log", "--oneline", "-n", "20"]),
	]);
	let sem: string | undefined;
	if (config.commands?.sem) {
		const semResult = await shell(cwd, config.commands.sem);
		sem = semResult.ok ? semResult.stdout : semResult.stderr;
	}
	return { cwd, branch: branch.stdout.trim(), status: status.stdout, diff: diff.stdout, stagedDiff: stagedDiff.stdout, recentLog: recentLog.stdout, sem };
}

async function buildProposal(ctx: ExtensionCommandContext, state: GitState, config: GitCommitConfig, notes: string[], mode: CommitMode): Promise<CommitProposal> {
	const fileCount = parseStatusFiles(state.status, mode).length;
	setProgressWidget(ctx, {
		title: "Generating proposal",
		steps: [
			{ label: "Git state collected", state: "done" },
			{ label: "Build AI commit proposal", state: "active", detail: `model: ${ctx.model?.id ?? "fallback"}, mode: ${mode}, files: ${fileCount}` },
		],
	});
	ctx.ui.setStatus("pi-git-commit", `Generating commit proposal with ${ctx.model?.id ?? "fallback"}...`);
	const result = await buildProposalWithModel(ctx, state, config, notes, mode);
	ctx.ui.setStatus("pi-git-commit", "");
	if (result.proposal) return result.proposal;
	setProgressWidget(ctx, {
		title: "Using heuristic fallback",
		steps: [
			{ label: "AI proposal unavailable", state: "failed", detail: result.reason },
			{ label: "Build heuristic commit proposal", state: "active" },
		],
	});
	ctx.ui.notify(`AI proposal unavailable; using heuristic fallback. ${result.reason}`, "warning");
	return { ...buildHeuristicProposal(state, config, notes, mode), fallbackReason: result.reason };
}

async function buildProposalWithModel(ctx: ExtensionCommandContext, state: GitState, config: GitCommitConfig, notes: string[], mode: CommitMode): Promise<{ proposal?: CommitProposal; reason: string }> {
	if (!ctx.model) return { reason: "No model selected." };
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok || !auth.apiKey) return { reason: auth.ok ? `No API key for ${ctx.model.provider}.` : auth.error };
	const allowedFiles = parseStatusFiles(state.status, mode);
	if (allowedFiles.length === 0) return { reason: "No eligible files for selected mode." };

	const userMessage: UserMessage = { role: "user", content: [{ type: "text", text: buildModelInput(state, config, notes, allowedFiles, mode) }], timestamp: Date.now() };
	try {
		const response = await complete(ctx.model, { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] }, { apiKey: auth.apiKey, headers: auth.headers });
		const text = response.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");
		const proposal = parseAiProposal(text, allowedFiles, mode, notes, config);
		return proposal ? { proposal, reason: "" } : { reason: "Model returned invalid proposal JSON." };
	} catch (error) {
		return { reason: error instanceof Error ? error.message : "Model call failed." };
	}
}

function buildModelInput(state: GitState, config: GitCommitConfig, notes: string[], allowedFiles: string[], mode: CommitMode) {
	const messageLanguage = config.message?.language ?? "en";
	return JSON.stringify({ branch: state.branch, mode, messageLanguage, languageInstruction: `Write commit subject, body, and footer in ${messageLanguage}. Keep conventional commit type/scope tokens in English.`, allowedFiles, status: state.status, diff: truncate(mode === "staged-only" ? state.stagedDiff : `${state.stagedDiff}\n${state.diff}`, MAX_DIFF_CHARS), recentLog: state.recentLog, sem: state.sem, config, notes }, null, 2);
}

function parseAiProposal(text: string, allowedFiles: string[], mode: CommitMode, notes: string[], config: GitCommitConfig): CommitProposal | undefined {
	const jsonText = extractJson(text);
	if (!jsonText) return undefined;
	const parsed = JSON.parse(jsonText) as { commits?: Array<{ message?: unknown; body?: unknown; footer?: unknown; files?: unknown; rationale?: unknown }> };
	if (!Array.isArray(parsed.commits)) return undefined;
	const allowed = new Set(allowedFiles);
	const commits = parsed.commits.map((commit) => normalizeCommit(commit, allowed, config)).filter((commit): commit is CommitPlan => Boolean(commit));
	return commits.length ? { commits, notes, mode, source: "ai" } : undefined;
}

function normalizeCommit(commit: { message?: unknown; body?: unknown; footer?: unknown; files?: unknown; rationale?: unknown }, allowed: Set<string>, config: GitCommitConfig): CommitPlan | undefined {
	const message = typeof commit.message === "string" ? commit.message.trim() : "";
	const files = Array.isArray(commit.files) ? commit.files.filter((file): file is string => typeof file === "string" && allowed.has(file)) : [];
	if (!message || !files.length) return undefined;
	return {
		message,
		body: config.lint?.allowBody === false ? undefined : cleanOptionalText(commit.body),
		footer: config.lint?.allowFooter === false ? undefined : cleanOptionalText(commit.footer),
		files,
		rationale: typeof commit.rationale === "string" ? commit.rationale.trim() : "AI-generated commit boundary.",
	};
}

function extractJson(text: string) {
	const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	return start >= 0 && end > start ? trimmed.slice(start, end + 1) : undefined;
}

function buildHeuristicProposal(state: GitState, config: GitCommitConfig, notes: string[], mode: CommitMode): CommitProposal {
	const files = parseStatusFiles(state.status, mode);
	if (files.length === 0) return { commits: [], notes, mode, source: "heuristic" };
	if (mode === "staged-only") return { commits: [{ message: makeMessage("chore", fallbackSubject("staged", config), config), files, rationale: "Uses already staged changes and avoids changing the index unexpectedly." }], notes, mode, source: "heuristic" };
	const groups = groupFiles(files);
	return { commits: groups.map((group) => ({ message: makeMessage(group.type, fallbackSubject(group.key, config), config), files: group.files, rationale: group.rationale })), notes, mode, source: "heuristic" };
}

function parseStatusFiles(status: string, mode: CommitMode): string[] {
	return unique(status.split("\n").map((line) => line.trimEnd()).filter(Boolean).filter((line) => mode === "all-changes" || (line[0] !== " " && line[0] !== "?")).map(statusPath).filter(Boolean));
}

function statusPath(line: string) {
	return line.slice(3).replace(/^.* -> /, "");
}

function findMixedFiles(status: string) {
	return status.split("\n").map((line) => line.trimEnd()).filter((line) => line && line[0] !== " " && line[1] !== " " && line[0] !== "?" && line[1] !== "?").map(statusPath);
}

function groupFiles(files: string[]) {
	const buckets: Record<string, string[]> = { docs: [], test: [], config: [], src: [], chore: [] };
	for (const file of files) {
		if (/(^|\/)README\.md$|\.md$/i.test(file)) buckets.docs.push(file);
		else if (/(^|\/)(test|tests|__tests__)\/|\.(test|spec)\./i.test(file)) buckets.test.push(file);
		else if (/\.(json|ya?ml|toml|config\.[cm]?[jt]s)$/i.test(file)) buckets.config.push(file);
		else if (/(^|\/)(src|lib)\//i.test(file)) buckets.src.push(file);
		else buckets.chore.push(file);
	}
	const groups = [] as Array<{ type: string; key: "src" | "test" | "docs" | "config" | "chore"; files: string[]; rationale: string }>;
	if (buckets.src.length) groups.push({ type: "feat", key: "src", files: buckets.src, rationale: "Groups source code changes together." });
	if (buckets.test.length) groups.push({ type: "test", key: "test", files: buckets.test, rationale: "Keeps test changes separate from runtime code." });
	if (buckets.docs.length) groups.push({ type: "docs", key: "docs", files: buckets.docs, rationale: "Keeps documentation changes separate." });
	if (buckets.config.length) groups.push({ type: "chore", key: "config", files: buckets.config, rationale: "Groups configuration and metadata updates." });
	if (buckets.chore.length) groups.push({ type: "chore", key: "chore", files: buckets.chore, rationale: "Groups remaining project changes." });
	return groups;
}

function fallbackSubject(key: "staged" | "src" | "test" | "docs" | "config" | "chore", config: GitCommitConfig) {
	const ko = /^ko|korean|한국어|한글/i.test(config.message?.language ?? "");
	const subjects = ko
		? { staged: "스테이징된 변경사항 커밋", src: "소스 변경사항 갱신", test: "테스트 갱신", docs: "문서 갱신", config: "설정 갱신", chore: "프로젝트 파일 갱신" }
		: { staged: "commit staged changes", src: "update source changes", test: "update tests", docs: "update documentation", config: "update configuration", chore: "update project files" };
	return subjects[key];
}

function makeMessage(type: string, subject: string, config: GitCommitConfig) {
	const allowedTypes = config.lint?.types;
	const finalType = allowedTypes?.length && !allowedTypes.includes(type) ? allowedTypes[0] : type;
	const scope = config.lint?.requireScope ? `(${config.lint.scopes?.[0] ?? "repo"})` : "";
	return `${finalType}${scope}: ${subject}`.slice(0, config.lint?.maxHeaderLength ?? 72);
}

function renderProposal(proposal: CommitProposal) {
	const lines = ["Commit proposal", "", `Source: ${proposal.source}${proposal.fallbackReason ? ` (${proposal.fallbackReason})` : ""}`, `Mode: ${proposal.mode}`, ""];
	proposal.commits.forEach((commit, index) => {
		lines.push(`Commit ${index + 1}`);
		lines.push(`  message: ${commit.message}`);
		if (commit.body) lines.push(`  body: ${commit.body.replace(/\n/g, "\n        ")}`);
		if (commit.footer) lines.push(`  footer: ${commit.footer.replace(/\n/g, "\n          ")}`);
		lines.push("  files:");
		commit.files.forEach((file) => lines.push(`    - ${file}`));
		lines.push("  why:");
		lines.push(`    ${commit.rationale}`);
		lines.push("");
	});
	if (proposal.notes.length) {
		lines.push("Local notes:");
		proposal.notes.forEach((note) => lines.push(`  - ${note.replace(/\n/g, "\n    ")}`));
		lines.push("");
	}
	return lines.join("\n");
}

async function askUser(ctx: ExtensionCommandContext, proposal: CommitProposal): Promise<UserAction> {
	const choice = await ctx.ui.select(renderProposal(proposal), ["Proceed as proposed", "Edit commit messages", "Regenerate with instruction", "Cancel"]);
	if (choice === "Proceed as proposed") return "proceed";
	if (choice === "Edit commit messages") return "edit";
	if (choice === "Regenerate with instruction") return "regenerate";
	return "cancel";
}

async function editCommitMessages(ctx: ExtensionCommandContext, proposal: CommitProposal): Promise<CommitProposal> {
	const initial = proposal.commits.map((commit, index) => [`Commit ${index + 1}`, `message: ${commit.message}`, "body: |", indentBlock(commit.body), "footer: |", indentBlock(commit.footer)].join("\n")).join("\n\n");
	const edited = await ctx.ui.editor("Edit commit messages", initial);
	if (!edited) return proposal;
	const parsed = parseEditedMessages(edited);
	if (parsed.length !== proposal.commits.length) {
		ctx.ui.notify("Message edit ignored: keep one `message:` block per commit.", "warning");
		return proposal;
	}
	return { ...proposal, commits: proposal.commits.map((commit, index) => ({ ...commit, ...parsed[index] })) };
}

function parseEditedMessages(text: string): Array<{ message: string; body?: string; footer?: string }> {
	const blocks = text.split(/\n(?=Commit \d+)/g);
	return blocks.map((block) => {
		const lines = block.split("\n");
		const message = lines.find((line) => line.startsWith("message:"))?.slice("message:".length).trim() ?? "";
		return { message, body: readPipeBlock(lines, "body"), footer: readPipeBlock(lines, "footer") };
	}).filter((item) => item.message);
}

function readPipeBlock(lines: string[], key: "body" | "footer") {
	const start = lines.findIndex((line) => line.trim() === `${key}: |`);
	if (start < 0) return undefined;
	const collected: string[] = [];
	for (let i = start + 1; i < lines.length; i++) {
		if (/^(message:|body: \||footer: \||Commit \d+)/.test(lines[i])) break;
		collected.push(lines[i].replace(/^  /, ""));
	}
	return cleanOptionalText(collected.join("\n"));
}

async function executeCommits(cwd: string, proposal: CommitProposal, onProgress?: (view: ProgressView) => void): Promise<CommitResult> {
	let stdout = "";
	let stderr = "";
	const summaries: string[] = [];
	for (const [index, commit] of proposal.commits.entries()) {
		const prefix = `Commit ${index + 1}/${proposal.commits.length}`;
		onProgress?.({
			title: "Executing commits",
			steps: [
				...summaries.map((summary) => ({ label: summary, state: "done" as const })),
				{ label: `${prefix}: ${commit.message}`, state: "active", detail: `files: ${commit.files.length}` },
			],
		});
		if (proposal.mode === "all-changes") {
			onProgress?.({ title: "Executing commits", steps: [...summaries.map((summary) => ({ label: summary, state: "done" as const })), { label: `${prefix}: stage files`, state: "active", detail: commit.files.map((file) => `- ${file}`).join("\n") }] });
			const addResult = await git(cwd, ["add", "--", ...commit.files]);
			stdout += addResult.stdout;
			stderr += addResult.stderr;
			if (!addResult.ok) return { ok: false, stdout, stderr, reason: "git" };
		}
		const args = ["commit", "-m", commit.message];
		if (commit.body) args.push("-m", commit.body);
		if (commit.footer) args.push("-m", commit.footer);
		onProgress?.({ title: "Executing commits", steps: [...summaries.map((summary) => ({ label: summary, state: "done" as const })), { label: `${prefix}: git commit`, state: "active", detail: commit.message }] });
		const commitResult = await git(cwd, args);
		stdout += commitResult.stdout;
		stderr += commitResult.stderr;
		if (!commitResult.ok) return { ok: false, stdout, stderr, reason: classifyCommitFailure(stderr) };
		const summary = await git(cwd, ["log", "-1", "--pretty=format:%h %s"]);
		if (summary.ok) summaries.push(summary.stdout.trim());
	}
	return { ok: true, stdout, stderr, summaries };
}

function classifyCommitFailure(stderr: string): "lint" | "hook" | "git" | "unknown" {
	const text = stderr.toLowerCase();
	if (text.includes("commitlint") || text.includes("scope") || text.includes("subject") || text.includes("type-enum") || text.includes("header")) return "lint";
	if (text.includes("hook") || text.includes("husky") || text.includes("lefthook") || text.includes("pre-commit") || text.includes("commit-msg")) return "hook";
	if (text.includes("nothing to commit") || text.includes("no changes added") || text.includes("not a git repository")) return "git";
	return "unknown";
}

function formatCommitFailureNotification(result: Exclude<CommitResult, { ok: true }>) {
	const output = `${result.stderr}\n${result.stdout}`.trim();
	const details = output ? `\n\n${output.slice(0, 2000)}` : "";
	return `Commit failed (${result.reason}).${details}\n\nResolve the Git state manually, then run /commit again.`;
}

function cleanOptionalText(value: unknown) {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function indentBlock(value?: string) {
	return value ? value.split("\n").map((line) => `  ${line}`).join("\n") : "";
}

function unique(values: string[]) {
	return [...new Set(values)];
}

function truncate(value: string, max: number) {
	return value.length > max ? `${value.slice(0, max)}\n...[truncated ${value.length - max} chars]` : value;
}

async function git(cwd: string, args: string[]): Promise<ShellResult> {
	try {
		const { stdout, stderr } = await execFileAsync("git", args, { cwd, maxBuffer: 1024 * 1024 * 20 });
		return { ok: true, stdout, stderr };
	} catch (error) {
		const err = error as { stdout?: string; stderr?: string; code?: number };
		return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? "", exitCode: err.code };
	}
}

async function shell(cwd: string, command: string): Promise<ShellResult> {
	try {
		const { stdout, stderr } = await execAsync(command, { cwd, maxBuffer: 1024 * 1024 * 20 });
		return { ok: true, stdout, stderr };
	} catch (error) {
		const err = error as { stdout?: string; stderr?: string; code?: number };
		return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? "", exitCode: err.code };
	}
}

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

// ─── State ───────────────────────────────────────────────────────────────────

type WorkflowMode = "idle" | "interviewing" | "executing" | "blocked" | "done";

interface WorkflowState {
  mode: WorkflowMode;
  branch: string | null;           // e.g. "pi/refactor-database-layer"
  baseBranch: string | null;       // the branch we started from
  planText: string | null;         // the locked plan content
  originalWorkingBranch: string | null; // branch at time of /pr-plan
}

let state: WorkflowState = {
  mode: "idle",
  branch: null,
  baseBranch: null,
  planText: null,
  originalWorkingBranch: null,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function execCapture(pi: ExtensionAPI, command: string, args: string[], timeout = 5000) {
  const result = await pi.exec(command, args, { timeout });
  return {
    ok: result.code === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    code: result.code ?? -1,
  };
}

async function getCurrentBranch(pi: ExtensionAPI): Promise<string | null> {
  const { ok, stdout } = await execCapture(pi, "git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  return ok ? stdout : null;
}

async function hasUncommittedChanges(pi: ExtensionAPI): Promise<boolean> {
  const { ok, stdout } = await execCapture(pi, "git", ["status", "--porcelain"]);
  return ok && stdout.length > 0;
}

async function checkGhAuth(pi: ExtensionAPI): Promise<{ ok: boolean; message: string }> {
  const { ok, stderr } = await execCapture(pi, "gh", ["auth", "status"]);
  if (!ok) {
    return { ok: false, message: `gh CLI not authenticated. Run 'gh auth login' first.\n${stderr}` };
  }
  return { ok: true, message: "ok" };
}

async function branchExists(pi: ExtensionAPI, branch: string): Promise<boolean> {
  const { ok, stdout } = await execCapture(pi, "git", ["rev-parse", "--verify", branch]);
  return ok && stdout.length > 0;
}

function generateBranchSlug(plan: string): string {
  // Use the first non-empty line as a summary
  const firstLine = plan.split("\n").find((l) => l.trim().length > 0) ?? "plan";
  const slug = firstLine
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return `pi/${slug || "plan"}`;
}

function persistState(pi: ExtensionAPI) {
  pi.appendEntry("pr-plan-state", { ...state });
}

function updateStatus(ctx: ExtensionContext) {
  if (state.mode === "idle") {
    ctx.ui.setStatus("pr-plan", undefined);
    ctx.ui.setWidget("pr-plan", undefined);
    return;
  }

  const branchLabel = state.branch ?? "unknown";
  const modeLabel =
    state.mode === "interviewing"
      ? "🔒 interviewing"
      : state.mode === "executing"
        ? "🔒 executing"
        : state.mode === "blocked"
          ? "🚫 blocked"
          : state.mode === "done"
            ? "✅ done"
            : "";

  ctx.ui.setStatus("pr-plan", ctx.ui.theme.fg("accent", `${modeLabel} ${branchLabel}`));

  // Widget showing current active task
  if (state.mode === "executing" && state.planText) {
    const lines = state.planText.split("\n");
    const activeLine = lines.find((l) => l.match(/^\d+\.\s*☐/)) ?? lines[0] ?? "Working...";
    ctx.ui.setWidget("pr-plan", [ctx.ui.theme.fg("muted", `Task: ${activeLine.replace(/^[\s☐✓]*/, "").trim()}`)]);
  } else {
    ctx.ui.setWidget("pr-plan", undefined);
  }
}

async function restoreStateFromSession(pi: ExtensionAPI, ctx: ExtensionContext) {
  const entries = ctx.sessionManager.getEntries();
  const lastState = entries
    .filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "pr-plan-state")
    .pop() as { data?: WorkflowState } | undefined;

  if (lastState?.data) {
    state = { ...lastState.data };
    // Validate branch still exists
    if (state.branch && !(await branchExists(pi, state.branch))) {
      state = { mode: "idle", branch: null, baseBranch: null, planText: null, originalWorkingBranch: null };
      persistState(pi);
    }
    updateStatus(ctx);
  }
}

// ─── Extension ─────────────────────────────────────────────────────────────────

export default function prPlanWorkflowExtension(pi: ExtensionAPI) {
  // ── Commands ────────────────────────────────────────────────────────────────

  pi.registerCommand("pr-plan", {
    description: "Start a PR-plan workflow: grill-me interview → branch → execute → PR",
    handler: async (_args, ctx) => {
      if (state.mode !== "idle") {
        ctx.ui.notify(
          `Already in PR-plan workflow on branch \`${state.branch}\`. Use /pr-done, /pr-cancel, or /pr-resume.`,
          "error",
        );
        return;
      }

      // 1. Check gh auth
      const gh = await checkGhAuth(pi);
      if (!gh.ok) {
        ctx.ui.notify(gh.message, "error");
        return;
      }

      // 2. Check repo is clean
      if (await hasUncommittedChanges(pi)) {
        ctx.ui.notify(
          "Uncommitted changes detected. Commit or stash them before starting PR-plan workflow.",
          "error",
        );
        return;
      }

      // 3. Remember where we started
      const current = await getCurrentBranch(pi);
      if (!current) {
        ctx.ui.notify("Could not determine current git branch.", "error");
        return;
      }
      state.originalWorkingBranch = current;
      state.baseBranch = current;

      // 4. Check for existing .pi/plan.md — if so, user must revise
      const planPath = ".pi/plan.md";
      const planExists = await execCapture(pi, "test", ["-f", planPath]).then((r) => r.ok);
      if (planExists) {
        const choice = await ctx.ui.confirm(
          "Existing plan found",
          `.pi/plan.md already exists. This will trigger another grill-me interview to revise it. Continue?`,
        );
        if (!choice) {
          state = { mode: "idle", branch: null, baseBranch: null, planText: null, originalWorkingBranch: null };
          return;
        }
      }

      // 5. Ask the user for their initial plan idea
      const idea = await ctx.ui.input(
        "What do you want to build?",
        "Describe your plan or idea in a few sentences...",
      );
      if (!idea?.trim()) {
        ctx.ui.notify("No plan provided. Cancelled.", "warning");
        return;
      }

      // 6. Enter interview mode and trigger grill-me with the user's idea
      state.mode = "interviewing";
      persistState(pi);
      updateStatus(ctx);
      ctx.ui.notify("PR-plan workflow started. Interviewing with grill-me skill...", "info");

      // Send the user's idea, then trigger the grill-me skill
      pi.sendUserMessage(`${idea.trim()}\n\n/skill:grill-me`, { deliverAs: "followUp" });
    },
  });

  pi.registerCommand("pr-done", {
    description: "Mark PR-plan work as complete and create a pull request",
    handler: async (_args, ctx) => {
      if (state.mode !== "executing" && state.mode !== "blocked") {
        ctx.ui.notify("No active PR-plan workflow to complete.", "error");
        return;
      }
      if (!state.branch || !state.baseBranch) {
        ctx.ui.notify("Workflow state is corrupted. Cancel and restart.", "error");
        return;
      }

      ctx.ui.notify("Generating PR summary...", "info");

      // Generate summary
      const diffStat = await execCapture(pi, "git", ["diff", `--stat`, `${state.baseBranch}...${state.branch}`]);
      const planSection = state.planText ?? "(no plan recorded)";
      const summary = `## Plan\n\n${planSection}\n\n## Changes\n\n${diffStat.ok ? diffStat.stdout : "(could not generate diff stat)"}`;

      // Push branch
      const push = await execCapture(pi, "git", ["push", "-u", "origin", state.branch]);
      if (!push.ok) {
        ctx.ui.notify(`Failed to push branch: ${push.stderr}`, "error");
        return;
      }

      // Create PR via gh
      const title = state.branch.replace("pi/", "").replace(/-/g, " ");
      const bodyFile = `/tmp/pr-body-${Date.now()}.md`;
      await pi.exec("bash", ["-c", `cat > ${bodyFile} << 'EOF'\n${summary}\nEOF`]);

      const pr = await execCapture(pi, "gh", [
        "pr", "create",
        "--base", state.baseBranch,
        "--head", state.branch,
        "--title", title,
        "--body-file", bodyFile,
      ]);

      if (!pr.ok) {
        ctx.ui.notify(`Failed to create PR: ${pr.stderr}`, "error");
        return;
      }

      ctx.ui.notify(`PR created! ${pr.stdout}`, "info");
      state.mode = "done";
      persistState(pi);
      updateStatus(ctx);

      // Offer to switch back to base branch
      const switchBack = await ctx.ui.confirm("Switch back to base branch?", `Checkout ${state.baseBranch}?`);
      if (switchBack) {
        await execCapture(pi, "git", ["checkout", state.baseBranch]);
        ctx.ui.notify(`Switched to ${state.baseBranch}`, "info");
        state = { mode: "idle", branch: null, baseBranch: null, planText: null, originalWorkingBranch: null };
        persistState(pi);
        updateStatus(ctx);
      }
    },
  });

  pi.registerCommand("pr-cancel", {
    description: "Cancel the active PR-plan workflow and return to the base branch",
    handler: async (_args, ctx) => {
      if (state.mode === "idle") {
        ctx.ui.notify("No active PR-plan workflow to cancel.", "error");
        return;
      }

      const confirm = await ctx.ui.confirm(
        "Cancel PR-plan?",
        `This will discard the branch \`${state.branch}\` and return to \`${state.baseBranch}\`.`,
      );
      if (!confirm) return;

      // Stash any uncommitted work
      await execCapture(pi, "git", ["stash", "-m", "pr-plan-cancel-stash"]);

      // Return to base branch
      if (state.baseBranch) {
        await execCapture(pi, "git", ["checkout", state.baseBranch]);
      }

      // Optionally delete the branch
      if (state.branch) {
        const del = await ctx.ui.confirm("Delete the pi branch?", `Remove \`${state.branch}\`?`);
        if (del) {
          await execCapture(pi, "git", ["branch", "-D", state.branch]);
        }
      }

      state = { mode: "idle", branch: null, baseBranch: null, planText: null, originalWorkingBranch: null };
      persistState(pi);
      updateStatus(ctx);
      ctx.ui.notify("PR-plan workflow cancelled.", "info");
    },
  });

  pi.registerCommand("pr-resume", {
    description: "Resume a previous PR-plan workflow from an existing pi/ branch",
    handler: async (_args, ctx) => {
      if (state.mode !== "idle") {
        ctx.ui.notify(
          `Already in PR-plan workflow on branch \`${state.branch}\`. Use /pr-done, /pr-cancel, or /pr-resume.`,
          "error",
        );
        return;
      }

      // List unmerged pi/ branches
      const branches = await execCapture(pi, "git", ["branch", "--format=%(refname:short)"]);
      if (!branches.ok) {
        ctx.ui.notify("Could not list branches.", "error");
        return;
      }

      const piBranches = branches.stdout
        .split("\n")
        .map((b) => b.trim())
        .filter((b) => b.startsWith("pi/"));

      if (piBranches.length === 0) {
        ctx.ui.notify("No pi/ branches found to resume.", "error");
        return;
      }

      const choice = await ctx.ui.select("Resume which branch?", piBranches);
      if (!choice) return;

      // Verify plan.md exists on that branch
      await execCapture(pi, "git", ["checkout", choice]);
      const planExists = await execCapture(pi, "test", ["-f", ".pi/plan.md"]).then((r) => r.ok);
      if (!planExists) {
        ctx.ui.notify(`Branch \`${choice}\` has no .pi/plan.md. Not a valid PR-plan branch.`, "error");
        await execCapture(pi, "git", ["checkout", state.originalWorkingBranch ?? "main"]);
        return;
      }

      // Load plan
      const planRead = await execCapture(pi, "cat", [".pi/plan.md"]);
      state.branch = choice;
      state.baseBranch = await execCapture(pi, "git", ["rev-parse", "--abbrev-ref", "@{upstream}"]).then(
        (r) => (r.ok ? r.stdout.replace("refs/remotes/origin/", "") : null),
      ) ?? "main";
      state.planText = planRead.ok ? planRead.stdout : null;
      state.mode = "executing";
      state.originalWorkingBranch = await getCurrentBranch(pi);
      persistState(pi);
      updateStatus(ctx);
      ctx.ui.notify(`Resumed PR-plan on branch \`${choice}\`.`, "info");
    },
  });

  // ── Events ──────────────────────────────────────────────────────────────────

  // Restore state on session start
  pi.on("session_start", async (_event, ctx) => {
    await restoreStateFromSession(pi, ctx);
  });

  // Block git branch switching during active workflow
  pi.on("tool_call", async (event) => {
    if (state.mode !== "idle" && event.toolName === "bash") {
      const command: string = event.input.command ?? "";
      const blocked = [
        /git\s+checkout/,
        /git\s+switch/,
        /git\s+branch\s+-[dD]/,
      ];
      if (blocked.some((re) => re.test(command))) {
        return {
          block: true,
          reason: `PR-plan workflow active on branch \`${state.branch}\`. Cannot switch or delete branches. Use /pr-done, /pr-cancel, or /pr-resume.`,
        };
      }
    }
  });

  // Minimal pointer during execution mode
  pi.on("before_agent_start", async () => {
    if (state.mode === "executing" && state.branch) {
      return {
        message: {
          customType: "pr-plan-context",
          content: `[PR-PLAN ACTIVE] Branch: ${state.branch} | Base: ${state.baseBranch} | See .pi/plan.md for locked plan.`,
          display: false,
        },
      };
    }
    if (state.mode === "interviewing") {
      return {
        message: {
          customType: "pr-plan-context",
          content: `[PR-PLAN INTERVIEWING] After we reach a shared understanding, you will be asked to confirm the plan. Do NOT create the branch yourself.`,
          display: false,
        },
      };
    }
  });

  // Handle plan confirmation after interview
  pi.on("agent_end", async (event, ctx) => {
    if (state.mode !== "interviewing" || !ctx.hasUI) return;

    // Extract plan from last assistant message
    const messages = event.messages;
    const lastAssistant = [...messages].reverse().find(
      (m) => m.role === "assistant" && Array.isArray(m.content),
    ) as { content: Array<{ type: string; text?: string }> } | undefined;

    if (!lastAssistant) return;

    const text = lastAssistant.content
      .filter((c): c is { type: string; text: string } => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");

    // Look for "Plan:" section
    const planMatch = text.match(/Plan:[\s\S]*?(?=\n\n[A-Z]|$)/i);
    const planSection = planMatch ? planMatch[0] : text.slice(0, 2000);

    if (!planSection.trim()) {
      // No plan yet — this is expected during back-and-forth interview turns
      return;
    }

    // Show plan and ask for confirmation
    const planPreview = planSection.slice(0, 800) + (planSection.length > 800 ? "..." : "");
    const confirm = await ctx.ui.confirm(
      "Lock this plan?",
      `${planPreview}\n\nCreate branch and begin execution?`,
    );

    if (!confirm) {
      // User rejected — stay in interviewing mode so they can refine
      ctx.ui.notify("Plan not locked. Continue refining.", "info");
      return;
    }

    // Generate branch name
    const branchName = generateBranchSlug(planSection);

    // Check for duplicate
    if (await branchExists(pi, branchName)) {
      ctx.ui.notify(
        `Branch \`${branchName}\` already exists. PR-plan workflow cannot start. Use /pr-resume or /pr-cancel, then try again.`,
        "error",
      );
      state = { mode: "idle", branch: null, baseBranch: null, planText: null, originalWorkingBranch: null };
      persistState(pi);
      updateStatus(ctx);
      return;
    }

    // Create branch, write plan, commit
    const checkout = await execCapture(pi, "git", ["checkout", "-b", branchName]);
    if (!checkout.ok) {
      ctx.ui.notify(`Failed to create branch: ${checkout.stderr}`, "error");
      return;
    }

    await pi.exec("bash", ["-c", `mkdir -p .pi && cat > .pi/plan.md << 'EOF'\n${planSection}\nEOF`]);
    await execCapture(pi, "git", ["add", ".pi/plan.md"]);
    await execCapture(pi, "git", ["commit", "-m", "chore: lock PR plan"]);

    state.branch = branchName;
    state.planText = planSection;
    state.mode = "executing";
    persistState(pi);
    updateStatus(ctx);
    ctx.ui.notify(`Branch \`${branchName}\` created and plan locked. Begin execution.`, "info");
  });

  // Warn on session shutdown if workflow active
  pi.on("session_shutdown", async (_event, ctx) => {
    if (state.mode === "executing" || state.mode === "interviewing") {
      // Non-interactive mode: just log
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Session ending with active PR-plan on \`${state.branch}\`. Resume with /pr-resume when you return.`,
          "warning",
        );
      }
    }
  });

  // ── Custom commit tool ──────────────────────────────────────────────────────

  pi.registerTool({
    name: "commit",
    label: "Commit",
    description: "Stage and commit changes with a conventional commit message. Auto-suggests the type based on changes.",
    parameters: Type.Object({
      message: Type.Optional(Type.String({ description: "Custom commit message. If omitted, a conventional message will be auto-suggested." })),
      type: Type.Optional(StringEnum(["feat", "fix", "chore", "test", "docs", "refactor", "style", "perf", "ci", "build", "revert"] as const)),
      scope: Type.Optional(Type.String({ description: "Optional scope, e.g. auth, db" })),
      files: Type.Optional(Type.Array(Type.String(), { description: "Specific files to stage. If omitted, stages all changes." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Stage files
      if (params.files && params.files.length > 0) {
        await pi.exec("git", ["add", ...params.files]);
      } else {
        await pi.exec("git", ["add", "-A"]);
      }

      // Build conventional commit message
      let message = params.message;
      if (!message) {
        const type = params.type ?? "chore";
        const scope = params.scope ? `(${params.scope})` : "";
        // Infer from diff
        const diffNames = await execCapture(pi, "git", ["diff", "--cached", "--name-only"]);
        const files = diffNames.ok ? diffNames.stdout.split("\n").filter(Boolean) : [];
        const summary = files.length > 0 ? `update ${files.slice(0, 3).join(", ")}${files.length > 3 ? " and others" : ""}` : "update";
        message = `${type}${scope}: ${summary}`;
      }

      const commit = await execCapture(pi, "git", ["commit", "-m", message]);
      if (!commit.ok) {
        throw new Error(`Commit failed: ${commit.stderr}`);
      }

      return {
        content: [{ type: "text", text: `Committed: ${message}\n${commit.stdout}` }],
        details: { message, stdout: commit.stdout },
      };
    },
  });

  // ── Blocker tool ─────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "report_blocker",
    label: "Report Blocker",
    description: "Report an unblockable issue. Creates a GitHub issue with details and stops the PR-plan workflow.",
    parameters: Type.Object({
      title: Type.String({ description: "Short title for the blocker" }),
      description: Type.String({ description: "Detailed description of the blocker and what was attempted" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (state.mode !== "executing" && state.mode !== "interviewing") {
        throw new Error("No active PR-plan workflow. Start one with /pr-plan.");
      }

      const currentBranch = state.branch ?? "unknown";
      const base = state.baseBranch ?? "unknown";
      const plan = state.planText ?? "(no plan)";

      // Get diff of partial work
      const diffStat = await execCapture(pi, "git", ["diff", "--stat", `${base}...${currentBranch}`]);
      const diff = diffStat.ok ? diffStat.stdout : "(could not generate diff)";

      const body = `## Blocker\n\n${params.description}\n\n## Plan Item Blocked\n\n${plan}\n\n## Partial Work\n\n${diff}\n\n## Branch\n\n\`${currentBranch}\` (off \`${base}\`)\n\n## Next Steps\n\nResume work with \`pi /pr-resume\` after resolving this issue.`;

      const issue = await execCapture(pi, "gh", [
        "issue", "create",
        "--title", `[PR-Plan Blocked] ${params.title}`,
        "--body", body,
      ]);

      if (!issue.ok) {
        throw new Error(`Failed to create issue: ${issue.stderr}`);
      }

      state.mode = "blocked";
      persistState(pi);
      updateStatus(ctx);

      // Stash and return to base
      await execCapture(pi, "git", ["stash", "-m", "pr-plan-blocker-stash"]);
      if (state.baseBranch) {
        await execCapture(pi, "git", ["checkout", state.baseBranch]);
      }

      return {
        content: [{ type: "text", text: `Blocker reported. Issue created: ${issue.stdout}\nWorkflow paused. Return with /pr-resume.` }],
        details: { issueUrl: issue.stdout, branch: currentBranch },
      };
    },
  });
}

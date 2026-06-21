/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence, Saga, Task, AnthropicAgent } from "smithers-orchestrator";
import { z } from "zod";
import { Database } from "bun:sqlite";

// ──────────────────────────────────────────────────────────────
// Schema definitions
// ──────────────────────────────────────────────────────────────

const { Workflow, smithers, outputs } = createSmithers({
  fetched_commits: z.object({
    repo: z.string(),
    count: z.number().int(),
    shas: z.string(),
    fetchedAt: z.string(),
  }),
  enrichment: z.object({
    repo: z.string(),
    riskLevel: z.string(),
    summary: z.string(),
    notableShas: z.string(),
  }),
  loaded_commits: z.object({
    repo: z.string(),
    loadedCount: z.number().int(),
    batchId: z.string(),
    rolledBack: z.boolean(),
  }),
  publish_feed: z.object({
    feedId: z.string(),
    published: z.boolean(),
  }),
});

// ──────────────────────────────────────────────────────────────
// Enrichment agent — haiku-4-5 for commit risk classification
// ──────────────────────────────────────────────────────────────

const enrichAgent = new AnthropicAgent({
  model: "claude-haiku-4-5",
  instructions:
    "You classify a batch of git commits for release-risk and write a one-paragraph changelog. Return ONLY raw JSON matching the schema. No markdown, no fences.",
});

// ──────────────────────────────────────────────────────────────
// Workflow (GREEN: real DELETE compensation — proves data integrity)
// ──────────────────────────────────────────────────────────────

export default smithers((ctx) => {
  const repo = ((ctx.input as Record<string, unknown>)?.repo as string) ?? "colinhacks/zod";
  const failPublish = ((ctx.input as Record<string, unknown>)?.failPublish as boolean) ?? true;

  const fetched = ctx.outputMaybe(outputs.fetched_commits, { nodeId: "fetch-commits" });
  const runId = ctx.runId;

  const sagaSteps = [
    {
      id: "load",
      action: (
        <Task id="load-act" output={outputs.loaded_commits} retries={0}>
          {async () => ({
            repo,
            loadedCount: fetched?.count ?? 0,
            batchId: runId,
            rolledBack: false,
          })}
        </Task>
      ),
      compensation: (
        // GREEN: real compensation — DELETEs the loaded row to ensure clean rollback
        <Task id="load-comp" output={outputs.loaded_commits}>
          {async () => {
            // Open a side-channel connection to smithers.db and delete the loaded row
            const db = new Database("./smithers.db");
            db.run("DELETE FROM loaded_commits WHERE run_id = ? AND node_id = 'load-act'", [runId]);
            db.close();
            return {
              repo,
              loadedCount: 0,
              batchId: runId,
              rolledBack: true,
            };
          }}
        </Task>
      ),
    },
    {
      id: "publish",
      action: (
        <Task id="publish-act" output={outputs.publish_feed} retries={0}>
          {async () => {
            if (failPublish) {
              throw new Error("downstream publish failed: feed broker unavailable (injected)");
            }
            return { feedId: `feed-${runId.slice(0, 8)}`, published: true };
          }}
        </Task>
      ),
      compensation: (
        // Publish never succeeded — its compensation is a no-op marker
        <Task id="publish-comp" output={outputs.publish_feed}>
          {async () => ({ feedId: "", published: false })}
        </Task>
      ),
    },
  ];

  return (
    <Workflow name="resilient-etl-saga">
      <Sequence>
        {/* STAGE 1: Fetch real commits from GitHub (keyless public API) */}
        <Task id="fetch-commits" output={outputs.fetched_commits} retries={1}>
          {async () => {
            const res = await fetch(
              `https://api.github.com/repos/${repo}/commits?per_page=5`,
              {
                headers: {
                  Accept: "application/vnd.github+json",
                  "User-Agent": "smithers-etl-poc",
                },
              }
            );
            if (!res.ok) {
              throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
            }
            const json = (await res.json()) as Array<{
              sha: string;
              commit: {
                message: string;
                author: { name: string; date: string };
              };
            }>;
            const shas = JSON.stringify(
              json.map((c) => ({
                sha: c.sha,
                message: c.commit.message.split("\n")[0].slice(0, 120),
                author: c.commit.author.name,
                date: c.commit.author.date,
              }))
            );
            return {
              repo,
              count: json.length,
              shas,
              fetchedAt: new Date().toISOString(),
            };
          }}
        </Task>

        {/* STAGE 2: Enrich commits with LLM risk classification */}
        <Task id="enrich-commits" agent={enrichAgent} output={outputs.enrichment} retries={1}>
          {`Analyze these git commits from the ${repo} repository and classify for release risk.

Commits (JSON):
${fetched?.shas ?? "[]"}

Return ONLY a JSON object with these fields:
- repo: the repository name (string)
- riskLevel: "low", "medium", or "high" based on the nature of the commits
- summary: a one-paragraph changelog summary of at most 80 words
- notableShas: comma-joined short SHAs (first 8 chars) of the most notable commits

Return raw JSON only. No markdown. No code fences.`}
        </Task>

        {/* STAGES 3+4: Saga — load then publish, with compensation on failure */}
        <Saga id="ingest-saga" onFailure="compensate" steps={sagaSteps} />
      </Sequence>
    </Workflow>
  );
});

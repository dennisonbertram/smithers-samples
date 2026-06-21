/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence, Task } from "smithers-orchestrator";
import { AnthropicAgent } from "smithers-orchestrator";
import { z } from "zod";
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// ──────────────────────────────────────────────────────────────
// Schema definitions — all numeric fields as z.string() to avoid
// z.number() -> INTEGER truncation gotcha
// ──────────────────────────────────────────────────────────────

const { Workflow, smithers, outputs } = createSmithers({
  research: z.object({
    targetName: z.string(),
    oneLiner: z.string(),
    primaryQuestion: z.string(),
    audience: z.string(),
    capabilities: z.array(z.object({
      name: z.string(),
      primitive: z.string(),
      evidenceRequired: z.string(),
    })),
    setupFacts: z.array(z.string()),
    liveServiceModel: z.string(),
    credentialNeeds: z.string(),
    knownFailureModes: z.array(z.string()),
  }),
  plan: z.object({
    progressionPrinciple: z.string(),
    levels: z.array(z.object({
      level: z.string(),
      name: z.string(),
      concept: z.string(),
      liveService: z.string(),
      credentials: z.string(),
      tddIntent: z.string(),
      liveEvidence: z.string(),
      blockedIf: z.string(),
    })),
    capstone: z.string(),
  }),
  writeMetadata: z.object({
    relPath: z.string(),
    bytes: z.string(),
    wrote: z.boolean(),
  }),
  writeResearchDocs: z.object({
    relPath: z.string(),
    bytes: z.string(),
    wrote: z.boolean(),
  }),
  writePlanningDocs: z.object({
    relPath: z.string(),
    bytes: z.string(),
    wrote: z.boolean(),
  }),
  writeStubs: z.object({
    dirsCreated: z.string(),
    filesCreated: z.string(),
    wrote: z.boolean(),
  }),
  manifest: z.object({
    degreeRoot: z.string(),
    totalFiles: z.string(),
    totalDirs: z.string(),
    smithersRunId: z.string(),
  }),
});

// ──────────────────────────────────────────────────────────────
// Agents — sonnet for large structured payloads
// ──────────────────────────────────────────────────────────────

const research = new AnthropicAgent({
  model: "claude-sonnet-4-6",
  maxOutputTokens: 4096,
  instructions: `You are an expert technical research analyst.
Your task is to produce a structured research map for a given tool/service.
Return ONLY a raw JSON object matching the schema exactly. No markdown fences, no backticks, no explanation.
The response must start with { and end with }.
Capabilities should be P0-relevant (the most important things to demonstrate) and each must name a concrete primitive.
Limit capabilities to at most 8 items. Keep strings concise.`,
});

const planner = new AnthropicAgent({
  model: "claude-sonnet-4-6",
  maxOutputTokens: 4096,
  instructions: `You are an expert curriculum and learning-path planner.
Design an L0..L5 red->green->regression POC ladder for the given tool/service research.
Return ONLY a raw JSON object matching the schema exactly. No markdown fences, no backticks, no explanation.
The response must start with { and end with }.
Include exactly 6 levels (L0 through L5). Each level builds on the previous.
Keep all strings concise (under 120 chars each).`,
});

// ──────────────────────────────────────────────────────────────
// Helper: walk directory tree and count files + dirs
// ──────────────────────────────────────────────────────────────

function walkDir(dir: string): { files: number; dirs: number } {
  let files = 0;
  let dirs = 0;
  if (!existsSync(dir)) return { files, dirs };
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      dirs++;
      const sub = walkDir(fullPath);
      files += sub.files;
      dirs += sub.dirs;
    } else {
      files++;
    }
  }
  return { files, dirs };
}

// ──────────────────────────────────────────────────────────────
// Workflow
// ──────────────────────────────────────────────────────────────

export default smithers((ctx) => {
  const target = ctx.input.target ?? "redis";
  const category = ctx.input.category ?? "uncategorized";
  const dirName = ctx.input.dirName ?? "01-overview";
  const outDir = ctx.input.outDir ?? "./scratch-out";

  const degreeRoot = join(outDir, target, "degrees", dirName);

  // Read agent outputs for downstream compute tasks
  const researchOut = ctx.outputMaybe(outputs.research, { nodeId: "research" });
  const planOut = ctx.outputMaybe(outputs.plan, { nodeId: "plan" });

  return (
    <Workflow name="degree-builder">
      <Sequence>
        {/* STAGE 1: Research agent — maps capabilities + facts */}
        <Task id="research" agent={research} output={outputs.research} retries={2}>
          {`Target tool/service: "${target}" (category: ${category}).
Produce a structured knowledge-base research map covering this tool/service.
Capabilities must be P0-relevant and each names a concrete primitive + the evidence a live POC must capture.
Include 6-8 capabilities covering the most important aspects of ${target}.
Return ONLY JSON matching the schema exactly.`}
        </Task>

        {/* STAGE 2: Planner agent — drafts L0..L5 POC ladder */}
        <Task id="plan" agent={planner} output={outputs.plan} retries={2}>
          {`Design an L0..L5 POC ladder for the "${target}" learning track.

Research summary:
- Tool: ${researchOut?.targetName ?? target}
- One-liner: ${researchOut?.oneLiner ?? "(research pending)"}
- Primary question: ${researchOut?.primaryQuestion ?? "(pending)"}
- Audience: ${researchOut?.audience ?? "(pending)"}
- Live service model: ${researchOut?.liveServiceModel ?? "(pending)"}
- Credential needs: ${researchOut?.credentialNeeds ?? "(pending)"}

Capabilities from research:
${JSON.stringify(researchOut?.capabilities ?? [], null, 2)}

Design exactly 6 levels (L0 through L5), each building toward more advanced usage.
Include a capstone that synthesizes all levels.
Return ONLY JSON matching the schema exactly.`}
        </Task>

        {/* STAGE 3a: Write 00-metadata stage */}
        <Task id="write-metadata" output={outputs.writeMetadata} retries={0}>
          {async () => {
            // RED gate: if DEGREE_BUILDER_RED=1, fail immediately
            if (process.env.DEGREE_BUILDER_RED === "1") {
              throw new Error("RED: writers disabled to prove red->green");
            }

            const stageDir = join(degreeRoot, "00-metadata");
            mkdirSync(stageDir, { recursive: true });

            let totalBytes = 0;

            const writeIfNew = (filePath: string, content: string) => {
              if (!existsSync(filePath)) {
                writeFileSync(filePath, content);
                totalBytes += content.length;
              }
            };

            const r = researchOut!;

            writeIfNew(join(stageDir, "degree.md"), `# ${r.targetName} Knowledge Base

## Name
${r.targetName}

## Target
${target}

## Slug
${target}-${category}

## Prime Directive
${r.oneLiner}

## Audience
${r.audience}

## Primary Question
${r.primaryQuestion}

## Status
Scaffolded; POCs pending.

## Why This Topic Matters
${r.oneLiner}. This knowledge base covers the essential primitives a practitioner needs to use ${r.targetName} effectively in production, with hands-on examples demonstrating each capability.
`);

            writeIfNew(join(stageDir, "scope.md"), `# Scope

## In Scope
- ${r.capabilities.map(c => c.name).join("\n- ")}

## Out of Scope
- Enterprise/advanced configurations beyond the 6 POC levels
- Custom deployment topologies

## Boundaries
This knowledge base focuses on ${r.targetName} fundamentals through L0–L5 hands-on examples.
`);

            writeIfNew(join(stageDir, "versions.md"), `# Versions

## Target Version
TBD — use latest stable

## Tested With
TBD — POCs pending

## Known Version Constraints
${r.knownFailureModes.slice(0, 2).join("\n") || "None documented yet."}
`);

            writeIfNew(join(stageDir, "environment.md"), `# Environment

## Required Setup
${r.setupFacts.map(f => `- ${f}`).join("\n")}

## OS Compatibility
- macOS (primary)
- Linux (CI)

## Runtime Dependencies
See live-access-requirements.md
`);

            writeIfNew(join(stageDir, "live-access-requirements.md"), `# Live Access Requirements

## Credential Needs
${r.credentialNeeds}

## Live Service Model
${r.liveServiceModel}

## Setup Facts
${r.setupFacts.map(f => `- ${f}`).join("\n")}
`);

            writeIfNew(join(stageDir, "assumptions.md"), `# Assumptions

## Core Assumptions
- ${target} is accessible via its standard interface
- Developer has the credentials listed in live-access-requirements.md
- All POCs are run against a live (non-mocked) service

## What We Are NOT Assuming
- Any specific version of ${target} (use latest stable)
- Pre-existing data in the target system
`);

            writeIfNew(join(stageDir, "credential-and-secret-policy.md"), `# Credential and Secret Policy

## Required Credentials
${r.credentialNeeds}

## Policy
- Never commit credentials to source control
- Use environment variables for all secrets
- Use .gitignore to exclude .env files
- Rotate credentials after any accidental exposure
`);

            writeIfNew(join(stageDir, "source-inventory.md"), `# Source Inventory

## Official Sources
- Official ${target} documentation
- Official API reference

## Research Sources
- Capability map (generated by degree-builder workflow)
- Live POC evidence files

## Status
Scaffolded; full inventory pending POC completion.
`);


            return { relPath: "00-metadata", bytes: String(totalBytes), wrote: true };
          }}
        </Task>

        {/* STAGE 3b: Write 01-research stage */}
        <Task id="write-research" output={outputs.writeResearchDocs} retries={0}>
          {async () => {
            if (process.env.DEGREE_BUILDER_RED === "1") {
              throw new Error("RED: writers disabled");
            }

            // Pause to create a killable window for durability testing
            await Bun.sleep(20000);

            const stageDir = join(degreeRoot, "01-research");
            mkdirSync(stageDir, { recursive: true });

            let totalBytes = 0;
            const r = researchOut!;

            const writeIfNew = (filePath: string, content: string) => {
              if (!existsSync(filePath)) {
                writeFileSync(filePath, content);
                totalBytes += content.length;
              }
            };

            // capability-map.md — house format table
            writeIfNew(join(stageDir, "capability-map.md"), `# Capability Map — ${r.targetName}

| P0 capability | ${r.targetName} primitive | Evidence required |
|---|---|---|
${r.capabilities.map(c => `| ${c.name} | ${c.primitive} | ${c.evidenceRequired} |`).join("\n")}
`);

            writeIfNew(join(stageDir, "mental-model.md"), `# Mental Model — ${r.targetName}

## Core Abstraction
${r.oneLiner}

## How It Works
${r.capabilities.slice(0, 3).map(c => `- **${c.name}**: ${c.primitive}`).join("\n")}

## Key Concepts
See capability-map.md for the full P0 capability list.
`);

            writeIfNew(join(stageDir, "setup-and-installation.md"), `# Setup and Installation

## Prerequisites
${r.setupFacts.map(f => `- ${f}`).join("\n")}

## Installation
See official documentation for the current installation procedure.

## Verification
After setup, run the L0 POC to verify your environment is working.
`);

            writeIfNew(join(stageDir, "live-service-model.md"), `# Live Service Model

${r.liveServiceModel}

## Access Pattern
${r.credentialNeeds}
`);

            writeIfNew(join(stageDir, "known-failure-modes.md"), `# Known Failure Modes

${r.knownFailureModes.map(m => `## ${m.slice(0, 60)}\n${m}\n`).join("\n")}
`);

            writeIfNew(join(stageDir, "research-index.md"), `# Research Index

## Sources Consulted
- Official ${target} documentation
- Live POC evidence (pending)
- Capability map (see capability-map.md)

## Research Status
Scaffolded; live verification pending.
`);

            writeIfNew(join(stageDir, "official-docs-summary.md"), `# Official Docs Summary — ${r.targetName}

## Primary Question Answered
${r.primaryQuestion}

## Summary
${r.oneLiner}

## Key Docs
- See capability-map.md for P0 primitives
- See setup-and-installation.md for setup steps
`);

            writeIfNew(join(stageDir, "configuration-and-env-vars.md"), `# Configuration and Environment Variables

## Required Environment Variables
${r.credentialNeeds}

## Setup Facts
${r.setupFacts.map(f => `- ${f}`).join("\n")}

## Notes
See live-access-requirements.md for credential policy.
`);

            return { relPath: "01-research", bytes: String(totalBytes), wrote: true };
          }}
        </Task>

        {/* STAGE 3c: Write 02-planning stage */}
        <Task id="write-planning" output={outputs.writePlanningDocs} retries={0}>
          {async () => {
            if (process.env.DEGREE_BUILDER_RED === "1") {
              throw new Error("RED: writers disabled");
            }

            const stageDir = join(degreeRoot, "02-planning");
            mkdirSync(stageDir, { recursive: true });

            let totalBytes = 0;
            const p = planOut!;
            const r = researchOut!;

            const writeIfNew = (filePath: string, content: string) => {
              if (!existsSync(filePath)) {
                writeFileSync(filePath, content);
                totalBytes += content.length;
              }
            };

            // poc-progression.md — exact house format
            writeIfNew(join(stageDir, "poc-progression.md"), `# POC Progression — ${r.targetName}

## Progression Principle
${p.progressionPrinciple}

${p.levels.map(l => `## ${l.level} — ${l.name}

**Concept:** ${l.concept}

**Live service:** ${l.liveService}

**Credentials:** ${l.credentials}

**Real resources:** See live-access-requirements.md

**TDD intent — RED/GREEN/REGRESSION:** ${l.tddIntent}

**Live evidence:** ${l.liveEvidence}

**Blocked if:** ${l.blockedIf}
`).join("\n")}
`);

            writeIfNew(join(stageDir, "degree-plan.md"), `# Learning Track Plan — ${r.targetName}

## Target
${target} (category: ${category})

## Levels
${p.levels.map(l => `- **${l.level}** — ${l.name}: ${l.concept}`).join("\n")}

## Capstone
${p.capstone}

## Status
Scaffolded; POCs pending.
`);

            writeIfNew(join(stageDir, "success-criteria.md"), `# Success Criteria

## Per-Level Criteria
${p.levels.map(l => `### ${l.level} — ${l.name}\n- Live evidence: ${l.liveEvidence}\n- Blocked if: ${l.blockedIf}\n`).join("\n")}

## Capstone Criteria
${p.capstone}
`);

            writeIfNew(join(stageDir, "live-test-strategy.md"), `# Live Test Strategy

## Principle
All POCs must hit the real ${target} service. No mocks.

## Per-Level Test Approach
${p.levels.map(l => `- **${l.level}**: ${l.tddIntent}`).join("\n")}

## Evidence Requirements
Each POC must produce SQLite rows, real API call evidence, and a red->green transition.
`);

            writeIfNew(join(stageDir, "no-mock-enforcement-plan.md"), `# No-Mock Enforcement Plan

## Policy
This knowledge base enforces live-service-only testing. Mocks are prohibited.

## Enforcement
- All POCs connect to ${r.liveServiceModel}
- Credentials: ${r.credentialNeeds}
- Any use of mocks/stubs invalidates the POC evidence
`);

            writeIfNew(join(stageDir, "risk-register.md"), `# Risk Register

## Known Risks
${r.knownFailureModes.map((m, i) => `### R${i + 1}: ${m.slice(0, 60)}\n**Description:** ${m}\n**Mitigation:** TBD\n`).join("\n")}
`);

            writeIfNew(join(stageDir, "observability-strategy.md"), `# Observability Strategy

## SQLite Tables
Each POC populates named Smithers tables for evidence.

## Key Observability Points
- Run status: _smithers_runs
- Task attempts: _smithers_attempts
- Events: _smithers_events
- Custom output: per-POC output tables

## Evidence Capture
All live evidence is captured in 04-logs/live-evidence-ledger.md.
`);

            writeIfNew(join(stageDir, "capstone-plan.md"), `# Capstone Plan

## Capstone Description
${p.capstone}

## Status
Scaffolded; capstone POC pending.
`);

            return { relPath: "02-planning", bytes: String(totalBytes), wrote: true };
          }}
        </Task>

        {/* STAGE 3d: Write stubs for 03-07 + top README */}
        <Task id="write-stubs" output={outputs.writeStubs} retries={0}>
          {async () => {
            if (process.env.DEGREE_BUILDER_RED === "1") {
              throw new Error("RED: writers disabled");
            }

            const p = planOut!;
            const r = researchOut!;

            let dirsCreated = 0;
            let filesCreated = 0;

            const writeIfNew = (filePath: string, content: string) => {
              if (!existsSync(filePath)) {
                writeFileSync(filePath, content);
                filesCreated++;
              }
            };

            const mkIfNew = (dir: string) => {
              if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
                dirsCreated++;
              }
            };

            // 03-pocs: create dirs for each level
            const pocsDir = join(degreeRoot, "03-pocs");
            mkIfNew(pocsDir);

            const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

            for (const level of p.levels) {
              const pocDir = join(pocsDir, `${level.level.toLowerCase()}-${slugify(level.name)}`);
              mkIfNew(pocDir);
              writeIfNew(join(pocDir, ".gitkeep"), "");
            }

            writeIfNew(join(pocsDir, "README.md"), `# 03 — POCs

## Status
Scaffolded; POCs pending.

## Planned Layout
${p.levels.map(l => `- \`${l.level.toLowerCase()}-${slugify(l.name)}/\` — ${l.name}`).join("\n")}
`);

            // 04-logs
            const logsDir = join(degreeRoot, "04-logs");
            mkIfNew(logsDir);

            writeIfNew(join(logsDir, "live-evidence-ledger.md"), `# Live Evidence Ledger

## Entry Template
\`\`\`
## [DATE] — [POC ID]
- runId: <smithers runId>
- status: <finished|partial|blocked>
- evidence: <summary>
\`\`\`

## Entries
No entries yet — POCs pending.
`);

            writeIfNew(join(logsDir, "command-log.md"), `# Command Log

No commands logged yet.
`);

            writeIfNew(join(logsDir, "decision-log.md"), `# Decision Log

No decisions logged yet.
`);

            writeIfNew(join(logsDir, "error-log.md"), `# Error Log

No errors logged yet.
`);

            writeIfNew(join(logsDir, "access-blockers.md"), `# Access Blockers

No blockers documented yet.
`);

            writeIfNew(join(logsDir, "test-results.md"), `# Test Results

No test results yet.
`);

            writeIfNew(join(logsDir, "quality-gate-log.md"), `# Quality Gate Log

No quality gate entries yet.
`);

            // 05-distillation, 06-skill-pack, 07-evaluation READMEs
            for (const [stage, title] of [
              ["05-distillation", "Distillation"],
              ["06-skill-pack", "Skill Pack"],
              ["07-evaluation", "Evaluation"],
            ]) {
              const dir = join(degreeRoot, stage);
              mkIfNew(dir);
              writeIfNew(join(dir, "README.md"), `# ${stage} — ${title}

Status: Scaffolded; pending POC completion.
`);
            }

            // Top-level README
            writeIfNew(join(degreeRoot, "README.md"), `# ${r.targetName} Knowledge Base

## Overview
${r.oneLiner}

## Primary Question
${r.primaryQuestion}

## Audience
${r.audience}

## POC Levels
${p.levels.map(l => `- **${l.level}** — ${l.name}`).join("\n")}

## Capstone
${p.capstone}

## Status
Scaffolded; POCs pending.
`);

            return {
              dirsCreated: String(dirsCreated),
              filesCreated: String(filesCreated),
              wrote: true,
            };
          }}
        </Task>

        {/* STAGE 4: Manifest — count files + dirs */}
        <Task id="manifest" output={outputs.manifest}>
          {async () => {
            const { files, dirs } = walkDir(degreeRoot);
            return {
              degreeRoot,
              totalFiles: String(files),
              totalDirs: String(dirs),
              smithersRunId: ctx.runId,
            };
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});

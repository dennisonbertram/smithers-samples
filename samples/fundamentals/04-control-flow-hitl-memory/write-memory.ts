/**
 * Cross-run memory writer.
 * Run this BEFORE the second workflow run to plant a memory fact.
 * Then the second run can read it via memory CLI or the store API.
 */
import { createMemoryStore } from "smithers-orchestrator/memory";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

const sqlite = new Database("smithers.db");
const db = drizzle(sqlite);
const store = createMemoryStore(db);

const ns = { kind: "workflow" as const, id: "l3-control-hitl-memory" };

await store.setFact(ns, "poc-fact", {
  value: "L3 memory proof: written by write-memory.ts",
  writtenAt: new Date().toISOString(),
});

console.log("Memory fact written.");

// Immediately read it back to prove round-trip
const recalled = await store.getFact(ns, "poc-fact");
console.log("Recalled fact:", JSON.stringify(recalled, null, 2));

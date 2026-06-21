/**
 * Cross-run memory reader.
 * Run this AFTER write-memory.ts to prove recall in a separate script.
 * Also dumps the raw SQLite row.
 */
import { createMemoryStore } from "smithers-orchestrator/memory";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

const sqlite = new Database("smithers.db");
const db = drizzle(sqlite);
const store = createMemoryStore(db);

const ns = { kind: "workflow" as const, id: "l3-control-hitl-memory" };

const facts = await store.listFacts(ns);
console.log("All facts in namespace:", JSON.stringify(facts, null, 2));

const specific = await store.getFact(ns, "poc-fact");
console.log("Specific fact 'poc-fact':", JSON.stringify(specific, null, 2));

// Raw SQLite row proof
const raw = sqlite.query("SELECT * FROM _smithers_memory_facts WHERE namespace = ? AND key = ?").all("workflow:l3-control-hitl-memory", "poc-fact");
console.log("Raw SQLite row:", JSON.stringify(raw, null, 2));

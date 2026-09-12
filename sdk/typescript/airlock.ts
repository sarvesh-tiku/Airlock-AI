/**
 * Airlock client for TypeScript agents. Zero dependencies; uses global fetch.
 *
 *   import { Airlock, ActionDenied } from "./airlock.ts";
 *   const airlock = new Airlock();
 *   const lease = await airlock.createLease({ issueId: "ENG-142", agent: "my-agent", writeSet: ["auth/**"] });
 *   await airlock.require(lease.id, "open-pr", ["auth/session"]);   // throws ActionDenied
 *
 * Decisions are made by the server. This client never turns a denial into an allow
 * and treats an unreachable Airlock as a denial.
 */

export type Action =
  | "open-pr" | "merge" | "deploy" | "modify-schema" | "change-api-contract" | "close-issue"
  | "edit-files" | "run-tests" | "read";

export type GateCode =
  | "ALLOW" | "STALE_CONTEXT" | "INCONSISTENT_CONTEXT" | "WEAK_PROVENANCE" | "OUT_OF_SCOPE" | "AGENT_COLLISION";

export type CheckName = "freshness" | "consistency" | "provenance" | "authority" | "concurrency";
export type LeaseStatus = "active" | "invalid" | "released";
export type FactKind = "requirement" | "constraint" | "dependency" | "authority";
export type Invariant = "I1" | "I2" | "I3" | "I4" | "I5";

export interface Check { name: CheckName; ok: boolean; detail: string; code?: GateCode }

export interface Decision {
  allowed: boolean;
  code: GateCode;
  reason: string;
  tier: "consequential" | "light";
  invariant: Invariant | null;
  checks: Check[];
  issueId: string;
  leaseId: string;
  revision: number;
  agent: string;
  action: Action | string;
  resources: string[];
  at: string;
  analysis?: string | null;
}

export interface Fact {
  id: string;
  kind: FactKind;
  text: string;
  source: { issueId: string | null; field: string; commentId: string | null; url: string | null };
  author: string | null;
  at: string | null;
  version: string;
  confidence: number;
}

export interface Consistency {
  status: "consistent" | "contradiction";
  findings: { a: string; b: string; method: "heuristic" | "model"; explanation: string }[];
  methods: string[];
}

export interface Lease {
  id: string;
  issueId: string;
  agent: string;
  status: LeaseStatus;
  revision: number;
  issuedAt: string;
  watches: Record<string, string>;
  readSet: string[];
  writeSet: string[];
  allowedActions: string[];
  deniedActions: string[];
  facts: Fact[];
  consistency: Consistency;
  changedSources: string[];
  changedFacts: { type: "added" | "modified" | "removed"; kind: FactKind; source: string | null; author?: string; at?: string; text?: string; before?: string }[];
  drift?: { explanation: string }[];
  history: { revision: number; issuedAt: string; invalidatedAt: string | null; changedSources: string[] }[];
}

export interface CreateLeaseInput {
  issueId: string;
  agent: string;
  readSet?: string[];
  writeSet?: string[];
  allowedActions?: string[];
  deniedActions?: string[];
  operator?: string;
}

export class AirlockError extends Error {}
export class AirlockUnavailable extends AirlockError {}
export class ActionDenied extends AirlockError {
  readonly decision: Decision;
  constructor(decision: Decision) {
    super(`Airlock denied ${decision.action}: ${decision.reason}`);
    this.decision = decision;
  }
}

export interface AirlockOptions { baseUrl?: string; timeoutMs?: number; fetch?: typeof fetch }

export class Airlock {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AirlockOptions = {}) {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    this.baseUrl = (options.baseUrl ?? env?.AIRLOCK_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new AirlockUnavailable(error instanceof Error ? error.message : String(error));
    }
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new AirlockError(data.error ?? `HTTP ${response.status}`);
    return data as T;
  }

  state(): Promise<Record<string, unknown>> { return this.request("GET", "/api/state"); }
  audit(): Promise<{ audit: Decision[] }> { return this.request("GET", "/api/audit"); }
  lease(leaseId: string): Promise<Lease> { return this.request("GET", `/api/leases/${leaseId}`); }
  createLease(input: CreateLeaseInput): Promise<Lease> { return this.request("POST", "/api/leases", input); }
  release(leaseId: string): Promise<Lease> { return this.request("POST", "/api/leases/release", { leaseId }); }
  replan(leaseId: string): Promise<Lease> { return this.request("POST", "/api/leases/replan", { leaseId }); }

  /** Ask the gate; never throws on a denial. */
  gate(leaseId: string, action: Action | string, resources: string[] = []): Promise<Decision> {
    return this.request("POST", "/api/gate", { leaseId, action, resources });
  }

  /** Ask the gate; throws ActionDenied unless allowed. */
  async require(leaseId: string, action: Action | string, resources: string[] = []): Promise<Decision> {
    const decision = await this.gate(leaseId, action, resources);
    if (!decision.allowed) throw new ActionDenied(decision);
    return decision;
  }

  /** Wrap an async function so it only runs when the gate allows, checked at call time. */
  guarded<A extends unknown[], R>(leaseId: string, action: Action | string, resources: string[], fn: (...args: A) => Promise<R> | R): (...args: A) => Promise<R> {
    return async (...args: A) => {
      await this.require(leaseId, action, resources);
      return fn(...args);
    };
  }

  /** The first failing check of a decision, which is the one that decided. */
  static failing(decision: Decision): Check | undefined {
    return decision.checks.find((c) => !c.ok);
  }
}

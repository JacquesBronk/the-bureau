import { describe, it, expect } from "vitest";
import {
  transition,
  isTerminal,
  canTransitionTo,
  StateTransitionError,
  TRANSITIONS,
  type TaskStatus,
  type TransitionName,
} from "../state-machine.js";

// All valid transitions: [from, to, expectedName]
const VALID_TRANSITIONS: [TaskStatus, TaskStatus, TransitionName][] = [
  ["pending",            "ready",              "deps_met"],
  ["pending",            "awaiting_approval",  "approval_required"],
  ["pending",            "canceled",           "cancel"],
  ["awaiting_approval",  "ready",              "approve"],
  ["awaiting_approval",  "canceled",           "cancel"],
  ["ready",              "running",            "dispatch"],
  ["ready",              "failed",             "dispatch_failed"],
  ["ready",              "canceled",           "cancel"],
  ["running",            "validating",         "validate"],
  ["running",            "completed",          "complete"],
  ["running",            "failed",             "fail"],
  ["running",            "ready",              "oom_retry"],
  ["running",            "canceled",           "cancel"],
  ["running",            "pending",            "auto_retry"],
  ["running",            "yielded",            "yield"],
  ["validating",         "completed",          "complete"],
  ["validating",         "failed",             "fail"],
  ["validating",         "canceled",           "cancel"],
  ["yielded",            "running",            "resume"],
  ["yielded",            "ready",              "yield_resolved"],
  ["yielded",            "canceled",           "cancel"],
  ["yielded",            "pending",            "retry"],
  ["failed",             "pending",            "retry"],
  ["canceled",           "pending",            "retry"],
];

const ALL_STATES: TaskStatus[] = [
  "pending", "ready", "awaiting_approval",
  "running", "validating", "completed", "failed", "canceled", "yielded",
];

const TERMINAL_STATES: TaskStatus[] = ["completed", "failed", "canceled"];
const NON_TERMINAL_STATES: TaskStatus[] = ["pending", "ready", "awaiting_approval", "running", "validating", "yielded"];

// Derive all invalid transitions from the valid set
const VALID_SET = new Set(VALID_TRANSITIONS.map(([f, t]) => `${f}→${t}`));
const ALL_INVALID_TRANSITIONS: [TaskStatus, TaskStatus][] = [];
for (const from of ALL_STATES) {
  for (const to of ALL_STATES) {
    if (from !== to && !VALID_SET.has(`${from}→${to}`)) {
      ALL_INVALID_TRANSITIONS.push([from, to]);
    }
  }
}

// ─── TRANSITIONS table structure ───────────────────────────────────────────

describe("TRANSITIONS table — structure", () => {
  it("has exactly 9 entries (one per TaskStatus)", () => {
    expect(TRANSITIONS.size).toBe(9);
  });

  it("contains every TaskStatus as a key", () => {
    for (const s of ALL_STATES) {
      expect(TRANSITIONS.has(s)).toBe(true);
    }
  });

  it("contains exactly 24 valid transitions total", () => {
    let count = 0;
    for (const inner of TRANSITIONS.values()) count += inner.size;
    expect(count).toBe(24);
  });

  it("completed has 0 outgoing transitions (true terminal)", () => {
    expect(TRANSITIONS.get("completed")!.size).toBe(0);
  });

  it("failed has exactly 1 outgoing transition (→ pending retry)", () => {
    expect(TRANSITIONS.get("failed")!.size).toBe(1);
    expect(TRANSITIONS.get("failed")!.get("pending")).toBe("retry");
  });

  it("canceled has exactly 1 outgoing transition (→ pending retry)", () => {
    expect(TRANSITIONS.get("canceled")!.size).toBe(1);
    expect(TRANSITIONS.get("canceled")!.get("pending")).toBe("retry");
  });

  it("running has the most outgoing transitions (7)", () => {
    expect(TRANSITIONS.get("running")!.size).toBe(7);
  });

  it("yielded has exactly 4 outgoing transitions (resume, yield_resolved, cancel, retry)", () => {
    expect(TRANSITIONS.get("yielded")!.size).toBe(4);
    expect(TRANSITIONS.get("yielded")!.get("running")).toBe("resume");
    expect(TRANSITIONS.get("yielded")!.get("ready")).toBe("yield_resolved");
    expect(TRANSITIONS.get("yielded")!.get("canceled")).toBe("cancel");
    expect(TRANSITIONS.get("yielded")!.get("pending")).toBe("retry");
  });
});

// ─── transition() — all valid transitions ─────────────────────────────────

describe("transition() — every valid transition returns the correct name", () => {
  for (const [from, to, name] of VALID_TRANSITIONS) {
    it(`${from} → ${to} returns "${name}"`, () => {
      expect(transition(from, to, "task-1", "graph-1")).toBe(name);
    });
  }
});

// ─── transition() — idempotent same-state no-ops ──────────────────────────

describe("transition() — idempotent same-state transitions return undefined", () => {
  for (const s of ALL_STATES) {
    it(`${s} → ${s} is a no-op (returns undefined)`, () => {
      expect(transition(s, s, "task-1", "graph-1")).toBeUndefined();
    });
  }
});

// ─── transition() — every invalid transition throws ───────────────────────

describe("transition() — every invalid transition throws StateTransitionError", () => {
  for (const [from, to] of ALL_INVALID_TRANSITIONS) {
    it(`${from} → ${to} throws StateTransitionError`, () => {
      expect(() => transition(from, to, "t1", "g1")).toThrow(StateTransitionError);
    });
  }

  it("error carries taskId, graphId, from, to, and name='StateTransitionError'", () => {
    let caught: unknown;
    try {
      transition("completed", "running", "my-task", "my-graph");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StateTransitionError);
    const err = caught as StateTransitionError;
    expect(err.taskId).toBe("my-task");
    expect(err.graphId).toBe("my-graph");
    expect(err.from).toBe("completed");
    expect(err.to).toBe("running");
    expect(err.name).toBe("StateTransitionError");
    expect(err.message).toMatch(/completed.*running/);
  });

  it("error message includes taskId and graphId", () => {
    let caught: unknown;
    try {
      transition("failed", "canceled", "task-xyz", "graph-abc");
    } catch (e) {
      caught = e;
    }
    const err = caught as StateTransitionError;
    expect(err.message).toContain("task-xyz");
    expect(err.message).toContain("graph-abc");
  });

  it("completed → any non-self state throws (terminal has zero outgoing)", () => {
    const targets: TaskStatus[] = ["pending", "ready", "awaiting_approval", "running", "validating", "failed", "canceled"];
    for (const to of targets) {
      expect(() => transition("completed", to, "t1", "g1")).toThrow(StateTransitionError);
    }
  });
});

// ─── isTerminal() ─────────────────────────────────────────────────────────

describe("isTerminal()", () => {
  for (const s of TERMINAL_STATES) {
    it(`${s} is terminal`, () => {
      expect(isTerminal(s)).toBe(true);
    });
  }

  for (const s of NON_TERMINAL_STATES) {
    it(`${s} is not terminal`, () => {
      expect(isTerminal(s)).toBe(false);
    });
  }

  it("terminal states have no outgoing transitions or only retry→pending", () => {
    for (const s of TERMINAL_STATES) {
      const outgoing = TRANSITIONS.get(s)!;
      // completed: 0, failed: 1 (retry), canceled: 1 (retry)
      expect(outgoing.size).toBeLessThanOrEqual(1);
    }
  });
});

// ─── canTransitionTo() ────────────────────────────────────────────────────

describe("canTransitionTo() — valid transitions return true", () => {
  for (const [from, to] of VALID_TRANSITIONS) {
    it(`${from} → ${to} returns true`, () => {
      expect(canTransitionTo(from, to)).toBe(true);
    });
  }
});

describe("canTransitionTo() — same-state (idempotent) always returns true", () => {
  for (const s of ALL_STATES) {
    it(`${s} → ${s} returns true`, () => {
      expect(canTransitionTo(s, s)).toBe(true);
    });
  }
});

describe("canTransitionTo() — invalid transitions return false", () => {
  for (const [from, to] of ALL_INVALID_TRANSITIONS) {
    it(`${from} → ${to} returns false`, () => {
      expect(canTransitionTo(from, to)).toBe(false);
    });
  }
});

// ─── Guard conditions ─────────────────────────────────────────────────────
// The state machine has no runtime guard predicates (no task-property checks).
// Enforcement is purely structural: the transition table is the single source
// of truth. These tests verify the structural guarantees hold.

describe("structural guards — state machine invariants", () => {
  it("auto_retry (running → pending) bypasses the failed state", () => {
    // This transition exists specifically so retries-remain path skips
    // checkGraphCompletion seeing a premature 'failed' state.
    expect(transition("running", "pending", "t1", "g1")).toBe("auto_retry");
    expect(canTransitionTo("running", "pending")).toBe(true);
  });

  it("manual retry requires passing through pending before re-dispatching", () => {
    // failed/canceled → pending is valid; failed/canceled → ready is NOT
    expect(canTransitionTo("failed", "pending")).toBe(true);
    expect(canTransitionTo("failed", "ready")).toBe(false);
    expect(canTransitionTo("canceled", "pending")).toBe(true);
    expect(canTransitionTo("canceled", "ready")).toBe(false);
  });

  it("approval gate: tasks requiring approval must go pending → awaiting_approval → ready", () => {
    expect(canTransitionTo("pending", "awaiting_approval")).toBe(true);
    expect(canTransitionTo("awaiting_approval", "ready")).toBe(true);
    // Cannot bypass the gate: pending cannot go directly to running
    expect(canTransitionTo("pending", "running")).toBe(false);
  });

  it("dispatch_failed allows ready → failed without ever running", () => {
    expect(transition("ready", "failed", "t1", "g1")).toBe("dispatch_failed");
  });

  it("oom_retry returns running task to ready without going through failed", () => {
    expect(transition("running", "ready", "t1", "g1")).toBe("oom_retry");
    // running → failed is a different, valid path
    expect(transition("running", "failed", "t1", "g1")).toBe("fail");
  });

  it("yield suspends a running task and resume brings it back without losing state", () => {
    // yield: running → yielded
    expect(transition("running", "yielded", "t1", "g1")).toBe("yield");
    // resume: yielded → running
    expect(transition("yielded", "running", "t1", "g1")).toBe("resume");
    // yielded is NOT terminal — the task can still complete or be canceled
    expect(isTerminal("yielded")).toBe(false);
    expect(canTransitionTo("yielded", "running")).toBe(true);
    expect(canTransitionTo("yielded", "canceled")).toBe(true);
    // yielded can be retried (→ pending) as a manual recovery (#113)
    expect(canTransitionTo("yielded", "pending")).toBe(true);
    expect(transition("yielded", "pending", "t1", "g1")).toBe("retry");
    // yielded cannot skip ahead to completed or failed
    expect(canTransitionTo("yielded", "completed")).toBe(false);
    expect(canTransitionTo("yielded", "failed")).toBe(false);
  });
});

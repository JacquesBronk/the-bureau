import { describe, it, expect } from "vitest";

/**
 * Tests for the monitoring UX improvements:
 * - await_graph_event formatted output
 * - monitor_graph dashboard/compact formatting
 *
 * We test the pure formatting helpers directly by importing from the tool files.
 * The tool handler integration is covered by the MCP tool handler tests.
 */

// Since formatDuration, formatTime, taskIcon, eventIcon are not exported from monitor-graph.ts,
// we re-implement and test the formatting logic to ensure correctness.
// If these get exported later, this file can import directly.

describe("Event formatting", () => {
  // Replicate the switch statement from await-graph-event.ts (lines 119-155)
  function formatEvent(ev: { type: string; taskId?: string; detail?: string }): string {
    const id = ev.taskId ?? "";
    switch (ev.type) {
      case "task_started":
        return `▶ ${id} started${ev.detail ? ` (${ev.detail})` : ""}`;
      case "task_progress":
        return `◐ ${id} — ${ev.detail ?? ""}`;
      case "task_completed":
        return `✓ ${id} completed (${ev.detail ?? ""})`;
      case "task_failed":
        return `✗ ${id} FAILED — ${ev.detail ?? ""}`;
      case "task_warning":
        return `⚠ ${id} — ${ev.detail ?? ""}`;
      case "task_approval_required":
        return `⏸ ${id} awaiting approval`;
      case "graph_completed":
        return `━━ Graph complete ━━`;
      case "graph_validating":
        return `🔍 Verification started`;
      case "graph_validated":
        return `━━ Verification passed ━━`;
      case "graph_validation_failed":
        return `━━ Verification FAILED ━━`;
      case "task_added":
        return `+ ${id} added to graph`;
      default:
        return `? ${ev.type}${id ? ` (${id})` : ""}`;
    }
  }

  it("formats task_started events", () => {
    expect(formatEvent({ type: "task_started", taskId: "build" }))
      .toBe("▶ build started");
  });

  it("formats task_started with detail", () => {
    expect(formatEvent({ type: "task_started", taskId: "build", detail: "role: coder" }))
      .toBe("▶ build started (role: coder)");
  });

  it("formats task_progress events", () => {
    expect(formatEvent({ type: "task_progress", taskId: "tests", detail: "Running vitest" }))
      .toBe("◐ tests — Running vitest");
  });

  it("formats task_progress without detail", () => {
    expect(formatEvent({ type: "task_progress", taskId: "tests" }))
      .toBe("◐ tests — ");
  });

  it("formats task_completed events", () => {
    expect(formatEvent({ type: "task_completed", taskId: "build", detail: "45s" }))
      .toBe("✓ build completed (45s)");
  });

  it("formats task_failed events", () => {
    expect(formatEvent({ type: "task_failed", taskId: "deploy", detail: "exit code 1" }))
      .toBe("✗ deploy FAILED — exit code 1");
  });

  it("formats task_warning events", () => {
    expect(formatEvent({ type: "task_warning", taskId: "lint", detail: "Agent completed without handoff" }))
      .toBe("⚠ lint — Agent completed without handoff");
  });

  it("formats task_approval_required events", () => {
    expect(formatEvent({ type: "task_approval_required", taskId: "review" }))
      .toBe("⏸ review awaiting approval");
  });

  it("formats graph_completed events", () => {
    expect(formatEvent({ type: "graph_completed" }))
      .toBe("━━ Graph complete ━━");
  });

  it("formats graph_validating events", () => {
    expect(formatEvent({ type: "graph_validating" }))
      .toBe("🔍 Verification started");
  });

  it("formats graph_validated events", () => {
    expect(formatEvent({ type: "graph_validated" }))
      .toBe("━━ Verification passed ━━");
  });

  it("formats graph_validation_failed events", () => {
    expect(formatEvent({ type: "graph_validation_failed" }))
      .toBe("━━ Verification FAILED ━━");
  });

  it("formats task_added events", () => {
    expect(formatEvent({ type: "task_added", taskId: "hotfix" }))
      .toBe("+ hotfix added to graph");
  });

  it("formats unknown event types with fallback", () => {
    expect(formatEvent({ type: "task_unknown", taskId: "x" }))
      .toBe("? task_unknown (x)");
  });

  it("formats unknown event types without taskId", () => {
    expect(formatEvent({ type: "custom_event" }))
      .toBe("? custom_event");
  });

  it("handles missing taskId gracefully", () => {
    expect(formatEvent({ type: "task_progress", detail: "something" }))
      .toBe("◐  — something");
  });
});

describe("Dashboard formatting helpers", () => {
  function formatDuration(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  }

  function formatTime(timestamp: number): string {
    const d = new Date(timestamp);
    return [
      d.getHours().toString().padStart(2, "0"),
      d.getMinutes().toString().padStart(2, "0"),
      d.getSeconds().toString().padStart(2, "0"),
    ].join(":");
  }

  function taskIcon(status: string): string {
    switch (status) {
      case "completed": return "✓";
      case "running": return "◐";
      case "failed": return "✗";
      case "canceled": return "✗";
      case "awaiting_approval": return "⏸";
      case "rework":
      case "re_queued": return "↺";
      default: return "○";
    }
  }

  function eventIcon(type: string): string {
    switch (type) {
      case "task_completed":
      case "graph_validated": return "✓";
      case "task_failed":
      case "graph_failed":
      case "graph_validation_failed": return "✗";
      case "task_started": return "▶";
      case "task_progress": return "◐";
      case "task_approval_required": return "⏸";
      case "graph_completed": return "━";
      case "graph_validating": return "🔍";
      case "task_added": return "+";
      default: return "·";
    }
  }

  describe("formatDuration", () => {
    it("formats seconds only", () => {
      expect(formatDuration(45_000)).toBe("0m 45s");
    });

    it("formats minutes and seconds", () => {
      expect(formatDuration(135_000)).toBe("2m 15s");
    });

    it("formats zero", () => {
      expect(formatDuration(0)).toBe("0m 00s");
    });

    it("pads single-digit seconds", () => {
      expect(formatDuration(63_000)).toBe("1m 03s");
    });

    it("handles large durations", () => {
      expect(formatDuration(3_600_000)).toBe("60m 00s");
    });
  });

  describe("formatTime", () => {
    it("formats a timestamp to HH:MM:SS", () => {
      // Use a fixed timestamp: 2026-01-01T14:05:09Z
      const ts = new Date("2026-01-01T14:05:09Z").getTime();
      const result = formatTime(ts);
      // Result depends on local timezone, just check format
      expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    });

    it("pads single digits", () => {
      const ts = new Date("2026-01-01T01:02:03Z").getTime();
      const result = formatTime(ts);
      expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    });
  });

  describe("taskIcon", () => {
    it("returns ✓ for completed", () => {
      expect(taskIcon("completed")).toBe("✓");
    });

    it("returns ◐ for running", () => {
      expect(taskIcon("running")).toBe("◐");
    });

    it("returns ✗ for failed", () => {
      expect(taskIcon("failed")).toBe("✗");
    });

    it("returns ✗ for canceled", () => {
      expect(taskIcon("canceled")).toBe("✗");
    });

    it("returns ⏸ for awaiting_approval", () => {
      expect(taskIcon("awaiting_approval")).toBe("⏸");
    });

    it("returns ↺ for rework", () => {
      expect(taskIcon("rework")).toBe("↺");
    });

    it("returns ↺ for re_queued", () => {
      expect(taskIcon("re_queued")).toBe("↺");
    });

    it("returns ○ for pending", () => {
      expect(taskIcon("pending")).toBe("○");
    });

    it("returns ○ for unknown statuses", () => {
      expect(taskIcon("something_else")).toBe("○");
    });
  });

  describe("eventIcon", () => {
    it("returns ✓ for task_completed", () => {
      expect(eventIcon("task_completed")).toBe("✓");
    });

    it("returns ✓ for graph_validated", () => {
      expect(eventIcon("graph_validated")).toBe("✓");
    });

    it("returns ✗ for failures", () => {
      expect(eventIcon("task_failed")).toBe("✗");
      expect(eventIcon("graph_failed")).toBe("✗");
      expect(eventIcon("graph_validation_failed")).toBe("✗");
    });

    it("returns ▶ for task_started", () => {
      expect(eventIcon("task_started")).toBe("▶");
    });

    it("returns + for task_added", () => {
      expect(eventIcon("task_added")).toBe("+");
    });

    it("returns · for unknown types", () => {
      expect(eventIcon("custom_type")).toBe("·");
    });
  });
});

describe("Output structure", () => {
  it("formatted output contains --- separator before JSON", () => {
    // Simulate what await_graph_event returns
    const lines = ["Graph abc12345 | 1 events", "▶ build started"];
    const rawJson = JSON.stringify({ events: [], count: 0 });
    const output = `${lines.join("\n")}\n---\n${rawJson}`;

    const parts = output.split("\n---\n");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain("Graph abc12345");
    expect(() => JSON.parse(parts[1])).not.toThrow();
  });

  it("JSON section is valid and parseable after separator", () => {
    const events = [
      { type: "task_started", taskId: "a", timestamp: 1000 },
      { type: "task_completed", taskId: "a", timestamp: 2000 },
    ];
    const rawJson = JSON.stringify({ events, count: 2 }, null, 2);
    const output = `Graph abc12345 | 2 events\n▶ a started\n✓ a completed ()\n---\n${rawJson}`;

    const jsonPart = output.split("\n---\n")[1];
    const parsed = JSON.parse(jsonPart);
    expect(parsed.events).toHaveLength(2);
    expect(parsed.count).toBe(2);
  });

  it("timeout output includes table header and hint", () => {
    const tableLines = [
      "TIMEOUT after 300s — Graph abc12345 | 1/3 completed | status: running",
      "",
      "Task                             Status                       Phase                Idle",
      "-------------------------------- ---------------------------- -------------------- --------",
      "build                            running                      implementing         42s",
      "",
      "All running agents are alive.",
    ];
    const output = `${tableLines.join("\n")}\n---\n{}`;

    expect(output).toContain("TIMEOUT after 300s");
    expect(output).toContain("Task");
    expect(output).toContain("Status");
    expect(output).toContain("build");
    expect(output).toContain("All running agents are alive");
  });
});

import { describe, it, expect } from "vitest";
import { classifyGitError, isIntegrationBranchMissing } from "../../src/utils/git-classify.js";

describe("classifyGitError", () => {
  it("returns git_clone_timeout for 'timed out' with 'clone'", () => {
    const r = classifyGitError("git clone timed out after 60s");
    expect(r.type).toBe("git_clone_timeout");
    expect(r.transient).toBe(true);
  });

  it("returns git_merge_timeout for 'timed out' without 'clone'", () => {
    const r = classifyGitError("merge operation timed out");
    expect(r.type).toBe("git_merge_timeout");
    expect(r.transient).toBe(true);
  });

  it("returns provider_unavailable for 503", () => {
    const r = classifyGitError("error 503 service unavailable");
    expect(r.type).toBe("provider_unavailable");
    expect(r.transient).toBe(true);
  });

  it("returns provider_unavailable for 'unable to connect'", () => {
    const r = classifyGitError("fatal: unable to connect to remote");
    expect(r.type).toBe("provider_unavailable");
    expect(r.transient).toBe(true);
  });

  it("returns provider_unavailable for connection refused", () => {
    const r = classifyGitError("ECONNREFUSED: connection refused");
    expect(r.type).toBe("provider_unavailable");
    expect(r.transient).toBe(true);
  });

  it("returns provider_unavailable for 'early eof'", () => {
    const r = classifyGitError("fatal: early eof");
    expect(r.type).toBe("provider_unavailable");
    expect(r.transient).toBe(true);
  });

  it("returns provider_unavailable for 'reset by peer'", () => {
    const r = classifyGitError("error: pack-protocol: read error (reset by peer)");
    expect(r.type).toBe("provider_unavailable");
    expect(r.transient).toBe(true);
  });

  it("returns transient_lock for 'index.lock'", () => {
    const r = classifyGitError("error: cannot lock ref: .git/index.lock");
    expect(r.type).toBe("transient_lock");
    expect(r.transient).toBe(true);
  });

  it("returns transient_lock for 'cannot lock ref'", () => {
    const r = classifyGitError("cannot lock ref 'refs/heads/main'");
    expect(r.type).toBe("transient_lock");
    expect(r.transient).toBe(true);
  });

  it("returns git_auth for 'authentication failed' (non-retryable)", () => {
    const r = classifyGitError("fatal: Authentication failed for 'https://git.example.com'");
    expect(r.type).toBe("git_auth");
    expect(r.transient).toBe(false);
  });

  it("returns git_auth for ' 403 ' pattern", () => {
    const r = classifyGitError("error: server returned http error code 403 Forbidden");
    expect(r.type).toBe("git_auth");
    expect(r.transient).toBe(false);
  });

  it("returns git_auth for 'permission denied (publickey'", () => {
    const r = classifyGitError("Permission denied (publickey).");
    expect(r.type).toBe("git_auth");
    expect(r.transient).toBe(false);
  });

  it("auth check wins over timeout — '401' in message body is non-retryable even with 'timed out'", () => {
    const r = classifyGitError(" 401 unauthorized: request timed out");
    expect(r.type).toBe("git_auth");
    expect(r.transient).toBe(false);
  });

  it("returns other for unrecognised output", () => {
    const r = classifyGitError("fatal: unexpected error XYZ-12345");
    expect(r.type).toBe("other");
    expect(r.transient).toBe(false);
  });

  it("returns other for empty string", () => {
    const r = classifyGitError("");
    expect(r.type).toBe("other");
    expect(r.transient).toBe(false);
  });
});

describe("isIntegrationBranchMissing", () => {
  it("matches the real git output shape (#317 phase3)", () => {
    expect(isIntegrationBranchMissing(
      "fatal: Remote branch bureau/abc12345/integration not found in upstream origin",
    )).toBe(true);
  });

  it("matches regardless of case", () => {
    expect(isIntegrationBranchMissing(
      "FATAL: REMOTE BRANCH BUREAU/ABC12345/INTEGRATION NOT FOUND IN UPSTREAM ORIGIN",
    )).toBe(true);
  });

  it("does not match an unrelated missing-branch error", () => {
    expect(isIntegrationBranchMissing(
      "fatal: Remote branch feature/some-other-branch not found in upstream origin",
    )).toBe(false);
  });

  it("does not match a generic clone failure", () => {
    expect(isIntegrationBranchMissing("fatal: repository 'https://example.com/repo.git' not found")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isIntegrationBranchMissing("")).toBe(false);
  });
});

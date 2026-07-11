#!/usr/bin/env node

/**
 * the-bureau CLI entry point
 *
 * Subcommands:
 *   config         Interactive mode — show discovered servers and current config
 *   config --exclude server1,server2   Exclude specific servers
 *   config --no-inherit                Disable MCP inheritance
 *   config --reset                     Remove .bureau/config.json
 *   config --show                      Show effective config agents would receive
 *   mint-operator-token [--loadout operator|coordinator] [--ttl 7d] [--session-id orchestrator]
 *                                      Mint an engine-signed operator token (prints token to stdout)
 *
 * No subcommand → start MCP server (original behaviour)
 */

async function main(): Promise<void> {
  const allArgs = process.argv.slice(2);
  const [subcommand, ...rest] = allArgs;

  if (subcommand === "config") {
    await runConfig(rest);
  } else if (subcommand === "mint-operator-token") {
    await runMintOperatorToken(rest);
  } else {
    const selfImprove = allArgs.includes("--with-self-improvement") || allArgs.includes("--self-improve");

    if (selfImprove) {
      const { loadBureauConfig } = await import("./mcp-config.js");
      const { DEFAULT_SELF_IMPROVEMENT_CONFIG } = await import("./self-improvement/index.js");

      const cwd = process.cwd();
      const config = loadBureauConfig(cwd);
      const siConfig = { ...DEFAULT_SELF_IMPROVEMENT_CONFIG, ...config.selfImprovement, enabled: true };

      print(green("Self-improvement enabled (middleware anomaly detection)"));
      print(dim(`  Analyzer model: ${siConfig.analyzerModel}`));
      print();

      try {
        const { checkDeferredWork } = await import("./self-improvement/index.js");
        const { createRedisClient, resolveRedisConfig } = await import("./redis.js");
        const deferredRedis = createRedisClient(resolveRedisConfig());
        const deferredMsg = await checkDeferredWork({
          redis: deferredRedis,
          deferredTtlDays: siConfig.deferredTtlDays,
        });
        if (deferredMsg) {
          print(yellow("Deferred improvements found:"));
          print(dim(`  ${deferredMsg}`));
          print();
        }
        await deferredRedis.quit();
      } catch { /* deferred check is best-effort */ }

      process.env.SELF_IMPROVEMENT = "true";

      await import("./mcp-server.js");
    } else {
      // Forward to MCP server — dynamic import triggers its top-level startup code
      await import("./mcp-server.js");
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function print(line = ""): void {
  process.stdout.write(line + "\n");
}

function bold(s: string): string {
  return `\x1b[1m${s}\x1b[0m`;
}

function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}

function yellow(s: string): string {
  return `\x1b[33m${s}\x1b[0m`;
}

function green(s: string): string {
  return `\x1b[32m${s}\x1b[0m`;
}

function cyan(s: string): string {
  return `\x1b[36m${s}\x1b[0m`;
}

function red(s: string): string {
  return `\x1b[31m${s}\x1b[0m`;
}

// ---------------------------------------------------------------------------
// Config subcommand
// ---------------------------------------------------------------------------

async function runConfig(args: string[]): Promise<void> {
  // Lazy imports — only pulled in when `config` is invoked, not on MCP startup
  const { existsSync, unlinkSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { discoverAndReport, applySetupChoices } = await import("./bureau-setup.js");
  const { loadBureauConfig, readUserMcpServers } = await import("./mcp-config.js");

  const cwd = process.cwd();

  // --- Parse flags ---
  const hasFlag = (flag: string): boolean => args.includes(flag);

  const noInherit = hasFlag("--no-inherit");
  const reset = hasFlag("--reset");
  const show = hasFlag("--show");

  // Collect --exclude values: --exclude a,b or repeated --exclude a --exclude b
  const excludeValues: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--exclude" && i + 1 < args.length) {
      excludeValues.push(...args[i + 1].split(",").map((s) => s.trim()).filter(Boolean));
      i++;
    } else if (args[i].startsWith("--exclude=")) {
      const val = args[i].slice("--exclude=".length);
      excludeValues.push(...val.split(",").map((s) => s.trim()).filter(Boolean));
    }
  }

  // --- Dispatch ---

  if (reset) {
    const configPath = join(cwd, ".bureau", "config.json");
    if (existsSync(configPath)) {
      unlinkSync(configPath);
      print(green("Removed .bureau/config.json — inheritance restored to defaults."));
    } else {
      print(dim("No .bureau/config.json found — nothing to reset."));
    }
    return;
  }

  if (show) {
    await runShow(cwd, loadBureauConfig, readUserMcpServers);
    return;
  }

  if (noInherit || excludeValues.length > 0) {
    await runApply(cwd, { noInherit, excludeValues }, loadBureauConfig, applySetupChoices);
    return;
  }

  // Interactive summary
  await runInteractive(cwd, discoverAndReport);
}

// ---------------------------------------------------------------------------
// mint-operator-token subcommand
// ---------------------------------------------------------------------------

async function runMintOperatorToken(args: string[]): Promise<void> {
  const { buildOperatorToken, parseTtlSeconds } = await import("./runtime/auth/operator-token-cli.js");
  const getOpt = (name: string, def: string) => {
    const i = args.findIndex(a => a === `--${name}`);
    if (i >= 0 && args[i + 1] !== undefined) return args[i + 1];
    const eq = args.find(a => a.startsWith(`--${name}=`));
    return eq ? eq.slice(name.length + 3) : def;
  };
  const loadout = getOpt("loadout", "operator") as "coordinator" | "operator";
  const ttlSeconds = parseTtlSeconds(getOpt("ttl", "7d"));
  const sessionId = getOpt("session-id", "orchestrator");
  const token = await buildOperatorToken(process.env, { loadout, ttlSeconds, sessionId });
  // Print ONLY the token to stdout so a wrapper script can capture it.
  process.stdout.write(token + "\n");
}

// ---------------------------------------------------------------------------
// Interactive mode
// ---------------------------------------------------------------------------

async function runInteractive(
  cwd: string,
  discoverAndReport: (cwd: string) => import("./bureau-setup.js").DiscoveryResult,
): Promise<void> {
  const result = discoverAndReport(cwd);

  print();
  print(bold("the-bureau — MCP Server Configuration"));
  print(dim("─".repeat(50)));
  print();

  // --- Sources ---
  print(bold("Sources scanned:"));
  for (const src of result.sources) {
    const status = src.exists
      ? src.servers.length > 0
        ? green("✓")
        : dim("○ (empty)")
      : dim("✗ (not found)");
    print(`  ${status}  ${dim(src.path)}`);
    if (src.servers.length > 0) {
      for (const name of src.servers) {
        print(`       ${cyan(name)}`);
      }
    }
  }

  print();

  // --- Discovered servers ---
  const serverNames = Object.keys(result.allServers);
  if (serverNames.length === 0) {
    print(dim("No MCP servers discovered."));
  } else {
    print(bold(`Discovered servers (${serverNames.length}):`));
    for (const name of serverNames) {
      const cfg = result.allServers[name];
      const isOAuth = result.oauthWarnings.some((w) => w.serverName === name);
      const oauthTag = isOAuth ? yellow(" [OAuth warning]") : "";
      print(`  ${cyan(name)}${oauthTag}`);
      print(`    ${dim(cfg.command + (cfg.args ? " " + cfg.args.join(" ") : ""))}`);
    }
  }

  // --- OAuth warnings ---
  if (result.oauthWarnings.length > 0) {
    print();
    print(yellow("OAuth / credential warnings:"));
    for (const w of result.oauthWarnings) {
      print(`  ${yellow("!")} ${bold(w.serverName)}: ${w.reason}`);
    }
    print(dim("  These servers may not work correctly in spawned agents."));
  }

  print();

  // --- Current config ---
  if (result.hasExistingConfig && result.currentConfig) {
    const mcp = result.currentConfig.mcp;
    print(bold("Current .bureau/config.json:"));
    print(`  inherit:  ${mcp.inherit ? green("true") : red("false")}`);
    if (mcp.exclude.length > 0) {
      print(`  exclude:  ${mcp.exclude.map(cyan).join(", ")}`);
    } else {
      print(`  exclude:  ${dim("(none)")}`);
    }
    if (mcp.include.length > 0) {
      print(`  include:  ${mcp.include.map(cyan).join(", ")}`);
    }
  } else {
    print(dim("No .bureau/config.json — using defaults (inherit all discovered servers)."));
  }

  print();
  print(bold("Usage:"));
  print(`  ${dim("the-bureau config --exclude server1,server2")}  Exclude specific servers`);
  print(`  ${dim("the-bureau config --no-inherit")}               Disable MCP inheritance`);
  print(`  ${dim("the-bureau config --reset")}                    Remove .bureau/config.json`);
  print(`  ${dim("the-bureau config --show")}                     Show effective config`);
  print();
}

// ---------------------------------------------------------------------------
// Show effective config
// ---------------------------------------------------------------------------

async function runShow(
  cwd: string,
  loadBureauConfig: (cwd: string) => import("./mcp-config.js").BureauConfig,
  readUserMcpServers: (cwd: string) => Record<string, import("./mcp-config.js").McpServerConfig>,
): Promise<void> {
  const config = loadBureauConfig(cwd);
  const effective = readUserMcpServers(cwd);

  print();
  print(bold("Effective config agents would receive:"));
  print(dim("─".repeat(50)));
  print();

  print(`  inherit: ${config.mcp.inherit ? green("true") : red("false")}`);
  if (config.mcp.exclude.length > 0) {
    print(`  exclude: ${config.mcp.exclude.join(", ")}`);
  }
  if (config.mcp.include.length > 0) {
    print(`  include: ${config.mcp.include.join(", ")}`);
  }

  print();

  const names = Object.keys(effective);
  if (names.length === 0) {
    print(dim("  No servers would be inherited (inheritance disabled or all excluded)."));
  } else {
    print(bold(`  Servers passed to spawned agents (${names.length}):`));
    for (const name of names) {
      const cfg = effective[name];
      print(`    ${cyan(name)}`);
      print(`      ${dim(cfg.command + (cfg.args ? " " + cfg.args.join(" ") : ""))}`);
    }
  }

  print();
}

// ---------------------------------------------------------------------------
// Apply choices (--exclude / --no-inherit)
// ---------------------------------------------------------------------------

async function runApply(
  cwd: string,
  opts: { noInherit: boolean; excludeValues: string[] },
  loadBureauConfig: (cwd: string) => import("./mcp-config.js").BureauConfig,
  applySetupChoices: (cwd: string, choices: import("./bureau-setup.js").SetupChoices) => void,
): Promise<void> {
  const existing = loadBureauConfig(cwd);

  // Merge new excludes with any already configured
  const mergedExclude = [
    ...new Set([...existing.mcp.exclude, ...opts.excludeValues]),
  ];

  const inherit = opts.noInherit ? false : existing.mcp.inherit;

  applySetupChoices(cwd, {
    inherit,
    exclude: mergedExclude,
  });

  print();
  if (opts.noInherit) {
    print(green("✓ MCP inheritance disabled.") + " Spawned agents will not inherit any MCP servers.");
  }
  if (opts.excludeValues.length > 0) {
    print(
      green("✓ Excluded: ") + opts.excludeValues.map(cyan).join(", "),
    );
  }
  if (mergedExclude.length > 0 && !opts.noInherit) {
    print(dim(`  Total excluded: ${mergedExclude.join(", ")}`));
  }
  print(dim("  Written to .bureau/config.json"));
  print();
  print(dim("  Run 'the-bureau config --show' to verify."));
  print();
}

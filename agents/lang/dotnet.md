## Language context: .NET / C#

> **Authoritative commands live in `bureau.buildconfig.json`** at the repo root (or
> per-service under `services[]`). Read that descriptor and use its `install` /
> `build` / `test` / `integrationTest` / `lint` values before running anything.
> The notes below are ecosystem *conventions* for orienting yourself — they are
> **not** this project's actual commands.

**Manifest.** A project is a `*.csproj` (or `*.fsproj`/`*.vbproj`); a `*.sln`
solution groups several projects. Dependencies are `<PackageReference>` entries
inside the project file; `Directory.Packages.props` may centralize versions.
Inspect these to learn the project layout, then defer to the descriptor for how
to invoke tooling.

**Conventional tooling (names only).**
- CLI / build: the `dotnet` SDK driver (`restore`, `build`, `test`, `format`).
- Test frameworks: `xUnit`, `NUnit`, `MSTest` (run via the SDK's test command).
- Lint / format: `dotnet format`, analyzers configured through `.editorconfig`.

**Common gotchas.**
- Restore packages before building — a build expects dependencies already
  resolved (the descriptor's `install` step typically covers this).
- Target the solution or the specific project file explicitly; an ambiguous
  directory with multiple project files won't resolve on its own.
- Build configuration matters (Debug vs Release); use whatever the descriptor
  declares rather than assuming a default.

**Requirement-coverage (EARS `coverageIds`) gate.** When a graph's exec criterion
carries `coverageIds`, the checker reads a **JUnit** report at `bureau-junit.xml`
whose `<testcase name>` must contain the bracketed EARS id (e.g. `[E-01]`).

Recommended — rename-free trx2junit flow (`trx2junit` is pre-installed in the dotnet worker image):

1. Tag the covering test with `[Fact(DisplayName = "[E-01] …")]` — use `DisplayName` because EARS ids contain a hyphen, which is illegal in a C# method name.
2. Run `dotnet test <proj-or-sln> --logger "trx;LogFileName=bureau-junit.trx" --results-directory .` then `trx2junit bureau-junit.trx` — writes `bureau-junit.xml` at repo root with `DisplayName` preserved as the JUnit `<testcase name>`, so the coverage checker matches `[E-01]` natively with no rename step.
3. Pass `bureau-junit.xml` to the coverage gate.

Fallback — JunitXml.TestLogger: works, but that logger emits the C# method name (not `DisplayName`), so a post-test `sed` rename is required to surface the EARS id (see the dogfooded reference `bureau-coverage-test.sh` in `JacquesBronk/another-json-lib`, issue #315).

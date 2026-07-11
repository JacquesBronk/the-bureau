## Language context: Python

> **Authoritative commands live in `bureau.buildconfig.json`** at the repo root (or
> per-service under `services[]`). Read that descriptor and use its `install` /
> `build` / `test` / `integrationTest` / `lint` values before running anything.
> The notes below are ecosystem *conventions* for orienting yourself — they are
> **not** this project's actual commands.

**Manifest.** `pyproject.toml` is the modern manifest (PEP 621); older projects use
`requirements.txt` and/or `setup.py`/`setup.cfg`. Tooling configuration (build
backend, lint, test) commonly lives inside `pyproject.toml`. Inspect it to learn
what the project uses, then defer to the descriptor for how to invoke it.

**Conventional tooling (names only).**
- Package / env managers: `pip`, `poetry`, `uv`, `pdm`, `conda`.
- Test runners: `pytest`, `unittest`, `tox`, `nox`.
- Lint / format / type-check: `ruff`, `flake8`, `black`, `isort`, `mypy`, `pyright`.

**Common gotchas.**
- Use the project's virtual environment. A `.venv/`, `venv/`, or tool-managed env
  must be active (or the tool's run wrapper used) so packages resolve correctly —
  never install into the system interpreter.
- `python` may be `python3`; the descriptor's commands are the source of truth.
- Editable installs (`-e`) are common for local packages; respect the existing
  install layout rather than reinstalling globally.

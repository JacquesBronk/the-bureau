# Documentation Quality Checklist
> Verify documentation is accurate, complete, and serves its audience before delivering.

## When to Use
Load this tool before reporting documentation work as complete. This is the docs equivalent of the verification checklist — every document must pass these checks before delivery.

## Process

Run each check in order. If any check fails, fix the issue before proceeding.

### 1. Code Examples Are Verified
- Every code snippet, command, or configuration example has been tested or traced to working source code
- Commands include expected output where it aids understanding
- File paths in examples match actual project structure
- Environment variables and config keys match what the code actually reads
- If an example cannot be verified, mark it explicitly: `<!-- UNVERIFIED: [reason] -->`

### 2. Prerequisites Are Complete
- Every tool, runtime, service, or configuration needed is listed
- Version requirements are specific (e.g., "Node.js 18+" not "Node.js")
- Prerequisites are ordered: install dependencies before using them
- Nothing is assumed installed that a new contributor wouldn't have

### 3. Audience Is Consistent
- The document serves one primary audience (developer, operator, or end user)
- Technical depth matches the audience: don't explain `git clone` to developers, don't assume operators know internal module names
- Jargon is either defined on first use or appropriate for the stated audience

### 4. Structure Is Sound
- Heading hierarchy is consistent (no skipped levels)
- Each section has a clear purpose — no empty or stub sections
- Steps are numbered and sequential; reference material uses lists or tables
- Code blocks have language tags for syntax highlighting
- The document can be scanned: key information is in headings, lists, or tables — not buried in paragraphs

### 5. No Duplicated Content
- Information that exists in another document is linked, not restated
- Configuration options are documented in one canonical location
- If the same concept appears in multiple docs, one is the source of truth and others link to it

### 6. Links and References Are Valid
- Internal links point to files that exist in the repository
- Section anchors match actual heading text
- External links are to stable URLs (versioned docs, not "latest" when version matters)
- No broken cross-references between documents

### 7. Troubleshooting Coverage
- Common errors a user will encounter following these steps are documented
- Error messages are quoted exactly as they appear
- Solutions are concrete actions, not vague suggestions
- "If X doesn't work" sections cover the most likely failure modes

### 8. No Aspirational Content
- Every feature, endpoint, flag, or behavior described exists in the current codebase
- No "coming soon", "planned", or "will be added" language
- No documented behavior that contradicts what the code actually does

## Iron Law
Do not deliver documentation that describes behavior you haven't verified in the source code. If you can't verify it, say so explicitly — never present assumptions as facts.

## Red Flags
- "I'm pretty sure this is how it works" — Read the code. Pretty sure is not verified.
- "This is how it should work" — Document what IS, not what SHOULD BE.
- "I'll verify the examples later" — Unverified examples are the #1 source of documentation bugs.
- "The README already covers this but I'll add it here too" — Link to it. Duplication decays.

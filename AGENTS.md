# ChatGPT Codex repository guidance — Dokladovka

## Source of truth

- Read `SPEC-dokladovka_3_email_ai_Codex.md` and
  `SPEC-dokladovka_4_pohoda_Codex.md` before implementation.
- Sections 11–13 of `SPEC-dokladovka_3_email_ai_Codex.md` override earlier
  requirements when they conflict.
- Use `AUDIT-digitoo-parity.md` as verified product context; current code and
  actually executed checks remain the factual source of truth.
- The implementation agent is ChatGPT Codex.
- Keep this file concise; task-specific details belong in the specification.

## Working rules

- Inspect the existing repository before editing. Do not re-scaffold or delete working code.
- Preserve the package manager and lockfile already used by the repository.
- Keep diffs focused. Do not reformat unrelated files.
- UI copy must remain in Slovak and be centralized in `src/i18n/sk.ts`.
- React components must use the async data/service layer and must not depend directly on mock storage.
- Never put secrets in frontend code, `localStorage`, generated bundles, or `VITE_*` variables.
- `OPENAI_API_KEY` is server-side only. OpenAI API calls belong to backend/worker, never the browser.
- Do not hardcode the receiving mail domain. Use configuration/data as defined by the spec.
- Preserve tenant and organization boundaries in types, services, API checks, storage keys, and tests.
- AI output is a suggestion. Human approval and deterministic validation remain mandatory.

## Verification

- Discover the actual scripts from `package.json` before running commands.
- Run the relevant lint, typecheck, unit tests, integration tests, and build after changes when available.
- Do not report a check as passing unless it was executed successfully.
- For each task, report changed files, executed commands, results, manual verification steps, and remaining TODOs.

## Dependency policy

- Prefer existing dependencies.
- Add a production dependency only when necessary and explain why.
- Never replace a library or architectural boundary solely for stylistic preference.

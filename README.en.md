# MSE Learning

DSH plugin for global standing corrections, evidence-linked failure lessons and daily consolidation. Current local candidate: **0.15.0-rebuild.24**.

Ordinary user corrections no longer require a remember keyword. Suspected corrections enter a bounded, source-bound extraction after the turn; concrete reusable rules persist and recall in later related sessions/projects. Negations and project limits are retained; one-off requests, questions and quoted logs are not automatically promoted. The status page shows saved, pending and ignored extraction results. This uses the existing learning model route and switches, not a model call for every message.

Explicit user corrections persist across sessions and projects, with project constraints retained. Two independent failures can produce a concrete unvalidated lesson. Related turns recall it again; attributed recurrence requests a material revision or retires an ineffective version. Daily consolidation runs while idle after local 23:00, with durable processing boundaries and catch-up.

The slim runtime preserves source model routes, a single background slot, bounded calls, durable pause and unknown-cost no-replay. It does not self-award validated status or enable paid evaluation. A successful JSON parsing check proves only that check; assistant success claims and arbitrary exit0 do not verify the full task.

Use Settings → Self-evolution to inspect memory, recurrence, checks, daily summaries and waits. Read-only views do not call models. Background reflection can incur model charges and preserves existing switches.

The new memory-v1.json imports legacy lessons-v1.json read-only; retain original state and package/config backups. Historical problems and spending remain in the original file. Old unvalidated candidates are not promoted by migration. Daily quota fields are ignored; the old evaluation/merge/renewal pipeline is outside the new package.

Layout: `rebuild/` holds the whole runtime closure, UI panel and test; `src/` keeps only its direct pure helpers; `adapters/dsh/usage.mjs` parses host usage; `scripts/` cover packing, the publication allowlist and package verification; `PUBLICATION.md`/`VALIDATION.md` carry the current publication and validation records. Superseded code, old docs and images stay in Git history only. See [migration and limits](docs/AUTONOMY_0.15.0.md). Relevant checks use node --test rebuild/rebuild.test.mjs and node scripts/verify-package.mjs. Offline fake-provider evidence is not proof of long-term live-model effectiveness.

As of rebuild.23 the settings entry is named "Self-evolution"; only the display name changed, with learning behavior unchanged. rebuild.24 only cleans the public work tree (superseded core, tests, docs and the Hermes adapter leave the tree but stay in Git history), syncs the packing-script assertions and adds the official DSH badge; the 18 runtime modules are byte-identical.

[![powered by dsh](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

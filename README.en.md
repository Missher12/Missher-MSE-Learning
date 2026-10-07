# MSE Learning

English | [中文](README.md) · [Desktop and downloads](https://github.com/Missher12/Missher-DeepseekHarness-Desktop)

Persists scoped user corrections and method candidates for DSH, recalls relevant lessons within a byte budget, and records adoption and verification established by the trusted host. It does not train model weights or guarantee that a model will never repeat a mistake.

Package: `@missher/dsh-mse-learning`. The **0.9.0-alpha.18 upgrade candidate** adds automatic review, limited trials, domain-bound objective validation and a library-wide overview. [VALIDATION](VALIDATION.md) separates r2 core and real-provider review evidence from r3 control-state regression and controlled browser UI evidence. Daily installation, downloadable Releases and marketplace acceptance remain separate stages; this document does not claim they are complete.

The host-title session pickers from alpha.17 remain. Titles are display-only and do not alter scope, recall identity or budgets. This upgrade changes the shared core; DSH scheduling does not establish equivalent lifecycle integration for every Agent. The historical `dsh-missher-evolution` package is a separate product; this plugin does not read or migrate its data.

## Features and cost

- Capture explicit corrections from host-authenticated user input; recall them by scope, supported applicability conditions and remaining budget.
- Keep inferred methods as candidates; safety review can admit a limited trial, while objective evidence is required for validation within a declared domain.
- Use **Settings → 自我进化 (Self-evolution)** for lessons, recall explanations, pause/resume, manual review, budgets and actual control acknowledgement.
- Recover acknowledged completion settlements after restart without rerunning models or tools or crediting a result twice.
- `/mse` shows status, `/mse why` explains recent recall, and `/mse now <task>` provides a read-only preview. They use the host command service instead of ordinary model messages.

Default recall limits are **2 lessons / 768 UTF-8 bytes per turn** and **1536 bytes per session**. Bytes are not tokens. Retrieval makes no model calls. Automatic reflection can make additional calls using the model and reasoning effort of the source turn that triggered reflection: at most 3 per 24 hours, at least 30 minutes apart, and at most 384 output tokens each. It can be disabled separately. Additional model evaluation defaults to `evaluationTokensPerDay=0`; it does not start paid evaluations automatically.

## Automatic review and validation

- **Trial does not mean proven benefit.** Candidate and baseline answer independently on the same route; a separate judge sees anonymous answers and checks both label orders. Safe, applicable advice with known costs can become `reviewed` / `trial`; a neutral-safe tie still has `benefit=unproven`. Injected trial text explicitly identifies its unverified status.
- **Objective evidence determines validated.** Registered algorithms or the Host-owned `mse-lifecycle-v1` scenario pack supply fixed checks; models supply answers only. Injection, model self-reports and claimed success are not verification. A domain verdict covers its registered request-generation, concurrent-ticket and acceptance-evidence cases, not arbitrary tasks.
- **Automatic validation is off by default** (`autoValidationEnabled=false`) and the evaluation token budget defaults to **0**. An explicit zero issues no paid evaluation calls. Manual and automatic evaluations share rolling 24-hour limits and reserve before requesting; unknown usage is not zero. Reflection retains its independent frequency limits. One evaluation may include multiple provider requests.
- New candidates bind their actual source session/turn and route. Historical candidates whose source cannot be recovered require an **explicit verification session**. Its provider/model/reasoning effort supplies the backfill route without changing the original project or silently borrowing the latest session's model.
- The overview separates recorded lessons, corrections, pending work, trials, validation and adoption. Library-wide reads do not widen recall scope. Original applicability/exclusion text remains; unsupported conditions block recall with a visible reason.

At most **one trial per turn** can use the existing **total 2-lesson/default 768-byte turn budget and 1536-byte session budget**, after corrections and validated methods; it adds no extra context allowance. Trials expire and may be withdrawn after trusted failure/correction evidence. Pause/disable stops later steps; uncertain requests after restart retain interruption facts and conservative charges rather than silently replaying the same request. Reading the overview, lesson details, status or diagnostics neither writes the learning store nor triggers paid work. The same settings page also exposes human-initiated configuration saves, enable/pause controls and manual reflection/validation actions. These are write or scheduling entry points; enabling automatic validation can schedule budgeted background evaluations. See [VALIDATION](VALIDATION.md) for the tested cancellation, recovery and accounting scope and its limits.

## Install a fixed version

Use a configured DSH host with Node.js ≥22.19.0. The tarball contains executable JavaScript and needs no install-time build. Distribution is through GitHub assets, not npm registry; `private:true` prevents accidental npm publication and does not prevent tarball installation.

The following is the fixed alpha.18 asset URL. It is an installation example, not a claim that the asset is published. Confirm that the Release contains this exact file and its checksums first:

```text
https://github.com/Missher12/Missher-MSE-Learning/releases/download/v0.9.0-alpha.18/missher-dsh-mse-learning-0.9.0-alpha.18.tgz
```

**Desktop:** open **Plugins → Add plugin**, paste the URL, then enable/reload as directed by the host. Open **Settings → 自我进化** and inspect the version and state. The desktop profile is managed by the application; do not target it with the CLI example below.

**Existing CLI / Web profile:** the example targets `web`; substitute your actual non-desktop profile.

```sh
dsh plugin --profile web add https://github.com/Missher12/Missher-MSE-Learning/releases/download/v0.9.0-alpha.18/missher-dsh-mse-learning-0.9.0-alpha.18.tgz
```

Alternatively, download the asset, check it against the Release's `SHA256SUMS`, and install that local `.tgz`. Source publication, downloadable Releases and marketplace acceptance are separate states. If [Releases](https://github.com/Missher12/Missher-MSE-Learning/releases) does not yet contain this version, its download URL is not available. Do not combine a versioned filename with `latest/download`.

## Start automatic validation

1. Install an available alpha.18 asset after checking its checksum. Open **Settings → 自我进化 (Self-evolution)** and check the version and enablement state.
2. Turn on **automatic validation**. For historical candidates without a recoverable source, explicitly select a **verification session** with a configured model route. It supplies the provider, model and reasoning effort without changing the lesson's original project.
3. Set a **nonzero evaluation token allowance** you accept, and ensure the evaluation-count allowance permits a plan. After saving, inspect actual control acknowledgement, queue stages and blocking reasons. A recorded candidate does not imply immediate promotion.
4. Distinguish recorded lessons, trials and validation. Safety review can admit a trial; objective checks are required for validated status within the registered domain. Turning off automatic validation stops later automatic steps. Reflection has its own switch and frequency limits.

Defaults remain **automatic validation off and evaluation tokens at 0**; these instructions do not set a budget for you. The evaluation-count allowance counts plans, each of which may make several provider requests. Reading the page does not start models.

## Evidence and platform boundaries

| Environment | Evidence and limits |
| --- | --- |
| Intel macOS with Missher's customized DSH 0.2.0-rc.2 | alpha.18 r2: full Node 303/303 and lifecycle 10/10. r3: offline real-adapter 125/125, control/commit/stop regression 62/62 and controlled browser UI 189/189, all bound to the same freeze. Real-provider review belongs to r2: 54/54 checks, 4 requests and 1437 tokens, reaching reviewed/trial/unproven with validated=0. See [VALIDATION](VALIDATION.md) for exact version ownership and reuse; this is not daily native-install acceptance. |
| Unmodified official DSH, later DSH versions, Windows and Ubuntu | Full compatibility is not claimed in this release. Permissive `*` peers do not prove the required interfaces exist. |
| Hermes 0.21.1 | This upgrade has 53/53 isolated Python/Node CLI checks, reused for r2/r3 through unchanged shared-core, Hermes-adapter and test-input bytes. This is not a new native PluginManager or real-provider run. alpha.15 PluginManager evidence remains historical. Distribution is being prepared as DSH-only; no new Hermes release or daily installation is claimed. |
| Other Agents | A host-independent Node SDK and JSON CLI are available, but a trusted lifecycle adapter is required. This is not automatic support for every Agent or a browser SDK. |

DSH must provide Cordis, LLM, Typert, Schemastery, commands/settings and related services. The complete settings UI also requires the static `@deepseek-ai/dsh-client-ui-primitives` module and matching settings extension points; the tested combination is Missher Desktop. Official packages are host-provided peers, not a bundled replacement host. Report the host version and redacted loading error when interfaces are missing; a version exemption is not a compatibility test.

## Pause, removal and retained data

Turn off enablement in **Settings → 自我进化** and check that persistent control has been acknowledged. A busy lock can leave it unconfirmed; a saved settings document alone is not confirmation. Disable automatic reflection separately to retain recall without starting new reflections; automatic validation has its own switch.

Before uninstalling, let active tasks finish and back up the entire host-resolved `dshHomePath('mse-learning')` directory, normally `mse-learning/` under the DSH data root. Include both `lessons-v1.json` and `sessions/`. Remove the package through Desktop's plugin manager, or from the same CLI / Web profile:

```sh
dsh plugin --profile web remove @missher/dsh-mse-learning
```

There is no uninstall data-deletion script; removing the package does not actively erase its learning store. If you want to erase personal data, first stop the relevant host, then manage that directory and its backups yourself. Do not delete the entire DSH data root or another plugin's directory. DSH and Hermes must not share a live writable learning store. A detected legacy `missherEvolutionCore` pauses the new controller.

The historical alpha.15/alpha.16→alpha.17 upgrade stayed on schema 2. alpha.18 is designed around optional schema-2 fields, but final compatibility and rollback checks are pending; retain a fresh complete backup before upgrading. Schema 1 needs explicit migration. Before downgrading to a package without durable settlement support, drain/retire pending settlements, or restore both the corresponding old package and the complete pre-upgrade backup. See the [durable settlement contract](docs/DURABLE_SETTLEMENT_OUTBOX.md).

## Development and verification

The repository's legacy-store fixtures are synthetic, not personal learning data. Node tests use one worker by default:

```sh
npm test
node scripts/pack.mjs --dsh-only
node scripts/pack-source.mjs
node scripts/verify-package.mjs
```

Use a fresh source copy or output directory for each build; packers reject existing candidate artifacts. `MSE_SOURCE_COMMIT` identifies the 40-character commit for an export without `.git`. Isolated host scripts take explicit artifact, Host modules and pnpm paths. UI verification requires `MSE_DSH_SOURCE` and `MSE_PLAYWRIGHT_ANCHOR`, with no maintainer-specific fallback. Optional historical alpha8 comparisons use `MSE_ALPHA4_ENGINE` and `MSE_ALPHA6_ENGINE`.

[Adapter protocol](docs/ADAPTER_PROTOCOL.md) · [Durable settlement](docs/DURABLE_SETTLEMENT_OUTBOX.md) · [Detailed behavior, Chinese](docs/BEHAVIOR.zh.md)

Arbitrary free-form Chinese conditions are not reliably understood; unclear conditions conservatively block recall. Unacknowledged work and manual model jobs do not have a cross-crash durability guarantee. Tests, readable settings and growing counters do not establish long-term model improvement. This round of real-provider acceptance covers bounded review only, not paid objective two-arm validation. Controlled browser UI evidence is separate from daily native-window acceptance.

## License and attribution

[MIT](LICENSE), Copyright © 2026 Missher. DSH/Cordis/Schemastery interfaces come from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness); host-provided packages retain their own licenses. The Hermes adapter targets [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent). The [RRSI research note](docs/RRSI_RESEARCH_2026-09-30.md) records design references; it does not mean RRSI is bundled or that either upstream endorses this plugin.

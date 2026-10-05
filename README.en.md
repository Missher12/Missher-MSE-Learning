# MSE Learning

English | [中文](README.md) · [Desktop and downloads](https://github.com/Missher12/Missher-DeepseekHarness-Desktop)

Persists scoped user corrections and method candidates for DSH, recalls relevant lessons within a byte budget, and records adoption and verification established by the trusted host. It does not train model weights or guarantee that a model will never repeat a mistake.

Package: `@missher/dsh-mse-learning`. **0.9.0-alpha.16** is a prerelease packaging revision: repository metadata, bilingual instructions and complete packaged documentation. Every business file under `src/` and `adapters/` remains identical to alpha.15. The historical `dsh-missher-evolution` package is a separate product; this plugin does not read or migrate its data.

## Features and cost

- Capture explicit corrections from host-authenticated user input; recall them by scope, supported applicability conditions and remaining budget.
- Keep inferred methods as candidates until trusted evaluation or registered algorithm checks qualify them for recall.
- Use **Settings → 自我进化 (Self-evolution)** for lessons, recall explanations, pause/resume, manual review, budgets and actual control acknowledgement.
- Recover acknowledged completion settlements after restart without rerunning models or tools or crediting a result twice.
- `/mse` shows status, `/mse why` explains recent recall, and `/mse now <task>` provides a read-only preview. They use the host command service instead of ordinary model messages.

Default recall limits are **2 lessons / 768 UTF-8 bytes per turn** and **1536 bytes per session**. Bytes are not tokens. Retrieval makes no model calls. Automatic review can make additional calls using the current task's model: at most 3 per 24 hours, at least 30 minutes apart, and at most 384 output tokens each. It can be disabled separately. Additional model evaluation defaults to `evaluationTokensPerDay=0`; it does not start paid evaluations automatically.

## Install a fixed version

Use a configured DSH host with Node.js ≥22.19.0. The tarball contains executable JavaScript and needs no install-time build. Distribution is through GitHub assets, not npm registry; `private:true` prevents accidental npm publication and does not prevent tarball installation.

Once this version's Release is published, its fixed asset URL is:

```text
https://github.com/Missher12/Missher-MSE-Learning/releases/download/v0.9.0-alpha.16/missher-dsh-mse-learning-0.9.0-alpha.16.tgz
```

**Desktop:** open **Plugins → Add plugin**, paste the URL, then enable/reload as directed by the host. Open **Settings → 自我进化** and inspect the version and state. The desktop profile is managed by the application; do not target it with the CLI example below.

**Existing CLI / Web profile:** the example targets `web`; substitute your actual non-desktop profile.

```sh
dsh plugin --profile web add https://github.com/Missher12/Missher-MSE-Learning/releases/download/v0.9.0-alpha.16/missher-dsh-mse-learning-0.9.0-alpha.16.tgz
```

Alternatively, download the asset, check it against the Release's `SHA256SUMS`, and install that local `.tgz`. Source publication, downloadable Releases and marketplace acceptance are separate states. If [Releases](https://github.com/Missher12/Missher-MSE-Learning/releases) does not yet contain this version, its download URL is not available. Do not combine a versioned filename with `latest/download`.

## Tested scope and host requirements

| Environment | Evidence and limits |
| --- | --- |
| Intel macOS with Missher's customized DSH 0.2.0-rc.2 | alpha.15 passed actual Loader, settings/command RPC, daily loading and data-preservation checks. alpha.16 retains those business files; packaging checks are recorded separately. |
| Unmodified official DSH, later DSH versions, Windows and Ubuntu | Full compatibility is not claimed in this release. Permissive `*` peers do not prove the required interfaces exist. |
| Hermes 0.21.1 | alpha.15 passed isolated PluginManager/CLI checks. This release packages DSH only; the Hermes manifest stays at alpha.15 and no new Hermes release or daily installation is performed. |
| Other Agents | A host-independent Node SDK and JSON CLI are available, but a trusted lifecycle adapter is required. This is not automatic support for every Agent or a browser SDK. |

DSH must provide Cordis, LLM, Typert, Schemastery, commands/settings and related services. The complete settings UI also requires the static `@deepseek-ai/dsh-client-ui-primitives` module and matching settings extension points; the tested combination is Missher Desktop. Official packages are host-provided peers, not a bundled replacement host. Report the host version and redacted loading error when interfaces are missing; a version exemption is not a compatibility test.

## Pause, removal and retained data

Turn off enablement in **Settings → 自我进化** and check that persistent control has been acknowledged. A busy lock can leave it unconfirmed; a saved settings document alone is not confirmation. Disable automatic review separately to retain recall without starting new background reviews.

Before uninstalling, let active tasks finish and back up the entire host-resolved `dshHomePath('mse-learning')` directory, normally `mse-learning/` under the DSH data root. Include both `lessons-v1.json` and `sessions/`. Remove the package through Desktop's plugin manager, or from the same CLI / Web profile:

```sh
dsh plugin --profile web remove @missher/dsh-mse-learning
```

There is no uninstall data-deletion script; removing the package does not actively erase its learning store. If you want to erase personal data, first stop the relevant host, then manage that directory and its backups yourself. Do not delete the entire DSH data root or another plugin's directory. DSH and Hermes must not share a live writable learning store. A detected legacy `missherEvolutionCore` pauses the new controller.

alpha.15→alpha.16 stays on schema 2 and needs no migration. Schema 1 needs explicit migration. Before downgrading to a package without durable settlement support, drain/retire pending settlements, or restore both the corresponding old package and the complete pre-upgrade backup. See the [durable settlement contract](docs/DURABLE_SETTLEMENT_OUTBOX.md).

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

Arbitrary free-form Chinese conditions are not reliably understood; unclear conditions conservatively block recall. Unacknowledged work and manual model jobs do not have a cross-crash durability guarantee. Tests, readable settings and growing counters do not establish long-term model improvement. Platform behavior, native visual interaction and real-provider results require separate acceptance.

## License and attribution

[MIT](LICENSE), Copyright © 2026 Missher. DSH/Cordis/Schemastery interfaces come from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness); host-provided packages retain their own licenses. The Hermes adapter targets [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent). The [RRSI research note](docs/RRSI_RESEARCH_2026-09-30.md) records design references; it does not mean RRSI is bundled or that either upstream endorses this plugin.

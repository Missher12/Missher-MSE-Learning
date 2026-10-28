# MSE 0.12.0 source handoff — pending root freeze

**State:** Root window 48 ran 103 checks against read-only `candidate-r2`: 98 passed and 5 failed, all in `details-client.test.mjs`. Window 49 then ran 40 `details-client` checks against read-only `candidate-r3`: 39 passed and 1 failed, in the pending-save UI assertion. Canonical fixes now wait for a fresh success render after the deferred mutation; they have passed static checks only and await root's serial re-run on a new candidate. Freeze remains on hold; package build, release and installation are not accepted. Window 51's isolated native pass confirmed three-field save and synthetic model discovery, then exposed two layout issues: the inner input stayed narrow inside its Host wrapper, and at a 600px window / 311px content width the stale notice was squeezed beside the save actions. Root runtime inspection traced the Input wrapper to `YD`; the plugin rule's `display:block` prevented the inner flex input from expanding. Canonical now has two plugin-only CSS fixes: the input wrapper uses `display:flex`, and the save footer has a dedicated class with a full-width notice and flex-wrapped, right-aligned actions. Source composition places the shared footer in overview settings and as a sibling after the budget panel's `mse-decision-fields`; its CSS binds to `.mse-details .mse-save-footer` and therefore covers both placements without changing other rows. `node --check adapters/dsh/client.js` passed. No tests, package build, freeze, release or installation were run for these CSS fixes. Window 51 continues on its frozen r4 copy, which is unchanged.

Window 52 then ran 40 checks against read-only r5: 39 passed and the only failure was the CSS source assertion in `decision model settings preserve remote drafts across Host and bind legacy refs across route changes`, which still expected `display:block`. The canonical assertion now expects the accepted `display:flex` rule; width/min/max and all route-draft interaction assertions remain intact. This edit was syntax-checked but not re-run.

Window 54/R6 then confirmed that the input fills its available width, long values remain usable, and the settings footer does not wrap vertically or overflow in narrow/wide Chinese and English views. Its remaining findings were duplicated `Reload host values` actions after a revision conflict and two-line English budget presets with no vertical breathing room at 559px content width. Canonical now combines the recovery action while preserving `reseed` and refreshing runtime status for failed saves; the preset buttons use natural height, a 36px minimum and 8px block padding. One interaction regression covers the conflicted write, single recovery entry, reseeded Host value and status refresh. These two follow-ups were syntax-checked only; no tests or packaging were run.

Window 54's additional observation and timing clarification record that the old credential conflict hint remained at 500ms and 16.879s after reload. A later independent `describeDecisionCredential` read at revision 2 / route-a returned `ok`, `configured`, `stored` and `writable`; the screenshots do not contain renderer RPC traces, so this is a persistent UI status issue, not evidence of credential storage failure. The receipt is `/home/missher/Projects/DSH-Recovery-20261012/coordinator/mse-model-setup-0120-20261021/window-54/RELOAD-TIMING-CLARIFICATION.json` (SHA-256 `09b2a9a14ad5921b560ff03c4021a23656e8e1e4554c2103961a780711eddd99`). Canonical `reseed` now invalidates the old context synchronously, increments a credential reload generation and shows loading; the changed context starts the existing 200ms read-only credential description at the latest draft revision. The existing writable/revision checks and effect cleanup remain in place. The interaction regression holds revision-23 metadata until revision-24 metadata is accepted, then confirms the late older result cannot overwrite it. No test or package run was added for this follow-up.

The 2026-10-21 Host source comparison found that ConfigForm and MSE use the same namespace revision: the Host form snapshot derives its revision from the shared `settings.describe` mirror, while MSE checks `settingsRevision` against the current `settings.describe()` row. The mismatch was a stale client mirror after a credential conflict: that path returns before `form.mutate()`, so Host `ConfigForm.recover()` does not refresh it. The explicit Reload now calls the optional read-only `configForms.describe().load()`, checks `status`, `error`, namespace presence and equality with the fresh `form.getSnapshot()` revision, and only then reseeds and refreshes credential metadata. A failed/unsupported read keeps the draft; Save, Discard and credential writes are gated while refresh is active, and edits made during the read are preserved. No Host/runtime source was changed and no storage failure is inferred from the screenshots.

The targeted follow-up command `node --test --test-name-pattern='a Host revision conflict|a credential conflict refreshes the Host mirror|a failed settings refresh keeps the draft' tests/details-client.test.mjs` passed 3/3; a separate settings-section injection check passed 1/1. Those runs preceded a final copy-only status-message adjustment; the final hashes below received syntax/whitespace checks, with no test rerun per root's serial-window instruction. This is bounded regression evidence, not a full suite or package acceptance. The root remains the owner of the next serial full check and freeze.

## Baseline and source scope

- Baseline: formal 0.11.1 release commit `0f6b3151e29169c6c8857686949dbf6a633ab582`, tag `v0.11.1`.
- Exact public source archive: `/home/missher/Projects/DSH-Recovery-20261012/desktop-upgrade/mse-decision-upgrade-20261020/final-delivery-0.11.1/anonymous-download/mse-learning-0.11.1-source.tar.gz`.
- Archive SHA-256: `a13e52882f5eceed123fdb0311089309a389c01afecb6157b7fd502061ea0acb`; 1,215,831 bytes and 143 public files. The digest was checked against the on-disk archive.
- Current working-tree `adapters/dsh/client.js` SHA-256: `d072f8495fafd00e2627b6b648e3588353612ddffbb7ac2a4c041268d575fb74` (unfrozen source file; not a package or manifest hash; includes explicit credential-conflict mirror refresh and draft-preserving failure behavior).
- Current working-tree `tests/details-client.test.mjs` SHA-256: `9aecb43bc6e0d7299dc65abfb77412b9063a3ee16435ec3fbad087bf3bdc47db` (canonical regression source; the window 52 r5 candidate remains unchanged).
- Public-set comparison against that archive: 15 changed files, one added file, zero removed files. The current public source set has 144 files. Read-only `candidate-r2` remains the window 48 evidence snapshot; root owns the next candidate and final manifest.

Changed public files:

- `README.md`
- `README.en.md`
- `VALIDATION.md`
- `adapters/dsh/client.js`
- `adapters/dsh/config.mjs`
- `adapters/dsh/control.mjs`
- `adapters/dsh/index.mjs`
- `adapters/dsh/typert.mjs`
- `adapters/hermes/plugin.yaml` (version metadata only; Hermes behavior is unchanged)
- `package.json`
- `scripts/pack.mjs`
- `src/decision-providers.mjs`
- `tests/decision.test.mjs`
- `tests/details-client.test.mjs`
- `tests/details-project.test.mjs`

Added public file: `docs/AUTONOMY_0.12.0.md`.

The local handoff file itself is excluded from the public source allowlist. Existing `.probes/`, caches, and other private coordination files remain outside the public source set.

## Candidate behavior

- Remote decision settings expose model name, API address and a masked API key field. General Save stores a pending key in the Host credentials service first, then applies route settings with the draft revision CAS. If the key write fails it remains in the field; if the key is stored but the route CAS fails, the UI says so. Saved keys use a backend/route-derived reference; the Remote returns metadata only. An unsaved field key is accepted for one model-directory GET and is not persisted by discovery.
- A pending remote key counts as a dirty form on its own. Discard clears it and invalidates outstanding discovery; discard is disabled during credential or form saves. If the Host revision changes while only a key is pending, the form keeps its original route draft and becomes stale instead of silently rebinding that key to the newer route.
- Password input is disabled while a key write is running. Each edit advances a key generation, cancels an in-flight discovery and clears its models; late results from the previous key are ignored. Credential and discovery actions use the draft's revision and are blocked when the draft is stale, with a refresh prompt.
- Legacy environment-variable references remain available in Advanced. A route switch saves the prior route binding before it can be reused; explicitly re-entering the reference binds it to the current route.
- Model-directory reads are same-origin GET only, reject redirects, time out after 8 seconds, cap responses at 64 KiB and lists at 500 models. OpenAI-compatible and Jev use `/v1/models`; Laya reads `/health` and only the `loaded` field. Laya `auto` stays a separate option. Discovery never calls inference or changes budget/settings.
- OpenAI origin roots, `/v1` bases and explicit `/<prefix>/v1` bases normalize to standard endpoints. Standard full `/v1/chat/completions` paths preserve the configured request path, including a trailing slash. All unknown OpenAI paths, including ones ending in `/`, remain exact legacy inference URLs and report discovery as unsupported. Jev/Laya retain the old service-base behavior and append `/v1/systemone`.
- Discovery rechecks cancellation and timeout after the fetch and bounded body reads. A late successful transport response after cancellation cannot produce models. Unsupported directories and oversized declarations still close the transport signal.
- Empty remote API addresses and invalid addresses have separate short status messages. The Host credential service is reported as unavailable only when its metadata says `serviceAvailable: false`; discovery and Laya auto-selection copy is concise.
- Budget preset buttons use an independent responsive grid, start at the left edge, and numeric inputs share one width. Budget values/defaults and automatic-validation settings are unchanged; the user's current High 200K/20 setting is not modified by this source change.

## Checks and root-owned test window

Canonical JavaScript syntax, package JSON, tracked-diff whitespace, and changed-source trailing-whitespace checks were completed before these CSS follow-ups. Window 48's 103-check result, window 49's 40-check result and window 52's 39/40 result are retained as separate receipts; frozen `candidate-r2`, `candidate-r3`, window 51's r4 copy and window 52's r5 copy remain unchanged. The pending-save render assertion is fixed in canonical. Window 54/R6 independently rechecked and confirmed the input sizing and footer layout in its native evidence. The latest credential-refresh regressions passed only the bounded checks listed above; the remaining 0.12.0 suite, package build and native recheck are pending.

The original recovery/credential-refresh interaction test covered only a ConfigForm mutation conflict. The new credential-conflict regression now models server revision 2 with the form mirror still at revision 0, verifies no `form.mutate()` call, then requires a successful mirror load before reseeding. A second regression confirms failed reads and edits during an in-flight read preserve the draft. R7's revision-24 test for late metadata remains in place. Syntax checks pass; bounded Node checks are recorded above. No package build or Host/runtime source modification was made. Window 54 screenshots are retained under `/home/missher/Projects/DSH-Recovery-20261012/desktop-upgrade/mse-decision-upgrade-20261020/connection-0.12.0/native-preparation/layout54-evidence/`.

Window 52's independent 40-check run on read-only r5 produced 39 passes and one failure, solely because the existing source regex expected `display:block`. Canonical now expects `display:flex` in that assertion while retaining the width/min/max and route-draft behavior checks. `node --check tests/details-client.test.mjs` passed. The test suite was not rerun and no package was built; see `/home/missher/Projects/DSH-Recovery-20261012/coordinator/mse-model-setup-0120-20261021/window-52/client-tests.log` for the window 52 receipt.

```sh
node --check src/decision-providers.mjs
node --check adapters/dsh/control.mjs
node --check adapters/dsh/index.mjs
node --check adapters/dsh/client.js
node --check adapters/dsh/config.mjs
node --check adapters/dsh/typert.mjs
node --check tests/decision.test.mjs
node --check tests/details-client.test.mjs
node --check tests/details-project.test.mjs
node --check scripts/pack.mjs
python3 -m json.tool package.json
git diff --check
```

Focused regression command for root's post-fix run, prepared but **not run against the updated canonical source**:

```sh
node --test --test-concurrency=1 --test-name-pattern='provider routes normalize supported bases|OpenAI requests preserve exact legacy and complete endpoint paths|model discovery uses bounded read-only provider directories|model discovery enforces its timeout|remote decision credentials are route-scoped|credential writes report a settings revision change|model discovery keeps a draft key one-time|decision model settings preserve remote drafts across Host|a pending API key marks the remote form dirty and Save stores only the credential|Discard clears a key-only remote draft without saving credentials or starting discovery|Discard stays disabled and cannot clear a draft while the settings save is pending|general Save stores a pending remote key|a failed general Save keeps the API key draft|a config CAS failure after storing the API key reports that only the key was saved|editing the API key cancels discovery|a changed settings revision blocks credential and discovery actions with only a pending API key|remote key status distinguishes an empty or invalid API address|a settings save rejects a changed revision, preserves a stable draft revision, and rechecks permission' tests/decision.test.mjs tests/details-project.test.mjs tests/details-client.test.mjs
```

All provider responses and credentials in these tests are synthetic; they perform no network call. Suggested root window: one serial 10–20 minute test allocation with a 2 GiB memory cap. If tests pass, package/source-manifest verification should run serially from root's frozen 0.12.0 copy in a separate 10–15 minute window, also capped at 2 GiB. Desktop then owns isolated native Chinese/English UI and save/restart verification. Estimates are planning ranges, not measurements from this candidate.

Before native acceptance, cover long model/endpoint values, 310/480/700 px content widths, wrapped presets, equal numeric field widths, route-switch cancellation, key-save/delete status, manual model entry, Laya `auto`, and saved settings after restart. Use an isolated profile and synthetic credentials.

No inference-quality claim, provider request, package artifact, Git push, formal release or daily installation is included in this handoff.

# 0.13.0 Unlimited budget mode — source candidate

## Status and acceptance boundary

- **Source:** 0.13.0 candidate; not frozen, committed or published. Root coordinator owns final freeze and Git; Desktop owns release and installation.
- **Formal release/install:** still 0.12.0.
- **Tests:** root's window 61 focused Node run recorded 189 tests: 176 passed, 13 failed, 0 skipped (29.387 seconds). Window 62 recorded 105 tests: 104 passed, 1 failed. Window 63 reran that case and exposed a production byte-accounting defect. Root later reports R4 passed Node 189, Hermes 58, and packaging. Desktop window 65 reported the footer feedback issue below. Root window 66 ran 48 client cases on candidate-r5: 45 passed, 3 failed; package work did not start. The R6 fixture corrections below have not been rerun.
- **Static checks:** post-repair JavaScript/MJS syntax, Python AST, package JSON, hash-table, and whitespace checks passed below. No test execution, build/package creation, provider request, or native UI check was run during this repair.
- **Build/package/provider/native UI/release/install:** not run or verified. DSH interaction coverage is a synthetic test only.
- **Daily configuration:** no profile/settings changes; Unlimited was not enabled for daily use. Existing saved numeric allowances remain intact.
- **Git:** no Git writes were performed.

## Behavior delivered in the source candidate

- Adds `evaluationBudgetMode: "limited" | "unlimited"`; omitted or invalid values resolve to Limited. Limited mode retains the rolling 24-hour token and logical-task caps. Unlimited removes only those shared caps for decisions, reviews, objective evaluations and controlled merge generation.
- Switching modes preserves configured finite limits, live tickets, spend receipts and checkpoints. It does not replay a dispatched request. A switch wakes only eligible budget/storage waiters; unknown results, pauses and provider-failure backoff keep their existing state.
- Both modes retain per-request ceilings, measured/reserved usage, one-at-a-time concurrency, unknown-cost isolation, deduplication, pause/stop, source/version gates, verification requirements, and automatic reflection's separate cadence/attempt limits.
- Bounds paid receipts to 4096 rows and the state document to 2 MiB. New paid work waits with `spend_ledger_full` when it cannot safely fit. Live ticket headroom covers checkpoints and settlement, including legacy tickets without a persisted per-ticket reserve; repairs that shrink an older near-full store remain possible.
- DSH status reports actual reserved/measured tokens, logical tasks, physical requests and unknown costs. Remaining allowance is `null` in Unlimited mode. Capacity details appear only when the ledger is full. Automatic validation remains a separate opt-in.

## Suggested single offline verification command for root

```sh
node --test --test-concurrency=1 tests/decision.test.mjs tests/auto-scheduler.test.mjs tests/details-client.test.mjs && python3 -m unittest discover -s tests -p test_hermes.py
```

This command was **not** rerun during this repair turn. Root's window 61 Node run and failure record are summarized below; the next Node + Hermes window remains for root to schedule under the single-writer/resource policy.

## Window 61 diagnosis and source-only repairs

The immutable failure record is `/home/missher/Projects/DSH-Recovery-20261012/coordinator/mse-unlimited-budget-0130-20261021/window-61/FAILURES.json`; the associated Node log SHA-256 is `85da9af79d173940ecc84aea06511ae4b0192f3afd8ef3b17ea5cf12364a61cf`. The result is a failure baseline from `candidate-r1/source`, not evidence that the repairs below pass. The frozen snapshot was not edited.

| Failed test | Root cause in window 61 | Source-only repair; awaits rerun |
| --- | --- | --- |
| `the review track runs two arms and two swapped judge passes, then commits` | `scan()` advances existing queued plans before registering new plans at the end of the same pass; the test expected four calls on its registration pass. | Run one pass to register the plan, then a second pass to execute it. |
| `the objective track reserves a pack ticket, answers every case and settles as host_pack` | Same registration-versus-advance ordering; no objective plan existed at the start of the first pass. | Register on the first pass and execute on the next. |
| `a cold start runs on the plan route, with no warm-up of its own` | Same first-pass ordering; the test expected four paid calls on the pass that only registered the plan. | Use two scans and keep the persisted route assertion. |
| `a pause between two arms stops the very next request` | The test's single scan only registered its new plan, so its pause gate was never reached. | Use a registration pass followed by the guarded execution pass. |
| `an archived source stops the next paid step and the commit` | The test's single scan only registered its new plan, so its source-permit gate was never reached. | Use a registration pass followed by the guarded execution pass. |
| `unlimited allows more than one million reserved tokens and twenty one-at-a-time decisions` | The competing request reused the active decision subject; unresolved-subject deduplication returns the existing record before the global busy check. | Create a distinct synthetic candidate for the competing request so it reaches `evaluation_busy`; production deduplication and the one-ticket limit remain unchanged. |
| `a checkpoint spends its own reserved bytes after ordinary writes approach the store limit` | The capacity baseline was captured before the fixture's padding write, so the later assertion compared against a smaller pre-padding allowance. | Capture serialized bytes plus the legacy reserve after padding and before the checkpoint. |
| `a nearly full pre-existing store can commit a small space-releasing repair` | The synthetic JSON property overhead omitted its comma, leaving 1023 rather than 1024 free bytes. | Include the comma in the fixture's overhead calculation; retain the exact 1024-byte assertion. |
| `a ready writable form renders the settings rows and a disabled save` | The General/overview settings surface no longer mounted the automatic-validation switch; it remained only on the budget tab. | Restore the switch to General while retaining the budget-tab switch, both bound to the same setting. |
| `the budget panel saves and reads back unlimited mode while retaining metrics and the opt-in switch` | The expected pending label omitted the selected mode's `（不限额）` qualifier. | Assert the full selected and currently applied labels. |
| `budget slider preserves custom values until a tier gesture and saves through the current revision` | While saving, the button label changes from Save to Saving; the fixture searched only for the Save label and did not enter its in-progress assertions. | Find either label so the test checks the disabled controls during the pending mutation. |
| `non-preset budget pairs stay exact on render and when an unrelated setting is saved` | The fixture requested the budget tab while looking for `contextBytes`, which is on the General/overview tab; switching tabs would also hide the custom budget controls being checked. | Keep the budget panel rendered, save through its automatic-validation switch, and assert the one-field patch leaves the custom token/task pair unchanged. |
| `常规 renders the verification picker, and a saved id missing from the directory says so` | The General switch was absent, so the combined session-and-switch patch could not be submitted. | Restoring the General switch preserves the expected single atomic patch. |

Hermes tests, packaging, native UI, provider calls, release, and installation remain unperformed. The window 63 source repair is still awaiting its next bounded verification window.

## Window 62 residual failure and static repair

Root's window 62 record is `/home/missher/Projects/DSH-Recovery-20261012/coordinator/mse-unlimited-budget-0130-20261021/window-62/FAILURES.json` (105 tests, 104 passed, 1 failed; log SHA-256 `23df5075a01ca4847ab60abc7431128de24f393ecf9d19639f612bd18551a97c`). The frozen `candidate-r2/source` snapshot was not edited.

The only failure was `a checkpoint spends its own reserved bytes after ordinary writes approach the store limit`: its initial request used the fixture's default `host` backend without a fallback route, so `decisionFail(..., allowFallback: true)` correctly did not request a Host fallback. The test now creates that ticket with an OpenAI-compatible primary route and a valid Host fallback route, matching the existing fallback contract. It retains the `needsHostFallback`, reserve reduction, capacity, and terminal-settlement assertions. Production code is unchanged. This fixture correction awaits a parent-scheduled minimal rerun.

## Window 63 production storage-accounting repair

Root's window 63 record is `/home/missher/Projects/DSH-Recovery-20261012/coordinator/mse-unlimited-budget-0130-20261021/window-63/FAILURES.json` (single test, 0 passed, 1 failed; log SHA-256 `2cc4da8aa8aece980d8c8e815b6eb89eadf7ce9eece03492ae35dfbf9515d951`). The frozen `candidate-r3/source` snapshot was not edited.

The failure was not a bad fixture or an overly strict assertion. `LessonStore.update()` increments `state.revision` after `LearningEngine.transaction()` returns, while ticket growth and capacity were measured inside the callback. In this case revisions advanced `1 → 3` for request creation/reservation, `3 → 5` for dispatch, then `6` for legacy-field deletion, `7` for padding, `8` for checkpoint, `9` for `ticketUsage`, and `10` for the fallback-state transaction. The last transaction crossed from one to two decimal digits after its reserve debit, so the persisted document grew one byte beyond the ticket's accounted allowance.

`src/index.mjs` now measures the projected next revision for spend-capacity admission and post-write capacity checks. Ticket growth is charged against the projected persisted body; repair comparisons retain the current persisted body as their baseline. The store's final 2 MiB check and revision write order remain unchanged. The existing strict assertions were kept. The terminal-settlement path then advances revisions `11 → 12` while removing the live job; the later `completionFixture` path advances `1 → 3 → 5 → 6 → 7 → 8`. Static inspection found no separate accounting defect in those paths, but window 63 stopped before those assertions, so they remain unverified at runtime.

Recommended next verification is this single decision test, which covers the entire checkpoint → fallback → terminal path and its second completion fixture, followed by the still-unrun Hermes unit suite. Reuse the retained passing Node evidence from window 62; let root decide whether a package check belongs in that window.

## Desktop window 65 feedback finding and static repair

Desktop reported that after a successful limited-budget save, changing the mode to Unlimited created an unsaved draft while the footer still showed the earlier “Saved and in effect” message. The client now suppresses only `saved` feedback while `dirtyNow` is true; it leaves save state, async generations, errors, partial-success/conflict feedback, and the Host save protocol unchanged. A targeted regression case now covers saving a synthetic custom token limit, changing the mode and seeing the unsaved state, discarding back to the saved draft, then changing the mode again and saving successfully. Its control status follows the form snapshot mode, and both CAS revisions and write operations are asserted. Static review corrected the fixture so it requires the token input only during the limited-mode edit; the test remains unexecuted. Root review and a later bounded retest remain pending; no frozen R4 files or window 65 evidence were edited.

## Window 66 client failures and R6 fixture-only corrections

Root's immutable window 66 outcome is `/home/missher/Projects/DSH-Recovery-20261012/coordinator/mse-unlimited-budget-0130-20261021/window-66/OUTCOME.json` (SHA-256 `10157b09016626b4dd98b54bdb9a0382d0f87810b2cf9b2863f24485f386aa63`); the client log SHA-256 is `f6315792c352c4ce0f3c2d0b294e0ac4b2470fb446521368f88f94ff62d81773`. It tested `candidate-r5/source`, recorded 45/48 passing client cases and three failures, and created no package.

Static comparison found the three failed fixtures reported success from `mutate()` without applying the patch to `snapshot.value`, advancing the Host revision, or notifying `subscribe()`. The production client correctly compares the current draft with the accepted Host snapshot, so the saved-success feedback stays hidden while those fixtures falsely leave the draft dirty.

| Window 66 failure | R6 source-only fixture correction | Kept assertions |
| --- | --- | --- |
| `Discard stays disabled and cannot clear a draft while the settings save is pending` | The delayed mutate now applies the patch only when its revision is still current, increments the revision and notifies subscribers when resolved. | Discard remains disabled during the pending save; the draft stays visible; the resolved write's revision and exact operation are checked. |
| `non-preset budget pairs stay exact on render and when an unrelated setting is saved` | The unrelated-setting mutate now commits its one-field patch, advances the revision and notifies subscribers. | The existing save revision/operation checks remain, with persisted token and task limits explicitly checked unchanged. |
| `a settings save rejects a changed revision, preserves a stable draft revision, and rechecks permission` | The stable mutate now applies its atomic operations and notifies subscribers. The later permission-revocation step uses 1344 after 1280 was correctly persisted, so it still presents a dirty draft. | Stale revision is refused before mutate; the stable write uses revision 21 and its exact two operations; permission revoked after render still produces zero writes. |

R6 changes only `tests/details-client.test.mjs` and this READY record; `adapters/dsh/client.js` and the new stale-success guard are unchanged. No production defect was found in these three failures. Root's next acceptance is limited to the client regression and a short native check; core/Hermes suites and broad layout checks are not part of that follow-up. No tests, build, package, model request, GUI, Git or daily settings action was run during the R6 source-only repair.

## Static check results

- `node --check` passed after repair for `tests/auto-scheduler.test.mjs`, `tests/decision.test.mjs`, `tests/details-client.test.mjs`, `adapters/dsh/client.js`, and `src/index.mjs`.
- Python AST parsing passed for all 15 Hermes adapter and Python test files.
- `package.json` JSON parsing passed.
- `git diff --check` passed for tracked changes; the updated READY note and local handoff documents have no trailing whitespace.
- After window 66, this R6 source-only repair ran only syntax, diff, whitespace and candidate-hash checks. No test, build, packaging, provider request or native UI action was executed during the repair.

## Candidate files and SHA-256

Hashes below identify the current 0.13.0 implementation, regression and release-note files. `HANDOVER.md` and this file are local handoff records; `VALIDATION.md` is part of the public file set. Root `READY-*` files are not in the public package allowlist, so this file is not self-hashed.

| File | SHA-256 |
| --- | --- |
| `README.md` | `cc82eea1869fa541f6faaaf9ab01067c7082de6daf3e2fc91e54d725bf712512` |
| `README.en.md` | `324cc7bc5fde806f490f756d738dfaaf04a61561857acfbf1af559de0dc555fb` |
| `VALIDATION.md` | `724bd18d08f6647e4319b4facf7bb116dafbe264be4e31a950b195dc154040e9` |
| `HANDOVER.md` | `8ebe9b189873221fe9ec33e9f7ab732cbfafbda17102c582ddc947aa03689511` |
| `adapters/dsh/auto.mjs` | `9d44b2b161e4ba8a1ebf9e5901eda901919874e5b1dc8925ad8e8fe8758f6307` |
| `adapters/dsh/client.js` | `7b98e43b40f0f292f60b9ecf5552d459f1bbc0ef1072bd3be5d678e955f773d5` |
| `adapters/dsh/config.mjs` | `698cc520b5000f31eda38414782fc1693f79ea7187f9ae0ceecb8c5daade3a16` |
| `adapters/dsh/index.mjs` | `bd3ef9956ee1385bdafcd47a79da1640bb34530fb3f6276ef51405b4222dfc9c` |
| `adapters/hermes/bridge.py` | `7e594322e4ad80b62f06c7f89ef9137ab9f7d28f9dda3649efeaab3936df40fe` |
| `adapters/hermes/plan.py` | `e582c5f189fa242e5fa325e6d4d7d31bb52a589234eacb2fab63da194ea5f3a8` |
| `adapters/hermes/plugin.yaml` | `ac8e06881cf1e9228354174414f7ffea0827acdcb9d45573a8b75f92eb855f7f` |
| `docs/AUTONOMY_0.13.0.md` | `e1ada379765b2079bea55ec56352dbfa9357e89e631eacaf97b1dc893477a717` |
| `package.json` | `d848ea74b4b5c3700d843f445b9eeb14e52acf069f49ccea8972ff1676f0cc50` |
| `scripts/pack.mjs` | `b55402452debd5e9de7a386148a34228e1960d8721c33e7e3b8f4ca5f6e95649` |
| `src/cli.mjs` | `af959ae3c2bd569ceb4fe0ff1c0c5fa5479ff40c6c4c4dad65b608f61d1cda6b` |
| `src/index.mjs` | `448c2082c7ec68b84a86ae6b8b645f7669d428e44037fcf5f9ccc11de07dedfd` |
| `src/store.mjs` | `a4842dbeeac6b3ec1c5c409e0f65980313643aefc8f8caca60668c4fdb0afe5b` |
| `tests/auto-scheduler.test.mjs` | `2d3d2600f94cd4f7038e58481a56beb52b97230fcaab0f44b029e61ac233b1bc` |
| `tests/decision.test.mjs` | `4abe16fefa0bf586e56d4fa6439b55dd624438ab7e9898c985297db908c049c3` |
| `tests/details-client.test.mjs` | `b525f6c5d7c0bc03b30695179999a157645b05890b512ef6abacd6678d4f8862` |
| `tests/test_hermes.py` | `d978eb2dd40231d754ed886d7ea0ceeabd7a1ac64566afa4407f8c4594fa4af6` |

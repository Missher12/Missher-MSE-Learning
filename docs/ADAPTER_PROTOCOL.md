# MSE trusted adapter protocol 2

The adapter owns user identity, project identity, model routing, request evidence and verifier provenance. The core owns persistent state, bounded recall, versioning, evaluation decisions and rollback. The JSON CLI is a local trusted transport, not a model tool server.

## Runtime lifecycle

1. `prepare({sessionId,turnId,origin:'user',prompt,projectKey?,environmentId?})` returns context, receipt, lesson IDs and `lessonVersions`. Only direct user input may create corrections. Use an authoritative project identity; omit it for instance scope. An optional environment ID isolates method validation across model/tool configurations.
2. Append the exact context within the host's permitted instruction surface. Preserve the current user's authority. Do not truncate individual rules or regenerate the receipt text.
3. Call `accept({receipt,lessonIds})` only after the adapter can prove adoption. DSH reports successful llm/stream inclusion; Hermes matches the final request and successful response ID. These are distinct from network wire evidence. Cancel unusable receipts with `cancel({receipt})`.
4. A trusted verifier binds each observation to the adopted lesson's version. Call `complete` once with the original session/turn/project identity. Infrastructure failures should be unknown; interruption should be cancelled. Do not infer task correctness from normal completion or zero exit alone.

```js
engine.complete({ sessionId, turnId, projectKey, outcome: 'verified', evidence: {
  source: 'host_verifier', checkId: 'source-dates-v1',
  checks: [{ lessonId, version, checkId: 'source-dates-v1', passed: true }],
}})
```

Multiple checks may have different results. Only explicitly bound lessons receive positive/negative evidence; others are inconclusive. A new write invalidates earlier checks until the changed artifact is checked again. A stale version cannot receive credit. For compatibility a single correction can accept the former checkId-only complete contract; new integrations should always send explicit versioned checks. The DSH/Hermes bridges require lesson IDs, and method callbacks also require expectedVersion.

`verified` means an adopted method/correction passed that check. `validated` means a method passed the recorded offline evaluation. Neither claims universal causal improvement. Existing schema-1 `tested` methods migrate to candidate, retaining their historical counters.

## Registered checks and actions

Methods: `preserve-null-v1`, `copy-source-date-v1`, `numeric-sort-v1`. Inputs are bounded arrays of unique `{id,value}` records. Date source values must be valid YYYY-MM-DD or null. Numeric sorting requires that the host has established an explicit ascending-order requirement; identity and values must match the trusted source, and equal numbers retain source order. Unknown, malformed, ambiguous or mismatched data yields not_applicable.

`checkArtifact` reports only bounded counts/reason codes. No source values are persisted or returned by that report. `applyMethod` is a pure transformation and does not write files. For an adopted method, the bridge's verifyArtifact/verify_artifact checks the artifact and binds its report to that receipt.

```js
通用 SDK 入口既可以直接用包根 `@missher/dsh-mse-learning`，也可以用 `@missher/dsh-mse-learning/core`：包根只重导出 core 的符号，并在 DSH 宿主调用其 `apply` 时才动态加载宿主适配器，因此没有 DSH 依赖的进程 import 包根不会失败。

import { guardedAction } from '@missher/dsh-mse-learning/core'
const result = await guardedAction(engine, {
  lessonId, expectedVersion, projectKey, source, artifact,
  repair: false, // Set true only when the host authorizes the registered bounded transformation.
  signal,
}, async (checkedRows, identity) => {
  // The host performs its already-authorized action and its own file/concurrency checks.
  return saveArtifact(checkedRows, identity.signal)
})
```

Failed or inapplicable checks prevent this callback from running. The callback is invoked only after a passing check. The host remains responsible for action authorization, target identity, transaction safety and cancellation. This helper does not automatically intercept unrelated shell/tools or award successful-task credit.

## Method evaluation

`record({eventId,source:'host_proposal',kind:'method',instruction,applicability?,exclusions?,hypothesisId?,environmentId?,projectKey?,supersedes?})` creates an offline candidate. Registered `methodId` uses immutable canonical instruction and conditions; conflicting text is rejected. User corrections continue to recall immediately.

`evaluateRegistered({lessonId,expectedVersion?,projectKey?})` compares a fixed suite of pure registered transformations. It records basis=registered_algorithm. Generic paired evaluations use `evaluate({lessonId,expectedVersion,eventId,suiteId,projectKey?,trials,policy?})` and record basis=host_trial.

Each trial contains:

```json
{"caseId":"case-1","family":"source-dates","split":"holdout","baseline":{"passed":false,"tokens":100},"candidate":{"passed":true,"tokens":100},"guardPassed":true}
```

The default gate needs >=12 independent pairs, >=4 holdout pairs, >=2 families including holdout, >=5 improvements, a holdout improvement and one-sided paired sign p<=.05. Regression/guard failure rejects; missing cost is inconclusive. Token growth must be supported by gain and is capped at 25%. Policy overrides can only tighten the default bounds. These criteria help reject weak evidence but do not establish independent samples automatically.

The adapter must separate proposal data, development data and holdout data. Rotate holdout after it has informed decisions. Distinct case IDs do not establish independent provenance. Use the same model/tools/environment for paired trials and do not expose reference answers to the solving agent. Saved trials are summarized/hashed; original datasets stay in the host's separate controlled storage.

For a bounded async runner, use `runEvaluation(engine,{lessonId,expectedVersion,suiteId,cases,maxTokens,projectKey?},runner,signal)`. The constructor requires an explicit evaluationTokensPerDay budget (default 0). Each runner invocation receives arm, sample, instruction, maxTokens and signal, and returns `{passed,tokens,guardPassed}` from trusted execution and verification. Arms run sequentially in alternating order. Supply actual measured tokens, honor the supplied quota/abort, and keep judge/reference data out of model inputs. The whole job has a 60-second deadline, a single active job, and a prepaid budget that is not refunded after cancellation. Direct evaluate only ingests trials; their external execution cost is the caller's responsibility.

## Re-opening an expired row (generation contract v2)

A row expires 90 days after it was last opened. Re-opening it starts a NEW generation and needs evidence that can be checked inside the write transaction:

- `newGeneration: true` with `expectedVersion` and `expectedGeneration` — the version and generation the caller observed when it decided to re-open (pre-contract rows report `generation 0`). Both are compared with the stored row and both enter the event fingerprint, so the same input can never renew the row twice. A matching condition is accepted as an explicit, freshly observed claim; `newGeneration: false` refuses explicitly.
- Without that condition, only a provably new observation re-opens a row: while the row carries the persistent `historyComplete` marker, its bounded ring holds every event it ever applied, so an event outside ring/origin/generation was demonstrably never seen here. The marker is written when this build creates the row and is only ever lost — when an append evicts an event, or when a ring has to be assembled for a row that never had one (a pre-contract row, or a short ring written during an upgrade). A legitimate re-open never restores it, and a `generation` counter is not evidence of completeness either.

Anything else is refused conservatively with no state change: `skipped: "new_observation_required"` (no verifiable evidence, including a bare boolean or a pre-contract row) or `skipped: "stale_generation"` (the condition no longer matches). Replaying a known event remains `duplicate: true`. This replaced the alpha.6 rule where a single `newGeneration: true` boolean was enough for a row whose ring had already evicted events; hosts that re-open rows must re-read the row and state the condition. `prepare` is unaffected: the user's own new turn is the trusted observation for its own scope.

## Hermes write interlock

The background settlement replay and the foreground hooks write to the same core store, so the queue's `complete` replay acquires the same re-entrant lock every foreground hook holds around its core call (resolved per attempt, never captured once). The background side waits at most `SETTLEMENT_LOCK_TIMEOUT` (2s) and then reports a transient `lock_busy`, which the queue retries inside its ordinary attempt and deadline bounds; the foreground never waits unboundedly on the background, and a foreground `prepare` retries a transiently busy store a bounded two times before a turn reports no context.

The final validity check and the write happen inside that same boundary. After acquiring it, the queue re-checks the latest host permission, the queue lifecycle (paused/disposed), the identity and existence of the entry (`entries.get(key) is entry`, so a session closed or an entry replaced while the retry waited is never written), and the deadline against the current clock. A refused write consumes no attempt and is never reported as settled: a withdrawn permission or an explicit pause keeps the frozen payload pending for a legitimate resume, a closed session or a disposed queue simply stops (the entry is already terminal), and an expired entry is retired as `expired`. The foreground backoff re-reads the same lifecycle boundary before each retry. Frozen outcomes, bounded retries, stop/unload cancellation, single-credit attribution and the context budget are unchanged.

## Governance and persistence

- Use list/history/status to inspect scoped methods and summarized decisions. They are local administrative APIs, not automatically injected into prompts.
- A replacement candidate leaves the current method active until promotion. Regression or rollback withdraws only that replacement and restores its actual validated predecessor where still applicable. Resume returns a method to candidate, requiring reevaluation.
- Export/import uses a bounded `mse-method-v1` packet with a checksum. It carries no source project, observation counts or trust level. Imports always begin as candidates in the target scope; registered methods require local reevaluation.
- Migration is explicit. Stop the old runtime and back up the entire state directory, then call migrate with matching adapter/instance identity. The main source bytes are additionally saved to before-schema2-rN.json; receipts and old pending reflection tickets are invalidated, session debits are preserved. Old software cannot read schema 2. Restore the pre-upgrade full directory and old package for rollback.
- Reflection has a 60-second deadline in DSH and passes a 60-second request timeout to the Hermes synchronous client. Token and daily-call caps are unchanged. Pausing disables new work and invalidates in-flight result settlement. DSH cancels with AbortSignal; a synchronous Hermes auxiliary client may finish in the background but its obsolete result is discarded.
- Context remains <=768 bytes by default / <=2 whole lessons per turn, <=1536 offered bytes per session. A consumed budget is not refunded after cancellation or failed receipt commit. Compaction does not reset the ledger.
- All state roots remain independent by host/instance. Never repoint a second host at a live store or import a legacy missher-evolution database as protocol-2 state.

## DSH 设置页（只读）

同一个 Bundle 还提供 设置 → 插件 → MSE 详情页里的「学习详情」：浏览器端注册进公开 slot
`plugins.bundle.config`（key 为包名），数据来自只读 Remote 命名空间 `mseDetails`
（`overview`、`sessions`、`lessons`、`lesson`、`recall`、`diagnose`）。它的边界：

- 作用域只由宿主决定：请求里只有一个 session id，目录来自 `sessionQuery.listSessions()`，项目身份来自该会话被校验过的 `header.cwd`；未知或已消失的 id 返回 `session_unknown`。
- 只读且不伪装：不写学习库、不消耗召回额度、不追加模型上下文；库不可读时返回 null 计数与错误码，`diagnose` 把核心的拒绝原样上报。
- 有界：会话目录最多 200 行、经验列表每页最多 50 条、提示词最多 512 字符、诊断/召回明细各 8 条，库本身由核心的 300 行上限约束。
- 前端每个读取资源都有请求序号，离开作用域或组件后旧响应不再落地。

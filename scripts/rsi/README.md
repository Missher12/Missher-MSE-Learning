# scripts/rsi — offline recall comparison (developer-only)

These are developer-only offline tools. The current [automatic runner](./auto-offline.mjs)
compares a candidate with the 0.16.1 production selector. It recommends a candidate only after a
gain on a different control question, and never promotes it into the installed plugin.

```sh
node scripts/rsi/auto-offline.mjs
# Optional on this Mac: automatically rerun when the local offline fixtures change. Ctrl-C stops.
node --watch-path=tests/fixtures scripts/rsi/auto-offline.mjs
```

If `node` is not on PATH on the DSH Mac, use
`"$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"` in its place.

The comparison below describes the historical sort-only replay (`replay.mjs`). Neither tool
reads the live learning library, calls a provider, or changes the installed plugin.

## Historical sort-only candidate

- **baseline**: `recallSelection` from `rebuild/recall.mjs`, unchanged.
- **applicability-first**: call the same `rankForRecall` first (so all existing scope/retirement/
  exclusion filters and relevance scores apply), then stably put rows whose own `applicability`
  matches the task (`appMatch === true`) before rows matched only through body tokens. The same
  `packRecall` then applies the existing 2-entry / 768 UTF-8 byte cap, guard wording and dedupe.

No other candidate, no search loop, no tunable knobs. If the candidate gains, loses or ties, that
is the result; labels and the algorithm are not edited to manufacture a win.

## Commands

```sh
# New comparison tests only (no runtime suite, no provider).
node --test scripts/rsi/replay.test.mjs

# The real comparison report; stdout is the machine-readable result.
node scripts/rsi/replay.mjs

# Keep the existing 24-case replay untouched as an independent baseline check.
node scripts/replay-recall.mjs
```

To archive a run:

```sh
node scripts/rsi/replay.mjs > delivery/rsi-autonomy016/comparison.json
```

The CLI accepts no arbitrary case path and no module/expression argument. It only reads the two
frozen public fixtures below; `--cases` is rejected on purpose.

## Inputs and labels

- `tests/fixtures/recall-cases.json` — the existing 24 hand-labelled regression cases. **Not modified
  by this batch.** The loader marks them `existing_24_regression` and `critical: true` for this
  analysis; their labels themselves are untouched.
- `tests/fixtures/rsi/recall-comparison.json` — small **manual/synthetic** cases added for this
  comparison. Each case records `source: "manual_regression"` or `"synthetic"` and a short
  `labelBasis`. It is not live production data and not a blind test.
- Every case must carry the prompt, scope, environment and complete entries. The runner uses
  `now = 0` (a synthetic fixed clock) so repeated runs are deterministic.
- Labels:
  - `expect.relevant` — ids that should be offered;
  - `expect.excluded` — ids that must not be offered;
  - `expect.guards` — ids that must be offered **with `mode: "guard"`** (not merely present under
    another mode). A method/null/unknown mode is a guard miss and is also reported in
    `guardModeMismatches`; it is not a guard hit.
  - ids that are selected but not in any of these lists are **unknown** and never scored.

An unlabelled case is listed with `labelled: false` and `verdict: "unknown"`. A missing or
unscorable answer is never converted into a pass.

## Output

`comparison.json` is the real CLI output. Every case contains:

- `baseline` / `candidate`: `offered` (`id`, `version`, `mode`), `bytes`, hit/miss/false-offer/
  guard/unknown/over-budget facts, plus `guardModeMismatches`;
- `expected` labels, selection changes (`added`, `removed`, `orderChanged`, `modeChanges`);
- `newMisses`, `newFalseOffers`, `newGuardMisses`, `verdict`, `criticalRegression`.

Aggregates are grouped by source (`existing_24_regression`, `manual_regression`, `synthetic`) and
reported overall. Ratios cover **only the labelled subset**:

- `labelledSubsetPrecision = knownRelevantHits / (knownRelevantHits + explicitFalseOffers)`;
- `labelledPositiveRecall = knownRelevantHits / (knownRelevantHits + knownRelevantMisses)`.

A zero denominator returns `{ "value": null, "reason": ... }`; it never becomes `0` or `100%`.
`unknownSelected` is reported separately. Bytes are reported but never counted as quality.

## Decision

- `no_go` — any critical regression (new critical miss/false offer/guard miss) or any over-budget
  selection. A per-case score can never offset it.
- `offline_signal_only` — no critical regression and the labelled subset has more relevant hits or
  fewer false offers; non-critical regressions are still listed per case.
- `no_measured_gain` — no labelled-subset quality gain. Byte savings and ordering changes alone do
  not count.

`deployAllowed` and `automaticPromotion` are always `false`. This tool never wires itself into the
plugin, never writes the live library and never changes the production strategy. Any future
integration is a separate user-authorized decision.

## Honest limits

- The 24 existing cases are a known regression set, not a blind test; the new cases are small,
  hand-labelled/synthetic, not live business evidence.
- `modelCalls: 0` is a fact about this process; `futureProviderCost` is `"not_evaluated"` — this
  tool does not prove that any candidate saves provider cost.
- Replay only covers the frozen cases; it cannot prove generalisation to unseen language, projects
  or real sessions.
- Requests do not contain a complete historical model answer, so this batch does **not** replay
  correction-extraction decisions or claim save precision/recall for them.

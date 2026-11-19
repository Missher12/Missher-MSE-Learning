# Third party notices

## Google Research RRSI selection structure

`rebuild/adaptive-selection.mjs` adapts the small `judge` and `select_round` decision structure from
Google Research RRSI, commit `be50316e1db05914068a973f322770ef08ed7ba1`:
<https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/selection.py>

Copyright 2026 the rrsi Authors and Google LLC. Licensed under Apache License 2.0; the full license
text is included at `licenses/Apache-2.0.txt`. The module header identifies this adaptation and
summarizes the MSE-specific changes. MSE retains its own real-evidence thresholds, safety checks,
and persisted policy format.

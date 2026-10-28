# 0.12.1 Budget slider — source handoff

## Scope and baseline

- Current released and installed baseline: 0.12.0. 0.12.1 is a source candidate only.
- The accepted starting hashes were `adapters/dsh/client.js` `d072f8495fafd00e2627b6b648e3588353612ddffbb7ac2a4c041268d575fb74` and `tests/details-client.test.mjs` `9aecb43bc6e0d7299dc65abfb77412b9063a3ee16435ec3fbad087bf3bdc47db`.
- The working tree had unrelated existing changes. Those were preserved. No profile/settings write, Git write, model request, build, package, preview, or native UI run was made.
- The user's saved budget remains 50K tokens / 5 tasks per day.

## Implementation

- Replaced the budget preset buttons with a native range input, five aligned ticks, a single localized status line and two equal-width numeric fields. The thumb position interpolates the token allowance across the five stops; custom task counts remain unselected even when their token value lands on a stop.
- Custom pairs remain exact through render, unrelated settings saves and discard. Arrow keys select the strictly lower/higher tier; Home/End select the endpoints. Pointer completion can explicitly select a tier even when the thumb value itself did not change. Selecting a tier updates both draft fields; redundant selections do not edit the draft again.
- The slider and numeric fields are locked during read-only, stale, saving, reloading and credential-write states. The existing draft, Save/Discard and revision-checked mutation path remains in use.
- Bumped `package.json` and the Hermes manifest to 0.12.1. Added bilingual release notes and 0.12.1 status lines. README and VALIDATION were restored from the root's finalized public export; comparison showed only the new 0.12.1 additions. Existing 0.12.0 images and prior accepted sections are preserved. `docs/AUTONOMY_0.12.0.md` was not changed. Added 0.12.1 to the existing Hermes documentation allowlist without changing pack behavior.

## Regression coverage

Added or updated `tests/details-client.test.mjs` coverage for:

- custom 30K/3 interpolation and strict left/right selection;
- custom 50K/2 and 250K/11 values, including Home/End, endpoint behavior, explicit same-value pointer selection and no active preset tick;
- preserving 50K/2 through an unrelated settings save;
- Save/Discard, revision 42 mutation, and read-only/saving locks.

These tests have **not** been run. Wait for the root coordinator's single serial verification window. Suggested focused command:

```sh
node --test --test-name-pattern='budget slider|non-preset budget pairs|ready writable form renders' tests/details-client.test.mjs
```

## Static checks

- `node --check adapters/dsh/client.js` — passed.
- `node --check tests/details-client.test.mjs` — passed.
- `node --check scripts/pack.mjs` — passed.
- `python3 -m json.tool package.json` — passed.
- Scoped `git diff --check` — passed. No trailing whitespace was found in the new release note; obsolete budget-preset CSS/markup selectors were absent.
- Both version metadata fields read 0.12.1. These checks do not verify browser layout, actual pointer/touch behavior, package contents or release/install acceptance.

## Final source hashes

| File | SHA-256 |
| --- | --- |
| `adapters/dsh/client.js` | `d832f083b739e0d8288c131cea41c3e651247298cf25e1822403fc5a7a2dc156` |
| `tests/details-client.test.mjs` | `0ef1dc0fc1b70b5a413f280268d7a39d84c5b3f1664d0f3849c2d28da4f4f1f0` |
| `package.json` | `5e506e9d6d3bda3becbe98cd4837deaec53ebfd78e709f37d0f449ab47d1a625` |
| `adapters/hermes/plugin.yaml` | `380810babe3deb338259f187b3ae78bd2a2d5210ecd63b2616e30c759d4e4b89` |
| `scripts/pack.mjs` | `5e5d8292041490dc886beb26ebcef575eff7538154d3fd8b89de2b2616cc326a` |
| `docs/AUTONOMY_0.12.1.md` | `5cf5755028800894a7a6cd62eecf18adc64427e55fe07a03e286d072f11914a6` |
| `README.md` | `c10e80e40cd11fdd7258d994ed5caa4507b110b12b5733a8f7bfd2795fbd0569` |
| `README.en.md` | `b3eae9662b39b2163570e8a72b3cf6522c658157df6209b42ef65ea58ef6b374` |
| `VALIDATION.md` | `be16152e2b4aac8c833b619763f2efaad39bd1c31bf249477b6a64cf28ee0d81` |
| `HANDOVER.md` | `9a3be2f0bda2971c2fbb69a80364b012cc11bf7d25c18f2d240182abebb0bb3f` |

Root owns Git/freeze; Desktop owns formal release and installation. This file is local handoff material, not a release claim.

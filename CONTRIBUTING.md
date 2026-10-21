# Contributing to Krypt Studio

Thanks for helping. Krypt Studio is MIT-licensed and has to stay that way, so a few rules are stricter than in most projects. Please read all of this before your first pull request.

## The short version

1. Sign off every commit (DCO).
2. Never copy code from GPL, AGPL, LGPL or proprietary projects, and never from FL Studio or any closed DAW.
3. Add only permissively licensed dependencies; `npm run license:check` must pass.
4. If an AI tool wrote part of your change, you reviewed it and you understand it.
5. `npm run typecheck`, `npm test` and `cargo test --manifest-path engine/Cargo.toml` pass.

## Developer Certificate of Origin (DCO)

Every commit must carry a `Signed-off-by` line with your real name and an email you can be reached at:

```
git commit -s -m "Fix the clap tail in the factory kit"
```

By signing off you certify the [Developer Certificate of Origin 1.1](https://developercertificate.org/): that you wrote the change or otherwise have the right to submit it under the project's MIT licence. Pull requests with unsigned commits can't be merged; `git rebase --signoff main` fixes a branch.

## What your sign-off also attests

When you open a pull request you confirm that:

- **No copied code.** You have not copied, transcribed or closely paraphrased code from GPL, AGPL, LGPL or proprietary projects. That includes LMMS, Ardour, Zrythm, Surge, Vital, Dexed, openDAW, Tracktion, JUCE, PyFLP, VeSTige and the GPL builds of the ASIO SDK. Studying how they behave is fine. Transcribing them is not.
- **No GPL dependencies.** You have not added a dependency under GPL, AGPL, LGPL, SSPL or a non-commercial licence. MIT, Apache-2.0, BSD, ISC, Zlib, Unlicense and CC0 are fine. MPL-2.0 is acceptable only unmodified and must be listed in `THIRD-PARTY-NOTICES.md`; ask first.
- **AI-generated code was reviewed and is understood.** You may use AI assistants. You are responsible for every line: you have read it, you understand what it does, and you have checked that it isn't reproducing someone else's licensed code.

## Clean-room rules for "works like FL Studio" features

Krypt Studio copies the *workflow* of pattern-based DAWs, never their code, assets or look. Functionality and file formats aren't protected; code, graphics, icons, sounds, presets, demo songs and manual text are.

- Write behavioural specs in your own words from public sources: the manual read for understanding, videos, hands-on use. Don't paste Image-Line text or screenshots into the repo.
- Don't decompile, disassemble or patch FL Studio or any other closed DAW. Don't use leaked material.
- Don't use Image-Line names or trade dress: no "Fruity", "FL", Sytrus, Harmor, Gross Beat, Edison, FPC and so on, and none of their logos, skins, icons, colours, sounds or presets. Our stock plugins are `krypt.*` and named "Krypt <Thing>".
- Format work (for example `.flp` import) uses two people: one reads and writes the spec, the other implements from the spec only. The spec and observation log live in `docs/formats/`. Test fixtures are projects we made ourselves.
- When you port an algorithm, implement it from the paper or specification and cite it (see `engine/crates/dsp/THIRD-PARTY.md`), not from a GPL implementation.
- All audio, presets, icons and fonts must be original or CC0/OFL, with their provenance recorded. The factory kit is synthesized by our own DSP for exactly this reason.

## Dependencies

- `npm run license:check` checks every shipped npm package and every Rust crate in the engine workspace against the allowlist in `scripts/lib/deps.mjs`. CI runs it on every pull request.
- After adding, removing or upgrading a dependency, run `npm run notices` and commit the regenerated `THIRD-PARTY-NOTICES.md`. CI fails if it's stale.
- Prefer small, maintained, permissive crates and packages. Never add a `postinstall` that compiles native code; `npm install` must not need a C++ or Rust toolchain.

## Code rules

The full list is in [CLAUDE.md](CLAUDE.md) and the house guide. The ones that bite most often:

- **Every mutation is a command** in `shared/commands/` with zod-validated arguments. The UI, MCP tools and the built-in agent all use it. Commands do no I/O and throw `CommandError` with a human-readable message.
- **No silent failures.** Every user action ends in visible feedback (a toast) and every IPC call returns `{ ok, message }`.
- **The renderer never imports `electron/**`.** OS access lives in `electron/system/*`. IPC channels are registered in `electron/ipc.ts` only.
- **Audio thread rules (Rust):** no allocation, no locks, no I/O in the callback. `assert_no_alloc` guards it in debug builds.
- **Schema changes** need a migration in `electron/project/migrations.ts` and a test.
- **Krypt UI kit:** Chakra Petch, `bg-krypt-void`, hairline `border-white/10`, the indigo-to-pink gradient as an accent only, `lucide-react` icons only.

## Before you open a pull request

```powershell
npm run typecheck
npm test
cargo test --manifest-path engine/Cargo.toml
npm run license:check
```

Run cargo from the repository root so `.cargo/config.toml` (static CRT) applies. For UI changes, include a screenshot or a short clip. For DSP changes, include before/after numbers from `krypt-studio-engine --render ... --analyze` where it makes sense.

## Reporting security issues

Don't open a public issue for a vulnerability (for example a way for an MCP client to escape the project's folders, or to reach the app from another machine). Report it privately on [Discord](https://discord.gg/muzFKR657F) to the Krypt team, or by email to hi@krypt.cc.

## Licence of contributions

Contributions are accepted under the MIT licence of this repository (inbound = outbound). The Krypt name and logo are not part of that grant; see [TRADEMARKS.md](TRADEMARKS.md).

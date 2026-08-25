# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0]

### Added

- **Cursor CLI 2026.08 compatibility**: `--stream-partial-output` for token-level streaming (duplicate buffered flushes are skipped), `--force` so print mode applies edits, and `--approve-mcps`.
- **Image input**: Pi image blocks are written to temp files and passed as paths the CLI can read.
- **Model families**: `agent models` variants (effort / thinking / fast) are grouped into one Pi model per family. Reasoning level selects the matching CLI id. Fallback list updated for CLI `2026.08.11`.
- **MCP `function` tool calls**: generic `tool_call.function` events are shown by name.

### Fixed

- **Linux `E2BIG`**: the print prompt is delivered on stdin instead of argv, so long sessions and Pi auto-compaction no longer fail at `MAX_ARG_STRLEN` (131072).
- **Pi 0.77+ `No API key found for cursor`**: `registerProvider` uses a literal placeholder `apiKey` so models appear after `agent login` without exporting `CURSOR_API_KEY`.

### Changed

- Default print invocation includes `--force`. Set `CURSOR_AGENT_FORCE=0` to opt out.
- Published as `@jiah-liu/pi-cursor-provider` (fork of `@netandreus/pi-cursor-provider`).
- **Display**: Cursor tool calls render as Pi thinking traces (not inline `⏳` lines in the answer). Assistant text is split around tools. Snapshot assistant events are de-duplicated into deltas.

## [0.1.2]

### Added

- **Duration and TTFT**: Assistant messages now include optional `duration` (total turn time) and `ttft` (time to first token) for display or logging.
- **Canonical model ID mapping**: You can select models by canonical IDs (e.g. `claude-sonnet-4-5`). When Pi provides a reasoning/thinking level, the provider resolves to the correct CLI model (e.g. thinking variant). Unmapped model IDs continue to work as before.
- **README model reference table**: Documented available models in a single table (Canonical ID, CLI model ID, Name, Reasoning) and noted that canonical IDs can use the thinking variant when reasoning is enabled.
- **Tooling**: `npm run lint` (Biome check), `npm run format` (Biome check --write), and `npm run typecheck` (TypeScript noEmit). Added `biome.json` and `tsconfig.json`.

## [0.1.1]

Small fixes.

## [0.1.0]

Initial release with Cursor Agent CLI provider, dynamic model discovery, and auth commands.
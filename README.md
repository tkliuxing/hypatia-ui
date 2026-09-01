# Hypatia Archive

A local web console for safely reviewing and cleaning Hypatia knowledge shelves.

## Run with npx

Install [Hypatia](https://github.com/MarchLiu/hypatia) first, then run:

```bash
npx --yes hypatia-archive
```

The command starts a server bound only to `127.0.0.1:4174` and opens `http://127.0.0.1:4174` in the default browser. Stop it with `Ctrl+C` when finished.

Use a different port or start without opening a browser when needed:

```bash
npx --yes hypatia-archive --port 5050
npx --yes hypatia-archive --no-open
```

`hypatia` must be available on `PATH`. To use a different executable, set `HYPATIA_BIN` to its absolute path before running the command.

## What It Does

- Lists registered Hypatia shelves and works with the selected connected shelf.
- Searches knowledge with Hypatia's JSE full-text query, then filters locally by tag and scope.
- Opens the complete knowledge record with its direct incoming and outgoing statements.
- Maps a focused local neighborhood in the Graph workspace, including statement references whose knowledge record has been deleted.
- Lets users inspect nodes and directed relationships, expand a node's immediate relations, and refocus the map with the toolbar control or a double-click/tap.
- Adds each graph focus change to browser history, so Back and Forward restore the previously focused node.
- Renders Markdown knowledge content with headings, links, code, lists, quotes, and images while skipping raw HTML.
- Previews deletion impact before every deletion.
- Requires typing the exact knowledge name before deletion.
- Offers an explicit choice to retain related statements or delete them with the knowledge entry.

Hypatia's native `knowledge-delete` command does not cascade to statements. The console preserves that behavior by default and only removes related statements when the destructive option is checked.

## Explore Relationships

Open **Graph** from a selected record or switch to the Graph workspace. The view begins with one focused knowledge entity and its direct incoming and outgoing statements, rather than loading the complete shelf. Select a node to inspect it, then use **Focus map** or double-click/tap a node to make it the next local map center. Browser Back and Forward move between those focus states.

The graph limits each direct direction to 60 relationships and caps the visible workspace at 90 nodes or 160 edges. A dangling reference node remains visible when a statement still refers to a deleted knowledge record, matching the default non-cascading deletion behavior.

## Read Formatted Content

Knowledge records whose stored format is `markdown` or `md` are rendered with `react-markdown`. Standard Markdown is displayed as formatted content in both the record inspector and graph inspector. Raw HTML is skipped rather than inserted into the page.

## Requirements

- Node.js 22 or later
- Hypatia installed and available on `PATH`, or `HYPATIA_BIN` set to the absolute executable path

The server only binds to `127.0.0.1`. It invokes Hypatia through `spawn` with argv arrays, not a shell command string. Calls are serialized because Hypatia's DuckDB shelf file allows one CLI process at a time.

## Develop From Source

```bash
pnpm install
pnpm dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The Vite development server proxies API requests to the local service at port `4174`.

To build and run the packaged production application locally:

```bash
pnpm build
pnpm start
```

The production command opens [http://127.0.0.1:4174](http://127.0.0.1:4174). Add `-- --no-open` to keep it from opening a browser.

## Validation

```bash
pnpm test
pnpm typecheck
pnpm build
npm pack --dry-run
```

## License

[MIT](LICENSE) Copyright (c) 2026 tkliuxing.

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
- Searches knowledge in two modes. **Keyword** asks Hypatia's JSE full-text query and then filters locally by tag and scope. **Semantic** runs `hypatia similar` against the shelf's embedding model, skips the operational layer (entries tagged `message`, `session`, `summary`, `hypatia-dream-run`, or `system`), and shows each hit's cosine distance instead of a page cursor. A shelf without an embedding model explains that instead of failing the request.
- Suggests tags while you type, read with `hypatia tag list` and capped at 50 matching values; the box still accepts any tag typed by hand.
- Marks entries the shelf keeps out of the vector index (`content.embed` is false) with a **not embedded** badge. Keyword search still finds them.
- The scope filter offers every scope the shelf uses, read with `hypatia scope list`. Both rosters arrived with Hypatia 4.1.0 and are detected at run time from the command's refusal, not from `--version`, so an older CLI falls back to the scopes on the loaded page and a free-text tag box. The rosters count statements too, so a scope that only statements carry is offered and filters the record list to nothing.
- Opens the complete knowledge record with its direct incoming and outgoing statements.
- Maps a focused local neighborhood in the Graph workspace, including statement references whose knowledge record has been deleted.
- Lets users inspect nodes and directed relationships, expand a node's immediate relations, and refocus the map with the toolbar control or a double-click/tap.
- Adds each graph focus change to browser history, so Back and Forward restore the previously focused node.
- Renders Markdown knowledge content with headings, links, code, lists, quotes, and images while skipping raw HTML.
- Previews deletion impact before every deletion.
- Requires typing the exact knowledge name before deletion.
- Offers an explicit choice to retain related statements or delete them with the knowledge entry.
- Selects several records with the checkbox column, including a select-all for the page on screen, and deletes them in one confirmed batch of up to 50.

Hypatia's native `knowledge-delete` command does not cascade to statements. The console preserves that behavior by default and only removes related statements when the destructive option is checked.

## Delete Several Records

Check the records to remove, then use **Delete selected**. The dialog lists every entry that will go, keeps the same opt-in choice about related statements, and asks for the number of selected records to be typed back — the count plays the part the record name plays for a single deletion, and the server re-checks it, so a caller that skips the dialog is refused the same way.

A batch is not a transaction. Hypatia has no multi-record write, so the records are removed one at a time behind a single mutation slot; a record that is already gone or whose removal fails is reported and stepped over rather than abandoning the records behind it, and records already removed are not rolled back. The result message names how many were deleted, how many were already gone, how many failed, and how many statements were removed or retained.

Selection belongs to the page on screen. Paging, filtering, refreshing, or switching shelves clears it, so nothing invisible is ever included in a deletion.

## Explore Relationships

Open **Graph** from a selected record or switch to the Graph workspace. The view begins with one focused knowledge entity and its direct incoming and outgoing statements, rather than loading the complete shelf. Select a node to inspect it, then use **Focus map** or double-click/tap a node to make it the next local map center. Browser Back and Forward move between those focus states.

The graph limits each direct direction to 60 relationships and caps the visible workspace at 90 nodes or 160 edges. A dangling reference node remains visible when a statement still refers to a deleted knowledge record, matching the default non-cascading deletion behavior.

## Read Formatted Content

Knowledge records whose stored format is `markdown` or `md` are rendered with `react-markdown`. Standard Markdown is displayed as formatted content in both the record inspector and graph inspector. Raw HTML is skipped rather than inserted into the page.

## Hypatia Compatibility

Hypatia Archive `0.2.0` is validated with [Hypatia 4.1.1](https://github.com/MarchLiu/hypatia). The version was checked against the running CLI rather than the README: `--version`, `list`, the JSE query shapes this server builds, `search`, `scope list --json`, `tag list --json`, `knowledge-get`, `similar`, and both delete commands were exercised on a real shelf, including the not-found behavior (`knowledge-get` prints `Knowledge 'x' not found.` and exits 0; the delete commands exit 1).

Hypatia 4.1.0 added the `scope list` and `tag list` subcommands, the `similar --tags/--exclude-tags/--where` filters, `knowledge-update`, and the optional `content.embed` flag; the console detects each capability at run time and degrades instead of failing. Hypatia 4.1.1 changed no CLI surface. Statements still come back as `head`, `relation`, and `tail` — normalized for the record inspector and Graph workspace — and the earlier `subject`, `predicate`, `object` shape remains supported for older shelves. `knowledge-delete` still does not cascade to statements, which is why the console keeps the retain-by-default choice.

One thing the console deliberately does not do is push the tag and scope filters into the JSE query. In 4.1.1 `$contains` matches a tag exactly and case-sensitively, so it is not the substring rule the filter uses, and `$search` cannot be combined with `$contains` in one operand (it returns no rows, and wrapping both in `$and` errors with `$search is not a SQL condition`).

## Requirements

- Node.js 22 or later
- Hypatia installed and available on `PATH`, or `HYPATIA_BIN` set to the absolute executable path

The server only binds to `127.0.0.1`. It invokes Hypatia through `spawn` with argv arrays, not a shell command string. Calls are queued rather than run in parallel. Hypatia's shelf store is safe for concurrent processes — SQLite runs WAL with a five-second busy timeout and PostgreSQL serializes on its own — so the queue is not a correctness requirement: it exists because each command opens with schema setup and an embedding-debt flush, both of which take a brief write lock, and a cold semantic search loads an embedding model the next call would reload.

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

The default suite uses fake CLI binaries, so it cannot notice the installed Hypatia changing shape. To check the real one, run the contract tests in `tests/live-cli.test.ts` (they never create or delete a record):

```bash
HYPATIA_LIVE=1 pnpm test
```

They are skipped otherwise, so CI needs no Hypatia install. `HYPATIA_LIVE_SHELF` names a shelf other than `default`.

## License

[MIT](LICENSE) Copyright (c) 2026 tkliuxing.

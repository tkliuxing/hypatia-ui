import { lazy, Suspense, type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Database,
  ListChecks,
  FileSearch,
  LoaderCircle,
  Network,
  RefreshCw,
  Search,
  Tags,
  Trash2,
  X
} from "lucide-react";
import { ContentRenderer } from "./ContentRenderer";
import {
  deleteKnowledge,
  deleteKnowledgeBatch,
  getImpact,
  getKnowledgePage,
  getScopes,
  getShelves,
  type Impact,
  type Knowledge,
  type Relationship,
  type Shelf
} from "./api";
import { GLOBAL_SCOPE_TOKEN, scopeOptions, type ScopeRoster } from "./scopeOptions";

const GraphView = lazy(() => import("./GraphView").then(({ GraphView: Component }) => ({ default: Component })));

type Notice = { tone: "success" | "error"; text: string } | null;
type WorkspaceView = "records" | "graph";

function initialSearchParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

function workspaceLocation(): { view: WorkspaceView; shelf: string; focus: string | null } {
  return {
    view: initialSearchParam("view") === "graph" ? "graph" : "records",
    shelf: initialSearchParam("shelf") || "default",
    focus: initialSearchParam("focus")
  };
}

function updateWorkspaceAddress(view: WorkspaceView, shelf: string, focus: string | null, mode: "replace" | "push" = "replace"): void {
  const params = new URLSearchParams(window.location.search);
  params.set("view", view);
  params.set("shelf", shelf);
  if (focus) params.set("focus", focus);
  else params.delete("focus");
  const query = params.toString();
  const url = window.location.pathname + (query ? "?" + query : "");
  if (mode === "push") window.history.pushState(null, "", url);
  else window.history.replaceState(null, "", url);
}

function dateLabel(value: string): string {
  return value ? value.replace("T", " ").slice(0, 16) : "Unknown date";
}

function excerpt(value: string, maximum = 180): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maximum ? compact.slice(0, maximum) + "..." : compact || "No content";
}

function scopeLabel(scope: string): string {
  return scope === "" ? "global" : scope;
}

function directionLabel(relationship: Relationship): string {
  if (relationship.direction === "outgoing") return relationship.predicate + " -> " + relationship.object;
  if (relationship.direction === "incoming") return relationship.subject + " -> " + relationship.predicate;
  return relationship.subject + " <-> " + relationship.object;
}

export function App() {
  const [shelves, setShelves] = useState<Shelf[]>([]);
  const [shelf, setShelf] = useState(() => initialSearchParam("shelf") || "default");
  const [view, setView] = useState<WorkspaceView>(() => initialSearchParam("view") === "graph" ? "graph" : "records");
  const [queryInput, setQueryInput] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [scopeInput, setScopeInput] = useState("");
  const [filters, setFilters] = useState({ q: "", tag: "", scope: "" });
  const [scopeRoster, setScopeRoster] = useState<ScopeRoster | null>(null);
  const [items, setItems] = useState<Knowledge[]>([]);
  const [currentCursor, setCurrentCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([]);
  const [pageNumber, setPageNumber] = useState(1);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [selectedName, setSelectedName] = useState<string | null>(() => initialSearchParam("focus"));
  const [impact, setImpact] = useState<Impact | null>(null);
  const [impactLoading, setImpactLoading] = useState(false);
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  const [deleteTarget, setDeleteTarget] = useState<Impact | null>(null);
  const [deleteRelations, setDeleteRelations] = useState(false);
  const [acknowledgedName, setAcknowledgedName] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [batchTarget, setBatchTarget] = useState<string[] | null>(null);
  const [batchRelations, setBatchRelations] = useState(false);
  const [acknowledgedCount, setAcknowledgedCount] = useState("");
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const inspectRequest = useRef(0);
  const listRequest = useRef(0);
  const listController = useRef<AbortController | null>(null);
  const scopesController = useRef<AbortController | null>(null);
  const listPanelRef = useRef<HTMLDivElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);

  const loadKnowledgePage = useCallback(async (
    cursor: string | null,
    nextHistory: Array<string | null>,
    nextPageNumber: number
  ) => {
    listController.current?.abort();
    const controller = new AbortController();
    const requestId = ++listRequest.current;
    listController.current = controller;
    setListLoading(true);
    setListError("");
    setItems([]);
    setSelection(new Set());
    setCurrentCursor(cursor);
    setNextCursor(null);
    setCursorHistory(nextHistory);
    setPageNumber(nextPageNumber);
    listPanelRef.current?.scrollTo({ top: 0, behavior: "auto" });
    try {
      const page = await getKnowledgePage({ shelf, ...filters, cursor: cursor || undefined, limit: 50, signal: controller.signal });
      if (requestId !== listRequest.current) return;
      setItems(page.items);
      setCurrentCursor(cursor);
      setNextCursor(page.nextCursor);
      setCursorHistory(nextHistory);
      setPageNumber(nextPageNumber);
    } catch (error) {
      if (controller.signal.aborted || requestId !== listRequest.current) return;
      setListError(error instanceof Error ? error.message : "Unable to load knowledge.");
      setItems([]);
      setNextCursor(null);
    } finally {
      if (requestId === listRequest.current) setListLoading(false);
    }
  }, [filters, shelf]);

  const refreshKnowledge = useCallback(() => loadKnowledgePage(null, [], 1), [loadKnowledgePage]);

  const loadScopes = useCallback(async () => {
    scopesController.current?.abort();
    const controller = new AbortController();
    scopesController.current = controller;
    try {
      const roster = await getScopes(shelf, controller.signal);
      if (!controller.signal.aborted) setScopeRoster({ shelf, scopes: roster.supported ? roster.scopes : null });
    } catch {
      // No notice: without the roster the options fall back to the page.
      if (!controller.signal.aborted) setScopeRoster({ shelf, scopes: null });
    }
  }, [shelf]);

  // The page first: the host runs one CLI call at a time, and the roster scan
  // should not hold up the rows.
  const reload = useCallback(async () => {
    const page = refreshKnowledge();
    void loadScopes();
    await page;
  }, [loadScopes, refreshKnowledge]);

  const previousPage = useCallback(() => {
    if (listLoading || cursorHistory.length === 0) return;
    const previousCursor = cursorHistory.at(-1) || null;
    void loadKnowledgePage(previousCursor, cursorHistory.slice(0, -1), pageNumber - 1);
  }, [cursorHistory, listLoading, loadKnowledgePage, pageNumber]);

  const nextPage = useCallback(() => {
    if (listLoading || !nextCursor) return;
    void loadKnowledgePage(nextCursor, [...cursorHistory, currentCursor], pageNumber + 1);
  }, [currentCursor, cursorHistory, listLoading, loadKnowledgePage, nextCursor, pageNumber]);

  useEffect(() => {
    let active = true;
    void getShelves()
      .then(({ shelves: nextShelves }) => {
        if (!active) return;
        setShelves(nextShelves);
        const requestedShelf = initialSearchParam("shelf");
        const preferred = (requestedShelf ? nextShelves.find((entry) => entry.name === requestedShelf && entry.connected) : undefined)
          || nextShelves.find((entry) => entry.name === "default" && entry.connected)
          || nextShelves.find((entry) => entry.connected);
        if (preferred) setShelf(preferred.name);
      })
      .catch((error: unknown) => {
        if (active) setListError(error instanceof Error ? error.message : "Unable to load shelves.");
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    void refreshKnowledge();
  }, [refreshKnowledge]);

  // The roster covers the whole shelf, so it follows the shelf, not the page.
  useEffect(() => {
    void loadScopes();
  }, [loadScopes]);

  useEffect(() => () => {
    listController.current?.abort();
    scopesController.current?.abort();
  }, []);

  useEffect(() => {
    function restoreWorkspaceFromHistory() {
      const location = workspaceLocation();
      inspectRequest.current += 1;
      setView(location.view);
      setShelf(location.shelf);
      setSelection(new Set());
      setSelectedName(location.focus);
      setImpact(null);
      setImpactLoading(false);
      setNotice(null);
    }

    window.addEventListener("popstate", restoreWorkspaceFromHistory);
    return () => window.removeEventListener("popstate", restoreWorkspaceFromHistory);
  }, []);

  const availableScopes = useMemo(
    () => scopeOptions(scopeRoster, shelf, items, scopeInput),
    [items, scopeInput, scopeRoster, shelf]
  );

  // Read in page order and filtered through the rows on screen, so a name the
  // page no longer carries cannot reach the delete request.
  const selectedNames = useMemo(
    () => items.filter((item) => selection.has(item.name)).map((item) => item.name),
    [items, selection]
  );
  const allSelected = items.length > 0 && selectedNames.length === items.length;

  function toggleRow(name: string) {
    setSelection((current) => {
      const next = new Set(current);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  }

  function toggleAllRows() {
    setSelection((current) => current.size === items.length && items.length > 0 ? new Set() : new Set(items.map((item) => item.name)));
  }

  const openImpact = useCallback(async (name: string) => {
    setSelectedName(name);
    setImpactLoading(true);
    setNotice(null);
    const requestId = ++inspectRequest.current;
    try {
      const nextImpact = await getImpact(shelf, name);
      if (requestId === inspectRequest.current) {
        setImpact(nextImpact);
        if (window.matchMedia("(max-width: 1100px)").matches) {
          requestAnimationFrame(() => inspectorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
        }
      }
    } catch (error) {
      if (requestId === inspectRequest.current) {
        setImpact(null);
        setNotice({ tone: "error", text: error instanceof Error ? error.message : "Unable to inspect this entry." });
      }
    } finally {
      if (requestId === inspectRequest.current) setImpactLoading(false);
    }
  }, [shelf]);

  function switchWorkspace(nextView: WorkspaceView) {
    setView(nextView);
    updateWorkspaceAddress(nextView, shelf, selectedName);
  }

  function openGraph(name: string) {
    const isNewFocus = view !== "graph" || selectedName !== name;
    setSelectedName(name);
    setImpact(null);
    setView("graph");
    updateWorkspaceAddress("graph", shelf, name, isNewFocus ? "push" : "replace");
  }

  function selectShelf(name: string) {
    setShelf(name);
    setSelection(new Set());
    setSelectedName(null);
    setImpact(null);
    updateWorkspaceAddress(view, name, null);
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSelectedName(null);
    setImpact(null);
    setFilters({ q: queryInput.trim(), tag: tagInput.trim(), scope: scopeInput });
  }

  function resetSearch() {
    setQueryInput("");
    setTagInput("");
    setScopeInput("");
    setFilters({ q: "", tag: "", scope: "" });
    setSelectedName(null);
    setImpact(null);
  }

  function openDelete() {
    if (!impact) return;
    setDeleteTarget(impact);
    setDeleteRelations(false);
    setAcknowledgedName("");
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const result = await deleteKnowledge(shelf, deleteTarget.knowledge.name, deleteRelations, acknowledgedName);
      setDeleteTarget(null);
      setSelectedName(null);
      setImpact(null);
      const text = result.deletedRelations > 0
        ? "Deleted " + result.name + " and " + result.deletedRelations + " related statement(s)."
        : "Deleted " + result.name + ". " + result.retainedRelations + " related statement(s) remain.";
      setNotice({ tone: "success", text });
      await reload();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Delete operation failed." });
    } finally {
      setDeleting(false);
    }
  }

  function openBatchDelete() {
    if (selectedNames.length === 0) return;
    setBatchTarget(selectedNames);
    setBatchRelations(false);
    setAcknowledgedCount("");
  }

  async function confirmBatchDelete() {
    if (!batchTarget) return;
    setBatchDeleting(true);
    try {
      const result = await deleteKnowledgeBatch(shelf, batchTarget, batchRelations, batchTarget.length);
      setBatchTarget(null);
      setSelectedName(null);
      setImpact(null);
      // A batch that ran is reported even when parts of it did not: the counts
      // are what happened, and a failure makes the notice an error one.
      const summary = "Deleted " + result.deletedCount + " record(s): " + result.deletedRelations
        + " statement(s) removed, " + result.retainedRelations + " retained.";
      const issues = result.missingCount + result.failedCount > 0
        ? " " + result.missingCount + " were already gone and " + result.failedCount + " failed."
        : "";
      setNotice({ tone: result.failedCount > 0 ? "error" : "success", text: summary + issues });
      await reload();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Bulk delete failed." });
    } finally {
      setBatchDeleting(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Shelf navigation">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true"><Database size={18} /></span>
          <div>
            <p className="eyebrow">LOCAL KNOWLEDGE</p>
            <h1>Hypatia Archive</h1>
          </div>
        </div>

        <div className="sidebar-section">
          <div className="section-kicker"><span>Shelves</span><span>{shelves.filter((entry) => entry.connected).length}</span></div>
          <div className="shelf-list">
            {shelves.length === 0 ? <p className="sidebar-empty">No connected shelves</p> : shelves.map((entry) => (
              <button
                key={entry.name}
                className={"shelf-button " + (entry.name === shelf ? "is-active" : "")}
                type="button"
                disabled={!entry.connected}
                onClick={() => selectShelf(entry.name)}
              >
                <span className="shelf-indicator" aria-hidden="true" />
                <span className="shelf-name">{entry.name}</span>
                <span className="shelf-state">{entry.connected ? "live" : "offline"}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="sidebar-foot"><Network size={16} aria-hidden="true" /><span>CLI bridge active</span></div>
      </aside>

      <main className="workspace">
        <header className="workspace-header">
          <div><p className="eyebrow">SHELF / {shelf}</p><h2>Knowledge maintenance</h2></div>
          <div className="workspace-actions">
            <div className="view-switch" role="tablist" aria-label="Workspace view">
              <button className={"view-tab " + (view === "records" ? "is-active" : "")} type="button" role="tab" aria-selected={view === "records"} onClick={() => switchWorkspace("records")}>Records</button>
              <button className={"view-tab " + (view === "graph" ? "is-active" : "")} type="button" role="tab" aria-selected={view === "graph"} onClick={() => switchWorkspace("graph")}><Network size={15} /> Graph</button>
            </div>
            <button className="icon-button" type="button" title="Refresh knowledge" aria-label="Refresh knowledge" onClick={() => void reload()} disabled={listLoading}>
              <RefreshCw size={18} className={listLoading ? "spin" : ""} />
            </button>
          </div>
        </header>

        <section className="search-band" aria-label="Knowledge search">
          <form onSubmit={submitSearch}>
            <label className="search-field">
              <Search size={19} aria-hidden="true" />
              <input value={queryInput} onChange={(event) => setQueryInput(event.target.value)} placeholder="Search names, content, tags, and synonyms" aria-label="Search knowledge" />
            </label>
            <label className="compact-field"><span>Tag</span><input value={tagInput} onChange={(event) => setTagInput(event.target.value)} placeholder="Any tag" /></label>
            <label className="compact-field">
              <span>Scope</span>
              <select value={scopeInput} onChange={(event) => setScopeInput(event.target.value)}>
                <option value="">Any scope</option>
                {availableScopes.hasGlobal ? <option value={GLOBAL_SCOPE_TOKEN}>global</option> : null}
                {availableScopes.values.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <button className="command-button" type="submit"><Search size={16} /> Search</button>
            <button className="text-button" type="button" onClick={resetSearch}>Reset</button>
          </form>
          <div className="result-summary">
            <span>{listLoading && items.length === 0 ? "Loading page" : "Page " + pageNumber}</span>
            <div className="page-controls" aria-label="Knowledge page navigation">
              <span className="page-count" aria-live="polite">{items.length + " records"}</span>
              <button className="icon-button pager-button" type="button" title="Previous page" aria-label="Previous page" onClick={previousPage} disabled={listLoading || cursorHistory.length === 0}><ChevronLeft size={17} /></button>
              <button className="icon-button pager-button" type="button" title="Next page" aria-label="Next page" onClick={nextPage} disabled={listLoading || !nextCursor}><ChevronRight size={17} /></button>
            </div>
          </div>
        </section>

        {notice ? <div className={"notice notice-" + notice.tone} role="status"><span>{notice.text}</span><button type="button" className="notice-close" onClick={() => setNotice(null)} aria-label="Dismiss message"><X size={15} /></button></div> : null}

        {view === "records" && selectedNames.length > 0 ? (
          <div className="selection-bar" role="group" aria-label="Selected records">
            <span className="selection-count"><ListChecks size={15} /> {selectedNames.length} selected</span>
            <button type="button" className="text-button" onClick={() => setSelection(new Set())}>Clear selection</button>
            <button type="button" className="danger-button" onClick={openBatchDelete}><Trash2 size={16} /> Delete selected</button>
          </div>
        ) : null}

        {view === "records" ? <section className="content-grid">
          <div ref={listPanelRef} className="knowledge-panel">
            <div className="table-head">
              <label className="row-select">
                <input
                  type="checkbox"
                  checked={allSelected}
                  disabled={items.length === 0}
                  ref={(node) => { if (node) node.indeterminate = selectedNames.length > 0 && !allSelected; }}
                  onChange={toggleAllRows}
                  aria-label="Select every record on this page"
                  title="Select every record on this page"
                />
              </label>
              <span className="table-head-cells"><span>Entry</span><span>Context</span><span>Created</span></span>
            </div>
            {listError && items.length === 0 ? <div className="blank-state error-state"><FileSearch size={24} /><p>{listError}</p></div> : null}
            {!listError && listLoading && items.length === 0 ? <div className="blank-state"><LoaderCircle size={26} className="spin" /><p>Loading knowledge records</p></div> : null}
            {!listError && !listLoading && items.length === 0 ? <div className="blank-state"><FileSearch size={26} /><p>No knowledge matches this view</p></div> : null}
            {items.map((item) => (
              <div
                key={item.name}
                className={"knowledge-row-wrap " + (selectedName === item.name ? "is-selected " : "") + (selection.has(item.name) ? "is-checked" : "")}
              >
                <label className="row-select">
                  <input
                    type="checkbox"
                    checked={selection.has(item.name)}
                    onChange={() => toggleRow(item.name)}
                    aria-label={"Select " + item.name}
                  />
                </label>
                <button type="button" className="knowledge-row" onClick={() => void openImpact(item.name)}>
                  <span className="knowledge-primary"><strong>{item.name}</strong><small>{excerpt(item.content.data)}</small></span>
                  <span className="row-context">
                    <span className="tag-list">{item.content.tags.slice(0, 3).map((tag) => <em key={tag}>{tag}</em>)}</span>
                    <span className="scope-list">{item.content.scopes.slice(0, 2).map((itemScope) => <i key={itemScope || "global"}>{scopeLabel(itemScope)}</i>)}</span>
                  </span>
                  <time dateTime={item.createdAt}>{dateLabel(item.createdAt)}</time>
                </button>
              </div>
            ))}
            {listError && items.length > 0 ? <p className="list-inline-error error-state">{listError}</p> : null}
          </div>

          <aside ref={inspectorRef} className="inspector" aria-label="Knowledge inspector">
            {impactLoading ? <div className="inspector-loading"><LoaderCircle className="spin" size={25} /><span>Reading entry and relations</span></div> : null}
            {!impactLoading && !impact ? <div className="inspector-empty"><Network size={30} /><h3>Inspect the graph</h3><p>Select a knowledge entry to read its full content and check every direct relationship before cleaning it.</p></div> : null}
            {!impactLoading && impact ? <Inspector impact={impact} onDelete={openDelete} onOpenGraph={() => openGraph(impact.knowledge.name)} /> : null}
          </aside>
        </section> : <Suspense fallback={<section className="graph-loading"><LoaderCircle size={26} className="spin" /><span>Loading graph workspace</span></section>}><GraphView shelf={shelf} initialNodeName={selectedName || items[0]?.name || null} onFocusChange={openGraph} /></Suspense>}
      </main>

      {batchTarget ? (
        <div className="modal-backdrop" role="presentation">
          <section className="delete-dialog" role="dialog" aria-modal="true" aria-labelledby="batch-delete-title">
            <header>
              <div><p className="eyebrow">DESTRUCTIVE BULK ACTION</p><h2 id="batch-delete-title">Delete selected entries</h2></div>
              <button type="button" className="icon-button" onClick={() => setBatchTarget(null)} aria-label="Close bulk delete dialog" title="Close"><X size={18} /></button>
            </header>
            <p className="delete-copy">This removes the <strong>{batchTarget.length}</strong> selected entries from the selected shelf, one at a time. A batch is not a transaction: an entry that fails is skipped and reported, and entries already removed are not rolled back.</p>
            <div className="impact-count"><ListChecks size={17} /><span>Entries to delete</span></div>
            <ul className="name-list">{batchTarget.map((name) => <li key={name}>{name}</li>)}</ul>
            <label className="check-line"><input type="checkbox" checked={batchRelations} onChange={(event) => setBatchRelations(event.target.checked)} /><span>Also delete the statements related to these entries</span></label>
            <label className="confirmation-field"><span>Type <code>{batchTarget.length}</code> to confirm</span><input value={acknowledgedCount} onChange={(event) => setAcknowledgedCount(event.target.value)} inputMode="numeric" autoComplete="off" spellCheck="false" /></label>
            <footer>
              <button type="button" className="text-button" onClick={() => setBatchTarget(null)} disabled={batchDeleting}>Cancel</button>
              <button type="button" className="danger-button" onClick={() => void confirmBatchDelete()} disabled={batchDeleting || acknowledgedCount.trim() !== String(batchTarget.length)}>
                {batchDeleting ? <LoaderCircle size={16} className="spin" /> : <Trash2 size={16} />} Delete selected
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      {deleteTarget ? (
        <div className="modal-backdrop" role="presentation">
          <section className="delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-title">
            <header>
              <div><p className="eyebrow">DESTRUCTIVE ACTION</p><h2 id="delete-title">Delete knowledge entry</h2></div>
              <button type="button" className="icon-button" onClick={() => setDeleteTarget(null)} aria-label="Close delete dialog" title="Close"><X size={18} /></button>
            </header>
            <p className="delete-copy">This removes <strong>{deleteTarget.knowledge.name}</strong> from the selected shelf. Hypatia does not cascade-delete graph statements.</p>
            <div className="impact-count"><Network size={17} /><span>{deleteTarget.relationships.length} direct relationship(s) found</span></div>
            <label className="check-line"><input type="checkbox" checked={deleteRelations} onChange={(event) => setDeleteRelations(event.target.checked)} /><span>Also delete these related statements</span></label>
            <label className="confirmation-field"><span>Type <code>{deleteTarget.knowledge.name}</code> to confirm</span><input value={acknowledgedName} onChange={(event) => setAcknowledgedName(event.target.value)} autoComplete="off" spellCheck="false" /></label>
            <footer>
              <button type="button" className="text-button" onClick={() => setDeleteTarget(null)} disabled={deleting}>Cancel</button>
              <button type="button" className="danger-button" onClick={() => void confirmDelete()} disabled={deleting || acknowledgedName !== deleteTarget.knowledge.name}>
                {deleting ? <LoaderCircle size={16} className="spin" /> : <Trash2 size={16} />} Delete entry
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function Inspector({ impact, onDelete, onOpenGraph }: { impact: Impact; onDelete: () => void; onOpenGraph: () => void }) {
  const knowledge = impact.knowledge;
  const relationships = impact.relationships;
  return (
    <>
      <div className="inspector-head">
        <div><p className="eyebrow">KNOWLEDGE RECORD</p><h3>{knowledge.name}</h3></div>
        <div className="inspector-actions">
          <button type="button" className="icon-button" onClick={onOpenGraph} title="Open in graph" aria-label="Open in graph"><Network size={17} /></button>
          <button type="button" className="icon-button danger-icon" onClick={onDelete} title="Delete this knowledge entry" aria-label="Delete this knowledge entry"><Trash2 size={17} /></button>
        </div>
      </div>
      <div className="metadata-line"><span>{knowledge.content.format}</span><span>{dateLabel(knowledge.createdAt)}</span></div>
      <ContentRenderer content={knowledge.content} emptyMessage="No stored content." />
      <div className="metadata-groups">
        <div><p><Tags size={14} /> Tags</p><div className="chip-wrap">{knowledge.content.tags.length ? knowledge.content.tags.map((tag) => <span className="chip tag-chip" key={tag}>{tag}</span>) : <span className="muted">None</span>}</div></div>
        <div><p><Database size={14} /> Scopes</p><div className="chip-wrap">{knowledge.content.scopes.length ? knowledge.content.scopes.map((scope) => <span className="chip scope-chip" key={scope || "global"}>{scopeLabel(scope)}</span>) : <span className="muted">Unscoped</span>}</div></div>
      </div>
      <div className="relationships-head"><span><Network size={15} /> Direct relationships</span><b>{relationships.length}</b></div>
      <div className="relationship-list">
        {relationships.length === 0 ? <p className="no-relations">No direct incoming or outgoing statements.</p> : relationships.map((relationship) => (
          <div className="relationship" key={relationship.subject + "-" + relationship.predicate + "-" + relationship.object}>
            <span className={"relation-direction " + relationship.direction}>
              {relationship.direction === "outgoing" ? <ArrowUpRight size={14} /> : relationship.direction === "incoming" ? <ArrowDownLeft size={14} /> : <Network size={14} />}
            </span>
            <div><strong>{directionLabel(relationship)}</strong><small>{relationship.direction === "both" ? "self-referential" : relationship.direction}</small></div>
          </div>
        ))}
      </div>
    </>
  );
}

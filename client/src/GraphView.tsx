import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import cytoscape, { type Core, type ElementDefinition, type EventObject } from "cytoscape";
import { ArrowDownLeft, ArrowUpRight, LoaderCircle, Network, RefreshCw } from "lucide-react";
import { getGraphNode, type GraphEdge, type GraphNode, type GraphNodeResponse } from "./api";
import { ContentRenderer } from "./ContentRenderer";

type GraphState = {
  focus: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

type Selection =
  | { kind: "node"; id: string }
  | { kind: "edge"; id: string }
  | null;

const MAX_NODES = 90;
const MAX_EDGES = 160;
const DOUBLE_NODE_TAP_WINDOW_MS = 450;

function emptyGraph(): GraphState {
  return { focus: "", nodes: [], edges: [] };
}

function shortLabel(value: string, maximum = 26): string {
  return value.length > maximum ? value.slice(0, maximum - 1) + "..." : value;
}

function dateLabel(value: string): string {
  return value ? value.replace("T", " ").slice(0, 16) : "Unknown date";
}

function mergeGraph(current: GraphState, response: GraphNodeResponse, reset: boolean): GraphState {
  const nodeById = new Map((reset ? [] : current.nodes).map((node) => [node.id, node]));
  for (const node of response.nodes) {
    const existing = nodeById.get(node.id);
    if (!existing && nodeById.size >= MAX_NODES) continue;
    nodeById.set(node.id, existing?.knowledge && !node.knowledge ? existing : node);
  }

  const edgeById = new Map((reset ? [] : current.edges).map((edge) => [edge.id, edge]));
  for (const edge of response.edges) {
    if (edgeById.size >= MAX_EDGES && !edgeById.has(edge.id)) continue;
    if (nodeById.has(edge.source) && nodeById.has(edge.target)) edgeById.set(edge.id, edge);
  }

  return {
    focus: reset ? response.focus : current.focus || response.focus,
    nodes: [...nodeById.values()],
    edges: [...edgeById.values()]
  };
}

function graphElements(graph: GraphState): ElementDefinition[] {
  return [
    ...graph.nodes.map((node) => ({
      group: "nodes" as const,
      data: {
        id: node.id,
        label: shortLabel(node.name),
        fullLabel: node.name,
        nodeType: node.knowledge ? "knowledge" : "reference"
      },
      classes: [node.id === graph.focus ? "focus" : "", node.knowledge ? "knowledge" : "reference"].filter(Boolean).join(" ")
    })),
    ...graph.edges.map((edge) => ({
      group: "edges" as const,
      data: {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: shortLabel(edge.predicate, 20),
        fullLabel: edge.predicate
      }
    }))
  ];
}

function applySelection(cy: Core, selection: Selection): void {
  cy.elements().removeClass("is-selected");
  if (selection) cy.getElementById(selection.id).addClass("is-selected");
}

export function GraphView({ shelf, initialNodeName, onFocusChange }: {
  shelf: string;
  initialNodeName: string | null;
  onFocusChange: (name: string) => void;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const onFocusChangeRef = useRef(onFocusChange);
  const lastNodeTap = useRef<{ name: string; timestamp: number } | null>(null);
  const expandedNodes = useRef(new Set<string>());
  const requestId = useRef(0);
  const [graph, setGraph] = useState<GraphState>(emptyGraph);
  const [selection, setSelection] = useState<Selection>(null);
  const [loadingNode, setLoadingNode] = useState("");
  const [error, setError] = useState("");

  const selectedNode = useMemo(() => selection?.kind === "node"
    ? graph.nodes.find((node) => node.id === selection.id) || null
    : null, [graph.nodes, selection]);
  const selectedEdge = useMemo(() => selection?.kind === "edge"
    ? graph.edges.find((edge) => edge.id === selection.id) || null
    : null, [graph.edges, selection]);

  const loadNode = useCallback(async (name: string, reset: boolean) => {
    const id = ++requestId.current;
    setLoadingNode(name);
    setError("");
    try {
      const response = await getGraphNode(shelf, name);
      if (id !== requestId.current) return;
      expandedNodes.current.add(name);
      setGraph((current) => mergeGraph(current, response, reset));
      if (reset) setSelection({ kind: "node", id: name });
    } catch (reason) {
      if (id !== requestId.current) return;
      setError(reason instanceof Error ? reason.message : "Unable to load graph relationships.");
      if (reset) setGraph(emptyGraph());
    } finally {
      if (id === requestId.current) setLoadingNode("");
    }
  }, [shelf]);

  useEffect(() => {
    onFocusChangeRef.current = onFocusChange;
  }, [onFocusChange]);

  useEffect(() => {
    expandedNodes.current.clear();
    setSelection(null);
    setGraph(emptyGraph());
    setError("");
    if (initialNodeName) void loadNode(initialNodeName, true);
  }, [initialNodeName, loadNode]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const cy = cytoscape({
      container: canvasRef.current,
      elements: [],
      style: [
        {
          selector: "node",
          style: {
            "background-color": "#176f5a",
            "border-color": "#0a3a30",
            "border-width": 2,
            color: "#173c33",
            label: "data(label)",
            "font-family": "Iowan Old Style, Palatino Linotype, Georgia, serif",
            "font-size": 11,
            "font-weight": 700,
            "text-wrap": "wrap",
            "text-max-width": "92px",
            "text-valign": "bottom",
            "text-margin-y": 7,
            width: 31,
            height: 31
          }
        },
        {
          selector: "node.focus",
          style: {
            "background-color": "#e0a73f",
            "border-color": "#6d4b11",
            width: 39,
            height: 39
          }
        },
        {
          selector: "node.reference",
          style: {
            "background-color": "#f7edd0",
            "border-color": "#987135",
            "border-style": "dashed",
            color: "#5f4822"
          }
        },
        {
          selector: "edge",
          style: {
            width: 1.5,
            "curve-style": "bezier",
            "line-color": "#8ba99f",
            "target-arrow-color": "#8ba99f",
            "target-arrow-shape": "triangle",
            label: "data(label)",
            color: "#48645b",
            "font-size": 9,
            "font-weight": 700,
            "text-background-color": "#f8fbfa",
            "text-background-opacity": 0.94,
            "text-background-padding": "2px",
            "text-rotation": "autorotate"
          }
        },
        {
          selector: "node.is-selected",
          style: {
            "overlay-color": "#d88f27",
            "overlay-opacity": 0.18,
            "overlay-padding": 9,
            "border-color": "#c07017"
          }
        },
        {
          selector: "edge.is-selected",
          style: {
            "line-color": "#c07017",
            "target-arrow-color": "#c07017",
            width: 3
          }
        }
      ]
    });
    cy.on("tap", "node", (event: EventObject) => {
      const name = event.target.id();
      const now = Date.now();
      const previous = lastNodeTap.current;
      setSelection({ kind: "node", id: name });
      if (previous && previous.name === name && now - previous.timestamp <= DOUBLE_NODE_TAP_WINDOW_MS) {
        lastNodeTap.current = null;
        onFocusChangeRef.current(name);
      } else {
        lastNodeTap.current = { name, timestamp: now };
      }
    });
    cy.on("tap", "edge", (event: EventObject) => setSelection({ kind: "edge", id: event.target.id() }));
    cy.on("tap", (event: EventObject) => {
      if (event.target === cy) setSelection(null);
    });
    cyRef.current = cy;
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, []);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements().remove();
    const elements = graphElements(graph);
    if (elements.length === 0) return;
    cy.add(elements);
    cy.layout({
      name: "cose",
      animate: false,
      fit: true,
      padding: 56,
      nodeRepulsion: () => 280000,
      idealEdgeLength: () => 130,
      gravity: 0.22
    }).run();
  }, [graph]);

  useEffect(() => {
    const cy = cyRef.current;
    if (cy) applySelection(cy, selection);
  }, [graph, selection]);

  const fitGraph = useCallback(() => cyRef.current?.fit(undefined, 48), []);
  const resetGraph = useCallback(() => {
    if (graph.focus) {
      expandedNodes.current.clear();
      void loadNode(graph.focus, true);
    }
  }, [graph.focus, loadNode]);
  const expandSelectedNode = useCallback(() => {
    if (!selectedNode || loadingNode || expandedNodes.current.has(selectedNode.name)) return;
    void loadNode(selectedNode.name, false);
  }, [loadNode, loadingNode, selectedNode]);
  const focusSelectedNode = useCallback(() => {
    if (selectedNode) onFocusChange(selectedNode.name);
  }, [onFocusChange, selectedNode]);

  const hasReachedLimit = graph.nodes.length >= MAX_NODES || graph.edges.length >= MAX_EDGES;

  return (
    <section className="graph-workspace" aria-label="Knowledge graph">
      <div className="graph-toolbar">
        <div className="graph-summary"><Network size={16} aria-hidden="true" /><span>{graph.nodes.length} nodes</span><span>{graph.edges.length} edges</span></div>
        <div className="graph-toolbar-actions">
          <button className="icon-button" type="button" onClick={fitGraph} title="Fit graph to view" aria-label="Fit graph to view" disabled={graph.nodes.length === 0}><Network size={17} /></button>
          <button className="icon-button" type="button" onClick={resetGraph} title="Reload focused node" aria-label="Reload focused node" disabled={!graph.focus || Boolean(loadingNode)}><RefreshCw size={17} className={loadingNode ? "spin" : ""} /></button>
        </div>
      </div>
      <div className="graph-layout">
        <div className="graph-canvas-frame">
          <div ref={canvasRef} className="graph-canvas" aria-label="Interactive knowledge graph" />
          {!initialNodeName && !loadingNode ? <div className="graph-blank"><Network size={30} /><p>Select a knowledge record to map its direct relationships.</p></div> : null}
          {loadingNode && graph.nodes.length === 0 ? <div className="graph-blank"><LoaderCircle size={28} className="spin" /><p>Loading graph relationships</p></div> : null}
          {error ? <div className="graph-error" role="alert">{error}</div> : null}
          {hasReachedLimit ? <div className="graph-limit" role="status">Graph display limit reached. Focus a node to continue exploring.</div> : null}
        </div>
        <aside className="graph-inspector" aria-label="Graph inspector">
          {selectedNode ? <NodeInspector
            node={selectedNode}
            isFocus={selectedNode.id === graph.focus}
            loading={loadingNode === selectedNode.name}
            expanded={expandedNodes.current.has(selectedNode.name)}
            canExpand={!hasReachedLimit}
            onExpand={expandSelectedNode}
            onFocus={focusSelectedNode}
          /> : null}
          {selectedEdge ? <EdgeInspector edge={selectedEdge} /> : null}
          {!selectedNode && !selectedEdge ? <div className="graph-inspector-empty"><Network size={28} /><h3>Inspect the graph</h3><p>Select a node or relationship to inspect it.</p></div> : null}
        </aside>
      </div>
    </section>
  );
}

function NodeInspector({ node, isFocus, loading, expanded, canExpand, onExpand, onFocus }: {
  node: GraphNode;
  isFocus: boolean;
  loading: boolean;
  expanded: boolean;
  canExpand: boolean;
  onExpand: () => void;
  onFocus: () => void;
}) {
  const knowledge = node.knowledge;
  return (
    <>
      <div className="inspector-head">
        <div><p className="eyebrow">{knowledge ? "KNOWLEDGE RECORD" : "GRAPH REFERENCE"}</p><h3>{node.name}</h3></div>
        {isFocus ? <span className="graph-focus-badge">focus</span> : null}
      </div>
      {knowledge ? <>
        <div className="metadata-line"><span>{knowledge.content.format}</span><span>{dateLabel(knowledge.createdAt)}</span></div>
        <ContentRenderer content={knowledge.content} emptyMessage="No stored content." />
        <div className="metadata-groups">
          <div><p>Tags</p><div className="chip-wrap">{knowledge.content.tags.length ? knowledge.content.tags.map((tag) => <span className="chip tag-chip" key={tag}>{tag}</span>) : <span className="muted">None</span>}</div></div>
          <div><p>Scopes</p><div className="chip-wrap">{knowledge.content.scopes.length ? knowledge.content.scopes.map((scope) => <span className="chip scope-chip" key={scope || "global"}>{scope || "global"}</span>) : <span className="muted">Unscoped</span>}</div></div>
        </div>
      </> : <p className="graph-reference-copy">This entity is still referenced by a statement, but does not have a knowledge record in this shelf.</p>}
      <div className="graph-node-actions">
        <button className="command-button" type="button" onClick={onFocus} disabled={isFocus}><Network size={16} /> Focus map</button>
        <button className="text-button graph-expand-button" type="button" onClick={onExpand} disabled={expanded || loading || !canExpand}>
          {loading ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />} {expanded ? "Relations loaded" : "Load relations"}
        </button>
      </div>
    </>
  );
}

function EdgeInspector({ edge }: { edge: GraphEdge }) {
  return (
    <>
      <div className="inspector-head"><div><p className="eyebrow">GRAPH STATEMENT</p><h3>{edge.predicate}</h3></div><Network size={20} aria-hidden="true" /></div>
      <div className="statement-path"><span>{edge.source}</span><ArrowUpRight size={16} aria-hidden="true" /><strong>{edge.predicate}</strong><ArrowDownLeft size={16} aria-hidden="true" /><span>{edge.target}</span></div>
      <div className="metadata-line"><span>{edge.content.format}</span><span>{dateLabel(edge.createdAt)}</span></div>
      <ContentRenderer content={edge.content} emptyMessage="No statement content." />
    </>
  );
}

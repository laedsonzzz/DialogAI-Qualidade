import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import { useToast } from "@/hooks/use-toast";
import { getCommonHeaders } from "@/lib/auth";

type KbType = "cliente" | "operador";

interface GraphNode {
  id: string;
  label: string;
  node_type?: string | null;
  source_id: string;
  kb_type: KbType;
  properties?: Record<string, any>;
  x?: number;
  y?: number;
}

interface GraphEdge {
  id: string;
  src_node_id: string;
  dst_node_id: string;
  relation: string;
  kb_type: KbType;
  properties?: Record<string, any>;
}

interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  counts?: { nodes: number; edges: number };
  kb_type?: KbType | null;
  source_id?: string | null;
}

interface NeighborsResponse {
  center_node_id: string | number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  kb_type?: KbType | null;
  source_id?: string | null;
}

interface NodeDetailResponse {
  node: GraphNode;
  snippets: { chunk_id: string; source_id: string; kb_type: KbType; content_snippet: string }[];
  kb_type?: KbType | null;
  source_id?: string | null;
}

interface GraphViewerProps {
  sourceId: string;
  kbType?: KbType | null;
  piiMode: "default" | "raw";
  onRequestExtract?: () => Promise<void> | void;
  onExportJson?: () => Promise<void> | void;
}

function uniqById<T extends { id: string }>(arr: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of arr) {
    map.set(item.id, item);
  }
  return Array.from(map.values());
}

function mergeGraphData(current: GraphResponse, incoming: GraphResponse | NeighborsResponse): GraphResponse {
  const nodes = uniqById(
    [...(current.nodes || []), ...(incoming.nodes || [])]
  );
  const edges = uniqById(
    [...(current.edges || []), ...(incoming.edges || [])]
  );
  return {
    nodes,
    edges,
    counts: { nodes: nodes.length, edges: edges.length },
    kb_type: (incoming as any)?.kb_type ?? current.kb_type ?? null,
    source_id: (incoming as any)?.source_id ?? current.source_id ?? null,
  };
}

/**
 * Layout simples: posiciona nós em círculo com raio adaptado ao tamanho do canvas.
 * Evita dependência de d3-force.
 */
function computeCircularLayout(nodes: GraphNode[], width: number, height: number): GraphNode[] {
  if (!nodes || nodes.length === 0) return [];
  const cx = width / 2;
  const cy = height / 2;
  const n = nodes.length;
  const radius = Math.max(80, Math.min(cx, cy) - 40);
  return nodes.map((node, i) => {
    const angle = (2 * Math.PI * i) / n;
    const x = cx + radius * Math.cos(angle);
    const y = cy + radius * Math.sin(angle);
    return { ...node, x, y };
  });
}

export const GraphViewer: React.FC<GraphViewerProps> = ({ sourceId, kbType = null, piiMode, onRequestExtract, onExportJson }) => {
  const { toast } = useToast();
  const [graph, setGraph] = useState<GraphResponse>({ nodes: [], edges: [], counts: { nodes: 0, edges: 0 }, kb_type: kbType ?? null, source_id: sourceId });
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [nodeSnippets, setNodeSnippets] = useState<{ chunk_id: string; source_id: string; kb_type: KbType; content_snippet: string }[]>([]);
  const [nodeDetailLoading, setNodeDetailLoading] = useState<boolean>(false);
  const [nodeDetailError, setNodeDetailError] = useState<string | null>(null);
  // Zoom responsivo (1 = ajustar ao container)
  const [zoom, setZoom] = useState<number>(1);

  const canvasRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number }>({ width: 800, height: 520 });

  useEffect(() => {
    function recomputeSize() {
      const el = canvasRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const width = Math.max(600, Math.floor(rect.width));
      const height = Math.max(420, Math.floor(rect.height));
      setCanvasSize({ width, height });
    }
    recomputeSize();
    window.addEventListener("resize", recomputeSize);
    return () => window.removeEventListener("resize", recomputeSize);
  }, []);

  const fetchGraph = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = new URL("/api/kb/graph", window.location.origin);
      url.searchParams.set("source_id", sourceId);
      url.searchParams.set("pii_mode", piiMode);
      if (kbType) url.searchParams.set("kb_type", kbType);
      url.searchParams.set("limit_nodes", "1000");
      url.searchParams.set("limit_edges", "2000");

      const res = await fetch(url.toString(), { headers: getCommonHeaders() });
      const txt = await res.text();
      if (!res.ok) {
        let json: any;
        try { json = JSON.parse(txt); } catch {}
        throw new Error(json?.error || txt || `Erro HTTP ${res.status}`);
      }
      const data: GraphResponse = JSON.parse(txt);
      setGraph(data);
      setSelectedNodeId(null);
    } catch (e: any) {
      setError(e.message || "Erro ao carregar grafo");
      toast({ title: "Erro ao carregar grafo", description: e.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [sourceId, piiMode, kbType, toast]);

  const fetchNeighbors = useCallback(async (nodeId: string) => {
    setLoading(true);
    setError(null);
    try {
      const url = new URL("/api/kb/graph/neighbors", window.location.origin);
      url.searchParams.set("node_id", nodeId);
      url.searchParams.set("source_id", sourceId);
      url.searchParams.set("pii_mode", piiMode);
      if (kbType) url.searchParams.set("kb_type", kbType);
      url.searchParams.set("limit", "500");

      const res = await fetch(url.toString(), { headers: getCommonHeaders() });
      const txt = await res.text();
      if (!res.ok) {
        let json: any;
        try { json = JSON.parse(txt); } catch {}
        throw new Error(json?.error || txt || `Erro HTTP ${res.status}`);
      }
      const data: NeighborsResponse = JSON.parse(txt);
      setGraph((g) => mergeGraphData(g, data));
      setSelectedNodeId(nodeId);
    } catch (e: any) {
      setError(e.message || "Erro ao carregar vizinhança");
      toast({ title: "Erro ao carregar vizinhança", description: e.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [sourceId, piiMode, kbType, toast]);

  const fetchNodeDetail = useCallback(async (nodeId: string) => {
    setNodeDetailLoading(true);
    setNodeDetailError(null);
    try {
      const url = new URL("/api/kb/graph/node", window.location.origin);
      url.searchParams.set("node_id", nodeId);
      url.searchParams.set("source_id", sourceId);
      url.searchParams.set("pii_mode", piiMode);
      if (kbType) url.searchParams.set("kb_type", kbType);
      const res = await fetch(url.toString(), { headers: getCommonHeaders() });
      const txt = await res.text();
      if (!res.ok) {
        let json: any;
        try { json = JSON.parse(txt); } catch {}
        throw new Error(json?.error || txt || `Erro HTTP ${res.status}`);
      }
      const data: NodeDetailResponse = JSON.parse(txt);
      setNodeSnippets(Array.isArray(data.snippets) ? data.snippets : []);
    } catch (e: any) {
      setNodeDetailError(e.message || "Erro ao carregar descrição do nó");
    } finally {
      setNodeDetailLoading(false);
    }
  }, [sourceId, piiMode, kbType]);
  
  const handleExportJson = useCallback(async () => {
    if (onExportJson) {
      await onExportJson();
      return;
    }
    try {
      const url = new URL("/api/kb/graph/export", window.location.origin);
      url.searchParams.set("source_id", sourceId);
      url.searchParams.set("pii_mode", piiMode);
      if (kbType) url.searchParams.set("kb_type", kbType);
      const res = await fetch(url.toString(), { headers: getCommonHeaders() });
      const txt = await res.text();
      if (!res.ok) {
        let json: any;
        try { json = JSON.parse(txt); } catch {}
        throw new Error(json?.error || txt || `Erro HTTP ${res.status}`);
      }
      const blob = new Blob([txt], { type: "application/json;charset=utf-8" });
      const a = document.createElement("a");
      const title = graph?.source_id ? `graph_${graph.source_id}` : "graph_export";
      a.download = `${title}.json`;
      a.href = URL.createObjectURL(blob);
      a.click();
      URL.revokeObjectURL(a.href);
      toast({ title: "JSON exportado", description: "O arquivo foi baixado com sucesso." });
    } catch (e: any) {
      toast({ title: "Erro ao exportar JSON", description: e.message, variant: "destructive" });
    }
  }, [sourceId, piiMode, kbType, graph, onExportJson, toast]);

  const handleExtract = useCallback(async () => {
    if (onRequestExtract) {
      await onRequestExtract();
    } else {
      try {
        const res = await fetch("/api/kb/graph/extract", {
          method: "POST",
          headers: getCommonHeaders(),
          body: JSON.stringify({
            kb_type: kbType || "cliente",
            source_id: sourceId,
            limit_chunks: 200,
            pii_mode: piiMode,
          }),
        });
        const txt = await res.text();
        if (!res.ok) {
          let json: any;
          try { json = JSON.parse(txt); } catch {}
          throw new Error(json?.error || txt || `Erro HTTP ${res.status}`);
        }
        const result = JSON.parse(txt);
        toast({
          title: "Extração concluída",
          description: `Processados ${result?.processed ?? 0} chunks • Nós: +${result?.nodesCreated ?? 0} • Arestas: +${result?.edgesCreated ?? 0}`,
        });
      } catch (e: any) {
        toast({ title: "Erro ao extrair grafo", description: e.message, variant: "destructive" });
      }
    }
    await fetchGraph();
  }, [sourceId, kbType, piiMode, onRequestExtract, fetchGraph, toast]);

  useEffect(() => {
    fetchGraph();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, kbType, piiMode]);

  const laidOutNodes = useMemo(() => computeCircularLayout(graph.nodes || [], canvasSize.width, canvasSize.height), [graph.nodes, canvasSize]);

  const nodeIndexById = useMemo(() => {
    const map = new Map<string, number>();
    laidOutNodes.forEach((n, i) => map.set(n.id, i));
    return map;
  }, [laidOutNodes]);

  const selectedNeighbors = useMemo(() => {
    if (!selectedNodeId) return new Set<string>();
    const set = new Set<string>();
    graph.edges.forEach((e) => {
      if (e.src_node_id === selectedNodeId || e.dst_node_id === selectedNodeId) {
        set.add(e.src_node_id);
        set.add(e.dst_node_id);
      }
    });
    return set;
  }, [graph.edges, selectedNodeId]);
  
  // Nó selecionado e suas arestas
  const selectedNode = useMemo(() => {
    if (!selectedNodeId) return null;
    return graph.nodes.find((n) => n.id === selectedNodeId) || null;
  }, [graph.nodes, selectedNodeId]);
  
  const selectedEdges = useMemo(() => {
    if (!selectedNodeId) return [];
    return graph.edges.filter((e) => e.src_node_id === selectedNodeId || e.dst_node_id === selectedNodeId);
  }, [graph.edges, selectedNodeId]);
  
  useEffect(() => {
    if (selectedNodeId) {
      fetchNodeDetail(selectedNodeId);
    } else {
      setNodeSnippets([]);
      setNodeDetailError(null);
    }
  }, [selectedNodeId, fetchNodeDetail]);
  
  // Bounding box dos nós para calcular viewBox responsivo e zoom
  const bbox = useMemo(() => {
    const xs = (laidOutNodes || []).map(n => n.x || 0);
    const ys = (laidOutNodes || []).map(n => n.y || 0);
    const minX = xs.length ? Math.min(...xs) : 0;
    const maxX = xs.length ? Math.max(...xs) : 1;
    const minY = ys.length ? Math.min(...ys) : 0;
    const maxY = ys.length ? Math.max(...ys) : 1;
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    return { minX, minY, maxX, maxY, w, h };
  }, [laidOutNodes]);
  
  const labelMaxLenForMargin = Math.max(
    0,
    ...((laidOutNodes || []).map(n => (n.label?.length || 0)))
  );
  const margin = Math.min(Math.max(60, labelMaxLenForMargin * 3), 240);
  const baseW = bbox.w + margin * 2;
  const baseH = bbox.h + margin * 2;
  const cx = (bbox.minX + bbox.maxX) / 2;
  const cy = (bbox.minY + bbox.maxY) / 2;
  const vw = baseW / Math.max(0.125, zoom);
  const vh = baseH / Math.max(0.125, zoom);
  const viewBox = `${cx - vw / 2} ${cy - vh / 2} ${vw} ${vh}`;
  
  return (
    <div className="space-y-3 max-h-[75vh] overflow-y-auto pb-2">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-foreground">Grafo da Fonte</h3>
          <p className="text-xs text-muted-foreground">
            Fonte: {graph.source_id ?? sourceId} • Tipo: {graph.kb_type ?? kbType ?? "-"} • PII: {piiMode}
          </p>
          <p className="text-xs text-muted-foreground">
            Nós: {graph.counts?.nodes ?? graph.nodes.length} • Arestas: {graph.counts?.edges ?? graph.edges.length}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" size="sm" onClick={fetchGraph} disabled={loading}>Recarregar</Button>
          <Button variant="outline" size="sm" onClick={handleExportJson}>Extrair para JSON</Button>
          <Button size="sm" onClick={handleExtract} disabled={loading}>Extrair grafo desta fonte</Button>
          <div className="flex items-center gap-1 ml-2">
            <Button variant="outline" size="sm" onClick={() => setZoom((z) => Math.max(0.125, z / 1.25))} title="Diminuir Zoom">−</Button>
            <Button variant="outline" size="sm" onClick={() => setZoom((z) => Math.min(8, z * 1.25))} title="Aumentar Zoom">+</Button>
            <Button variant="outline" size="sm" onClick={() => setZoom(1)} title="Ajustar ao Container">Fit</Button>
          </div>
        </div>
      </div>

      {error && (
        <Card className="p-3 text-sm text-destructive">
          {error}
        </Card>
      )}

      <Card ref={canvasRef} className="p-2 overflow-auto border-border h-[300px] sm:h-[360px] md:h-[420px] lg:h-[480px]">
        <svg viewBox={viewBox} preserveAspectRatio="xMidYMid meet" className="w-full h-full">
          {/* Edges */}
          {graph.edges.map((e) => {
            const srcIdx = nodeIndexById.get(e.src_node_id);
            const dstIdx = nodeIndexById.get(e.dst_node_id);
            if (srcIdx == null || dstIdx == null) return null;
            const src = laidOutNodes[srcIdx];
            const dst = laidOutNodes[dstIdx];
            const isSelectedEdge =
              selectedNodeId != null && (e.src_node_id === selectedNodeId || e.dst_node_id === selectedNodeId);
            return (
              <g key={e.id}>
                <line
                  x1={src.x}
                  y1={src.y}
                  x2={dst.x}
                  y2={dst.y}
                  stroke={isSelectedEdge ? "#22c55e" : "#94a3b8"}
                  strokeWidth={isSelectedEdge ? 2.5 : 1.25}
                  opacity={0.85}
                />
                {/* relation label at midpoint */}
                <text
                  x={(src.x! + dst.x!) / 2}
                  y={(src.y! + dst.y!) / 2}
                  fontSize={10}
                  fill="#64748b"
                  textAnchor="middle"
                >
                  {e.relation}
                </text>
              </g>
            );
          })}

          {/* Nodes */}
          {laidOutNodes.map((n) => {
            const isSelected = selectedNodeId === n.id;
            const isNeighbor = selectedNeighbors.has(n.id);
            const color =
              n.node_type === "pessoa" ? "#0ea5e9" :
              n.node_type === "empresa" ? "#f59e0b" :
              n.node_type === "processo" ? "#8b5cf6" :
              n.node_type === "produto" ? "#ef4444" :
              "#6366f1";
            const radius = isSelected ? 8 : isNeighbor ? 6 : 5;
            return (
              <g key={n.id}>
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={radius}
                  fill={color}
                  stroke={isSelected ? "#22c55e" : "#0f172a"}
                  strokeWidth={isSelected ? 2 : 1}
                  style={{ cursor: "pointer" }}
                  onClick={() => fetchNeighbors(n.id)}
                />
                <title>{n.label}</title>
                <text
                  x={n.x}
                  y={(n.y ?? 0) - (radius + 6)}
                  fontSize={canvasSize.width < 640 ? 9 : canvasSize.width < 800 ? 10 : 11}
                  fill="#334155"
                  textAnchor="middle"
                >
                  {n.label && n.label.length > 28 ? `${n.label.slice(0, 25)}…` : n.label}
                </text>
              </g>
            );
          })}
        </svg>
      </Card>
  
      {selectedNode && (
        <Card className="p-3 border-border">
          <div className="flex flex-col gap-2">
            <div>
              <h4 className="font-semibold text-foreground">Detalhes do Nó</h4>
              <p className="text-xs text-muted-foreground">ID: {selectedNode.id} • Tipo: {selectedNode.node_type || "-"}</p>
            </div>
            <div>
              <p className="text-sm"><span className="font-medium">Rótulo:</span> {selectedNode.label}</p>
            </div>
            <div>
              <p className="text-sm"><span className="font-medium">Fonte:</span> {selectedNode.source_id}</p>
            </div>

            <div>
              <p className="text-sm font-medium">Descrição</p>
              {nodeDetailLoading ? (
                <p className="text-xs text-muted-foreground">Carregando descrição...</p>
              ) : nodeDetailError ? (
                <p className="text-xs text-destructive">{nodeDetailError}</p>
              ) : nodeSnippets.length > 0 ? (
                <ul className="mt-1 space-y-1">
                  {nodeSnippets.map((s) => (
                    <li key={s.chunk_id}>
                      <p className="text-sm text-muted-foreground">{s.content_snippet}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">Nenhum trecho encontrado para este nó.</p>
              )}
            </div>

            <div>
              <p className="text-sm font-medium">Propriedades</p>
              {selectedNode.properties && Object.keys(selectedNode.properties).length > 0 ? (
                <ul className="mt-1 text-sm text-muted-foreground">
                  {Object.entries(selectedNode.properties).map(([k, v]) => (
                    <li key={k}><span className="font-medium">{k}:</span> {typeof v === "string" ? v : JSON.stringify(v)}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">Sem propriedades disponíveis</p>
              )}
            </div>
            <div>
              <p className="text-sm font-medium">Relações</p>
              {selectedEdges.length > 0 ? (
                <ul className="mt-1 text-sm text-muted-foreground">
                  {selectedEdges.map((e) => {
                    const otherId = e.src_node_id === selectedNode.id ? e.dst_node_id : e.src_node_id;
                    const other = graph.nodes.find((n) => n.id === otherId);
                    return (
                      <li key={e.id}>
                        {selectedNode.label} — [{e.relation}] → {other?.label || otherId}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">Sem relações carregadas</p>
              )}
            </div>
          </div>
        </Card>
      )}
  
      {graph.nodes.length === 0 && (
        <Card className="p-3 text-sm text-muted-foreground">
          Nenhum nó encontrado para esta fonte. Clique em "Extrair grafo desta fonte" para gerar nós/arestas a partir dos chunks.
        </Card>
      )}
    </div>
  );
};

export default GraphViewer;
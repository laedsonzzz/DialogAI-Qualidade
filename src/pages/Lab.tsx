import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { getAuthHeader, getClientId, getCommonHeaders } from "@/lib/auth";

type UploadResponse = {
  ok: boolean;
  run_id: string;
  status: string;
  totals: {
    totalDistinctIds: number;
    motivoDistinctIds: Record<string, number>;
  };
  inserted_rows: number;
  skipped_rows: number;
  warnings?: string[];
};

type ProgressMotivo = {
  motivo: string;
  total_ids_distinct: number;
  processed_ids_distinct: number;
  updated_at?: string;
  cached?: boolean;
};

type ProgressResponse = {
  run: { id: string; status: "pending" | "running" | "completed" | "failed"; created_at?: string; updated_at?: string };
  motivos: ProgressMotivo[];
  overall: {
    totalDistinctIds: number;
    processedDistinctIds: number;
  };
};

type LabResultItem = {
  motivo: string;
  scenario_title?: string;
  customer_profiles?: string[];
  process_text?: string | null;
  operator_guidelines?: string[];
  patterns?: string[];
  status?: string; // ready, etc.
  updated_at?: string;
};

type ResultsResponse = {
  run_id: string;
  results: LabResultItem[];
};

const API_BASE = import.meta.env?.VITE_API_BASE_URL || "";

const Lab: React.FC = () => {
  const { toast } = useToast();
  const navigate = useNavigate();

  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<"pending" | "running" | "completed" | "failed" | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [uploadTotals, setUploadTotals] = useState<{ totalDistinctIds: number; motivoDistinctIds: Record<string, number> } | null>(null);

  const [progress, setProgress] = useState<ProgressResponse | null>(null);
  const [results, setResults] = useState<LabResultItem[]>([]);
  const [committing, setCommitting] = useState<Record<string, boolean>>({});
  const [committed, setCommitted] = useState<Set<string>>(new Set());
  const [authChecked, setAuthChecked] = useState(false);
  const [canManage, setCanManage] = useState(false);

  async function ensurePermission() {
    try {
      const res = await fetch(`${API_BASE}/api/auth/me`, {
        headers: {
          ...getAuthHeader(),
          "Content-Type": "application/json",
        },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCanManage(false);
        setAuthChecked(true);
        navigate("/", { replace: true });
        return;
      }
      const cid = getClientId();
      const found = Array.isArray((data as any)?.clients) ? (data as any).clients.find((c: any) => c.client_id === cid) : null;
      const allowed = Boolean(found?.permissions?.can_manage_scenarios);
      setCanManage(allowed);
      setAuthChecked(true);
      if (!allowed) {
        navigate("/", { replace: true });
      }
    } catch {
      setCanManage(false);
      setAuthChecked(true);
      navigate("/", { replace: true });
    }
  }

  const pollRef = useRef<number | null>(null);

  const selectedClientId = useMemo(() => getClientId(), []);

  function clearPoll() {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  useEffect(() => {
    return () => {
      clearPoll();
    };
  }, []);

  useEffect(() => {
    ensurePermission();
    const handler = () => {
      ensurePermission();
    };
    window.addEventListener("client:changed", handler as any);
    return () => window.removeEventListener("client:changed", handler as any);
  }, []);

  function onSelectFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] || null;
    setFile(f || null);
  }

  async function handleUpload() {
    if (!file) {
      toast({ title: "Selecione um arquivo", description: "CSV ou XLSX com colunas esperadas", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);

      // Não defina Content-Type manualmente em FormData
      const headers: Record<string, string> = {
        ...getAuthHeader(),
      };
      if (selectedClientId) {
        headers["X-Client-Id"] = selectedClientId;
      }

      const res = await fetch(`${API_BASE}/api/lab/scenarios/upload`, {
        method: "POST",
        headers,
        body: form,
      });
      const data: UploadResponse = await res.json();
      if (!res.ok) {
        throw new Error((data as any)?.error || `Erro HTTP ${res.status}`);
      }
      setRunId(data.run_id);
      setRunStatus((data.status as any) || "pending");
      setWarnings(data.warnings || []);
      setUploadTotals(data.totals || null);
      toast({ title: "Base enviada", description: `Execução #${data.run_id} criada` });
    } catch (e: any) {
      toast({ title: "Falha no upload", description: String(e?.message || e), variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  async function handleStartAnalysis() {
    if (!runId) {
      toast({ title: "Nenhum run criado", description: "Envie uma base antes de iniciar a análise", variant: "destructive" });
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/lab/scenarios/analyze/${encodeURIComponent(runId)}`, {
        method: "POST",
        headers: getCommonHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((data as any)?.error || `Erro HTTP ${res.status}`);
      }
      setRunStatus("running");
      toast({ title: "Análise iniciada", description: `Execução #${runId} em processamento` });
      startPolling();
    } catch (e: any) {
      toast({ title: "Erro ao iniciar análise", description: String(e?.message || e), variant: "destructive" });
    }
  }

  function startPolling() {
    clearPoll();
    pollRef.current = window.setInterval(async () => {
      try {
        if (!runId) return;
        const res = await fetch(`${API_BASE}/api/lab/scenarios/progress/${encodeURIComponent(runId)}`, {
          headers: getCommonHeaders(),
        });
        const data: ProgressResponse = await res.json();
        if (!res.ok) {
          throw new Error((data as any)?.error || `Erro HTTP ${res.status}`);
        }
        setProgress(data);
        setRunStatus(data.run?.status || null);

        // Se completed ou failed, para polling e carrega resultados
        if (data.run?.status === "completed" || data.run?.status === "failed") {
          clearPoll();
          await loadResults();
        }
      } catch (e) {
        // silencioso para evitar spam, mas parar se necessário
        // poderíamos adicionar lógica de backoff
      }
    }, 2000);
  }

  async function loadResults() {
    if (!runId) return;
    try {
      const res = await fetch(`${API_BASE}/api/lab/scenarios/results/${encodeURIComponent(runId)}`, {
        headers: getCommonHeaders(),
      });
      const data: ResultsResponse = await res.json();
      if (!res.ok) {
        throw new Error((data as any)?.error || `Erro HTTP ${res.status}`);
      }
      setResults(Array.isArray(data.results) ? data.results : []);
    } catch (e: any) {
      toast({ title: "Erro ao carregar resultados", description: String(e?.message || e), variant: "destructive" });
    }
  }

  async function handleCommit(motivo: string) {
    if (!runId) return;
    try {
      setCommitting((prev) => ({ ...prev, [motivo]: true }));
      const res = await fetch(`${API_BASE}/api/lab/scenarios/commit`, {
        method: "POST",
        headers: getCommonHeaders(),
        body: JSON.stringify({ run_id: runId, motivo }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((data as any)?.error || `Erro HTTP ${res.status}`);
      }
      setCommitted((prev) => new Set([...prev, motivo]));
      toast({ title: "Cenário commitado", description: `Motivo "${motivo}" enviado ao banco principal` });
    } catch (e: any) {
      toast({ title: "Erro ao commitar cenário", description: String(e?.message || e), variant: "destructive" });
    } finally {
      setCommitting((prev) => ({ ...prev, [motivo]: false }));
    }
  }

  const overallPct = useMemo(() => {
    const tot = progress?.overall?.totalDistinctIds || uploadTotals?.totalDistinctIds || 0;
    const proc = progress?.overall?.processedDistinctIds || 0;
    if (tot <= 0) return 0;
    return Math.min(100, Math.round((proc / tot) * 100));
  }, [progress?.overall, uploadTotals?.totalDistinctIds]);

  const hasCachedMotivos = useMemo(() => {
    return (progress?.motivos || []).some((m) => m.cached);
  }, [progress?.motivos]);

  if (!authChecked) {
    return <div className="min-h-screen bg-background" />;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-muted">
      <div className="container mx-auto px-4 py-8">
        <div className="mb-6 flex items-center gap-3">
          <Button variant="outline" onClick={() => navigate("/")}>Voltar</Button>
          <div className="ml-auto">
            {runStatus === "running" && <span className="text-sm text-muted-foreground">Analisando...</span>}
            {runStatus === "completed" && <span className="text-sm text-green-600">Concluído</span>}
            {runStatus === "failed" && <span className="text-sm text-destructive">Falhou</span>}
          </div>
        </div>

        <Card className="p-4 mb-6">
          <h2 className="font-semibold mb-3">Upload de Base de Transcrições</h2>
          <div className="grid md:grid-cols-3 gap-3">
            <div className="md:col-span-2 grid gap-2">
              <Label>Arquivo (CSV ou XLSX)</Label>
              <Input type="file" accept=".csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" onChange={onSelectFile} />
            </div>
            <div className="flex items-end">
              <Button onClick={handleUpload} disabled={!file || uploading}>{uploading ? "Enviando..." : "Enviar"}</Button>
            </div>
          </div>
          {warnings.length > 0 && (
            <div className="mt-3">
              <p className="text-sm text-muted-foreground">Avisos:</p>
              <ul className="text-sm list-disc list-inside">
                {warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}
          {uploadTotals && (
            <div className="mt-3 text-sm text-muted-foreground">
              Total de IdAtendimentos distintos: <span className="font-semibold text-foreground">{uploadTotals.totalDistinctIds}</span>
            </div>
          )}
        </Card>

        <Card className="p-4 mb-6">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Análise e Progresso</h2>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={async () => { await loadResults(); }} disabled={!runId}>Carregar Resultados</Button>
              <Button onClick={handleStartAnalysis} disabled={!runId || runStatus === "running"}>Iniciar Análise</Button>
            </div>
          </div>

          <div className="mt-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm">Progresso geral</span>
              <span className="text-xs text-muted-foreground">
                {progress?.overall?.processedDistinctIds || 0} / {progress?.overall?.totalDistinctIds || uploadTotals?.totalDistinctIds || 0}
              </span>
            </div>
            <Progress value={overallPct} />
            {hasCachedMotivos && (
              <p className="text-xs text-muted-foreground mt-2">
                Motivos marcados como <span className="text-foreground">cache</span> foram concluídos 100% e podem ser retomados em caso de falhas.
              </p>
            )}
          </div>

          <div className="mt-6 grid gap-3">
            {(progress?.motivos || []).map((m) => {
              const pct = m.total_ids_distinct > 0 ? Math.min(100, Math.round((m.processed_ids_distinct / m.total_ids_distinct) * 100)) : 0;
              return (
                <Card key={m.motivo} className="p-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium">{m.motivo}</div>
                      <div className="text-xs text-muted-foreground">
                        {m.processed_ids_distinct} / {m.total_ids_distinct} {m.cached ? " • cached" : ""}
                      </div>
                    </div>
                    <span className="text-xs text-muted-foreground">Atualizado: {m.updated_at ? new Date(m.updated_at).toLocaleString() : "-"}</span>
                  </div>
                  <div className="mt-2">
                    <Progress value={pct} />
                  </div>
                </Card>
              );
            })}
            {(progress?.motivos || []).length === 0 && <p className="text-sm text-muted-foreground">Nenhum motivo encontrado ainda. Envie a base e inicie a análise.</p>}
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Resultados por Motivo</h2>
            {runId && <span className="text-xs text-muted-foreground">run #{runId}</span>}
          </div>

          <div className="mt-4 grid gap-4">
            {results.map((r) => {
              const isCommitted = committed.has(r.motivo);
              const committingNow = committing[r.motivo];
              const canCommit = String(r.status || "").toLowerCase() === "ready";
              return (
                <Card key={r.motivo} className="p-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-semibold">{r.scenario_title || r.motivo}</div>
                      <div className="text-xs text-muted-foreground">Motivo: {r.motivo}</div>
                      <div className="text-xs text-muted-foreground">Status: {r.status || "-"}</div>
                      {r.updated_at && <div className="text-xs text-muted-foreground">Atualizado: {new Date(r.updated_at).toLocaleString()}</div>}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant={isCommitted ? "outline" : "default"}
                        disabled={!canCommit || committingNow || isCommitted}
                        onClick={() => handleCommit(r.motivo)}
                      >
                        {isCommitted ? "Commitado" : committingNow ? "Commitando..." : "Commit"}
                      </Button>
                    </div>
                  </div>

                  <div className="grid md:grid-cols-2 gap-3 mt-3">
                    <div className="grid gap-2">
                      <div className="font-medium">Perfis de Cliente</div>
                      {Array.isArray(r.customer_profiles) && r.customer_profiles.length > 0 ? (
                        <ul className="list-disc list-inside text-sm text-muted-foreground">
                          {r.customer_profiles.map((p, i) => <li key={i}>{p}</li>)}
                        </ul>
                      ) : (
                        <p className="text-sm text-muted-foreground">Nenhum perfil.</p>
                      )}
                    </div>
                    <div className="grid gap-2">
                      <div className="font-medium">Diretrizes do Atendente</div>
                      {Array.isArray(r.operator_guidelines) && r.operator_guidelines.length > 0 ? (
                        <ul className="list-disc list-inside text-sm text-muted-foreground">
                          {r.operator_guidelines.map((g, i) => <li key={i}>{g}</li>)}
                        </ul>
                      ) : (
                        <p className="text-sm text-muted-foreground">Nenhuma diretriz.</p>
                      )}
                    </div>
                  </div>

                  <div className="grid gap-2 mt-3">
                    <div className="font-medium">Processo (Resumo)</div>
                    {r.process_text ? (
                      <div className="text-sm text-muted-foreground whitespace-pre-wrap">{r.process_text}</div>
                    ) : (
                      <p className="text-sm text-muted-foreground">Sem processo extraído.</p>
                    )}
                  </div>

                  <div className="grid gap-2 mt-3">
                    <div className="font-medium">Padrões</div>
                    {Array.isArray(r.patterns) && r.patterns.length > 0 ? (
                      <ul className="list-disc list-inside text-sm text-muted-foreground">
                        {r.patterns.map((p, i) => <li key={i}>{p}</li>)}
                      </ul>
                    ) : (
                      <p className="text-sm text-muted-foreground">Nenhum padrão listado.</p>
                    )}
                  </div>
                </Card>
              );
            })}
            {results.length === 0 && <p className="text-sm text-muted-foreground">Sem resultados carregados. Inicie a análise e/ou carregue os resultados.</p>}
          </div>
        </Card>
      </div>
    </div>
  );
};

export default Lab;
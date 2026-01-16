import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { getAuthHeader, getClientId, getCommonHeaders } from "@/lib/auth";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Info } from "lucide-react";

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
  const [maxPerMotivo, setMaxPerMotivo] = useState<string>("");
  // Edição de resultados por motivo
  const [editing, setEditing] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [editForm, setEditForm] = useState<Record<string, {
    scenario_title: string;
    process_text: string;
    customer_profiles: string[];
    operator_guidelines: string[];
    patterns: string[];
  }>>({});

  // Preview/mapeamento de colunas
  const requiredCanonicals = useMemo(() => ([
    "IdAtendimento",
    "Message",
    "Role",
    "Ordem",
    "MotivoDeContato",
  ]), []);
  const canonicalDescriptions: Record<string, string> = {
    IdAtendimento: "ID único por atendimento (agrupa as mensagens de uma conversa real).",
    Message: "Texto da mensagem enviada.",
    Role: "Quem enviou: agent (atendente), bot (assistente auxiliar), user (cliente).",
    Ordem: "Ordem sequencial das mensagens dentro de um IdAtendimento.",
    MotivoDeContato: "Motivo do contato (define o cenário).",
  };

  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewHeaders, setPreviewHeaders] = useState<string[]>([]);
  const [previewSuggestedMapping, setPreviewSuggestedMapping] = useState<Record<string, string>>({});
  const [canonicalComplete, setCanonicalComplete] = useState<boolean>(false);
  const [insufficientColumns, setInsufficientColumns] = useState<boolean>(false);
  // mapping com chaves humanizadas (IdAtendimento, Message, Role, Ordem, MotivoDeContato) -> nome de coluna do arquivo
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [mappingError, setMappingError] = useState<string | null>(null);

  function resetPreviewStates() {
    setPreviewHeaders([]);
    setPreviewSuggestedMapping({});
    setCanonicalComplete(false);
    setInsufficientColumns(false);
    setMapping({});
    setMappingError(null);
  }

  // Converte keys internas do preview para chaves humanizadas
  function toHumanMapping(internal: Record<string, string>): Record<string, string> {
    const map: Record<string, string> = {};
    const conv: Record<string, string> = {
      idAtendimento: "IdAtendimento",
      message: "Message",
      role: "Role",
      ordem: "Ordem",
      motivoDeContato: "MotivoDeContato",
    };
    Object.keys(internal || {}).forEach((k) => {
      const h = conv[k];
      if (h) map[h] = internal[k];
    });
    return map;
  }

  async function fetchPreview(f: File) {
    setPreviewLoading(true);
    setMappingError(null);
    try {
      const form = new FormData();
      form.append("file", f);
      const headers: Record<string, string> = {
        ...getAuthHeader(),
      };
      const cid = getClientId();
      if (cid) headers["X-Client-Id"] = cid;

      const res = await fetch(`${API_BASE}/api/lab/scenarios/preview`, {
        method: "POST",
        headers,
        body: form,
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error((data as any)?.error || `Erro HTTP ${res.status}`);
      }
      const headersArr = Array.isArray(data.headers) ? data.headers : [];
      setPreviewHeaders(headersArr);
      setCanonicalComplete(Boolean(data.canonicalComplete));
      setInsufficientColumns(Boolean(data.insufficientColumns));
      const suggested = data.suggestedMapping || {};
      setPreviewSuggestedMapping(suggested);
      // Prepopula mapping humanizado com a sugestão (quando presente)
      const hm = toHumanMapping(suggested);
      setMapping(hm);
    } catch (e: any) {
      setMappingError(String(e?.message || e));
      setPreviewHeaders([]);
      setPreviewSuggestedMapping({});
      setCanonicalComplete(false);
      setInsufficientColumns(false);
      setMapping({});
    } finally {
      setPreviewLoading(false);
    }
  }

  function validateMapping(current: Record<string, string>): string | null {
    // Se canonicalComplete, mapeamento pode ser omitido (usaremos sugestão)
    if (canonicalComplete) return null;
    // Verifica cobertura das 5 chaves e unicidade
    const chosen: string[] = [];
    for (const key of requiredCanonicals) {
      const v = (current[key] || "").trim();
      if (!v) return `Selecione a coluna para "${key}"`;
      chosen.push(v.toLowerCase());
    }
    const set = new Set(chosen);
    if (set.size !== chosen.length) {
      return "Cada coluna canônica deve apontar para uma coluna diferente do arquivo (mapeamentos duplicados encontrados).";
    }
    // Colunas insuficientes
    if (insufficientColumns) {
      return `Arquivo possui menos colunas (${previewHeaders.length}) do que o necessário (${requiredCanonicals.length}).`;
    }
    return null;
  }

  const canUpload = useMemo(() => {
    if (!file) return false;
    if (uploading) return false;
    if (insufficientColumns) return false;
    if (canonicalComplete) return true;
    const err = validateMapping(mapping);
    return !err;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, uploading, insufficientColumns, canonicalComplete, mapping]);

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
    resetPreviewStates();
    if (f) {
      fetchPreview(f);
    }
  }

  async function handleUpload() {
    if (!file) {
      toast({ title: "Selecione um arquivo", description: "CSV ou XLSX com colunas esperadas", variant: "destructive" });
      return;
    }
    // Valida mapeamento quando necessário
    const err = validateMapping(mapping);
    if (err) {
      setMappingError(err);
      toast({ title: "Mapeamento inválido", description: err, variant: "destructive" });
      return;
    }

    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);

      // Inclui mapping quando necessário ou quando já canônico (para transparência)
      if (canonicalComplete || Object.keys(mapping).length > 0) {
        // Envia no formato humanizado (backend aceita humano ou interno)
        form.append("mapping", JSON.stringify(mapping));
      }

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
      const payload: any = {};
      const trimmed = (maxPerMotivo || "").trim();
      if (trimmed) {
        const num = parseInt(trimmed, 10);
        if (Number.isFinite(num) && num > 0) {
          payload.max_per_motivo = num;
        }
      }
      const res = await fetch(`${API_BASE}/api/lab/scenarios/analyze/${encodeURIComponent(runId)}`, {
        method: "POST",
        headers: getCommonHeaders(),
        body: JSON.stringify(payload),
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

  // Helpers de edição
  function startEdit(motivo: string, r: LabResultItem) {
    const initial: any = {
      scenario_title: String(r.scenario_title || r.motivo || ""),
      process_text: String(r.process_text || ""),
      customer_profiles: Array.isArray(r.customer_profiles) ? [...r.customer_profiles] : [],
      operator_guidelines: Array.isArray(r.operator_guidelines) ? [...r.operator_guidelines] : [],
      patterns: Array.isArray(r.patterns) ? [...r.patterns] : [],
    };
    setEditForm((prev) => ({ ...prev, [motivo]: initial }));
    setEditing((prev) => ({ ...prev, [motivo]: true }));
  }

  function cancelEdit(motivo: string) {
    setEditing((prev) => ({ ...prev, [motivo]: false }));
    setEditForm((prev) => {
      const next = { ...prev };
      delete next[motivo];
      return next;
    });
  }

  function updateFormField(motivo: string, key: keyof typeof editForm[string], value: any) {
    setEditForm((prev) => {
      const curr = prev[motivo] || { scenario_title: "", process_text: "", customer_profiles: [], operator_guidelines: [], patterns: [] };
      return { ...prev, [motivo]: { ...curr, [key]: value } };
    });
  }

  function updateListItem(motivo: string, key: "customer_profiles" | "operator_guidelines" | "patterns", idx: number, value: string) {
    setEditForm((prev) => {
      const curr = prev[motivo] || { scenario_title: "", process_text: "", customer_profiles: [], operator_guidelines: [], patterns: [] };
      const arr = Array.isArray(curr[key]) ? [...curr[key]] : [];
      arr[idx] = value;
      return { ...prev, [motivo]: { ...curr, [key]: arr } };
    });
  }

  function addListItem(motivo: string, key: "customer_profiles" | "operator_guidelines" | "patterns") {
    setEditForm((prev) => {
      const curr = prev[motivo] || { scenario_title: "", process_text: "", customer_profiles: [], operator_guidelines: [], patterns: [] };
      const arr = Array.isArray(curr[key]) ? [...curr[key]] : [];
      arr.push("");
      return { ...prev, [motivo]: { ...curr, [key]: arr } };
    });
  }

  function removeListItem(motivo: string, key: "customer_profiles" | "operator_guidelines" | "patterns", idx: number) {
    setEditForm((prev) => {
      const curr = prev[motivo] || { scenario_title: "", process_text: "", customer_profiles: [], operator_guidelines: [], patterns: [] };
      const arr = Array.isArray(curr[key]) ? [...curr[key]] : [];
      arr.splice(idx, 1);
      return { ...prev, [motivo]: { ...curr, [key]: arr } };
    });
  }

  async function saveEdit(motivo: string) {
    if (!runId) return;
    const curr = editForm[motivo];
    if (!curr) return;

    // Monta payload respeitando limites (validados também no backend)
    const payload: any = {
      scenario_title: (curr.scenario_title || "").trim(),
      process_text: typeof curr.process_text === "string" ? curr.process_text : null,
      customer_profiles: (curr.customer_profiles || []).map((s) => String(s || "").trim()).filter(Boolean).slice(0, 6),
      operator_guidelines: (curr.operator_guidelines || []).map((s) => String(s || "").trim()).filter(Boolean).slice(0, 20),
      patterns: (curr.patterns || []).map((s) => String(s || "").trim()).filter(Boolean).slice(0, 20),
    };

    // Evita enviar campos vazios iguais ao original? Opcional: enviar todos
    setSaving((prev) => ({ ...prev, [motivo]: true }));
    try {
      const res = await fetch(`${API_BASE}/api/lab/scenarios/results/${encodeURIComponent(runId)}/${encodeURIComponent(motivo)}`, {
        method: "PATCH",
        headers: getCommonHeaders(),
        body: JSON.stringify(payload),
      });
      const txt = await res.text();
      if (!res.ok) {
        let j: any; try { j = JSON.parse(txt); } catch {}
        throw new Error(j?.error || `Erro HTTP ${res.status}`);
      }
      toast({ title: "Resultados atualizados", description: `Motivo "${motivo}" salvo com sucesso.` });
      await loadResults();
      cancelEdit(motivo);
    } catch (e: any) {
      toast({ title: "Erro ao salvar edições", description: String(e?.message || e), variant: "destructive" });
    } finally {
      setSaving((prev) => ({ ...prev, [motivo]: false }));
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

  // Exibição de "atendimentos amostrados" sem somar motivos diferentes:
  // - Se houver exatamente 1 motivo, o topo mostra o progresso desse motivo (processed/total).
  // - Caso contrário, não soma motivos distintos no topo.
  const singleMotivo = useMemo(() => {
    const list = progress?.motivos || [];
    return list.length === 1 ? list[0] : null;
  }, [progress?.motivos]);

  const overallPct = useMemo(() => {
    if (singleMotivo) {
      const tot = Number(singleMotivo.total_ids_distinct || 0);
      const proc = Number(singleMotivo.processed_ids_distinct || 0);
      if (tot <= 0) return 0;
      return Math.min(100, Math.round((proc / tot) * 100));
    }
    return 0;
  }, [singleMotivo]);

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
              <Button onClick={handleUpload} disabled={!canUpload}>{uploading ? "Enviando..." : "Enviar"}</Button>
            </div>
          </div>

          {/* Mensagens de preview e validação */}
          {previewLoading && (
            <div className="mt-3 text-sm text-muted-foreground">Lendo cabeçalhos e gerando preview...</div>
          )}
          {mappingError && (
            <div className="mt-3 text-sm text-destructive">{mappingError}</div>
          )}
          {insufficientColumns && (
            <div className="mt-3 text-sm text-destructive">
              Arquivo possui menos colunas ({previewHeaders.length}) do que o necessário ({requiredCanonicals.length}). Selecione outro arquivo.
            </div>
          )}

          {/* UI de mapeamento - exibida somente quando não estiver totalmente canônico */}
          {file && !previewLoading && !insufficientColumns && !canonicalComplete && previewHeaders.length > 0 && (
            <div className="mt-4 border-t pt-4">
              <h3 className="font-medium mb-2">Mapeamento de Colunas</h3>
              <p className="text-xs text-muted-foreground mb-3">
                Selecione para cada campo canônico a coluna correspondente do seu arquivo. Colunas extras serão ignoradas.
              </p>
              <div className="grid gap-3 md:grid-cols-2">
                {requiredCanonicals.map((ckey) => (
                  <div key={ckey} className="grid gap-1">
                    <div className="flex items-center gap-2">
                      <Label>{ckey}</Label>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-muted text-foreground cursor-default">
                            <Info className="w-3 h-3" />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          <p className="text-xs">{canonicalDescriptions[ckey]}</p>
                        </TooltipContent>
                      </Tooltip>
                    </div>
                    <Select
                      value={mapping[ckey] || ""}
                      onValueChange={(v) => {
                        const next = { ...mapping, [ckey]: v };
                        setMapping(next);
                        const err = validateMapping(next);
                        setMappingError(err);
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Selecione a coluna..." />
                      </SelectTrigger>
                      <SelectContent>
                        {previewHeaders.map((h) => (
                          <SelectItem key={`${ckey}-${h}`} value={h}>{h}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
              {mappingError && (
                <p className="text-xs text-destructive mt-2">{mappingError}</p>
              )}
            </div>
          )}

          {/* Avisos pós-upload */}
          {warnings.length > 0 && (
            <div className="mt-3">
              <p className="text-sm text-muted-foreground">Avisos:</p>
              <div className="max-h-48 overflow-y-auto rounded-md border bg-background/50 p-2">
                <ul className="text-sm list-disc list-inside pr-2">
                  {warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </div>
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
              <div className="flex items-center gap-2">
                <Label htmlFor="max-per-motivo" className="text-xs">Qtd por motivo</Label>
                <Input
                  id="max-per-motivo"
                  type="number"
                  placeholder="Opcional..."
                  value={maxPerMotivo}
                  onChange={(e) => {
                    // permite vazio; quando preenchido, deve ser inteiro positivo
                    setMaxPerMotivo(e.target.value);
                  }}
                  className="w-28 h-8 text-sm"
                />
              </div>
              <Button variant="outline" onClick={async () => { await loadResults(); }} disabled={!runId}>Carregar Resultados</Button>
              <Button onClick={handleStartAnalysis} disabled={!runId || runStatus === "running"}>Iniciar Análise</Button>
            </div>
          </div>

          <div className="mt-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm">Atendimentos amostrados</span>
              <span className="text-xs text-muted-foreground">
                {singleMotivo ? (
                  <>
                    {singleMotivo.processed_ids_distinct} / {singleMotivo.total_ids_distinct}
                  </>
                ) : (
                  <>—</>
                )}
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
              const motivo = r.motivo;
              const isCommitted = committed.has(motivo);
              const committingNow = committing[motivo];
              const canCommit = String(r.status || "").toLowerCase() === "ready";
              const isEditing = !!editing[motivo];
              const isSaving = !!saving[motivo];
              const form = editForm[motivo];

              return (
                <Card key={motivo} className="p-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-semibold">
                        {isEditing ? (
                          <Input
                            value={form?.scenario_title ?? (r.scenario_title || r.motivo || "")}
                            onChange={(e) => updateFormField(motivo, "scenario_title", e.target.value)}
                          />
                        ) : (
                          r.scenario_title || r.motivo
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">Motivo: {motivo}</div>
                      <div className="text-xs text-muted-foreground">Status: {r.status || "-"}</div>
                      {r.updated_at && <div className="text-xs text-muted-foreground">Atualizado: {new Date(r.updated_at).toLocaleString()}</div>}
                    </div>
                    <div className="flex items-center gap-2">
                      {!isEditing && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => startEdit(motivo, r)}
                        >
                          Editar
                        </Button>
                      )}
                      {isEditing && (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => cancelEdit(motivo)}
                            disabled={isSaving}
                          >
                            Descartar
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => saveEdit(motivo)}
                            disabled={isSaving}
                          >
                            {isSaving ? "Salvando..." : "Salvar alterações"}
                          </Button>
                        </>
                      )}
                      <Button
                        variant={isCommitted ? "outline" : "default"}
                        disabled={!canCommit || committingNow || isCommitted || isEditing}
                        onClick={() => handleCommit(motivo)}
                      >
                        {isCommitted ? "Commitado" : committingNow ? "Commitando..." : "Commit"}
                      </Button>
                    </div>
                  </div>

                  {/* Perfis de Cliente */}
                  <div className="grid md:grid-cols-2 gap-3 mt-3">
                    <div className="grid gap-2">
                      <div className="font-medium">Perfis de Cliente</div>
                      {isEditing ? (
                        <div className="grid gap-2">
                          {(form?.customer_profiles || []).map((p, i) => (
                            <div key={`cp-${motivo}-${i}`} className="flex gap-2">
                              <Input
                                value={p}
                                onChange={(e) => updateListItem(motivo, "customer_profiles", i, e.target.value)}
                              />
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => removeListItem(motivo, "customer_profiles", i)}
                              >
                                Remover
                              </Button>
                            </div>
                          ))}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => addListItem(motivo, "customer_profiles")}
                            disabled={(form?.customer_profiles || []).length >= 6}
                          >
                            Adicionar Perfil
                          </Button>
                        </div>
                      ) : (
                        Array.isArray(r.customer_profiles) && r.customer_profiles.length > 0 ? (
                          <ul className="list-disc list-inside text-sm text-muted-foreground">
                            {r.customer_profiles.map((p, i) => <li key={i}>{p}</li>)}
                          </ul>
                        ) : (
                          <p className="text-sm text-muted-foreground">Nenhum perfil.</p>
                        )
                      )}
                    </div>

                    {/* Diretrizes do Atendente */}
                    <div className="grid gap-2">
                      <div className="font-medium">Diretrizes do Atendente</div>
                      {isEditing ? (
                        <div className="grid gap-2">
                          {(form?.operator_guidelines || []).map((g, i) => (
                            <div key={`og-${motivo}-${i}`} className="flex gap-2">
                              <Input
                                value={g}
                                onChange={(e) => updateListItem(motivo, "operator_guidelines", i, e.target.value)}
                              />
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => removeListItem(motivo, "operator_guidelines", i)}
                              >
                                Remover
                              </Button>
                            </div>
                          ))}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => addListItem(motivo, "operator_guidelines")}
                            disabled={(form?.operator_guidelines || []).length >= 20}
                          >
                            Adicionar Diretriz
                          </Button>
                        </div>
                      ) : (
                        Array.isArray(r.operator_guidelines) && r.operator_guidelines.length > 0 ? (
                          <ul className="list-disc list-inside text-sm text-muted-foreground">
                            {r.operator_guidelines.map((g, i) => <li key={i}>{g}</li>)}
                          </ul>
                        ) : (
                          <p className="text-sm text-muted-foreground">Nenhuma diretriz.</p>
                        )
                      )}
                    </div>
                  </div>

                  {/* Processo */}
                  <div className="grid gap-2 mt-3">
                    <div className="font-medium">Processo (Resumo)</div>
                    {isEditing ? (
                      <Textarea
                        value={form?.process_text ?? (r.process_text || "")}
                        onChange={(e) => updateFormField(motivo, "process_text", e.target.value)}
                        className="min-h-[120px]"
                      />
                    ) : r.process_text ? (
                      <div className="text-sm text-muted-foreground whitespace-pre-wrap">{r.process_text}</div>
                    ) : (
                      <p className="text-sm text-muted-foreground">Sem processo extraído.</p>
                    )}
                  </div>

                  {/* Padrões */}
                  <div className="grid gap-2 mt-3">
                    <div className="font-medium">Padrões</div>
                    {isEditing ? (
                      <div className="grid gap-2">
                        {(form?.patterns || []).map((p, i) => (
                          <div key={`pt-${motivo}-${i}`} className="flex gap-2">
                            <Input
                              value={p}
                              onChange={(e) => updateListItem(motivo, "patterns", i, e.target.value)}
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => removeListItem(motivo, "patterns", i)}
                            >
                              Remover
                            </Button>
                          </div>
                        ))}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => addListItem(motivo, "patterns")}
                          disabled={(form?.patterns || []).length >= 20}
                        >
                          Adicionar Padrão
                        </Button>
                      </div>
                    ) : Array.isArray(r.patterns) && r.patterns.length > 0 ? (
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
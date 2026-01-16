import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { getAuthHeader, getCommonHeaders, getClientId } from "@/lib/auth";
import { EllipsisVertical, RefreshCw, Save, Plus, X } from "lucide-react";

type ScenarioItem = {
  id: string;
  motivo_label: string;
  title: string;
  status: "active" | "archived";
  metadata?: any;
  profiles?: string[];
};

type ScenarioDetails = {
  id: string;
  motivo_label: string;
  title: string;
  profiles: string[];
  process_text: string;
  operator_guidelines: string[];
  patterns: string[];
};

type MeResponse = {
  user: { id: string; email: string; is_admin?: boolean };
  clients: Array<{
    client_id: string;
    client_name: string;
    client_code?: string;
    permissions: {
      can_manage_scenarios: boolean;
      can_start_chat: boolean;
      can_edit_kb: boolean;
      can_view_team_chats: boolean;
      can_view_all_client_chats: boolean;
    };
  }>;
};

const API_BASE = import.meta.env?.VITE_API_BASE_URL || "";

const Scenarios: React.FC = () => {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [authChecked, setAuthChecked] = useState(false);
  const [canManage, setCanManage] = useState(false);

  const [items, setItems] = useState<ScenarioItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Dialog de edição
  const [editOpen, setEditOpen] = useState(false);
  const [editingId, setEditingId] = useState<string>("");
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState<{
    scenario_title: string;
    customer_profiles: string[];
    process_text: string;
    operator_guidelines: string[];
    patterns: string[];
  }>({
    scenario_title: "",
    customer_profiles: [],
    process_text: "",
    operator_guidelines: [],
    patterns: [],
  });

  const selectedClientId = useMemo(() => getClientId(), []);

  async function ensurePermission() {
    try {
      const res = await fetch(`${API_BASE}/api/auth/me`, {
        headers: {
          ...getAuthHeader(),
          "Content-Type": "application/json",
        },
      });
      const data: MeResponse & any = await res.json();
      if (!res.ok) {
        setCanManage(false);
        setAuthChecked(true);
        navigate("/", { replace: true });
        return;
      }
      const cid = selectedClientId;
      const found = Array.isArray(data.clients) ? data.clients.find((c: any) => c.client_id === cid) : null;
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

  async function loadScenarios() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/scenarios?status=active`, {
        headers: getCommonHeaders(),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || `Erro HTTP ${res.status}`);
      }
      const arr: ScenarioItem[] = Array.isArray(data) ? data : [];
      setItems(arr);
    } catch (e: any) {
      setError(String(e?.message || e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  async function loadDetails(id: string) {
    setDetailsLoading(true);
    setDetailsError(null);
    try {
      const res = await fetch(`${API_BASE}/api/scenarios/${encodeURIComponent(id)}/details`, {
        headers: getCommonHeaders(),
      });
      const data: ScenarioDetails = await res.json();
      if (!res.ok) {
        throw new Error((data as any)?.error || `Erro HTTP ${res.status}`);
      }
      setForm({
        scenario_title: String(data.title || data.motivo_label || ""),
        customer_profiles: Array.isArray(data.profiles) ? [...data.profiles] : [],
        process_text: String(data.process_text || ""),
        operator_guidelines: Array.isArray(data.operator_guidelines) ? [...data.operator_guidelines] : [],
        patterns: Array.isArray(data.patterns) ? [...data.patterns] : [],
      });
    } catch (e: any) {
      setDetailsError(String(e?.message || e));
      setForm({
        scenario_title: "",
        customer_profiles: [],
        process_text: "",
        operator_guidelines: [],
        patterns: [],
      });
    } finally {
      setDetailsLoading(false);
    }
  }

  useEffect(() => {
    ensurePermission();
    const handler = () => {
      ensurePermission();
      loadScenarios();
    };
    window.addEventListener("client:changed", handler as any);
    return () => window.removeEventListener("client:changed", handler as any);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (authChecked && canManage) {
      loadScenarios();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authChecked, canManage]);

  // Abrir modal de edição quando houver ?edit=:id na URL
  useEffect(() => {
    if (!authChecked || !canManage) return;
    const id = searchParams.get("edit");
    if (id) {
      setEditingId(id);
      setEditOpen(true);
      loadDetails(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authChecked, canManage, searchParams]);

  function startEdit(id: string) {
    setEditingId(id);
    setEditOpen(true);
    try {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("edit", id);
        return next;
      });
    } catch {}
    loadDetails(id);
  }

  function closeEdit() {
    setEditOpen(false);
    setEditingId("");
    setDetailsError(null);
    try {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete("edit");
        return next;
      });
    } catch {}
  }

  function updateField<K extends keyof typeof form>(key: K, value: any) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function updateListItem(key: "customer_profiles" | "operator_guidelines" | "patterns", idx: number, value: string) {
    setForm((prev) => {
      const arr = Array.isArray(prev[key]) ? [...prev[key]] : [];
      arr[idx] = value;
      return { ...prev, [key]: arr };
    });
  }

  function addListItem(key: "customer_profiles" | "operator_guidelines" | "patterns") {
    setForm((prev) => {
      const arr = Array.isArray(prev[key]) ? [...prev[key]] : [];
      arr.push("");
      return { ...prev, [key]: arr };
    });
  }

  function removeListItem(key: "customer_profiles" | "operator_guidelines" | "patterns", idx: number) {
    setForm((prev) => {
      const arr = Array.isArray(prev[key]) ? [...prev[key]] : [];
      arr.splice(idx, 1);
      return { ...prev, [key]: arr };
    });
  }

  async function saveFork() {
    if (!editingId) return;
    setSaving(true);
    try {
      const payload = {
        scenario_title: String(form.scenario_title || "").trim(),
        customer_profiles: (form.customer_profiles || []).map((s) => String(s || "").trim()).filter(Boolean).slice(0, 6),
        process_text: typeof form.process_text === "string" ? form.process_text : null,
        operator_guidelines: (form.operator_guidelines || []).map((s) => String(s || "").trim()).filter(Boolean).slice(0, 20),
        patterns: (form.patterns || []).map((s) => String(s || "").trim()).filter(Boolean).slice(0, 20),
      };
      const res = await fetch(`${API_BASE}/api/scenarios/${encodeURIComponent(editingId)}/fork`, {
        method: "POST",
        headers: getCommonHeaders(),
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((data as any)?.error || `Erro HTTP ${res.status}`);
      }
      toast({ title: "Nova versão criada", description: `Cenário atualizado para "${payload.scenario_title}" e anterior arquivado.` });
      closeEdit();
      // Após fork, recarrega lista (somente "active")
      await loadScenarios();
    } catch (e: any) {
      toast({ title: "Erro ao salvar alterações", description: String(e?.message || e), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (!authChecked) {
    return <div className="min-h-screen bg-background" />;
  }

  return (
    <div className="min-h-screen p-4">
      <div className="max-w-5xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={() => navigate("/")} title="Voltar para início">
              Voltar
            </Button>
            <h2 className="text-xl font-semibold">Cenários</h2>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => loadScenarios()} disabled={loading}>
              <RefreshCw className="w-4 h-4 mr-2" />
              Recarregar
            </Button>
          </div>
        </div>

        {!canManage && (
          <Card className="p-4 border-destructive/50">
            <p className="text-sm text-destructive">Você não possui permissão para gerenciar cenários neste cliente.</p>
          </Card>
        )}

        <div className="grid gap-3">
          {loading && <Card className="p-4">Carregando...</Card>}
          {error && !loading && (
            <Card className="p-4 border-destructive/50">
              <p className="text-sm text-destructive">{error}</p>
            </Card>
          )}
          {!loading && !error && items.length === 0 && (
            <Card className="p-8 text-center border-border">
              <p className="text-muted-foreground">Nenhum cenário ativo encontrado.</p>
            </Card>
          )}
          {items.map((sc) => (
            <Card key={sc.id} className="p-4">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-foreground">{sc.title}</h3>
                    <Badge variant={sc.status === "active" ? "secondary" : "outline"}>
                      {sc.status === "active" ? "Ativo" : "Arquivado"}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">Motivo: {sc.motivo_label}</p>
                  <div className="mt-2">
                    {Array.isArray(sc.profiles) && sc.profiles.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {sc.profiles.map((p, i) => (
                          <Badge key={`${sc.id}-pf-${i}`} variant="outline">{p}</Badge>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">Sem perfis listados.</p>
                    )}
                  </div>
                </div>
                <div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 hover:text-accent-foreground h-10 w-10 hover:bg-muted"
                      >
                        <EllipsisVertical />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => startEdit(sc.id)}>
                        Editar informações
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </Card>
          ))}
        </div>

        {/* Dialog de edição (UI igual ao Lab) */}
        <Dialog open={editOpen} onOpenChange={(open) => (open ? setEditOpen(true) : closeEdit())}>
          <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Editar Cenário</DialogTitle>
            </DialogHeader>
            {detailsLoading && <div className="text-sm text-muted-foreground">Carregando detalhes...</div>}
            {detailsError && !detailsLoading && <div className="text-sm text-destructive">{detailsError}</div>}
            {!detailsLoading && !detailsError && (
              <div className="grid gap-4">
                {/* Título do cenário */}
                <div className="grid gap-1.5">
                  <Label>Título do cenário</Label>
                  <Input
                    value={form.scenario_title}
                    onChange={(e) => updateField("scenario_title", e.target.value)}
                    placeholder="Ex.: 'Reativação de cartão bloqueado'"
                  />
                </div>

                {/* Perfis de cliente */}
                <div className="grid gap-2">
                  <div className="flex items-center justify-between">
                    <Label>Perfis de Cliente</Label>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => addListItem("customer_profiles")}
                      disabled={(form.customer_profiles || []).length >= 6}
                    >
                      <Plus className="w-4 h-4 mr-2" />
                      Adicionar Perfil
                    </Button>
                  </div>
                  <div className="grid gap-2">
                    {(form.customer_profiles || []).map((p, i) => (
                      <div key={`cp-${i}`} className="flex gap-2">
                        <Input
                          value={p}
                          onChange={(e) => updateListItem("customer_profiles", i, e.target.value)}
                          placeholder="Ex.: Cliente Irritado"
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => removeListItem("customer_profiles", i)}
                          className="text-destructive hover:text-destructive"
                          title="Remover"
                        >
                          <X className="w-4 h-4" />
                        </Button>
                      </div>
                    ))}
                    {(form.customer_profiles || []).length === 0 && (
                      <p className="text-xs text-muted-foreground">Nenhum perfil listado.</p>
                    )}
                  </div>
                </div>

                {/* Diretrizes do atendente */}
                <div className="grid gap-2">
                  <div className="flex items-center justify-between">
                    <Label>Diretrizes do Atendente</Label>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => addListItem("operator_guidelines")}
                      disabled={(form.operator_guidelines || []).length >= 20}
                    >
                      <Plus className="w-4 h-4 mr-2" />
                      Adicionar Diretriz
                    </Button>
                  </div>
                  <div className="grid gap-2">
                    {(form.operator_guidelines || []).map((g, i) => (
                      <div key={`og-${i}`} className="flex gap-2">
                        <Input
                          value={g}
                          onChange={(e) => updateListItem("operator_guidelines", i, e.target.value)}
                          placeholder="Ex.: Confirmar dados do cliente com simpatia"
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => removeListItem("operator_guidelines", i)}
                          className="text-destructive hover:text-destructive"
                          title="Remover"
                        >
                          <X className="w-4 h-4" />
                        </Button>
                      </div>
                    ))}
                    {(form.operator_guidelines || []).length === 0 && (
                      <p className="text-xs text-muted-foreground">Nenhuma diretriz listada.</p>
                    )}
                  </div>
                </div>

                {/* Processo */}
                <div className="grid gap-1.5">
                  <Label>Processo (Resumo)</Label>
                  <Textarea
                    value={form.process_text}
                    onChange={(e) => updateField("process_text", e.target.value)}
                    placeholder="Descreva o processo objetivo (passo a passo resumido)"
                    className="min-h-[120px]"
                  />
                </div>

                {/* Padrões */}
                <div className="grid gap-2">
                  <div className="flex items-center justify-between">
                    <Label>Padrões</Label>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => addListItem("patterns")}
                      disabled={(form.patterns || []).length >= 20}
                    >
                      <Plus className="w-4 h-4 mr-2" />
                      Adicionar Padrão
                    </Button>
                  </div>
                  <div className="grid gap-2">
                    {(form.patterns || []).map((p, i) => (
                      <div key={`pt-${i}`} className="flex gap-2">
                        <Input
                          value={p}
                          onChange={(e) => updateListItem("patterns", i, e.target.value)}
                          placeholder="Ex.: Validação de identidade em 2 etapas"
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => removeListItem("patterns", i)}
                          className="text-destructive hover:text-destructive"
                          title="Remover"
                        >
                          <X className="w-4 h-4" />
                        </Button>
                      </div>
                    ))}
                    {(form.patterns || []).length === 0 && (
                      <p className="text-xs text-muted-foreground">Nenhum padrão listado.</p>
                    )}
                  </div>
                </div>

                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={closeEdit} disabled={saving}>
                    Descartar
                  </Button>
                  <Button onClick={saveFork} disabled={saving}>
                    <Save className="w-4 h-4 mr-2" />
                    {saving ? "Salvando..." : "Salvar alterações"}
                  </Button>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
};

export default Scenarios;
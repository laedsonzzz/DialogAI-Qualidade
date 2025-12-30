import { useState, useEffect } from "react";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { Input } from "./ui/input";
import { Card } from "./ui/card";
import { useToast } from "@/hooks/use-toast";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "./ui/select";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "./ui/alert-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { Plus, Trash2, Upload, Archive, RotateCcw } from "lucide-react";
import { getCommonHeaders, getAuthHeader, getClientId } from "@/lib/auth";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription, DrawerClose } from "./ui/drawer";
import { Switch } from "./ui/switch";
import GraphViewer from "./GraphViewer";

interface KnowledgeEntry {
  id: string;
  title: string;
  category: string;
  content: string;
  status: "active" | "archived";
  created_at?: string;
  updated_at?: string;
}

interface KbSource {
  id: string;
  kb_type: "cliente" | "operador";
  source_kind: "document" | "free_text";
  title: string;
  original_filename?: string | null;
  mime_type?: string | null;
  size_bytes?: number | null;
  status: "active" | "archived";
  created_by?: string | null;
  created_at?: string;
  updated_at?: string;
}

export const KnowledgeBaseManager = () => {
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("");
  const [content, setContent] = useState("");
  const [filterStatusLegacy, setFilterStatusLegacy] = useState<"active" | "archived" | "all">("active");

  // RAG states
  const [activeKbTab, setActiveKbTab] = useState<"cliente" | "operador">("cliente");
  const [filterStatusCliente, setFilterStatusCliente] = useState<"active" | "archived" | "all">("active");
  const [filterStatusOperador, setFilterStatusOperador] = useState<"active" | "archived" | "all">("active");
  const [sourcesCliente, setSourcesCliente] = useState<KbSource[]>([]);
  const [sourcesOperador, setSourcesOperador] = useState<KbSource[]>([]);
  const [uploadFilesCliente, setUploadFilesCliente] = useState<FileList | null>(null);
  const [uploadFilesOperador, setUploadFilesOperador] = useState<FileList | null>(null);
  const [uploadTitleCliente, setUploadTitleCliente] = useState<string>("");
  const [uploadTitleOperador, setUploadTitleOperador] = useState<string>("");
  const [piiModeCliente, setPiiModeCliente] = useState<"default" | "raw">("default");
  const [piiModeOperador, setPiiModeOperador] = useState<"default" | "raw">("default");
  const [textTitleCliente, setTextTitleCliente] = useState<string>("");
  const [textContentCliente, setTextContentCliente] = useState<string>("");
  const [textTitleOperador, setTextTitleOperador] = useState<string>("");
  const [textContentOperador, setTextContentOperador] = useState<string>("");
  const [loadingUpload, setLoadingUpload] = useState<boolean>(false);
  const [loadingText, setLoadingText] = useState<boolean>(false);
  const [loadingList, setLoadingList] = useState<boolean>(false);

  const [showArchiveDialog, setShowArchiveDialog] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<KnowledgeEntry | null>(null);
  const [conflictCount, setConflictCount] = useState<number | null>(null);
  const { toast } = useToast();

  const [canEditKB, setCanEditKB] = useState<boolean>(false);
  // Graph Drawer state
  const [showGraphDrawer, setShowGraphDrawer] = useState<boolean>(false);
  const [graphSource, setGraphSource] = useState<KbSource | null>(null);
  const [graphPiiMode, setGraphPiiMode] = useState<"default" | "raw">("default");

  const API_BASE = import.meta.env?.VITE_API_BASE_URL || "";

  useEffect(() => {
    loadEntries();
    loadPermissions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload legacy when filter changes
  useEffect(() => {
    loadEntries();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterStatusLegacy]);

  // Reload when client changes (broadcast from ClientSwitcher)
  useEffect(() => {
    const handler = () => {
      loadPermissions();
      loadEntries();
      setShowForm(false);
      setTitle("");
      setCategory("");
      setContent("");
      // Reload RAG sources for both contexts
      loadSources("cliente", filterStatusCliente);
      loadSources("operador", filterStatusOperador);
    };
    window.addEventListener("client:changed", handler as any);
    return () => {
      window.removeEventListener("client:changed", handler as any);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Initial RAG load
    loadSources("cliente", filterStatusCliente);
    loadSources("operador", filterStatusOperador);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadSources("cliente", filterStatusCliente);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterStatusCliente]);

  useEffect(() => {
    loadSources("operador", filterStatusOperador);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterStatusOperador]);

  async function apiGet<T>(path: string): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: getCommonHeaders(),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `Erro HTTP ${res.status}`);
    }
    return res.json();
  }

  async function apiPost<T>(path: string, body: any): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: getCommonHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `Erro HTTP ${res.status}`);
    }
    return res.json();
  }

  async function apiPatch<T>(path: string, body: any): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "PATCH",
      headers: getCommonHeaders(),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      let json: any;
      try { json = JSON.parse(text); } catch {}
      const err = new Error(json?.error || text || `Erro HTTP ${res.status}`);
      (err as any).status = res.status;
      (err as any).code = json?.code;
      throw err;
    }
    try { return JSON.parse(text); } catch { return text as unknown as T; }
  }

  async function apiDelete<T>(path: string): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "DELETE",
      headers: getCommonHeaders(),
    });
    const text = await res.text();
    if (!res.ok) {
      let json: any;
      try { json = JSON.parse(text); } catch {}
      const err = new Error(json?.error || text || `Erro HTTP ${res.status}`);
      (err as any).status = res.status;
      (err as any).code = json?.code;
      (err as any).referencedCount = json?.referencedCount;
      throw err;
    }
    try { return JSON.parse(text); } catch { return text as unknown as T; }
  }

  async function loadPermissions() {
    try {
      const res = await fetch(`${API_BASE}/api/auth/me`, {
        headers: {
          ...getAuthHeader(),
          "Content-Type": "application/json",
        },
      });
      if (!res.ok) {
        setCanEditKB(false);
        return;
      }
      const data = await res.json();
      const cid = typeof getClientId === "function" ? getClientId() : null;
      const found = (data.clients || []).find((c: any) => c.client_id === cid);
      setCanEditKB(Boolean(found?.permissions?.can_edit_kb));
    } catch {
      setCanEditKB(false);
    }
  }

  const loadEntries = async () => {
    try {
      const statusParam = filterStatusLegacy === "all" ? "all" : filterStatusLegacy;
      const data = await apiGet<KnowledgeEntry[]>(`/api/knowledge_base?status=${statusParam}`);
      setEntries(data || []);
    } catch (error: any) {
      toast({
        title: "Erro ao carregar processos",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  // RAG API helpers
  async function loadSources(kbType: "cliente" | "operador", status: "active" | "archived" | "all") {
    try {
      setLoadingList(true);
      const statusParam = status === "all" ? "all" : status;
      const list = await apiGet<KbSource[]>(`/api/kb/sources?kb_type=${kbType}&status=${statusParam}`);
      if (kbType === "cliente") setSourcesCliente(list || []);
      else setSourcesOperador(list || []);
    } catch (e: any) {
      toast({
        title: `Erro ao listar fontes (${kbType})`,
        description: e.message,
        variant: "destructive",
      });
      if (kbType === "cliente") setSourcesCliente([]);
      else setSourcesOperador([]);
    } finally {
      setLoadingList(false);
    }
  }

  // Graph Drawer handlers
  function openGraph(source: KbSource) {
    setGraphSource(source);
    setGraphPiiMode("default");
    setShowGraphDrawer(true);
  }
  function closeGraph() {
    setShowGraphDrawer(false);
    setGraphSource(null);
  }

  async function uploadDocuments(kbType: "cliente" | "operador") {
    if (!canEditKB) {
      toast({
        title: "Ação não permitida",
        description: "Você não possui permissão para editar a base de conhecimento neste cliente.",
        variant: "destructive",
      });
      return;
    }
    const files = kbType === "cliente" ? uploadFilesCliente : uploadFilesOperador;
    const titleSingle = kbType === "cliente" ? uploadTitleCliente : uploadTitleOperador;
    const piiMode = kbType === "cliente" ? piiModeCliente : piiModeOperador;
    if (!files || files.length === 0) {
      toast({
        title: "Selecione ao menos um arquivo",
        description: "Suporte a PDF, DOCX e TXT.",
        variant: "destructive",
      });
      return;
    }

    try {
      setLoadingUpload(true);
      const fd = new FormData();
      Array.from(files).forEach((f) => fd.append("files", f));
      fd.append("kb_type", kbType);
      fd.append("pii_mode", piiMode);
      if (files.length === 1 && titleSingle.trim()) {
        fd.append("title", titleSingle.trim());
      }

      const cid = typeof getClientId === "function" ? getClientId() : null;
      const headers: Record<string, string> = {
        ...getAuthHeader(),
      };
      if (cid) headers["x-client-id"] = cid;

      const res = await fetch(`${API_BASE}/api/kb/sources/upload`, {
        method: "POST",
        headers,
        body: fd,
      });

      const text = await res.text();
      if (!res.ok) {
        let json: any;
        try { json = JSON.parse(text); } catch {}
        throw new Error(json?.error || text || `Erro HTTP ${res.status}`);
      }
      let json: any;
      try { json = JSON.parse(text); } catch { json = text; }

      toast({
        title: "Fontes carregadas",
        description: `Criadas ${json?.created?.length ?? 0} fontes (${kbType}).`,
      });

      // Reset inputs
      if (kbType === "cliente") {
        setUploadFilesCliente(null);
        setUploadTitleCliente("");
      } else {
        setUploadFilesOperador(null);
        setUploadTitleOperador("");
      }

      // Refresh list
      await loadSources(kbType, kbType === "cliente" ? filterStatusCliente : filterStatusOperador);
    } catch (e: any) {
      toast({
        title: "Erro ao enviar documentos",
        description: e.message,
        variant: "destructive",
      });
    } finally {
      setLoadingUpload(false);
    }
  }

  async function createTextSource(kbType: "cliente" | "operador") {
    if (!canEditKB) {
      toast({
        title: "Ação não permitida",
        description: "Você não possui permissão para editar a base de conhecimento neste cliente.",
        variant: "destructive",
      });
      return;
    }

    const tTitle = kbType === "cliente" ? textTitleCliente.trim() : textTitleOperador.trim();
    const tContent = kbType === "cliente" ? textContentCliente : textContentOperador;
    const piiMode = kbType === "cliente" ? piiModeCliente : piiModeOperador;
    if (!tTitle || !tContent || !tContent.trim()) {
      toast({
        title: "Preencha título e conteúdo",
        description: "Título e conteúdo são obrigatórios para fonte de texto.",
        variant: "destructive",
      });
      return;
    }

    try {
      setLoadingText(true);
      await apiPost(`/api/kb/sources/text`, {
        kb_type: kbType,
        title: tTitle,
        content: tContent,
        pii_mode: piiMode,
      });

      toast({
        title: "Fonte de texto criada",
        description: `A fonte foi criada no contexto ${kbType}.`,
      });

      if (kbType === "cliente") {
        setTextTitleCliente("");
        setTextContentCliente("");
      } else {
        setTextTitleOperador("");
        setTextContentOperador("");
      }

      await loadSources(kbType, kbType === "cliente" ? filterStatusCliente : filterStatusOperador);
    } catch (e: any) {
      toast({
        title: "Erro ao criar fonte de texto",
        description: e.message,
        variant: "destructive",
      });
    } finally {
      setLoadingText(false);
    }
  }

  async function archiveSource(id: string) {
    if (!canEditKB) {
      toast({
        title: "Ação não permitida",
        description: "Você não possui permissão para editar a base de conhecimento neste cliente.",
        variant: "destructive",
      });
      return;
    }
    try {
      await apiPatch(`/api/kb/sources/${id}`, { status: "archived" });
      toast({ title: "Fonte arquivada" });
      await loadSources("cliente", filterStatusCliente);
      await loadSources("operador", filterStatusOperador);
    } catch (e: any) {
      toast({
        title: "Erro ao arquivar fonte",
        description: e.message,
        variant: "destructive",
      });
    }
  }

  async function reactivateSource(id: string) {
    if (!canEditKB) {
      toast({
        title: "Ação não permitida",
        description: "Você não possui permissão para editar a base de conhecimento neste cliente.",
        variant: "destructive",
      });
      return;
    }
    try {
      await apiPatch(`/api/kb/sources/${id}`, { status: "active" });
      toast({ title: "Fonte reativada" });
      await loadSources("cliente", filterStatusCliente);
      await loadSources("operador", filterStatusOperador);
    } catch (e: any) {
      toast({
        title: "Erro ao reativar fonte",
        description: e.message,
        variant: "destructive",
      });
    }
  }

  async function deleteSource(id: string) {
    if (!canEditKB) {
      toast({
        title: "Ação não permitida",
        description: "Você não possui permissão para editar a base de conhecimento neste cliente.",
        variant: "destructive",
      });
      return;
    }
    try {
      await apiDelete(`/api/kb/sources/${id}`);
      toast({ title: "Fonte excluída" });
      await loadSources("cliente", filterStatusCliente);
      await loadSources("operador", filterStatusOperador);
    } catch (e: any) {
      toast({
        title: "Erro ao excluir fonte",
        description: e.message,
        variant: "destructive",
      });
    }
  }

  const handleSubmitLegacy = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!canEditKB) {
      toast({
        title: "Ação não permitida",
        description: "Você não possui permissão para editar a base de conhecimento neste cliente.",
        variant: "destructive",
      });
      return;
    }

    try {
      await apiPost("/api/knowledge_base", {
        title,
        category,
        content,
      });

      toast({
        title: "Processo salvo com sucesso!",
        description: "O processo está disponível para uso nas simulações.",
      });

      setTitle("");
      setCategory("");
      setContent("");
      setShowForm(false);
      loadEntries();
    } catch (error: any) {
      toast({
        title: "Erro ao salvar processo",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const handleDeleteLegacy = async (id: string) => {
    if (!canEditKB) {
      toast({
        title: "Ação não permitida",
        description: "Você não possui permissão para editar a base de conhecimento neste cliente.",
        variant: "destructive",
      });
      return;
    }
    try {
      await apiDelete(`/api/knowledge_base/${id}`);
      toast({ title: "Processo excluído" });
      loadEntries();
    } catch (error: any) {
      // Se estiver em uso, abrir pop-up para Arquivar
      if ((error as any)?.status === 409 && (error as any)?.code === "KB_IN_USE") {
        const target = entries.find((e) => e.id === id) || null;
        setArchiveTarget(target);
        setConflictCount((error as any)?.referencedCount ?? null);
        setShowArchiveDialog(true);
        return;
      }
      toast({
        title: "Erro ao excluir processo",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const handleArchiveLegacy = async (id: string) => {
    if (!canEditKB) {
      toast({
        title: "Ação não permitida",
        description: "Você não possui permissão para editar a base de conhecimento neste cliente.",
        variant: "destructive",
      });
      return;
    }
    try {
      await apiPatch(`/api/knowledge_base/${id}`, { status: "archived" });
      toast({ title: "Processo arquivado" });
      setShowArchiveDialog(false);
      setArchiveTarget(null);
      setConflictCount(null);
      loadEntries();
    } catch (error: any) {
      toast({
        title: "Erro ao arquivar processo",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const handleReactivateLegacy = async (id: string) => {
    if (!canEditKB) {
      toast({
        title: "Ação não permitida",
        description: "Você não possui permissão para editar a base de conhecimento neste cliente.",
        variant: "destructive",
      });
      return;
    }
    try {
      await apiPatch(`/api/knowledge_base/${id}`, { status: "active" });
      toast({ title: "Processo reativado" });
      loadEntries();
    } catch (error: any) {
      toast({
        title: "Erro ao reativar processo",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const renderRagTab = (kbType: "cliente" | "operador") => {
    const isCliente = kbType === "cliente";
    const filterStatus = isCliente ? filterStatusCliente : filterStatusOperador;
    const setFilterStatus = isCliente ? setFilterStatusCliente : setFilterStatusOperador;
    const sources = isCliente ? sourcesCliente : sourcesOperador;
    const uploadFiles = isCliente ? uploadFilesCliente : uploadFilesOperador;
    const setUploadFiles = isCliente ? setUploadFilesCliente : setUploadFilesOperador;
    const uploadTitle = isCliente ? uploadTitleCliente : uploadTitleOperador;
    const setUploadTitle = isCliente ? setUploadTitleCliente : setUploadTitleOperador;
    const piiMode = isCliente ? piiModeCliente : piiModeOperador;
    const setPiiMode = isCliente ? setPiiModeCliente : setPiiModeOperador;
    const textTitle = isCliente ? textTitleCliente : textTitleOperador;
    const setTextTitle = isCliente ? setTextTitleCliente : setTextTitleOperador;
    const textContent = isCliente ? textContentCliente : textContentOperador;
    const setTextContent = isCliente ? setTextContentCliente : setTextContentOperador;

    return (
      <div className="grid lg:grid-cols-2 gap-6">
        {/* Ingestão por Documentos */}
        <Card className="p-4 border-border">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-foreground">
              Ingestão por Documentos ({kbType === "cliente" ? "Cliente" : "Operador"})
            </h3>
            <div className="text-xs text-muted-foreground">
              PDF, DOCX, TXT • PII: {piiMode === "default" ? "anonimizando" : "raw"}
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium text-foreground">Arquivos</label>
              <Input
                type="file"
                multiple
                onChange={(e) => setUploadFiles(e.target.files)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium text-foreground">
                  Título (opcional, usado se 1 arquivo)
                </label>
                <Input
                  value={uploadTitle}
                  onChange={(e) => setUploadTitle(e.target.value)}
                  placeholder="Ex: FAQs Cartão"
                />
              </div>
              <div>
                <label className="text-sm font-medium text-foreground">PII Mode</label>
                <Select value={piiMode} onValueChange={(v) => setPiiMode(v as any)}>
                  <SelectTrigger>
                    <SelectValue placeholder="PII Mode" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">default (anonimiza)</SelectItem>
                    <SelectItem value="raw">raw (não anonimiza)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                onClick={() => uploadDocuments(kbType)}
                disabled={!canEditKB || loadingUpload}
              >
                <Upload className="w-4 h-4 mr-2" />
                {loadingUpload ? "Enviando..." : "Enviar Documentos"}
              </Button>
            </div>
          </div>
        </Card>

        {/* Ingestão por Texto Livre */}
        <Card className="p-4 border-border">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-foreground">
              Ingestão por Texto Livre ({kbType === "cliente" ? "Cliente" : "Operador"})
            </h3>
            <div className="text-xs text-muted-foreground">
              PII: {piiMode === "default" ? "anonimizando" : "raw"}
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium text-foreground">Título</label>
              <Input
                value={textTitle}
                onChange={(e) => setTextTitle(e.target.value)}
                placeholder="Ex: Diretrizes de Atendimento"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-foreground">Conteúdo</label>
              <Textarea
                value={textContent}
                onChange={(e) => setTextContent(e.target.value)}
                placeholder={
                  isCliente
                    ? "Cole aqui fatos/FAQs do CLIENTE (ex.: política, produtos, canais, etc.)"
                    : "Cole aqui REGRAS/PILARES do ATENDENTE (ex.: scripts, pilares, boas práticas)"
                }
                className="min-h-[180px]"
              />
            </div>
            <div className="flex gap-2">
              <Button
                onClick={() => createTextSource(kbType)}
                disabled={!canEditKB || loadingText}
              >
                <Plus className="w-4 h-4 mr-2" />
                {loadingText ? "Salvando..." : "Criar Fonte de Texto"}
              </Button>
            </div>
          </div>
        </Card>

        {/* Lista de Fontes */}
        <Card className="p-4 border-border lg:col-span-2">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-foreground">Fontes ({kbType})</h3>
            <div className="flex items-center gap-2">
              <Select value={filterStatus} onValueChange={(v) => setFilterStatus(v as any)}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder="Filtrar" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Ativos</SelectItem>
                  <SelectItem value="archived">Arquivados</SelectItem>
                  <SelectItem value="all">Todos</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                onClick={() => loadSources(kbType, filterStatus)}
              >
                Recarregar
              </Button>
            </div>
          </div>

          <div className="mt-4 grid gap-3">
            {loadingList && (
              <Card className="p-4 border-dashed border-border text-sm text-muted-foreground">
                Carregando fontes...
              </Card>
            )}
            {!loadingList && sources.length === 0 && (
              <Card className="p-8 text-center border-border">
                <p className="text-muted-foreground">
                  Nenhuma fonte cadastrada neste contexto.
                </p>
              </Card>
            )}
            {!loadingList &&
              sources.map((s) => (
                <Card key={s.id} className="p-4 border-border">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <h4 className="font-semibold text-foreground">{s.title}</h4>
                        <span className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground">
                          {s.source_kind === "document" ? "documento" : "texto"}
                        </span>
                        <span className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground">
                          {s.status}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        {s.source_kind === "document" && s.original_filename
                          ? `Arquivo: ${s.original_filename} ${s.mime_type ? `(${s.mime_type})` : ""}`
                          : "Fonte de texto livre"}
                      </p>
                      {!!s.created_at && (
                        <p className="text-xs text-muted-foreground">
                          Criado em: {new Date(s.created_at).toLocaleString()}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => openGraph(s)}
                        className="text-foreground"
                      >
                        Ver Grafo
                      </Button>
                      {canEditKB ? (
                        <>
                          {s.status === "active" ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => archiveSource(s.id)}
                              className="text-foreground"
                            >
                              <Archive className="w-4 h-4 mr-1" />
                              Arquivar
                            </Button>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => reactivateSource(s.id)}
                              className="text-foreground"
                            >
                              <RotateCcw className="w-4 h-4 mr-1" />
                              Reativar
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => deleteSource(s.id)}
                            className="text-destructive hover:text-destructive"
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </div>
                </Card>
              ))}
          </div>
        </Card>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* RAG: Bases por Contexto */}
      <div className="space-y-2">
        <h2 className="text-xl font-semibold text-foreground">Base de Conhecimento (RAG)</h2>
        <p className="text-sm text-muted-foreground">
          Faça ingestão de fontes separadas por contexto:
          - Cliente: fatos/FAQs do cliente (usados no chat como contexto do cliente).
          - Operador: regras/pilares do atendimento (usados na avaliação).
        </p>
      </div>

      <Tabs value={activeKbTab} onValueChange={(v) => setActiveKbTab(v as any)}>
        <TabsList className="mb-4">
          <TabsTrigger value="cliente">Cliente</TabsTrigger>
          <TabsTrigger value="operador">Operador (Atendente)</TabsTrigger>
        </TabsList>
        <TabsContent value="cliente">
          {renderRagTab("cliente")}
        </TabsContent>
        <TabsContent value="operador">
          {renderRagTab("operador")}
        </TabsContent>
      </Tabs>

      {/* Drawer: Visualização de Grafo por Fonte */}
      <Drawer open={showGraphDrawer} onOpenChange={(open) => { setShowGraphDrawer(open); if (!open) setGraphSource(null); }}>
        <DrawerContent className="p-4">
          <DrawerHeader>
            <DrawerTitle>Grafo da Fonte</DrawerTitle>
            <DrawerDescription>
              {graphSource ? (
                <>
                  <span className="font-medium">{graphSource.title}</span> • Tipo: {graphSource.kb_type} •
                  ID: {graphSource.id}
                </>
              ) : (
                <>Selecione uma fonte para visualizar o grafo.</>
              )}
            </DrawerDescription>
          </DrawerHeader>

          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-sm text-foreground">Exibir PII</span>
              <Switch
                checked={graphPiiMode === "raw"}
                onCheckedChange={(checked) => setGraphPiiMode(checked ? "raw" : "default")}
              />
              <span className="text-xs text-muted-foreground">
                {graphPiiMode === "raw" ? "raw (não anonimiza)" : "default (anonimiza)"}
              </span>
            </div>
            <DrawerClose asChild>
              <Button variant="outline" size="sm">Fechar</Button>
            </DrawerClose>
          </div>

          {graphSource && (
            <GraphViewer
              sourceId={graphSource.id}
              kbType={graphSource.kb_type}
              piiMode={graphPiiMode}
              // Permitir extração on-demand; backend garantirá RBAC
              onRequestExtract={async () => {
                try {
                  const res = await fetch(`${API_BASE}/api/kb/graph/extract`, {
                    method: "POST",
                    headers: getCommonHeaders(),
                    body: JSON.stringify({
                      kb_type: graphSource.kb_type,
                      source_id: graphSource.id,
                      limit_chunks: 200,
                      pii_mode: graphPiiMode,
                    }),
                  });
                  const txt = await res.text();
                  if (!res.ok) {
                    let json: any;
                    try { json = JSON.parse(txt); } catch {}
                    throw new Error(json?.error || txt || `Erro HTTP ${res.status}`);
                  }
                } catch (e: any) {
                  // GraphViewer tem fallback próprio; aqui mantemos silencioso
                  console.warn("Erro ao extrair grafo desta fonte:", e?.message || e);
                }
              }}
            />
          )}
        </DrawerContent>
      </Drawer>

      {/* Separador Visual */}
      <div className="h-px bg-border my-2" />

      {/* Legado: Processos Operacionais */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold text-foreground">Processos Operacionais (Legado)</h2>
          <div className="flex items-center gap-2">
            <Select value={filterStatusLegacy} onValueChange={(v) => setFilterStatusLegacy(v as any)}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="Filtrar" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Ativos</SelectItem>
                <SelectItem value="archived">Arquivados</SelectItem>
                <SelectItem value="all">Todos</SelectItem>
              </SelectContent>
            </Select>
            {canEditKB && (
              <Button onClick={() => setShowForm(!showForm)} size="sm">
                <Plus className="w-4 h-4 mr-2" />
                Novo Processo
              </Button>
            )}
          </div>
        </div>

        {showForm && canEditKB && (
          <Card className="p-4 border-border">
            <form onSubmit={handleSubmitLegacy} className="space-y-4">
              <div>
                <label className="text-sm font-medium text-foreground">Título</label>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Ex: Aumento de Limite"
                  required
                />
              </div>

              <div>
                <label className="text-sm font-medium text-foreground">Categoria</label>
                <Input
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="Ex: Crédito"
                  required
                />
              </div>

              <div>
                <label className="text-sm font-medium text-foreground">Conteúdo do Processo</label>
                <Textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="Cole aqui o conteúdo do processo operacional, scripts, fluxos, etc."
                  className="min-h-[200px]"
                  required
                />
              </div>

              <div className="flex gap-2">
                <Button type="submit">
                  <Upload className="w-4 h-4 mr-2" />
                  Salvar Processo
                </Button>
                <Button type="button" variant="outline" onClick={() => setShowForm(false)}>
                  Cancelar
                </Button>
              </div>
            </form>
          </Card>
        )}

        {/* Dialog de Arquivamento quando exclusão é bloqueada por referências */}
        <AlertDialog open={showArchiveDialog} onOpenChange={setShowArchiveDialog}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Não é possível excluir</AlertDialogTitle>
              <AlertDialogDescription>
                {archiveTarget ? (
                  <>
                    O processo <strong>{archiveTarget.title}</strong> está em uso em conversas
                    {typeof conflictCount === "number" ? ` (${conflictCount})` : ""}. Você pode arquivá-lo para ocultá-lo das seleções sem perder histórico.
                  </>
                ) : (
                  <>Este processo está em uso em conversas. Você pode arquivá-lo.</>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => { setShowArchiveDialog(false); setArchiveTarget(null); setConflictCount(null); }}>
                Cancelar
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => archiveTarget && handleArchiveLegacy(archiveTarget.id)}
              >
                Arquivar
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <div className="grid gap-3">
          {entries.map((entry) => (
            <Card key={entry.id} className="p-4 border-border">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <h3 className="font-semibold text-foreground">{entry.title}</h3>
                  <p className="text-sm text-muted-foreground mt-1">{entry.category}</p>
                  <p className="text-sm text-muted-foreground mt-2 line-clamp-2">
                    {entry.content.substring(0, 150)}...
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {canEditKB ? (
                    <>
                      {entry.status === "active" ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleArchiveLegacy(entry.id)}
                          className="text-foreground"
                        >
                          <Archive className="w-4 h-4 mr-1" />
                          Arquivar
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleReactivateLegacy(entry.id)}
                          className="text-foreground"
                        >
                          <RotateCcw className="w-4 h-4 mr-1" />
                          Reativar
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDeleteLegacy(entry.id)}
                        className="text-destructive hover:text-destructive"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
            </Card>
          ))}

          {entries.length === 0 && !showForm && (
            <Card className="p-8 text-center border-border">
              <p className="text-muted-foreground">
                Nenhum processo cadastrado ainda. Adicione processos para tornar as simulações mais realistas.
              </p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
};
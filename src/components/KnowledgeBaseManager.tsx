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
import { Plus, Trash2, Upload, Archive, RotateCcw } from "lucide-react";

interface KnowledgeEntry {
  id: string;
  title: string;
  category: string;
  content: string;
  status: "active" | "archived";
  created_at?: string;
  updated_at?: string;
}

export const KnowledgeBaseManager = () => {
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("");
  const [content, setContent] = useState("");
  const [filterStatus, setFilterStatus] = useState<"active" | "archived" | "all">("active");
  const [showArchiveDialog, setShowArchiveDialog] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<KnowledgeEntry | null>(null);
  const [conflictCount, setConflictCount] = useState<number | null>(null);
  const { toast } = useToast();

  const API_BASE = import.meta.env?.VITE_API_BASE_URL || "";

  useEffect(() => {
    loadEntries();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload when filter changes
  useEffect(() => {
    loadEntries();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterStatus]);

  async function apiGet<T>(path: string): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `Erro HTTP ${res.status}`);
    }
    return res.json();
  }

  async function apiPost<T>(path: string, body: any): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
      headers: { "Content-Type": "application/json" },
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
    const res = await fetch(`${API_BASE}${path}`, { method: "DELETE" });
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

  const loadEntries = async () => {
    try {
      const statusParam = filterStatus === "all" ? "all" : filterStatus;
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

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

  const handleDelete = async (id: string) => {
    try {
      await apiDelete(`/api/knowledge_base/${id}`);
      toast({ title: "Processo excluído" });
      loadEntries();
    } catch (error: any) {
      // Se estiver em uso, abrir pop-up para Arquivar
      if (error?.status === 409 && error?.code === "KB_IN_USE") {
        const target = entries.find((e) => e.id === id) || null;
        setArchiveTarget(target);
        setConflictCount(error?.referencedCount ?? null);
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

  const handleArchive = async (id: string) => {
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

  const handleReactivate = async (id: string) => {
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-foreground">Base de Conhecimento</h2>
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
          <Button onClick={() => setShowForm(!showForm)} size="sm">
            <Plus className="w-4 h-4 mr-2" />
            Novo Processo
          </Button>
        </div>
      </div>

      {showForm && (
        <Card className="p-4 border-border">
          <form onSubmit={handleSubmit} className="space-y-4">
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
              onClick={() => archiveTarget && handleArchive(archiveTarget.id)}
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
                {entry.status === "active" ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleArchive(entry.id)}
                    className="text-foreground"
                  >
                    <Archive className="w-4 h-4 mr-1" />
                    Arquivar
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleReactivate(entry.id)}
                    className="text-foreground"
                  >
                    <RotateCcw className="w-4 h-4 mr-1" />
                    Reativar
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDelete(entry.id)}
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
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
  );
};
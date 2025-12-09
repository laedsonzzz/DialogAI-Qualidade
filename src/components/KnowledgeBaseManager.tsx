import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { Input } from "./ui/input";
import { Card } from "./ui/card";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, Upload } from "lucide-react";

interface KnowledgeEntry {
  id: string;
  title: string;
  category: string;
  content: string;
}

export const KnowledgeBaseManager = () => {
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("");
  const [content, setContent] = useState("");
  const { toast } = useToast();

  useEffect(() => {
    loadEntries();
  }, []);

  const loadEntries = async () => {
    const { data, error } = await supabase
      .from("knowledge_base")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      toast({
        title: "Erro ao carregar processos",
        description: error.message,
        variant: "destructive",
      });
      return;
    }

    setEntries(data || []);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const { error } = await supabase.from("knowledge_base").insert({
      title,
      category,
      content,
    });

    if (error) {
      toast({
        title: "Erro ao salvar processo",
        description: error.message,
        variant: "destructive",
      });
      return;
    }

    toast({
      title: "Processo salvo com sucesso!",
      description: "O processo está disponível para uso nas simulações.",
    });

    setTitle("");
    setCategory("");
    setContent("");
    setShowForm(false);
    loadEntries();
  };

  const handleDelete = async (id: string) => {
    const { error } = await supabase.from("knowledge_base").delete().eq("id", id);

    if (error) {
      toast({
        title: "Erro ao excluir processo",
        description: error.message,
        variant: "destructive",
      });
      return;
    }

    toast({
      title: "Processo excluído",
    });

    loadEntries();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-foreground">Base de Conhecimento</h2>
        <Button onClick={() => setShowForm(!showForm)} size="sm">
          <Plus className="w-4 h-4 mr-2" />
          Novo Processo
        </Button>
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
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleDelete(entry.id)}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="w-4 h-4" />
              </Button>
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
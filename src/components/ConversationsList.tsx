import React, { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getCommonHeaders, getAuthHeader } from "@/lib/auth";
import { useNavigate } from "react-router-dom";

type Conversation = {
  id: string;
  scenario: string;
  customer_profile: string;
  process_id?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  csat_score?: number | null;
  user_id?: string;
};

type ClientPerms = {
  can_start_chat: boolean;
  can_edit_kb: boolean;
  can_view_team_chats: boolean;
  can_view_all_client_chats: boolean;
};

type MeResponse = {
  user: { id: string; email: string; full_name?: string; status?: string; is_admin?: boolean };
  clients: Array<{
    client_id: string;
    client_name: string;
    client_code?: string;
    tipo_usuario?: string;
    permissions: ClientPerms;
  }>;
};

const API_BASE = import.meta.env?.VITE_API_BASE_URL || "";

function formatDateTime(dt?: string | null) {
  if (!dt) return "-";
  try {
    const d = new Date(dt);
    return d.toLocaleString();
  } catch {
    return dt;
  }
}

const ConversationsList: React.FC = () => {
  const [items, setItems] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [canTeam, setCanTeam] = useState(false);
  const [canClient, setCanClient] = useState(false);
  const [scope, setScope] = useState<"team" | "client">("team");
  const [isAdmin, setIsAdmin] = useState(false);

  const navigate = useNavigate();

  async function loadPermissions() {
    try {
      const res = await fetch(`${API_BASE}/api/auth/me`, {
        headers: {
          ...getAuthHeader(),
          "Content-Type": "application/json",
        },
      });
      const data: MeResponse = await res.json();
      if (!res.ok) throw new Error((data as any)?.error || `Erro HTTP ${res.status}`);

      // Como o componente não sabe qual cliente está selecionado, as permissões efetivas
      // serão avaliadas no backend por X-Client-Id. Aqui basta verificar se existe
      // ao menos um cliente com permissões; a seleção do cliente via X-Client-Id
      // vai determinar o conjunto aplicado nas rotas.
      // Para evitar falsa-positivos, manteremos ambos falsos por padrão e
      // deixaremos o backend retornar "own" quando o usuário não tem can_view_team_chats.
      const anyTeam = (data.clients || []).some((c) => c.permissions?.can_view_team_chats);
      const anyClient = (data.clients || []).some((c) => c.permissions?.can_view_all_client_chats);
      setCanTeam(anyTeam);
      setCanClient(anyClient);
      setIsAdmin(!!(data as any)?.user?.is_admin);
      // Seleciona escopo inicial: team se possível, senão client se possível, senão team (retorna próprias)
      if (anyTeam) setScope("team");
      else if (anyClient) setScope("client");
      else setScope("team");
    } catch (e: any) {
      setCanTeam(false);
      setCanClient(false);
    }
  }

  async function loadConversations(nextScope?: "team" | "client") {
    setLoading(true);
    setError(null);
    try {
      const sc = nextScope || scope || "team";
      const url = `${API_BASE}/api/conversations?scope=${encodeURIComponent(sc)}`;
      const res = await fetch(url, { headers: getCommonHeaders() });
      const data: Conversation[] = await res.json();
      if (!res.ok) {
        throw new Error((data as any)?.error || `Erro HTTP ${res.status}`);
      }
      setItems(Array.isArray(data) ? data : []);
    } catch (e: any) {
      setError(String(e?.message || e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadPermissions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadConversations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  useEffect(() => {
    const handler = () => {
      loadPermissions();
      // Recarrega conversas conforme escopo atual
      loadConversations();
    };
    window.addEventListener("client:changed", handler as any);
    return () => {
      window.removeEventListener("client:changed", handler as any);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleDeleteConversation(convId: string) {
    if (!isAdmin) return;
    const reason = window.prompt("Informe um motivo (opcional) para a exclusão (soft delete):") || null;
    if (!window.confirm("Confirmar exclusão lógica desta conversa? Esta ação não poderá ser desfeita na UI.")) {
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/conversations/${convId}`, {
        method: "DELETE",
        headers: {
          ...getCommonHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ reason }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || `Erro HTTP ${res.status}`);
      }
      // Recarrega lista
      loadConversations();
    } catch (e: any) {
      alert(e?.message || "Erro ao excluir conversa");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-foreground">Conversas</h2>

        <div className="flex items-center gap-2">
          <Button
            variant={scope === "team" ? "default" : "outline"}
            size="sm"
            onClick={() => {
              if (!canTeam) return;
              setScope("team");
            }}
            disabled={!canTeam && !canClient /* sem nenhuma permissão, ainda pode ver as próprias via team */}
          >
            Equipe
          </Button>
          <Button
            variant={scope === "client" ? "default" : "outline"}
            size="sm"
            onClick={() => {
              if (!canClient) return;
              setScope("client");
            }}
            disabled={!canClient}
          >
            Cliente
          </Button>
        </div>
      </div>

      {!canTeam && !canClient && (
        <p className="text-xs text-muted-foreground">
          Você não possui permissões para ver conversas da equipe ou do cliente. Mostrando apenas suas próprias conversas.
        </p>
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
            <p className="text-muted-foreground">Nenhuma conversa encontrada.</p>
          </Card>
        )}
        {items.map((conv) => (
          <Card
            key={conv.id}
            className={`p-4 border-border ${conv.ended_at ? "cursor-pointer hover:border-primary" : "opacity-95"}`}
            onClick={() => {
              if (conv.ended_at) {
                navigate(`/conversations/${conv.id}`);
              }
            }}
          >
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-foreground">{conv.scenario}</h3>
                  <Badge variant={conv.ended_at ? "secondary" : "outline"}>
                    {conv.ended_at ? "Finalizada" : "Em andamento"}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  Perfil do cliente: {conv.customer_profile}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Início: {formatDateTime(conv.started_at)}
                  {conv.ended_at ? ` • Fim: ${formatDateTime(conv.ended_at)}` : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {typeof conv.csat_score === "number" ? (
                  <Badge variant="secondary">CSAT: {conv.csat_score}</Badge>
                ) : (
                  <Badge variant="outline">Sem avaliação</Badge>
                )}
                {isAdmin && (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteConversation(conv.id);
                    }}
                  >
                    Excluir
                  </Button>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
};

export default ConversationsList;
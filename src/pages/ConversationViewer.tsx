import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getCommonHeaders, getAuthHeader } from "@/lib/auth";

type ConversationMeta = {
  id: string;
  scenario: string;
  customer_profile: string;
  process_id?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  csat_score?: number | null;
  user_id?: string;
};

type ConversationMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  seq?: number | null;
};

type MeResponse = {
  user: { id: string; email: string; is_admin?: boolean };
};

const API_BASE = import.meta.env?.VITE_API_BASE_URL || "";

function formatDateTimeMaceio(dt?: string | null) {
  if (!dt) return "-";
  try {
    const d = new Date(dt);
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Maceio",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  } catch {
    return dt;
  }
}

const ConversationViewer: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [meta, setMeta] = useState<ConversationMeta | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [loadingMeta, setLoadingMeta] = useState(false);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [errorMeta, setErrorMeta] = useState<string | null>(null);
  const [errorMsgs, setErrorMsgs] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function loadIsAdmin() {
    try {
      const res = await fetch(`${API_BASE}/api/auth/me`, {
        headers: {
          ...getAuthHeader(),
          "Content-Type": "application/json",
        },
      });
      const data: MeResponse & any = await res.json();
      if (!res.ok) throw new Error(data?.error || `Erro HTTP ${res.status}`);
      setIsAdmin(!!data?.user?.is_admin);
    } catch {
      setIsAdmin(false);
    }
  }

  async function loadMeta() {
    if (!id) return;
    setLoadingMeta(true);
    setErrorMeta(null);
    try {
      const res = await fetch(`${API_BASE}/api/conversations/${id}`, {
        headers: getCommonHeaders(),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || `Erro HTTP ${res.status}`);
      }
      setMeta(data as ConversationMeta);
    } catch (e: any) {
      setErrorMeta(String(e?.message || e));
      setMeta(null);
    } finally {
      setLoadingMeta(false);
    }
  }

  async function loadMessages() {
    if (!id) return;
    setLoadingMsgs(true);
    setErrorMsgs(null);
    try {
      const res = await fetch(`${API_BASE}/api/conversations/${id}/messages`, {
        headers: getCommonHeaders(),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || `Erro HTTP ${res.status}`);
      }
      setMessages(Array.isArray(data) ? data : []);
    } catch (e: any) {
      setErrorMsgs(String(e?.message || e));
      setMessages([]);
    } finally {
      setLoadingMsgs(false);
    }
  }

  useEffect(() => {
    loadIsAdmin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadMeta();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (meta && meta.ended_at) {
      loadMessages();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.id, meta?.ended_at]);

  async function handleDelete() {
    if (!id) return;
    const reason = window.prompt("Informe um motivo (opcional) para a exclusão (soft delete):") || null;
    if (!window.confirm("Confirmar exclusão lógica desta conversa? Esta ação não poderá ser desfeita na UI.")) {
      return;
    }
    setDeleting(true);
    try {
      const res = await fetch(`${API_BASE}/api/conversations/${id}`, {
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
      navigate(-1);
    } catch (e: any) {
      alert(e?.message || "Erro ao excluir conversa");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="min-h-screen p-4">
      <div className="max-w-4xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <Button variant="ghost" onClick={() => navigate(-1)}>
            Voltar
          </Button>
          {isAdmin && meta && (
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? "Excluindo..." : "Excluir conversa"}
            </Button>
          )}
        </div>

        <Card className="p-4">
          {loadingMeta && <p>Carregando conversa...</p>}
          {errorMeta && !loadingMeta && <p className="text-destructive text-sm">{errorMeta}</p>}
          {!loadingMeta && !errorMeta && meta && (
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">{meta.scenario}</h2>
              <p className="text-sm text-muted-foreground">Perfil: {meta.customer_profile}</p>
              <p className="text-xs text-muted-foreground">
                Início: {formatDateTimeMaceio(meta.started_at)}{" "}
                {meta.ended_at ? `• Fim: ${formatDateTimeMaceio(meta.ended_at)}` : ""}
              </p>
              <div className="mt-2">
                {typeof meta.csat_score === "number" ? (
                  <Badge variant="secondary">CSAT: {meta.csat_score}</Badge>
                ) : (
                  <Badge variant="outline">Sem avaliação</Badge>
                )}
              </div>
            </div>
          )}
        </Card>

        <Card className="p-4">
          {!meta?.ended_at && !loadingMeta && !errorMeta && (
            <p className="text-sm text-muted-foreground">
              Esta conversa ainda não foi finalizada. As mensagens só ficam disponíveis após o encerramento.
            </p>
          )}
          {meta?.ended_at && (
            <>
              {loadingMsgs && <p>Carregando mensagens...</p>}
              {errorMsgs && !loadingMsgs && <p className="text-destructive text-sm">{errorMsgs}</p>}
              {!loadingMsgs && !errorMsgs && messages.length === 0 && (
                <p className="text-sm text-muted-foreground">Nenhuma mensagem registrada.</p>
              )}
              {!loadingMsgs && !errorMsgs && messages.length > 0 && (
                <div className="space-y-3">
                  {messages.map((m) => (
                    <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                      <div className={`max-w-[80%] p-3 rounded-lg border ${m.role === "user" ? "bg-primary text-primary-foreground" : "bg-card"}`}>
                        <div className="text-xs text-muted-foreground mb-1">
                          {m.role === "user" ? "Atendente" : "Cliente"} • {formatDateTimeMaceio(m.created_at)}
                        </div>
                        <div className="text-sm whitespace-pre-wrap">{m.content}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </Card>
      </div>
    </div>
  );
};

export default ConversationViewer;
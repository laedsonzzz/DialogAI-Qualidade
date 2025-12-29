import React, { useEffect, useState } from "react";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { getAuthHeader, getClientId, setClientId } from "@/lib/auth";

type ClientPerms = {
  can_start_chat: boolean;
  can_edit_kb: boolean;
  can_view_team_chats: boolean;
  can_view_all_client_chats: boolean;
};

type MeResponse = {
  user: {
    id: string;
    email: string;
    full_name?: string;
    status?: string;
  };
  clients: Array<{
    client_id: string;
    client_name: string;
    client_code?: string;
    tipo_usuario?: string;
    permissions: ClientPerms;
  }>;
};

const API_BASE = import.meta.env?.VITE_API_BASE_URL || "";

const ClientSwitcher: React.FC = () => {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [clients, setClients] = useState<MeResponse["clients"]>([]);
  const [selected, setSelected] = useState<string | undefined>(() => getClientId() || undefined);
  const [error, setError] = useState<string | null>(null);

  async function loadClients() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/auth/me`, {
        headers: {
          ...getAuthHeader(),
        },
      });
      const data: MeResponse = await res.json();
      if (!res.ok) {
        throw new Error((data as any)?.error || `Erro HTTP ${res.status}`);
      }
      setClients(data.clients || []);
    } catch (e: any) {
      setError(String(e?.message || e) || "Erro ao carregar clientes");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadClients();
  }, []);

  function handleChangeClient(nextClientId: string) {
    setSelected(nextClientId);
    setClientId(nextClientId);
    const name = clients.find((c) => c.client_id === nextClientId)?.client_name || nextClientId;
    toast({
      title: "Cliente selecionado",
      description: `Agora operando no cliente: ${name}`,
    });
    try {
      window.dispatchEvent(new CustomEvent("client:changed", { detail: { clientId: nextClientId } }));
    } catch {
      // ambiente sem window? ignora
    }
  }

  return (
    <Card className="p-3 border-border/50 bg-card/50 backdrop-blur-sm">
      <div className="flex items-end gap-3 flex-wrap">
        <div className="grid gap-2 min-w-[260px]">
          <Label>Cliente</Label>
          <Select
            value={selected}
            onValueChange={handleChangeClient}
            disabled={loading || clients.length === 0}
          >
            <SelectTrigger>
              <SelectValue placeholder={loading ? "Carregando..." : "Selecione um cliente"} />
            </SelectTrigger>
            <SelectContent>
              {clients.map((c) => (
                <SelectItem key={c.client_id} value={c.client_id}>
                  {c.client_name} {c.client_code ? `(${c.client_code})` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {error && (
            <p className="text-xs text-destructive">
              {error}
            </p>
          )}
          {(!selected || selected.length === 0) && !loading && clients.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Selecione um cliente para habilitar as rotas protegidas (X-Client-Id).
            </p>
          )}
          {clients.length === 0 && !loading && (
            <p className="text-xs text-muted-foreground">
              Nenhum cliente associado a este usuário.
            </p>
          )}
        </div>

        <div className="ml-auto">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={loadClients}
            disabled={loading}
          >
            Recarregar
          </Button>
        </div>
      </div>
    </Card>
  );
};

export default ClientSwitcher;
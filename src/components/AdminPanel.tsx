import React, { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { getAuthHeader, getCommonHeaders } from "@/lib/auth";
import { Trash2, Save, Plus, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
type Client = {
  id: string;
  name: string;
  code: string;
};

type User = {
  id: string;
  email: string;
  full_name: string;
  status: "active" | "inactive";
  is_admin: boolean;
  must_reset_password?: boolean;
};

type UserClient = {
  id: string; // synthetic user_id:client_id
  user_id: string;
  client_id: string;
  tipo_usuario: string;
  can_start_chat: boolean;
  can_edit_kb: boolean;
  can_view_team_chats: boolean;
  can_view_all_client_chats: boolean;
  can_manage_scenarios: boolean;
  email?: string;
  full_name?: string;
  client_name?: string;
  client_code?: string;
};

const API_BASE = import.meta.env?.VITE_API_BASE_URL || "";

// Admin API helpers
async function apiGetAdmin<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      ...getAuthHeader(),
      "Content-Type": "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {}
    throw new Error(json?.error || text || `Erro HTTP ${res.status}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text as unknown as T;
  }
}

async function apiPostAdmin<T>(path: string, body: any): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: getCommonHeaders(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const err = new Error(json?.error || text || `Erro HTTP ${res.status}`);
    (err as any).status = res.status;
    (err as any).code = json?.code;
    (err as any).payload = json;
    throw err;
  }
  return (json ?? (text as unknown as T)) as T;
}

async function apiPatchAdmin<T>(path: string, body: any): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PATCH",
    headers: getCommonHeaders(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const err = new Error(json?.error || text || `Erro HTTP ${res.status}`);
    (err as any).status = res.status;
    (err as any).code = json?.code;
    (err as any).payload = json;
    throw err;
  }
  return (json ?? (text as unknown as T)) as T;
}

async function apiDeleteAdmin<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "DELETE",
    headers: {
      ...getAuthHeader(),
      "Content-Type": "application/json",
    },
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const err = new Error(json?.error || text || `Erro HTTP ${res.status}`);
    (err as any).status = res.status;
    (err as any).code = json?.code;
    (err as any).referencedCount = json?.referencedCount;
    (err as any).payload = json;
    throw err;
  }
  return (json ?? (text as unknown as T)) as T;
}

const AdminPanel: React.FC = () => {
  const { toast } = useToast();

  // Clients state
  const [clients, setClients] = useState<Client[]>([]);
  const [cName, setCName] = useState("");
  const [cCode, setCCode] = useState("");
  const [clientsLoading, setClientsLoading] = useState(false);
  const [clientsError, setClientsError] = useState<string | null>(null);

  // Users state
  const [users, setUsers] = useState<User[]>([]);
  const [uEmail, setUEmail] = useState("");
  const [uFullName, setUFullName] = useState("");
  const [uIsAdmin, setUIsAdmin] = useState(false);
  const [uStatus, setUStatus] = useState<"active" | "inactive">("active");
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);

  // Search with debounce
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery.trim().toLowerCase()), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // Filters (multi-select)
  const [filtersStatus, setFiltersStatus] = useState<Set<"active" | "inactive">>(new Set());
  const [filtersAdmin, setFiltersAdmin] = useState<Set<"admin" | "nonadmin">>(new Set());
  const [filtersClientIds, setFiltersClientIds] = useState<Set<string>>(new Set());
  const [filtersTipos, setFiltersTipos] = useState<Set<"interno" | "externo">>(new Set());
  const [filtersPerms, setFiltersPerms] = useState<
    Set<"can_start_chat" | "can_edit_kb" | "can_view_team_chats" | "can_view_all_client_chats" | "can_manage_scenarios">
  >(new Set());
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Permissions editor state (right panel)
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [selectedClientId, setSelectedClientId] = useState<string>("");
  const [tipoUsuario, setTipoUsuario] = useState<string>("interno");
  const [canStartChat, setCanStartChat] = useState(false);
  const [canEditKB, setCanEditKB] = useState(false);
  const [canViewTeam, setCanViewTeam] = useState(false);
  const [canViewAll, setCanViewAll] = useState(false);
  const [canManageLab, setCanManageLab] = useState(false);

  // Links per selected user (for right panel)
  const [userLinks, setUserLinks] = useState<UserClient[]>([]);
  const [linksLoading, setLinksLoading] = useState(false);
  const [linksError, setLinksError] = useState<string | null>(null);

  // All links map (for filtering)
  const [allLinks, setAllLinks] = useState<UserClient[]>([]);
  const allLinksByUser = useMemo<Record<string, UserClient[]>>(() => {
    const map: Record<string, UserClient[]> = {};
    for (const l of allLinks) {
      if (!map[l.user_id]) map[l.user_id] = [];
      map[l.user_id].push(l);
    }
    return map;
  }, [allLinks]);

  const usersMap = useMemo(() => Object.fromEntries(users.map((u) => [u.id, u])), [users]);
  const clientsMap = useMemo(() => Object.fromEntries(clients.map((c) => [c.id, c])), [clients]);

  // Prefill editor using existing vínculos do usuário ao carregar
  useEffect(() => {
    if (!selectedUserId) return;
    if (userLinks.length === 0) {
      // Sem vínculos, zera controles
      setTipoUsuario("interno");
      setCanStartChat(false);
      setCanEditKB(false);
      setCanViewTeam(false);
      setCanViewAll(false);
      setCanManageLab(false);
      return;
    }
    // Se nenhum cliente estiver selecionado, assume o primeiro vínculo
    if (!selectedClientId) {
      const l = userLinks[0];
      setSelectedClientId(l.client_id);
      setTipoUsuario(l.tipo_usuario || "interno");
      setCanStartChat(!!l.can_start_chat);
      setCanEditKB(!!l.can_edit_kb);
      setCanViewTeam(!!l.can_view_team_chats);
      setCanViewAll(!!l.can_view_all_client_chats);
    }
  }, [userLinks, selectedUserId]);

  // Sincroniza toggles ao trocar o cliente selecionado
  useEffect(() => {
    if (!selectedClientId) return;
    const link = userLinks.find((l) => l.client_id === selectedClientId);
    if (link) {
      setTipoUsuario(link.tipo_usuario || "interno");
      setCanStartChat(!!link.can_start_chat);
      setCanEditKB(!!link.can_edit_kb);
      setCanViewTeam(!!link.can_view_team_chats);
      setCanViewAll(!!link.can_view_all_client_chats);
      setCanManageLab(!!link.can_manage_scenarios);
    } else {
      setTipoUsuario("interno");
      setCanStartChat(false);
      setCanEditKB(false);
      setCanViewTeam(false);
      setCanViewAll(false);
      setCanManageLab(false);
    }
  }, [selectedClientId, userLinks]);

  // (Removido bloco duplicado de prefill/sync para evitar condições de corrida.
  // O bloco oficial de prefill/sync está em 201–243.)
  // Loaders
  async function loadClients() {
    setClientsLoading(true);
    setClientsError(null);
    try {
      const data = await apiGetAdmin<Client[]>("/api/admin/clients");
      setClients(Array.isArray(data) ? data : []);
    } catch (e: any) {
      setClientsError(String(e?.message || e));
    } finally {
      setClientsLoading(false);
    }
  }

  async function loadUsers() {
    setUsersLoading(true);
    setUsersError(null);
    try {
      const data = await apiGetAdmin<User[]>("/api/admin/users");
      setUsers(Array.isArray(data) ? data : []);
    } catch (e: any) {
      setUsersError(String(e?.message || e));
    } finally {
      setUsersLoading(false);
    }
  }

  async function loadUserLinks(uid: string): Promise<UserClient[]> {
    setLinksLoading(true);
    setLinksError(null);
    try {
      const data = await apiGetAdmin<UserClient[]>(`/api/admin/user_clients?user_id=${encodeURIComponent(uid)}`);
      const arr = Array.isArray(data) ? data : [];
      setUserLinks(arr);
      return arr;
    } catch (e: any) {
      setLinksError(String(e?.message || e));
      setUserLinks([]);
      return [];
    } finally {
      setLinksLoading(false);
    }
  }

  async function loadAllUserClients() {
    try {
      const data = await apiGetAdmin<UserClient[]>(`/api/admin/user_clients`);
      setAllLinks(Array.isArray(data) ? data : []);
    } catch (e: any) {
      // silently ignore; filters will behave as if no links
    }
  }

  // Initial load
  useEffect(() => {
    loadClients();
    loadUsers();
    loadAllUserClients();
  }, []);

  // React to client switcher broadcast (refresh global data)
  useEffect(() => {
    const handler = () => {
      loadClients();
      loadUsers();
      loadAllUserClients();
      if (selectedUserId) loadUserLinks(selectedUserId);
    };
    window.addEventListener("client:changed", handler as any);
    return () => window.removeEventListener("client:changed", handler as any);
  }, [selectedUserId]);

  // Clients handlers
  async function handleCreateClient() {
    if (!cName.trim() || !cCode.trim()) {
      toast({ title: "Informe nome e código do cliente", variant: "destructive" });
      return;
    }
    try {
      await apiPostAdmin<Client>("/api/admin/clients", { name: cName.trim(), code: cCode.trim() });
      setCName("");
      setCCode("");
      loadClients();
      toast({ title: "Cliente criado" });
    } catch (e: any) {
      toast({ title: "Erro ao criar cliente", description: String(e?.message || e), variant: "destructive" });
    }
  }

  async function handleUpdateClient(c: Client, nextName: string, nextCode: string) {
    if (!nextName.trim() || !nextCode.trim()) {
      toast({ title: "Nome e código são obrigatórios", variant: "destructive" });
      return;
    }
    try {
      await apiPatchAdmin(`/api/admin/clients/${encodeURIComponent(c.id)}`, { name: nextName.trim(), code: nextCode.trim() });
      loadClients();
      toast({ title: "Cliente atualizado" });
    } catch (e: any) {
      toast({ title: "Erro ao atualizar cliente", description: String(e?.message || e), variant: "destructive" });
    }
  }

  async function handleDeleteClient(c: Client) {
    try {
      await apiDeleteAdmin(`/api/admin/clients/${encodeURIComponent(c.id)}`);
      loadClients();
      toast({ title: "Cliente excluído" });
    } catch (e: any) {
      const code = (e as any)?.code;
      if (code === "CLIENT_IN_USE") {
        toast({
          title: "Cliente em uso",
          description: "Existem vínculos ou dados associados. Exclua apenas clientes sem uso.",
          variant: "destructive",
        });
      } else {
        toast({ title: "Erro ao excluir cliente", description: String(e?.message || e), variant: "destructive" });
      }
    }
  }

  // Users handlers
  async function handleCreateUser() {
    if (!uEmail.trim() || !uFullName.trim()) {
      toast({ title: "Informe email e nome completo", variant: "destructive" });
      return;
    }
    try {
      await apiPostAdmin<User>("/api/admin/users", {
        email: uEmail.trim(),
        full_name: uFullName.trim(),
        is_admin: uIsAdmin,
        status: uStatus,
      });
      setUEmail("");
      setUFullName("");
      setUIsAdmin(false);
      setUStatus("active");
      loadUsers();
      toast({ title: "Usuário criado", description: "O usuário definirá a senha no primeiro login." });
    } catch (e: any) {
      toast({ title: "Erro ao criar usuário", description: String(e?.message || e), variant: "destructive" });
    }
  }

  async function handlePatchUser(u: User, patch: Partial<User> & { must_reset_password?: boolean }) {
    try {
      await apiPatchAdmin(`/api/admin/users/${encodeURIComponent(u.id)}`, patch);
      loadUsers();
      toast({ title: "Usuário atualizado" });
    } catch (e: any) {
      toast({ title: "Erro ao atualizar usuário", description: String(e?.message || e), variant: "destructive" });
    }
  }

  // Permissions handlers (right panel)
  function fillEditorFromLink(link?: UserClient) {
    if (!link) return;
    setSelectedClientId(link.client_id);
    setTipoUsuario(link.tipo_usuario || "interno");
    setCanStartChat(!!link.can_start_chat);
    setCanEditKB(!!link.can_edit_kb);
    setCanViewTeam(!!link.can_view_team_chats);
    setCanViewAll(!!link.can_view_all_client_chats);
    setCanManageLab(!!link.can_manage_scenarios);
  }

  async function handleUpsertUserClient() {
    if (!selectedUserId || !selectedClientId || !tipoUsuario) {
      toast({ title: "Selecione usuário, cliente e tipo de usuário", variant: "destructive" });
      return;
    }
    try {
      await apiPostAdmin<UserClient>("/api/admin/user_clients", {
        user_id: selectedUserId,
        client_id: selectedClientId,
        tipo_usuario: tipoUsuario,
        can_start_chat: canStartChat,
        can_edit_kb: canEditKB,
        can_view_team_chats: canViewTeam,
        can_view_all_client_chats: canViewAll,
        can_manage_scenarios: canManageLab,
      });
      loadUserLinks(selectedUserId);
      loadAllUserClients(); // sync filters source
      toast({ title: "Permissões salvas" });
    } catch (e: any) {
      const code = (e as any)?.code;
      const status = (e as any)?.status;
      let msg = String(e?.message || e);
      switch (code) {
        case "MISSING_FIELDS":
          msg = "Selecione usuário, cliente e tipo de usuário.";
          break;
        case "INVALID_TIPO":
        case "CHECK_VIOLATION":
          msg = "Tipo de usuário inválido. Use 'interno' ou 'externo'.";
          break;
        case "USER_NOT_FOUND":
          msg = "Usuário não encontrado ou inativo.";
          break;
        case "CLIENT_NOT_FOUND":
          msg = "Cliente não encontrado.";
          break;
        case "FK_VIOLATION":
          msg = "Referência inválida: usuário/cliente inexistente.";
          break;
        case "UNIQUE_VIOLATION":
          msg = "Conflito de unicidade do vínculo (user_id, client_id).";
          break;
      }
      toast({
        title: "Erro ao salvar permissões",
        description: `${msg}${status ? ` [HTTP ${status}]` : ""}`,
        variant: "destructive",
      });
    }
  }

  async function handleDeleteLink(link: UserClient) {
    try {
      await apiDeleteAdmin(`/api/admin/user_clients/${encodeURIComponent(link.id)}`);
      if (selectedUserId) loadUserLinks(selectedUserId);
      loadAllUserClients(); // sync filters source
      toast({ title: "Vínculo removido" });
    } catch (e: any) {
      toast({ title: "Erro ao remover vínculo", description: String(e?.message || e), variant: "destructive" });
    }
  }

  // Filter helpers
  function toggleSet<T extends string>(setter: React.Dispatch<React.SetStateAction<Set<T>>>, setValue: Set<T>, value: T) {
    const next = new Set(setValue);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setter(next);
  }

  function clearFilters() {
    setFiltersStatus(new Set());
    setFiltersAdmin(new Set());
    setFiltersClientIds(new Set());
    setFiltersTipos(new Set());
    setFiltersPerms(new Set());
  }
  // Filtering logic: OR inside group, AND across groups; clients: OR; perms: global across any client
  const filteredUsers = useMemo(() => {
    const q = debouncedQuery;
    const qMatch = (u: User) => {
      if (!q) return true;
      const name = (u.full_name || "").toLowerCase();
      const email = (u.email || "").toLowerCase();
      return name.includes(q) || email.includes(q);
    };

    function matchesFilters(u: User): boolean {
      // Status
      if (filtersStatus.size > 0 && !filtersStatus.has(u.status)) return false;
      // Admin
      if (filtersAdmin.size > 0) {
        const flag = u.is_admin ? "admin" : "nonadmin";
        if (!filtersAdmin.has(flag as any)) return false;
      }
      const links = allLinksByUser[u.id] || [];
      // Clients (OR)
      if (filtersClientIds.size > 0) {
        const hasClient = links.some((l) => filtersClientIds.has(l.client_id));
        if (!hasClient) return false;
      }
      // Tipo de usuário (OR)
      if (filtersTipos.size > 0) {
        const hasTipo = links.some((l) => filtersTipos.has(l.tipo_usuario as any));
        if (!hasTipo) return false;
      }
      // Permissões (global OR across any client)
      if (filtersPerms.size > 0) {
        const hasPerm = links.some(
          (l) =>
            (filtersPerms.has("can_start_chat") && l.can_start_chat) ||
            (filtersPerms.has("can_edit_kb") && l.can_edit_kb) ||
            (filtersPerms.has("can_view_team_chats") && l.can_view_team_chats) ||
            (filtersPerms.has("can_view_all_client_chats") && l.can_view_all_client_chats) ||
            (filtersPerms.has("can_manage_scenarios") && l.can_manage_scenarios)
        );
        if (!hasPerm) return false;
      }
      return true;
    }

    return users.filter((u) => qMatch(u) && matchesFilters(u));
  }, [users, debouncedQuery, filtersStatus, filtersAdmin, filtersClientIds, filtersTipos, filtersPerms, allLinksByUser]);

  // Layout: Left 1/3, Right 2/3 (md+)
  return (
    <div className="space-y-4">
      <Tabs defaultValue="clients" className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="clients">Clientes</TabsTrigger>
          <TabsTrigger value="users">Usuários & Permissões</TabsTrigger>
        </TabsList>

        {/* Clients */}
        <TabsContent value="clients">
          <div className="grid md:grid-cols-2 gap-4">
            <Card className="p-4">
              <h3 className="font-semibold mb-3">Cadastrar Cliente</h3>
              <div className="grid gap-3">
                <div className="grid gap-1.5">
                  <Label>Nome</Label>
                  <Input value={cName} onChange={(e) => setCName(e.target.value)} placeholder="Ex.: Claro" />
                </div>
                <div className="grid gap-1.5">
                  <Label>Código</Label>
                  <Input value={cCode} onChange={(e) => setCCode(e.target.value)} placeholder="Ex.: CLARO" />
                </div>
                <div className="flex gap-2">
                  <Button onClick={handleCreateClient}>
                    <Plus className="w-4 h-4 mr-2" />
                    Criar Cliente
                  </Button>
                  <Button variant="outline" onClick={loadClients} disabled={clientsLoading}>
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Recarregar
                  </Button>
                </div>
                {clientsError && <p className="text-xs text-destructive">{clientsError}</p>}
              </div>
            </Card>

            <Card className="p-4">
              <h3 className="font-semibold mb-3">Clientes Cadastrados</h3>
              <div className="grid gap-3">
                {clients.map((c) => (
                  <ClientRow key={c.id} client={c} onSave={handleUpdateClient} onDelete={handleDeleteClient} />
                ))}
                {clients.length === 0 && <p className="text-sm text-muted-foreground">Nenhum cliente cadastrado.</p>}
              </div>
            </Card>
          </div>
        </TabsContent>

        {/* Users & Permissions */}
        <TabsContent value="users">
          <div className="grid md:grid-cols-3 gap-4">
            {/* Left panel: 1/3 */}
            <div className="md:col-span-1 space-y-4">
              {/* Create User */}
              <Card className="p-4">
                <h3 className="font-semibold mb-3">Criar Usuário</h3>
                <div className="grid gap-3">
                  <div className="grid gap-1.5">
                    <Label>Email</Label>
                    <Input value={uEmail} onChange={(e) => setUEmail(e.target.value)} placeholder="email@empresa.com" />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Nome completo</Label>
                    <Input value={uFullName} onChange={(e) => setUFullName(e.target.value)} placeholder="Nome e sobrenome" />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label className="mr-2">Administrador</Label>
                    <Switch checked={uIsAdmin} onCheckedChange={setUIsAdmin} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Status</Label>
                    <Select value={uStatus} onValueChange={(v) => setUStatus(v as "active" | "inactive")}>
                      <SelectTrigger>
                        <SelectValue placeholder="Status" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="active">Ativo</SelectItem>
                        <SelectItem value="inactive">Inativo</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex gap-2">
                    <Button onClick={handleCreateUser}>
                      <Plus className="w-4 h-4 mr-2" />
                      Criar Usuário
                    </Button>
                    <Button variant="outline" onClick={loadUsers} disabled={usersLoading}>
                      <RefreshCw className="w-4 h-4 mr-2" />
                      Recarregar
                    </Button>
                  </div>
                  {usersError && <p className="text-xs text-destructive">{usersError}</p>}
                </div>
              </Card>

              {/* Search */}
              <Card className="p-4">
                <div className="grid gap-1.5">
                  <Label>Buscar usuário</Label>
                  <Input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Filtrar por nome ou email"
                  />
                </div>
              </Card>

              {/* Filters (multi-select) — moved to modal for better CX */}
              <Card className="p-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold">Filtros</h3>
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={clearFilters}>Limpar</Button>
                    <Button onClick={() => setFiltersOpen(true)}>Abrir filtros</Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  Use os filtros para refinar a lista de usuários sem poluir a interface.
                </p>
              </Card>

              <Dialog open={filtersOpen} onOpenChange={setFiltersOpen}>
                <DialogContent className="max-w-2xl">
                  <DialogHeader>
                    <DialogTitle>Filtros de Usuários</DialogTitle>
                  </DialogHeader>
                  <div className="grid gap-4 max-h-[60vh] overflow-y-auto overflow-x-hidden pr-1">
                    {/* Status */}
                    <div className="grid gap-2">
                      <Label className="text-sm">Status</Label>
                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2">
                          <Checkbox
                            checked={filtersStatus.has("active")}
                            onCheckedChange={() => toggleSet(setFiltersStatus, filtersStatus, "active")}
                            id="flt-status-active"
                          />
                          <Label htmlFor="flt-status-active" className="text-sm cursor-pointer">Ativo</Label>
                        </div>
                        <div className="flex items-center gap-2">
                          <Checkbox
                            checked={filtersStatus.has("inactive")}
                            onCheckedChange={() => toggleSet(setFiltersStatus, filtersStatus, "inactive")}
                            id="flt-status-inactive"
                          />
                          <Label htmlFor="flt-status-inactive" className="text-sm cursor-pointer">Inativo</Label>
                        </div>
                      </div>
                    </div>

                    {/* Perfil (Admin) */}
                    <div className="grid gap-2">
                      <Label className="text-sm">Perfil</Label>
                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2">
                          <Checkbox
                            checked={filtersAdmin.has("admin")}
                            onCheckedChange={() => toggleSet(setFiltersAdmin, filtersAdmin, "admin")}
                            id="flt-admin-yes"
                          />
                          <Label htmlFor="flt-admin-yes" className="text-sm cursor-pointer">Admin</Label>
                        </div>
                        <div className="flex items-center gap-2">
                          <Checkbox
                            checked={filtersAdmin.has("nonadmin")}
                            onCheckedChange={() => toggleSet(setFiltersAdmin, filtersAdmin, "nonadmin")}
                            id="flt-admin-no"
                          />
                          <Label htmlFor="flt-admin-no" className="text-sm cursor-pointer">Não-admin</Label>
                        </div>
                      </div>
                    </div>

                    {/* Clientes */}
                    <div className="grid gap-2">
                      <Label className="text-sm">Clientes</Label>
                      <div className="grid gap-2 max-h-[180px] overflow-y-auto overflow-x-hidden pr-1">
                        {clients.map((c) => {
                          const checked = filtersClientIds.has(c.id);
                          const htmlId = `flt-client-${c.id}`;
                          return (
                            <div className="flex items-center gap-2" key={c.id}>
                              <Checkbox
                                checked={checked}
                                onCheckedChange={() => toggleSet(setFiltersClientIds, filtersClientIds, c.id)}
                                id={htmlId}
                              />
                              <Label htmlFor={htmlId} className="text-sm cursor-pointer">
                                {c.name} {c.code ? `(${c.code})` : ""}
                              </Label>
                            </div>
                          );
                        })}
                        {clients.length === 0 && <p className="text-xs text-muted-foreground">Nenhum cliente.</p>}
                      </div>
                    </div>

                    {/* Tipo de Usuário */}
                    <div className="grid gap-2">
                      <Label className="text-sm">Tipo de usuário</Label>
                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2">
                          <Checkbox
                            checked={filtersTipos.has("interno")}
                            onCheckedChange={() => toggleSet(setFiltersTipos, filtersTipos, "interno")}
                            id="flt-tipo-interno"
                          />
                          <Label htmlFor="flt-tipo-interno" className="text-sm cursor-pointer">interno</Label>
                        </div>
                        <div className="flex items-center gap-2">
                          <Checkbox
                            checked={filtersTipos.has("externo")}
                            onCheckedChange={() => toggleSet(setFiltersTipos, filtersTipos, "externo")}
                            id="flt-tipo-externo"
                          />
                          <Label htmlFor="flt-tipo-externo" className="text-sm cursor-pointer">externo</Label>
                        </div>
                      </div>
                    </div>

                    {/* Permissões */}
                    <div className="grid gap-2">
                      <Label className="text-sm">Permissões</Label>
                      <div className="grid gap-2">
                        <div className="flex items-center gap-2">
                          <Checkbox
                            checked={filtersPerms.has("can_start_chat")}
                            onCheckedChange={() => toggleSet(setFiltersPerms, filtersPerms, "can_start_chat")}
                            id="flt-perm-start"
                          />
                          <Label htmlFor="flt-perm-start" className="text-sm cursor-pointer">Pode iniciar chat</Label>
                        </div>
                        <div className="flex items-center gap-2">
                          <Checkbox
                            checked={filtersPerms.has("can_edit_kb")}
                            onCheckedChange={() => toggleSet(setFiltersPerms, filtersPerms, "can_edit_kb")}
                            id="flt-perm-kb"
                          />
                          <Label htmlFor="flt-perm-kb" className="text-sm cursor-pointer">Pode editar base de conhecimento</Label>
                        </div>
                        <div className="flex items-center gap-2">
                          <Checkbox
                            checked={filtersPerms.has("can_view_team_chats")}
                            onCheckedChange={() => toggleSet(setFiltersPerms, filtersPerms, "can_view_team_chats")}
                            id="flt-perm-team"
                          />
                          <Label htmlFor="flt-perm-team" className="text-sm cursor-pointer">Pode ver chats da equipe</Label>
                        </div>
                        <div className="flex items-center gap-2">
                          <Checkbox
                            checked={filtersPerms.has("can_view_all_client_chats")}
                            onCheckedChange={() => toggleSet(setFiltersPerms, filtersPerms, "can_view_all_client_chats")}
                            id="flt-perm-all"
                          />
                          <Label htmlFor="flt-perm-all" className="text-sm cursor-pointer">Pode ver todos os chats do cliente</Label>
                        </div>
                        <div className="flex items-center gap-2">
                          <Checkbox
                            checked={filtersPerms.has("can_manage_scenarios")}
                            onCheckedChange={() => toggleSet(setFiltersPerms, filtersPerms, "can_manage_scenarios")}
                            id="flt-perm-lab"
                          />
                          <Label htmlFor="flt-perm-lab" className="text-sm cursor-pointer">Pode gerenciar cenários</Label>
                        </div>
                      </div>
                    </div>
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={clearFilters}>Limpar filtros</Button>
                    <Button onClick={() => setFiltersOpen(false)}>Aplicar</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
              {/* Users list */}
              <Card className="p-4">
                <h3 className="font-semibold mb-2">Usuários</h3>
                <div className="space-y-2 max-h-[280px] overflow-y-auto overflow-x-hidden pr-1">
                  {filteredUsers.map((u) => (
                    <UserRow
                      key={u.id}
                      user={u}
                      selected={selectedUserId === u.id}
                      onSelect={async () => {
                        // Seleciona usuário e carrega vínculos; evita reset imediato para não gerar flicker nos toggles
                        setSelectedUserId(u.id);
                        const links = await loadUserLinks(u.id);
                        if (links && links.length > 0) {
                          const l = links[0];
                          setSelectedClientId(l.client_id);
                          setTipoUsuario(l.tipo_usuario || "interno");
                          setCanStartChat(!!l.can_start_chat);
                          setCanEditKB(!!l.can_edit_kb);
                          setCanViewTeam(!!l.can_view_team_chats);
                          setCanViewAll(!!l.can_view_all_client_chats);
                          setCanManageLab(!!l.can_manage_scenarios);
                        } else {
                          // Sem vínculos: define padrão claro
                          setSelectedClientId("");
                          setTipoUsuario("interno");
                          setCanStartChat(false);
                          setCanEditKB(false);
                          setCanViewTeam(false);
                          setCanViewAll(false);
                        }
                      }}
                    />
                  ))}
                  {filteredUsers.length === 0 && <p className="text-sm text-muted-foreground">Nenhum usuário encontrado.</p>}
                </div>
              </Card>
            </div>

            {/* Right panel: 2/3 */}
            <div className="md:col-span-2">
              <Card className="p-4">
                {!selectedUserId && (
                  <div className="text-sm text-muted-foreground">
                    Selecione um usuário na lista à esquerda para editar permissões e vínculos.
                  </div>
                )}
                {selectedUserId && (
                  <div className="grid gap-4">
                    {/* Selected user summary */}
                    {usersMap[selectedUserId] ? (
                      <SelectedUserSummary
                        user={usersMap[selectedUserId]}
                        onPatch={handlePatchUser}
                      />
                    ) : (
                      <div className="text-sm text-muted-foreground">Carregando usuário...</div>
                    )}

                    {/* Editor de permissões */}
                    <div className="grid md:grid-cols-2 gap-4">
                      <div className="grid gap-2">
                        <Label>Cliente</Label>
                        <Select value={selectedClientId} onValueChange={setSelectedClientId}>
                          <SelectTrigger>
                            <SelectValue placeholder="Selecione um cliente" />
                          </SelectTrigger>
                          <SelectContent>
                            {clients.map((c) => (
                              <SelectItem key={c.id} value={c.id}>
                                {c.name} {c.code ? `(${c.code})` : ""}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid gap-2">
                        <Label>Tipo de usuário</Label>
                        <Select value={tipoUsuario} onValueChange={setTipoUsuario}>
                          <SelectTrigger>
                            <SelectValue placeholder="interno/externo" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="interno">interno</SelectItem>
                            <SelectItem value="externo">externo</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    <div className="grid md:grid-cols-2 gap-4 mt-2">
                      <PermToggle label="Pode iniciar chat" checked={canStartChat} onChange={setCanStartChat} />
                      <PermToggle label="Pode editar base de conhecimento" checked={canEditKB} onChange={setCanEditKB} />
                      <PermToggle label="Pode ver chats da equipe" checked={canViewTeam} onChange={setCanViewTeam} />
                      <PermToggle label="Pode ver todos os chats do cliente" checked={canViewAll} onChange={setCanViewAll} />
                      <PermToggle label="Pode gerenciar cenários" checked={canManageLab} onChange={setCanManageLab} />
                    </div>

                    <div className="flex gap-2 mt-2">
                      <Button onClick={handleUpsertUserClient}>
                        <Save className="w-4 h-4 mr-2" />
                        Salvar Permissões
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => selectedUserId && loadUserLinks(selectedUserId)}
                        disabled={linksLoading}
                      >
                        <RefreshCw className="w-4 h-4 mr-2" />
                        Recarregar Vínculos
                      </Button>
                    </div>

                    <hr className="my-4" />
                    <h4 className="font-semibold mb-2">Vínculos existentes</h4>
                    {linksError && <p className="text-xs text-destructive mb-2">{linksError}</p>}
                    <div className="space-y-2 max-h-[260px] overflow-y-auto overflow-x-hidden pr-1">
                      {userLinks.map((l) => (
                        <Card key={l.id} className="p-3 flex items-center justify-between">
                          <div className="text-sm">
                            <div className="font-medium">
                              {l.client_name || clientsMap[l.client_id]?.name || l.client_id}{" "}
                              {l.client_code ? `(${l.client_code})` : ""}
                            </div>
                            <div className="text-muted-foreground">
                              tipo: {l.tipo_usuario} • start:{String(l.can_start_chat)} • kb:{String(l.can_edit_kb)} • lab:{String(l.can_manage_scenarios)} •
                              team:{String(l.can_view_team_chats)} • all:{String(l.can_view_all_client_chats)}
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => fillEditorFromLink(l)}
                            >
                              Carregar
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-destructive hover:text-destructive"
                              onClick={() => handleDeleteLink(l)}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        </Card>
                      ))}
                      {userLinks.length === 0 && (
                        <p className="text-sm text-muted-foreground">Nenhum vínculo para este usuário.</p>
                      )}
                    </div>
                  </div>
                )}
              </Card>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
};

// Left-side client row editor
const ClientRow: React.FC<{
  client: Client;
  onSave: (c: Client, nextName: string, nextCode: string) => void;
  onDelete: (c: Client) => void;
}> = ({ client, onSave, onDelete }) => {
  const [name, setName] = useState(client.name);
  const [code, setCode] = useState(client.code);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setName(client.name);
    setCode(client.code);
    setDirty(false);
  }, [client.id, client.name, client.code]);

  return (
    <Card className="p-3 flex items-center gap-3">
      <div className="grid gap-1 flex-1">
        <div className="grid md:grid-cols-2 gap-2">
          <div className="grid gap-1.5">
            <Label>Nome</Label>
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setDirty(true);
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Código</Label>
            <Input
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                setDirty(true);
              }}
            />
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!dirty}
          onClick={() => onSave(client, name, code)}
        >
          <Save className="w-4 h-4 mr-1" />
          Salvar
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={() => onDelete(client)}
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>
    </Card>
  );
};

// User row in left list
const UserRow: React.FC<{
  user: User;
  selected: boolean;
  onSelect: () => void;
}> = ({ user, selected, onSelect }) => {
  return (
    <Card
      className={`p-3 transition-colors cursor-pointer ${selected ? "ring-2 ring-secondary" : ""}`}
      onClick={onSelect}
    >
      <div className="flex items-center justify-between">
        <div className="text-sm">
          <div className="font-medium flex items-center gap-2">
            {user.full_name}
            <Badge
              variant={user.status === "active" ? "default" : "secondary"}
              className={user.status === "active" ? "bg-green-600 text-white" : "bg-gray-500 text-white"}
            >
              {user.status === "active" ? "Ativo" : "Inativo"}
            </Badge>
            {user.is_admin && <Badge variant="outline">Admin</Badge>}
          </div>
          <div className="text-muted-foreground">{user.email}</div>
        </div>
      </div>
    </Card>
  );
};
// Selected user summary (right panel header)
const SelectedUserSummary: React.FC<{
  user: User;
  onPatch: (u: User, patch: Partial<User> & { must_reset_password?: boolean }) => void;
}> = ({ user, onPatch }) => {
  const [isAdmin, setIsAdmin] = useState<boolean>(user.is_admin);
  const [status, setStatus] = useState<"active" | "inactive">(user.status);
  useEffect(() => {
    setIsAdmin(user.is_admin);
    setStatus(user.status);
  }, [user.id, user.is_admin, user.status]);

  return (
    <Card className="p-3">
      <div className="flex items-center justify-between">
        <div className="text-sm">
          <div className="font-semibold text-base">{user.full_name}</div>
          <div className="text-muted-foreground">{user.email}</div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Label className="text-xs">Admin</Label>
            <Switch
              checked={isAdmin}
              onCheckedChange={(v) => {
                setIsAdmin(v);
                onPatch(user, { is_admin: v });
              }}
            />
          </div>
          <Select value={status} onValueChange={(v) => { setStatus(v as any); onPatch(user, { status: v as any }); }}>
            <SelectTrigger className="w-[120px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Ativo</SelectItem>
              <SelectItem value="inactive">Inativo</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPatch(user, { must_reset_password: true })}
            title="Forçar redefinição de senha no próximo login"
          >
            Forçar Reset
          </Button>
        </div>
      </div>
    </Card>
  );
};

// Permission toggle component
const PermToggle: React.FC<{ label: string; checked: boolean; onChange: (v: boolean) => void }> = ({ label, checked, onChange }) => (
  <div className="flex items-center justify-between p-3 border rounded-md">
    <span className="text-sm">{label}</span>
    <Switch checked={checked} onCheckedChange={onChange} />
  </div>
);

export default AdminPanel;
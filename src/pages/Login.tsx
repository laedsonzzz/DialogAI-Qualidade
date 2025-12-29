import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/use-toast";
import { setTokens, setClientId } from "@/lib/auth";

const API_BASE = import.meta.env?.VITE_API_BASE_URL || "";

const Login: React.FC = () => {
  const navigate = useNavigate();

  // Estado comum
  const [loading, setLoading] = useState(false);
  const [clientId, setClientIdInput] = useState("");

  // Estado login normal / primeiro acesso
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isFirstAccess, setIsFirstAccess] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  // Estado bootstrap (admin inicial)
  const [needsBootstrap, setNeedsBootstrap] = useState(false);
  const [adminFullName, setAdminFullName] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [adminConfirmPassword, setAdminConfirmPassword] = useState("");

  useEffect(() => {
    // Verifica se é necessário fluxo de bootstrap (nenhum usuário cadastrado)
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/auth/bootstrap`, { method: "GET" });
        const data = await res.json().catch(() => ({}));
        setNeedsBootstrap(Boolean(data?.needs_bootstrap));
      } catch {
        setNeedsBootstrap(false);
      }
    })();
  }, []);

  async function onBootstrapSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;

    // Validações
    if (!email) {
      toast({ title: "Email obrigatório", description: "Informe o email do administrador", variant: "destructive" });
      return;
    }
    if (!adminFullName) {
      toast({ title: "Nome obrigatório", description: "Informe o nome completo do administrador", variant: "destructive" });
      return;
    }
    if (!adminPassword || !adminConfirmPassword) {
      toast({ title: "Defina a senha", description: "Informe e confirme a senha do administrador", variant: "destructive" });
      return;
    }
    if (adminPassword !== adminConfirmPassword) {
      toast({ title: "Senhas diferentes", description: "A confirmação deve ser igual à senha", variant: "destructive" });
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          full_name: adminFullName,
          password: adminPassword,
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const msg = data?.error || `Erro ao criar administrador (HTTP ${res.status})`;
        toast({ title: "Falha no bootstrap", description: String(msg), variant: "destructive" });
        setLoading(false);
        return;
      }

      const access = data?.access_token;
      const refresh = data?.refresh_token;
      if (!access) {
        toast({ title: "Resposta inválida", description: "Token de acesso não retornado", variant: "destructive" });
        setLoading(false);
        return;
      }

      setTokens(access, refresh);
      if (clientId) {
        setClientId(clientId);
      }
      toast({ title: "Administrador criado", description: "Sessão iniciada como administrador" });
      navigate("/", { replace: true });
    } catch (err: any) {
      toast({
        title: "Erro inesperado",
        description: String(err?.message || err),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }

  async function onLoginSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;

    // Validações
    if (!email) {
      toast({ title: "Email obrigatório", description: "Informe seu email corporativo", variant: "destructive" });
      return;
    }
    if (!isFirstAccess && !password) {
      toast({ title: "Senha obrigatória", description: "Informe sua senha", variant: "destructive" });
      return;
    }
    if (isFirstAccess) {
      if (!newPassword || !confirmPassword) {
        toast({ title: "Defina sua senha", description: "Informe e confirme sua nova senha para primeiro acesso", variant: "destructive" });
        return;
      }
      if (newPassword !== confirmPassword) {
        toast({ title: "Senhas diferentes", description: "A confirmação deve ser igual à nova senha", variant: "destructive" });
        return;
      }
    }

    setLoading(true);
    try {
      const body: Record<string, any> = { email };
      if (password) body.password = password;
      if (isFirstAccess) {
        body.new_password = newPassword;
        body.confirm_password = confirmPassword;
      }

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      // Opcional: enviar Client ID (não é necessário para /login, mas não atrapalha)
      if (clientId) {
        headers["X-Client-Id"] = clientId;
      }

      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        // Primeiro acesso solicitado pelo backend
        if (data?.require_set_password && !isFirstAccess) {
          setIsFirstAccess(true);
          toast({
            title: "Primeiro acesso necessário",
            description: "Defina sua nova senha para concluir o login",
          });
          setLoading(false);
          return;
        }
        const msg = data?.error || `Erro ao autenticar (HTTP ${res.status})`;
        toast({ title: "Login falhou", description: String(msg), variant: "destructive" });
        setLoading(false);
        return;
      }

      const access = data?.access_token;
      const refresh = data?.refresh_token;
      if (!access) {
        toast({ title: "Resposta inválida", description: "Token de acesso não retornado pelo servidor", variant: "destructive" });
        setLoading(false);
        return;
      }

      setTokens(access, refresh);
      if (clientId) {
        setClientId(clientId);
      }

      toast({ title: "Login realizado", description: "Sessão iniciada com sucesso" });
      navigate("/", { replace: true });
    } catch (err: any) {
      toast({
        title: "Erro inesperado",
        description: String(err?.message || err),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-muted p-4">
      <Card className="w-full max-w-md shadow-glow">
        <CardHeader>
          <CardTitle>{needsBootstrap ? "Configuração Inicial (Administrador)" : "Autenticação"}</CardTitle>
        </CardHeader>
        <CardContent>
          {needsBootstrap ? (
            <form onSubmit={onBootstrapSubmit} className="space-y-4">
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  Nenhum usuário encontrado. Crie o administrador inicial para começar.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="adminEmail">Email (Administrador)</Label>
                <Input
                  id="adminEmail"
                  type="email"
                  placeholder="admin@empresa.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="adminFullName">Nome completo</Label>
                <Input
                  id="adminFullName"
                  type="text"
                  placeholder="Nome do Administrador"
                  value={adminFullName}
                  onChange={(e) => setAdminFullName(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="adminPassword">Senha</Label>
                <Input
                  id="adminPassword"
                  type="password"
                  placeholder="Crie a senha do administrador"
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="adminConfirmPassword">Confirmar senha</Label>
                <Input
                  id="adminConfirmPassword"
                  type="password"
                  placeholder="Confirme a senha do administrador"
                  value={adminConfirmPassword}
                  onChange={(e) => setAdminConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="clientId">Client ID (UUID) opcional</Label>
                <Input
                  id="clientId"
                  type="text"
                  placeholder="Opcional: UUID do cliente (tenant)"
                  value={clientId}
                  onChange={(e) => setClientIdInput(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Você poderá escolher/alterar o cliente após o login.
                </p>
              </div>

              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Criando..." : "Criar Administrador"}
              </Button>

              <div className="text-center">
                <p className="text-xs text-muted-foreground">
                  Após criar, você será autenticado automaticamente.
                </p>
              </div>
            </form>
          ) : (
            <form onSubmit={onLoginSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="seu.email@empresa.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username"
                />
              </div>

              {!isFirstAccess && (
                <div className="space-y-2">
                  <Label htmlFor="password">Senha</Label>
                  <Input
                    id="password"
                    type="password"
                    placeholder="Sua senha"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                  />
                </div>
              )}

              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <Label className="flex items-center gap-2">
                    <Switch checked={isFirstAccess} onCheckedChange={setIsFirstAccess} />
                    Primeiro acesso (definir senha)
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Ative para criar sua senha no primeiro login
                  </p>
                </div>
              </div>

              {isFirstAccess && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="newPassword">Nova senha</Label>
                    <Input
                      id="newPassword"
                      type="password"
                      placeholder="Crie sua senha"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      autoComplete="new-password"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="confirmPassword">Confirmar nova senha</Label>
                    <Input
                      id="confirmPassword"
                      type="password"
                      placeholder="Confirme sua senha"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      autoComplete="new-password"
                    />
                  </div>
                </>
              )}

              <div className="space-y-2">
                <Label htmlFor="clientId">Client ID (UUID)</Label>
                <Input
                  id="clientId"
                  type="text"
                  placeholder="Opcional: selecione o cliente (ex.: UUID)"
                  value={clientId}
                  onChange={(e) => setClientIdInput(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Opcional: informe o UUID do cliente para multi-tenant. Você poderá trocar mais tarde.
                </p>
              </div>

              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Entrando..." : "Entrar"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default Login;
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { getAuthHeader, getClientId } from "@/lib/auth";

type MeUser = {
  id: string;
  email: string;
  full_name?: string;
  status?: string;
  is_admin?: boolean;
  avatar_present?: boolean;
  avatar_updated_at?: string | null;
};

type MeClient = {
  client_id: string;
  client_name: string;
  client_code?: string;
  tipo_usuario?: string;
};

type MeResponse = {
  user: MeUser;
  clients: MeClient[];
};

const API_BASE = import.meta.env?.VITE_API_BASE_URL || "";

const ProfileMenu: React.FC = () => {
  const { toast } = useToast();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const selectedClientId = useMemo(() => getClientId(), []);
  const clientName = useMemo(() => {
    const cid = selectedClientId;
    if (!cid || !me?.clients) return null;
    const c = me.clients.find((x) => x.client_id === cid);
    return c ? (c.client_code ? `${c.client_name} (${c.client_code})` : c.client_name) : null;
  }, [selectedClientId, me?.clients]);

  async function loadMe() {
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
      setMe(data);
      await loadAvatar(data?.user);
    } catch (e: any) {
      console.error("Erro ao carregar perfil:", e);
    }
  }

  async function loadAvatar(user?: MeUser | null) {
    try {
      const has = user?.avatar_present;
      if (!has) {
        setAvatarUrl(null);
        return;
      }
      const bust = user?.avatar_updated_at ? `?t=${encodeURIComponent(String(user.avatar_updated_at))}` : "";
      const res = await fetch(`${API_BASE}/api/profile/avatar${bust}`, {
        headers: {
          ...getAuthHeader(),
        },
      });
      if (!res.ok) {
        // 404: sem avatar
        setAvatarUrl(null);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      setAvatarUrl(url);
    } catch (e) {
      console.warn("Falha ao carregar avatar:", e);
      setAvatarUrl(null);
    }
  }

  useEffect(() => {
    loadMe();
  }, []);

  // Atualiza nomenclatura quando client:changed
  useEffect(() => {
    const handler = () => {
      loadMe();
    };
    window.addEventListener("client:changed", handler as any);
    return () => window.removeEventListener("client:changed", handler as any);
  }, []);

  function getInitials(name?: string | null) {
    const n = String(name || "").trim();
    if (!n) return "U";
    const parts = n.split(/\s+/);
    const a = parts[0]?.[0] || "";
    const b = parts.length > 1 ? parts[parts.length - 1]?.[0] || "" : "";
    return (a + b).toUpperCase();
  }

  async function handleUploadAvatar(file: File) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toast({ title: "Arquivo muito grande", description: "Limite 2 MB", variant: "destructive" });
      return;
    }
    if (!["image/jpeg", "image/png"].includes(file.type)) {
      toast({ title: "Tipo inválido", description: "Apenas JPEG ou PNG", variant: "destructive" });
      return;
    }
    try {
      setUploading(true);
      const form = new FormData();
      form.append("avatar", file);
      const res = await fetch(`${API_BASE}/api/profile/avatar`, {
        method: "POST",
        headers: {
          ...getAuthHeader(),
        },
        body: form,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data?.error || `Falha no upload (HTTP ${res.status})`;
        toast({ title: "Upload falhou", description: String(msg), variant: "destructive" });
        return;
      }
      toast({ title: "Avatar atualizado" });
      // Atualiza me e avatar
      await loadMe();
      setPreviewUrl(null);
      setOpen(true);
    } catch (e: any) {
      toast({ title: "Erro no upload", description: String(e?.message || e), variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  function onSelectFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] || null;
    if (!f) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(f);
    setPreviewUrl(url);
  }

  const displayName = useMemo(() => {
    const name = me?.user?.full_name || "";
    const client = clientName;
    return client ? `${name} (${client})` : name;
  }, [me?.user?.full_name, clientName]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" className="p-0 h-10 w-10 rounded-full">
          <Avatar className="h-10 w-10">
            {avatarUrl ? (
              <AvatarImage src={avatarUrl} alt="avatar" />
            ) : (
              <AvatarFallback>{getInitials(me?.user?.full_name)}</AvatarFallback>
            )}
          </Avatar>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Perfil</DialogTitle>
          <DialogDescription>Veja suas informações e altere sua foto.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <Avatar className="h-16 w-16">
              {previewUrl ? (
                <AvatarImage src={previewUrl} alt="preview" />
              ) : avatarUrl ? (
                <AvatarImage src={avatarUrl} alt="avatar" />
              ) : (
                <AvatarFallback className="text-lg">{getInitials(me?.user?.full_name)}</AvatarFallback>
              )}
            </Avatar>
            <div className="text-sm">
              <div className="font-semibold">{displayName || me?.user?.full_name || "-"}</div>
              <div className="text-muted-foreground">{me?.user?.email || "-"}</div>
              <div className="text-muted-foreground">
                {me?.user?.status || "-"} {me?.user?.is_admin ? "• admin" : ""}
              </div>
            </div>
          </div>

          <Card className="p-3">
            <div className="grid gap-2">
              <Label>Alterar foto</Label>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png"
                onChange={onSelectFile}
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  disabled={!previewUrl || uploading}
                  onClick={() => {
                    const f = fileInputRef.current?.files?.[0];
                    if (f) handleUploadAvatar(f);
                  }}
                >
                  {uploading ? "Salvando..." : "Salvar nova foto"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setPreviewUrl(null);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                >
                  Cancelar
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">Limite 2 MB. Tipos: JPEG/PNG. Recorte automático 256x256.</p>
            </div>
          </Card>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Fechar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ProfileMenu;
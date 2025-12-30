import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MessageSquare, Target, TrendingUp, BookOpen, Sparkles, Zap, Info } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import ChatInterface from "@/components/ChatInterface";
import { KnowledgeBaseManager } from "@/components/KnowledgeBaseManager";
import ConversationsList from "@/components/ConversationsList";
import AdminPanel from "@/components/AdminPanel";
import heroImage from "@/assets/hero-customer-service.jpg";
import aiChatIllustration from "@/assets/ai-chat-illustration.jpg";
import analyticsIllustration from "@/assets/analytics-illustration.jpg";
import knowledgeIllustration from "@/assets/knowledge-illustration.jpg";
import ClientSwitcher from "@/components/ClientSwitcher";
import ProfileMenu from "@/components/ProfileMenu";
import { useNavigate } from "react-router-dom";
import { getAuthHeader, clearTokens, getClientId } from "@/lib/auth";
import { getCommonHeaders } from "@/lib/auth";

interface KnowledgeEntry {
  id: string;
  title: string;
  category: string;
}

const scenarios = [
  {
    id: "limite",
    title: "Solicitação de Aumento de Limite",
    description: "Cliente deseja aumentar o limite do cartão de crédito",
    profiles: [
      { id: "calmo", label: "Cliente Calmo", emotion: "😊" },
      { id: "ansioso", label: "Cliente Ansioso", emotion: "😰" },
      { id: "irritado", label: "Cliente Irritado", emotion: "😠" },
    ],
  },
  {
    id: "cobranca",
    title: "Contestação de Cobrança",
    description: "Cliente contesta uma cobrança não reconhecida",
    profiles: [
      { id: "confuso", label: "Cliente Confuso", emotion: "🤔" },
      { id: "preocupado", label: "Cliente Preocupado", emotion: "😟" },
      { id: "irritado", label: "Cliente Muito Irritado", emotion: "😡" },
    ],
  },
  {
    id: "cartao",
    title: "Problema com Cartão",
    description: "Cliente com problema de cartão bloqueado ou não recebido",
    profiles: [
      { id: "calmo", label: "Cliente Calmo", emotion: "😊" },
      { id: "urgente", label: "Cliente com Urgência", emotion: "⏰" },
      { id: "frustrado", label: "Cliente Frustrado", emotion: "😤" },
    ],
  },
  {
    id: "credito",
    title: "Solicitação de Crédito",
    description: "Cliente interessado em contratar um empréstimo",
    profiles: [
      { id: "empolgado", label: "Cliente Empolgado", emotion: "🤩" },
      { id: "cauteloso", label: "Cliente Cauteloso", emotion: "🤨" },
      { id: "desconfiado", label: "Cliente Desconfiado", emotion: "🧐" },
    ],
  },
];

const Index = () => {
  const [selectedScenario, setSelectedScenario] = useState<string | null>(null);
  const [selectedProfile, setSelectedProfile] = useState<string | null>(null);
  const [selectedProcess, setSelectedProcess] = useState<string>("");
  const [showChat, setShowChat] = useState(false);
  const [processes, setProcesses] = useState<KnowledgeEntry[]>([]);
  const [activeTab, setActiveTab] = useState<string>("simulate");
  const [canStartChat, setCanStartChat] = useState<boolean>(false);
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  const [hasAdmin, setHasAdmin] = useState<boolean>(true);

  const API_BASE = import.meta.env?.VITE_API_BASE_URL || "";
  const navigate = useNavigate();

  // Carrega permissões do usuário para o cliente selecionado (can_start_chat)
  const loadPermissions = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/me`, {
        headers: {
          ...getAuthHeader(),
          "Content-Type": "application/json",
        },
      });
      if (!res.ok) {
        setCanStartChat(false);
        return;
      }
      const data = await res.json();
      const cid = getClientId();
      const found = (data.clients || []).find((c: any) => c.client_id === cid);
      setCanStartChat(Boolean(found?.permissions?.can_start_chat));
      setIsAdmin(Boolean(data?.user?.is_admin));
    } catch {
      setCanStartChat(false);
    }
  };

  useEffect(() => {
    loadPermissions();
    loadAdminStatus();
  }, []);

  async function loadAdminStatus() {
    try {
      const res = await fetch(`${API_BASE}/api/auth/admin_status`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error((data as any)?.error || `Erro HTTP ${res.status}`);
      }
      setHasAdmin(Boolean(data?.has_admin));
    } catch {
      // Se falhar, mantém como true para não exibir ação por engano
      setHasAdmin(true);
    }
  }

  async function elevateIfNoAdmin() {
    try {
      const res = await fetch(`${API_BASE}/api/auth/elevate_if_no_admin`, {
        method: "POST",
        headers: {
          ...getAuthHeader(),
          "Content-Type": "application/json",
        },
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error((data as any)?.error || `Erro HTTP ${res.status}`);
      }
      // Elevado com sucesso
      setIsAdmin(true);
      setHasAdmin(true);
      // Recarregar permissões/UI
      await loadPermissions();
      setActiveTab("admin");
    } catch (e: any) {
      console.error("Erro ao elevar administrador:", e);
      // silencia, botão fica apenas desabilitado quando já existe admin
    }
  }

  const handleLogout = async () => {
    try {
      await fetch(`${API_BASE}/api/auth/logout`, {
        method: "POST",
        headers: {
          ...getAuthHeader(),
          "Content-Type": "application/json",
        },
      });
    } catch {
      // ignore network errors
    } finally {
      clearTokens();
      navigate("/login", { replace: true });
    }
  };

  useEffect(() => {
    loadProcesses();
  }, []);
  
  useEffect(() => {
    const handler = () => {
      loadPermissions();
      loadAdminStatus();
      loadProcesses();
      setShowChat(false);
      setSelectedScenario(null);
      setSelectedProfile(null);
      setSelectedProcess("");
    };
    window.addEventListener("client:changed", handler as any);
    return () => {
      window.removeEventListener("client:changed", handler as any);
    };
  }, []);
  
  const loadProcesses = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/knowledge_base`, {
        headers: getCommonHeaders(),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Erro HTTP ${res.status}`);
      }
      const data: KnowledgeEntry[] = await res.json();
      setProcesses(data || []);
    } catch (error) {
      console.error("Erro ao carregar processos:", error);
      setProcesses([]);
    }
  };

  const handleStartTraining = () => {
    if (!canStartChat) return;
    if (selectedScenario && selectedProfile) {
      setShowChat(true);
    }
  };

  const handleBackToMenu = () => {
    setShowChat(false);
    setSelectedScenario(null);
    setSelectedProfile(null);
    setSelectedProcess("");
    loadProcesses();
  };

  if (showChat && selectedScenario && selectedProfile) {
    const scenario = scenarios.find(s => s.id === selectedScenario);
    const profile = scenario?.profiles.find(p => p.id === selectedProfile);
    
    return (
      <ChatInterface
        scenario={scenario!.title}
        customerProfile={profile!.label}
        processId={selectedProcess || undefined}
        onBack={handleBackToMenu}
      />
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-muted">
      <div className="container mx-auto px-4 py-8">
        <div className="mb-6">
          <div className="flex items-center gap-4">
            <ClientSwitcher />
            {!isAdmin && !hasAdmin && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={elevateIfNoAdmin}
                title="Promover sua conta a administrador (nenhum admin existe)"
              >
                Tornar-se Administrador
              </Button>
            )}
            <div className="ml-auto flex items-center gap-3">
              <ProfileMenu />
              <Button variant="outline" size="sm" onClick={handleLogout}>
                Sair
              </Button>
            </div>
          </div>
        </div>
        {/* Hero Section with Image */}
        <div className="relative mb-16 rounded-3xl overflow-hidden shadow-glow">
          <div 
            className="absolute inset-0 bg-cover bg-center"
            style={{ backgroundImage: `url(${heroImage})` }}
          >
            <div className="absolute inset-0 bg-gradient-to-r from-primary/95 via-primary/80 to-transparent" />
          </div>
          <div className="relative z-10 px-8 md:px-16 py-16 md:py-24 text-white">
            <div className="max-w-2xl">
              <div className="inline-flex items-center gap-2 bg-secondary/20 backdrop-blur-sm px-4 py-2 rounded-full mb-6">
                <Sparkles className="w-5 h-5 text-secondary" />
                <span className="text-sm font-semibold">Diretoria de Qualidade</span>
              </div>
              <h1 className="text-5xl md:text-6xl font-bold mb-6 leading-tight">
                Simulador de Atendimento
              </h1>
              <p className="text-xl md:text-2xl mb-8 text-white/90 leading-relaxed">
                Treine suas habilidades de atendimento com simulações realistas baseadas em IA e processos reais
              </p>
              <div className="flex flex-wrap gap-4">
                <Button
                  size="lg"
                  className="bg-secondary hover:bg-secondary/90 text-white shadow-lg"
                  disabled={!canStartChat}
                  onClick={() => {
                    setActiveTab("simulate");
                    setTimeout(() => {
                      document.getElementById('scenarios-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }, 100);
                  }}
                >
                  <Zap className="w-5 h-5 mr-2" />
                  Começar Agora
                </Button>
                <Button 
                  size="lg" 
                  variant="outline"
                  className="bg-white/10 backdrop-blur-sm border-white/20 text-white hover:bg-white/20"
                  onClick={() => setActiveTab("knowledge")}
                >
                  <BookOpen className="w-5 h-5 mr-2" />
                  Base de Conhecimento
                </Button>
              </div>
            </div>
          </div>
        </div>

        {/* Tabs for Simulation and Knowledge Base */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="max-w-6xl mx-auto">
          <TabsList className={`grid w-full ${isAdmin ? 'grid-cols-4' : 'grid-cols-3'} mb-8 bg-card/50 backdrop-blur-sm p-1`}>
            <TabsTrigger
              value="simulate"
              className="flex items-center gap-2"
            >
              <MessageSquare className="w-4 h-4" />
              Iniciar Simulação
            </TabsTrigger>
            <TabsTrigger
              value="knowledge"
              className="flex items-center gap-2"
            >
              <BookOpen className="w-4 h-4" />
              Base de Conhecimento
            </TabsTrigger>
            <TabsTrigger
              value="conversations"
              className="flex items-center gap-2"
            >
              <MessageSquare className="w-4 h-4" />
              Conversas
            </TabsTrigger>
            {isAdmin && (
              <TabsTrigger
                value="admin"
                className="flex items-center gap-2"
              >
                <MessageSquare className="w-4 h-4" />
                Admin
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="knowledge">
            <KnowledgeBaseManager />
            
            {/* Developer Info */}
            <div className="mt-12 text-center">
              <div className="inline-block bg-card/50 backdrop-blur-sm rounded-lg px-6 py-4 border border-border/50">
                <p className="text-sm text-muted-foreground">
                  <span className="font-semibold text-foreground">Idealizado e iniciado por:</span> Time de Qualidade Itaú PJ/PF | 
                  <span className="font-semibold text-foreground"> Aprimorado por:</span> Time MonitorIA | 
                  <span className="ml-2">Versão 1.0.0</span> | 
                  <span className="ml-2">© 2025 Todos os direitos reservados</span>
                </p>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="simulate">
            {/* Features */}
            <div className="grid md:grid-cols-3 gap-6 mb-12">
              <Dialog>
                <DialogTrigger asChild>
                  <Card className="border-2 shadow-elegant hover:shadow-glow transition-all group overflow-hidden cursor-pointer">
                    <div className="h-48 overflow-hidden relative">
                      <img 
                        src={aiChatIllustration} 
                        alt="AI Chat" 
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                      />
                      <div className="absolute top-4 right-4 bg-secondary/90 backdrop-blur-sm rounded-full p-2">
                        <Info className="w-5 h-5 text-white" />
                      </div>
                    </div>
                    <CardHeader>
                      <Target className="w-8 h-8 text-secondary mb-2" />
                      <CardTitle className="text-lg">Cenários Reais</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <CardDescription>
                        Pratique situações comuns do dia a dia com diferentes perfis de clientes
                      </CardDescription>
                    </CardContent>
                  </Card>
                </DialogTrigger>
                <DialogContent className="max-w-2xl">
                  <DialogHeader>
                    <DialogTitle className="flex items-center gap-2 text-2xl">
                      <Target className="w-8 h-8 text-secondary" />
                      Cenários Reais de Atendimento
                    </DialogTitle>
                    <DialogDescription className="text-base space-y-4 pt-4">
                      <p>
                        Nosso simulador oferece uma variedade de cenários baseados em situações reais do atendimento ao cliente. 
                        Cada cenário foi cuidadosamente desenvolvido para refletir desafios autênticos que você encontrará no dia a dia.
                      </p>
                      
                      <div className="space-y-3">
                        <h4 className="font-semibold text-foreground">Cenários disponíveis:</h4>
                        <ul className="list-disc list-inside space-y-2 text-muted-foreground">
                          <li>Aumento de Limite: Lidando com solicitações de crédito</li>
                          <li><strong>Contestação de Cobrança:</strong> Resolvendo disputas e cobranças não reconhecidas</li>
                          <li><strong>Problema com Cartão:</strong> Assistência com cartões bloqueados ou não recebidos</li>
                          <li><strong>Solicitação de Crédito:</strong> Orientação sobre empréstimos e produtos financeiros</li>
                        </ul>
                      </div>

                      <div className="space-y-3">
                        <h4 className="font-semibold text-foreground">Perfis de Clientes:</h4>
                        <p>
                          Cada cenário inclui múltiplos perfis emocionais (calmo, ansioso, irritado, etc.), 
                          permitindo que você pratique técnicas de comunicação adaptadas a diferentes temperamentos.
                        </p>
                      </div>

                      <div className="mt-6 p-4 bg-muted/50 rounded-lg">
                        <p className="text-sm text-muted-foreground italic">
                          💡 Dica: Comece com perfis mais calmos e progrida para situações mais desafiadoras à medida que ganha confiança.
                        </p>
                      </div>
                    </DialogDescription>
                  </DialogHeader>
                </DialogContent>
              </Dialog>
              
              <Dialog>
                <DialogTrigger asChild>
                  <Card className="border-2 shadow-elegant hover:shadow-glow transition-all group overflow-hidden cursor-pointer">
                    <div className="h-48 overflow-hidden relative">
                      <img 
                        src={knowledgeIllustration} 
                        alt="Knowledge Base" 
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                      />
                      <div className="absolute top-4 right-4 bg-secondary/90 backdrop-blur-sm rounded-full p-2">
                        <Info className="w-5 h-5 text-white" />
                      </div>
                    </div>
                    <CardHeader>
                      <MessageSquare className="w-8 h-8 text-secondary mb-2" />
                      <CardTitle className="text-lg">IA Conversacional</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <CardDescription>
                        Interaja com clientes simulados por inteligência artificial
                      </CardDescription>
                    </CardContent>
                  </Card>
                </DialogTrigger>
                <DialogContent className="max-w-2xl">
                  <DialogHeader>
                    <DialogTitle className="flex items-center gap-2 text-2xl">
                      <MessageSquare className="w-8 h-8 text-secondary" />
                      Inteligência Artificial Conversacional
                    </DialogTitle>
                    <DialogDescription className="text-base space-y-4 pt-4">
                      <p>
                        Utilizamos modelos avançados de IA para criar experiências de conversação realistas e dinâmicas. 
                        Nosso sistema não segue scripts rígidos - ele adapta suas respostas com base no contexto e no seu comportamento.
                      </p>
                      
                      <div className="space-y-3">
                        <h4 className="font-semibold text-foreground">Características da IA:</h4>
                        <ul className="list-disc list-inside space-y-2 text-muted-foreground">
                          <li><strong>Respostas Contextuais:</strong> Entende e responde de acordo com o histórico da conversa</li>
                          <li><strong>Personalidades Distintas:</strong> Cada perfil tem comportamentos e vocabulário únicos</li>
                          <li><strong>Reações Emocionais:</strong> Simula frustração, satisfação e outras emoções autênticas</li>
                          <li><strong>Processamento de Linguagem Natural:</strong> Compreende diferentes formas de expressão</li>
                          <li><strong>Base de Conhecimento Integrada:</strong> Pode referenciar processos e políticas da empresa</li>
                        </ul>
                      </div>

                      <div className="space-y-3">
                        <h4 className="font-semibold text-foreground">Tecnologia:</h4>
                        <p>
                          Powered by Diva AI, nosso sistema utiliza modelos de linguagem de última geração 
                          para proporcionar conversas que parecem naturais e imprevisíveis, assim como interações reais.
                        </p>
                      </div>

                      <div className="mt-6 p-4 bg-muted/50 rounded-lg">
                        <p className="text-sm text-muted-foreground italic">
                          🤖 A IA aprende com cada interação para proporcionar cenários cada vez mais desafiadores e realistas.
                        </p>
                      </div>
                    </DialogDescription>
                  </DialogHeader>
                </DialogContent>
              </Dialog>
              
              <Dialog>
                <DialogTrigger asChild>
                  <Card className="border-2 shadow-elegant hover:shadow-glow transition-all group overflow-hidden cursor-pointer">
                    <div className="h-48 overflow-hidden relative">
                      <img 
                        src={analyticsIllustration} 
                        alt="Analytics" 
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                      />
                      <div className="absolute top-4 right-4 bg-secondary/90 backdrop-blur-sm rounded-full p-2">
                        <Info className="w-5 h-5 text-white" />
                      </div>
                    </div>
                    <CardHeader>
                      <TrendingUp className="w-8 h-8 text-secondary mb-2" />
                      <CardTitle className="text-lg">Feedback Detalhado</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <CardDescription>
                        Receba avaliação CSAT e sugestões práticas de melhoria
                      </CardDescription>
                    </CardContent>
                  </Card>
                </DialogTrigger>
                <DialogContent className="max-w-2xl">
                  <DialogHeader>
                    <DialogTitle className="flex items-center gap-2 text-2xl">
                      <TrendingUp className="w-8 h-8 text-secondary" />
                      Sistema de Avaliação e Feedback
                    </DialogTitle>
                    <DialogDescription className="text-base space-y-4 pt-4">
                      <p>
                        Ao final de cada simulação, você recebe uma avaliação completa e objetiva do seu desempenho, 
                        baseada em métricas reais usadas na indústria de atendimento ao cliente.
                      </p>
                      
                      <div className="space-y-3">
                        <h4 className="font-semibold text-foreground">Métricas Avaliadas:</h4>
                        <ul className="list-disc list-inside space-y-2 text-muted-foreground">
                          <li><strong>CSAT Score (1-5):</strong> Customer Satisfaction Score - métrica padrão da indústria</li>
                          <li><strong>Empatia:</strong> Capacidade de compreender e validar sentimentos do cliente</li>
                          <li><strong>Clareza:</strong> Quão bem você comunica informações e soluções</li>
                          <li><strong>Eficiência:</strong> Tempo e passos necessários para resolver o problema</li>
                          <li><strong>Profissionalismo:</strong> Tom, linguagem e postura durante o atendimento</li>
                          <li><strong>Aderência aos Processos:</strong> Seguimento correto dos procedimentos (quando aplicável)</li>
                        </ul>
                      </div>

                      <div className="space-y-3">
                        <h4 className="font-semibold text-foreground">Feedback Personalizado:</h4>
                        <p>
                          Além das notas, você recebe sugestões específicas de melhoria, exemplos de frases 
                          que funcionaram bem e pontos de atenção para desenvolver suas habilidades.
                        </p>
                      </div>

                      <div className="space-y-3">
                        <h4 className="font-semibold text-foreground">Pontos Fortes e Áreas de Melhoria:</h4>
                        <p>
                          O sistema identifica seus pontos fortes para que você os mantenha, e aponta áreas 
                          específicas onde há oportunidade de crescimento, com dicas práticas e acionáveis.
                        </p>
                      </div>

                      <div className="mt-6 p-4 bg-muted/50 rounded-lg">
                        <p className="text-sm text-muted-foreground italic">
                          📊 Use o feedback para acompanhar sua evolução e focar nas habilidades que mais precisam ser desenvolvidas.
                        </p>
                      </div>
                    </DialogDescription>
                  </DialogHeader>
                </DialogContent>
              </Dialog>
            </div>

            {/* Scenario Selection */}
            <div className="max-w-4xl mx-auto" id="scenarios-section">
              <h2 className="text-2xl font-bold text-primary mb-6">Escolha um Cenário</h2>
              
              <div className="grid md:grid-cols-2 gap-6 mb-8">
                {scenarios.map((scenario) => (
                  <Card
                    key={scenario.id}
                    className={`cursor-pointer transition-all hover:shadow-glow ${
                      selectedScenario === scenario.id
                        ? 'ring-2 ring-secondary shadow-glow'
                        : 'hover:border-secondary'
                    }`}
                    onClick={() => {
                      setSelectedScenario(scenario.id);
                      setSelectedProfile(null);
                    }}
                  >
                    <CardHeader>
                      <CardTitle className="text-lg">{scenario.title}</CardTitle>
                      <CardDescription>{scenario.description}</CardDescription>
                    </CardHeader>
                    {selectedScenario === scenario.id && (
                      <CardContent>
                        <p className="text-sm font-semibold mb-3 text-primary">Escolha o perfil do cliente:</p>
                        <div className="space-y-2">
                          {scenario.profiles.map((profile) => (
                            <Button
                              key={profile.id}
                              variant={selectedProfile === profile.id ? "default" : "outline"}
                              className="w-full justify-start"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedProfile(profile.id);
                              }}
                            >
                              <span className="mr-2 text-xl">{profile.emotion}</span>
                              {profile.label}
                            </Button>
                          ))}
                        </div>
                      </CardContent>
                    )}
                  </Card>
                ))}
              </div>

              {/* Process Selection */}
              {processes.length > 0 && selectedScenario && selectedProfile && (
                <Card className="mb-8 border-2 shadow-elegant">
                  <CardHeader>
                    <div className="flex items-center gap-2">
                      <BookOpen className="w-5 h-5 text-secondary" />
                      <CardTitle className="text-lg">Processo Operacional (Opcional)</CardTitle>
                    </div>
                    <CardDescription>
                      Selecione um processo para tornar a simulação mais realista e baseada em fluxos reais
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Select value={selectedProcess} onValueChange={setSelectedProcess}>
                      <SelectTrigger>
                        <SelectValue placeholder="Escolha um processo ou deixe em branco" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Sem processo específico</SelectItem>
                        {processes.map((process) => (
                          <SelectItem key={process.id} value={process.id}>
                            {process.title} - {process.category}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </CardContent>
                </Card>
              )}

              {selectedScenario && selectedProfile && (
                <div className="flex justify-center">
                  <Button
                    size="lg"
                    className="bg-gradient-primary text-white hover:opacity-90 shadow-glow text-lg px-8"
                    disabled={!canStartChat}
                    onClick={handleStartTraining}
                  >
                    Iniciar Simulação
                  </Button>
                </div>
              )}

              {/* Developer Info */}
              <div className="mt-12 text-center">
                <div className="inline-block bg-card/50 backdrop-blur-sm rounded-lg px-6 py-4 border border-border/50">
                  <p className="text-sm text-muted-foreground">
                    <span className="font-semibold text-foreground">Idealizado e iniciado por:</span> Time de Qualidade Itaú PJ/PF | 
                    <span className="font-semibold text-foreground"> Aprimorado por:</span> Time MonitorIA | 
                    <span className="ml-2">Versão 1.0.0</span> | 
                    <span className="ml-2">© 2025 Todos os direitos reservados</span>
                  </p>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="conversations">
            <ConversationsList />
          </TabsContent>

          {isAdmin && (
            <TabsContent value="admin">
              <AdminPanel />
            </TabsContent>
          )}

        </Tabs>
      </div>
    </div>
  );
};

export default Index;

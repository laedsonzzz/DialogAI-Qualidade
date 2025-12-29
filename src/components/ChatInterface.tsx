import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Send, Loader2, Mic, MessageSquare } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition";
import EvaluationResults from "./EvaluationResults";
import { getCommonHeaders } from "@/lib/auth";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface ChatInterfaceProps {
  scenario: string;
  customerProfile: string;
  processId?: string;
  onBack: () => void;
}

interface PromptVersion {
  id: string;
  version?: number;
  is_active?: boolean;
  content?: string;
}

interface Prompt {
  id: string;
  name?: string;
  versions?: PromptVersion[];
}

const ChatInterface = ({ scenario, customerProfile, processId, onBack }: ChatInterfaceProps) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [showEvaluation, setShowEvaluation] = useState(false);
  const [evaluation, setEvaluation] = useState<any>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [startY, setStartY] = useState<number | null>(null);

  // Prompts por cliente e versão selecionada (multi-tenant)
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [selectedPromptVersionId, setSelectedPromptVersionId] = useState<string | null>(null);
  const [promptsLoaded, setPromptsLoaded] = useState(false);
  const hasStartedRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const recordingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const micButtonRef = useRef<HTMLButtonElement>(null);
  const { toast } = useToast();
  const { isListening, transcript, isSupported, startListening, stopListening, resetTranscript } = useSpeechRecognition();

  const API_BASE = import.meta.env?.VITE_API_BASE_URL || "";

  useEffect(() => {
    loadPrompts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hasStartedRef.current && promptsLoaded) {
      hasStartedRef.current = true;
      startConversation();
    }
  }, [promptsLoaded]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    if (transcript && !isListening && isRecording) {
      setInput(transcript);
      handleRecordingComplete();
    }
  }, [transcript, isListening, isRecording]);

  useEffect(() => {
    return () => {
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
      }
    };
  }, []);

  const handleRecordingComplete = () => {
    setIsRecording(false);
    setRecordingTime(0);
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
  };

  const startRecording = () => {
    if (isLoading) return;

    setIsRecording(true);
    setRecordingTime(0);
    resetTranscript();
    startListening();

    recordingTimerRef.current = setInterval(() => {
      setRecordingTime((prev) => prev + 1);
    }, 1000);
  };

  const stopRecording = () => {
    if (!isRecording) return;
    stopListening();

    // Wait a bit for the final transcript to be processed
    setTimeout(() => {
      if (transcript) {
        setInput(transcript);
      }
      handleRecordingComplete();
    }, 300);
  };

  const cancelRecording = () => {
    if (!isRecording) return;

    stopListening();
    resetTranscript();
    setInput("");
    handleRecordingComplete();

    toast({
      title: "Gravação cancelada",
      variant: "default",
    });
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setStartY(e.clientY);
    startRecording();
  };

  const handleMouseUp = () => {
    stopRecording();
    setStartY(null);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isRecording && startY !== null) {
      const deltaY = startY - e.clientY;
      if (deltaY > 50) {
        cancelRecording();
        setStartY(null);
      }
    }
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    setStartY(touch.clientY);
    startRecording();
  };

  const handleTouchEnd = () => {
    stopRecording();
    setStartY(null);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (isRecording && startY !== null) {
      const touch = e.touches[0];
      const deltaY = startY - touch.clientY;
      if (deltaY > 50) {
        cancelRecording();
        setStartY(null);
      }
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

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

  const startConversation = async () => {
    setIsLoading(true);
    try {
      // Create conversation
      const conv = await apiPost<{ id: string }>("/api/conversations", {
        scenario,
        customerProfile,
        processId: processId || null,
        promptVersionId: selectedPromptVersionId || null,
      });
      setConversationId(conv.id);

      // Initial assistant message
      const data = await apiPost<{ message: string }>("/api/chat", {
        messages: [],
        scenario,
        customerProfile,
        processId: processId || null,
        conversationId: conv.id,
      });

      const aiMessage: Message = { role: "assistant", content: data.message };
      setMessages([aiMessage]);
    } catch (error: any) {
      console.error("Error starting conversation:", error);
      let msg = error?.message || "";
      let missing = "";
      try {
        const parsed = JSON.parse(msg);
        if (parsed && typeof parsed === "object") {
          msg = parsed.error || msg;
          missing = parsed.missing_permission || "";
        }
      } catch {}
      if (missing === "can_start_chat" || /Acesso negado/i.test(msg)) {
        toast({
          title: "Sem permissão",
          description: "Você não possui permissão para iniciar conversas neste cliente.",
          variant: "destructive",
        });
        onBack();
        return;
      }
      toast({
        title: "Erro",
        description: msg || "Não foi possível iniciar a conversa",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  async function loadPrompts() {
    try {
      // Lista prompts e versões do cliente atual
      const list = await apiGet<any>("/api/prompts?include=all");
      // Normaliza em {id,name,versions[]}
      const normalized: Prompt[] = Array.isArray(list)
        ? list.map((p: any) => ({
            id: p.id,
            name: p.name || p.title || "Prompt",
            versions: Array.isArray(p.versions)
              ? p.versions.map((v: any) => ({
                  id: v.id,
                  version: v.version,
                  is_active: v.is_active || v.active || false,
                  content: v.content,
                }))
              : [],
          }))
        : [];
      setPrompts(normalized);

      // Seleciona por padrão a versão ativa do primeiro prompt, se existir
      const firstActive = normalized.flatMap((p) => p.versions || []).find((v) => v.is_active);
      if (firstActive?.id) {
        setSelectedPromptVersionId(firstActive.id);
      }
    } catch (error) {
      // Silencia erro (prompts são opcionais)
      console.warn("Erro ao carregar prompts:", error);
    } finally {
      setPromptsLoaded(true);
    }
  }

  const sendMessage = async () => {
    if (!conversationId) {
      toast({
        title: "Conversa não iniciada",
        description: "Não foi possível iniciar a conversa. Volte e tente novamente.",
        variant: "destructive",
      });
      return;
    }
    if (!input.trim() || isLoading) return;

    const userMessage: Message = { role: "user", content: input };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInput("");
    setIsLoading(true);

    try {
      const data = await apiPost<{ message: string }>("/api/chat", {
        messages: updatedMessages,
        scenario,
        customerProfile,
        processId: processId || null,
        conversationId,
      });

      const aiMessage: Message = { role: "assistant", content: data.message };
      const finalMessages = [...updatedMessages, aiMessage];
      setMessages(finalMessages);
    } catch (error: any) {
      console.error("Error sending message:", error);
      toast({
        title: "Erro",
        description: error.message || "Não foi possível enviar a mensagem",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const endConversation = async () => {
    if (messages.length < 4) {
      toast({
        title: "Conversa muito curta",
        description: "Continue a conversa um pouco mais antes de encerrar",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    try {
      const data = await apiPost<any>("/api/evaluate", {
        transcript: messages,
        scenario,
        customerProfile,
        conversationId,
      });

      setEvaluation(data);
      setShowEvaluation(true);
    } catch (error: any) {
      console.error("Error evaluating conversation:", error);
      toast({
        title: "Erro",
        description: error.message || "Não foi possível avaliar a conversa",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  if (showEvaluation && evaluation) {
    return <EvaluationResults evaluation={evaluation} onBack={onBack} />;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-muted p-4">
      <div className="max-w-4xl mx-auto h-[calc(100vh-2rem)] flex flex-col">
        {/* Header */}
        <div className="bg-gradient-to-r from-card to-card/80 backdrop-blur-sm rounded-t-2xl border-b border-border/50 p-4 shadow-elegant">
          <div className="flex items-center justify-between mb-3">
            <Button variant="ghost" size="sm" onClick={onBack} className="hover:bg-muted/50">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Voltar
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={endConversation}
              disabled={isLoading || messages.length < 4}
              className="shadow-lg"
            >
              Encerrar e Avaliar
            </Button>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-gradient-primary flex items-center justify-center shadow-glow">
              <MessageSquare className="w-6 h-6 text-white" />
            </div>
            <div>
              <h2 className="font-semibold text-primary text-lg">{scenario}</h2>
              <p className="text-sm text-muted-foreground flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-secondary animate-pulse" />
                Perfil: {customerProfile}
              </p>

              {/* Seleção de Prompt/Versão por cliente */}
              {prompts.length > 0 && (
                <div className="mt-2">
                  <div className="text-xs text-muted-foreground mb-1">Prompt da simulação</div>
                  <Select
                    value={selectedPromptVersionId || undefined}
                    onValueChange={(v) => setSelectedPromptVersionId(v)}
                  >
                    <SelectTrigger className="w-[280px]">
                      <SelectValue placeholder="Selecione o prompt/versão" />
                    </SelectTrigger>
                    <SelectContent>
                      {prompts.flatMap((p) =>
                        (p.versions || []).map((v) => (
                          <SelectItem key={v.id} value={v.id}>
                            {p.name} {typeof v.version === "number" ? `v${v.version}` : ""}{" "}
                            {v.is_active ? "(ativo)" : ""}
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 bg-card/50 backdrop-blur-sm p-6 overflow-y-auto">
          <div className="space-y-4">
            {messages.map((message, index) => (
              <div
                key={index}
                className={`flex ${message.role === "user" ? "justify-end" : "justify-start"} animate-fade-in`}
              >
                <div className={`flex items-end gap-2 max-w-[80%] ${message.role === "user" ? "flex-row-reverse" : "flex-row"}`}>
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                      message.role === "user" ? "bg-gradient-primary shadow-glow" : "bg-muted"
                    }`}
                  >
                    {message.role === "user" ? (
                      <span className="text-white text-sm font-bold">Eu</span>
                    ) : (
                      <MessageSquare className="w-4 h-4 text-muted-foreground" />
                    )}
                  </div>
                  <Card
                    className={`p-4 shadow-elegant transition-all hover:shadow-glow ${
                      message.role === "user" ? "bg-gradient-primary text-white border-0" : "bg-card border-border/50"
                    }`}
                  >
                    <p className="text-sm leading-relaxed">{message.content}</p>
                  </Card>
                </div>
              </div>
            ))}
            {isLoading && (
              <div className="flex justify-start animate-fade-in">
                <div className="flex items-end gap-2">
                  <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center">
                    <MessageSquare className="w-4 h-4 text-muted-foreground" />
                  </div>
                  <Card className="bg-card p-4 shadow-elegant border-border/50">
                    <div className="flex items-center gap-2">
                      <Loader2 className="w-5 h-5 animate-spin text-primary" />
                      <span className="text-sm text-muted-foreground">Digitando...</span>
                    </div>
                  </Card>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Input */}
        <div className="bg-gradient-to-r from-card to-card/80 backdrop-blur-sm rounded-b-2xl border-t border-border/50 p-4 shadow-elegant">
          {!isSupported && (
            <div className="mb-2 text-xs text-muted-foreground text-center bg-muted/50 p-2 rounded-lg">
              ⚠️ Reconhecimento de voz não disponível neste navegador
            </div>
          )}

          {isRecording && (
            <div className="mb-3 flex items-center justify-center gap-3 text-sm bg-destructive/10 p-3 rounded-lg">
              <div className="flex items-center gap-2 text-destructive animate-pulse">
                <div className="w-3 h-3 rounded-full bg-destructive shadow-glow" />
                <span className="font-medium">
                  {new Date(recordingTime * 1000).toISOString().substr(14, 5)}
                </span>
              </div>
              <span className="text-muted-foreground">Deslize para cima para cancelar</span>
            </div>
          )}

          <div className="flex gap-2">
            {isSupported && (
              <div className="relative">
                <Button
                  ref={micButtonRef}
                  onMouseDown={handleMouseDown}
                  onMouseUp={handleMouseUp}
                  onMouseMove={handleMouseMove}
                  onMouseLeave={() => isRecording && stopRecording()}
                  onTouchStart={handleTouchStart}
                  onTouchEnd={handleTouchEnd}
                  onTouchMove={handleTouchMove}
                  disabled={isLoading || !conversationId}
                  variant={isRecording ? "destructive" : "outline"}
                  className={`touch-none select-none transition-all ${isRecording ? "scale-110 animate-pulse shadow-lg" : ""}`}
                  size="icon"
                >
                  <Mic className="w-4 h-4" />
                </Button>
              </div>
            )}
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyPress={(e) => e.key === "Enter" && !isRecording && sendMessage()}
              placeholder={
                !conversationId
                  ? "Aguardando início da conversa..."
                  : isRecording
                  ? "Gravando áudio..."
                  : "Digite ou segure o microfone para falar..."
              }
              disabled={isLoading || isRecording || !conversationId}
              className="flex-1"
            />
            <Button
              onClick={sendMessage}
              disabled={isLoading || !input.trim() || isRecording || !conversationId}
              className="bg-gradient-primary text-white hover:opacity-90 shadow-glow"
              size="icon"
            >
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChatInterface;

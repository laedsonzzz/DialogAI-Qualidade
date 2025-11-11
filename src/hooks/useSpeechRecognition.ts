import { useState, useEffect, useCallback, useRef } from 'react';

interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}

interface ISpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onstart: ((this: ISpeechRecognition, ev: Event) => any) | null;
  onend: ((this: ISpeechRecognition, ev: Event) => any) | null;
  onresult: ((this: ISpeechRecognition, ev: SpeechRecognitionEvent) => any) | null;
  onerror: ((this: ISpeechRecognition, ev: SpeechRecognitionErrorEvent) => any) | null;
}

declare global {
  interface Window {
    SpeechRecognition: new () => ISpeechRecognition;
    webkitSpeechRecognition: new () => ISpeechRecognition;
  }
}

export const useSpeechRecognition = () => {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [isSupported, setIsSupported] = useState(false);
  const [recognition, setRecognition] = useState<ISpeechRecognition | null>(null);
  const accumulatedTranscriptRef = useRef('');
  const shouldRestartRef = useRef(false);
  const isStoppingRef = useRef(false);

  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (SpeechRecognition) {
      setIsSupported(true);
      const recognitionInstance = new SpeechRecognition();
      
      // Configurações otimizadas para melhor precisão
      recognitionInstance.continuous = true;
      recognitionInstance.interimResults = true;
      recognitionInstance.lang = 'pt-BR';
      recognitionInstance.maxAlternatives = 1;

      recognitionInstance.onstart = () => {
        console.log('🎤 Reconhecimento iniciado');
        setIsListening(true);
        isStoppingRef.current = false;
      };

      recognitionInstance.onend = () => {
        console.log('🛑 Reconhecimento finalizado');
        setIsListening(false);
        
        // Reconexão automática se não foi parada intencionalmente
        if (shouldRestartRef.current && !isStoppingRef.current) {
          console.log('🔄 Reconectando automaticamente...');
          try {
            recognitionInstance.start();
          } catch (error) {
            console.error('Erro ao reconectar:', error);
          }
        }
      };

      recognitionInstance.onresult = (event: SpeechRecognitionEvent) => {
        let finalTranscript = '';
        let interimTranscript = '';

        // CORREÇÃO CRÍTICA: Processar TODOS os resultados, não apenas a partir do resultIndex
        // Isso garante que nenhuma palavra seja perdida
        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i];
          const transcriptPiece = result[0].transcript;
          
          if (result.isFinal) {
            finalTranscript += transcriptPiece;
          } else {
            interimTranscript += transcriptPiece;
          }
        }

        // Atualizar o acumulado apenas com resultados finais
        if (finalTranscript) {
          // Adicionar espaço apenas se já houver conteúdo acumulado
          if (accumulatedTranscriptRef.current) {
            accumulatedTranscriptRef.current += ' ' + finalTranscript.trim();
          } else {
            accumulatedTranscriptRef.current = finalTranscript.trim();
          }
          console.log('✅ Transcrição acumulada:', accumulatedTranscriptRef.current);
        }

        // Combinar acumulado com interim para mostrar em tempo real
        let currentTranscript = accumulatedTranscriptRef.current;
        if (interimTranscript) {
          currentTranscript = currentTranscript 
            ? currentTranscript + ' ' + interimTranscript.trim()
            : interimTranscript.trim();
        }
        
        console.log('📝 Transcrição atual:', currentTranscript);
        setTranscript(currentTranscript);
      };

      recognitionInstance.onerror = (event: SpeechRecognitionErrorEvent) => {
        console.error('❌ Erro no reconhecimento de voz:', event.error);
        
        // Não tratar como erro fatal se for apenas "no-speech"
        if (event.error === 'no-speech') {
          console.log('ℹ️ Nenhuma fala detectada, aguardando...');
          return;
        }
        
        // Para outros erros, parar e reportar
        if (event.error !== 'aborted') {
          setIsListening(false);
          shouldRestartRef.current = false;
        }
      };

      setRecognition(recognitionInstance);
    } else {
      console.warn('⚠️ Speech Recognition não é suportado neste navegador');
      setIsSupported(false);
    }
  }, []);

  const startListening = useCallback(() => {
    if (recognition && !isListening) {
      setTranscript('');
      accumulatedTranscriptRef.current = '';
      shouldRestartRef.current = true;
      isStoppingRef.current = false;
      
      try {
        recognition.start();
      } catch (error) {
        console.error('Erro ao iniciar reconhecimento:', error);
      }
    }
  }, [recognition, isListening]);

  const stopListening = useCallback(() => {
    if (recognition && isListening) {
      shouldRestartRef.current = false;
      isStoppingRef.current = true;
      recognition.stop();
    }
  }, [recognition, isListening]);

  const resetTranscript = useCallback(() => {
    setTranscript('');
    accumulatedTranscriptRef.current = '';
  }, []);

  return {
    isListening,
    transcript,
    isSupported,
    startListening,
    stopListening,
    resetTranscript,
  };
};

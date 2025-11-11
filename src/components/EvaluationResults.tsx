import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Star, CheckCircle2, AlertCircle, ArrowLeft } from "lucide-react";

interface Opportunity {
  area: string;
  trecho_original: string;
  sugestao: string;
}

interface EvaluationProps {
  evaluation: {
    csat: number;
    pontos_positivos: string[];
    oportunidades: Opportunity[];
    resumo: string;
  };
  onBack: () => void;
}

const EvaluationResults = ({ evaluation, onBack }: EvaluationProps) => {
  const getScoreColor = (score: number) => {
    if (score >= 4) return "text-green-600";
    if (score >= 3) return "text-yellow-600";
    return "text-red-600";
  };

  const getScoreLabel = (score: number) => {
    if (score === 5) return "Excelente";
    if (score === 4) return "Muito Bom";
    if (score === 3) return "Bom";
    if (score === 2) return "Regular";
    return "Precisa Melhorar";
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-muted p-4">
      <div className="max-w-4xl mx-auto py-8">
        <Button variant="ghost" onClick={onBack} className="mb-6">
          <ArrowLeft className="w-4 h-4 mr-2" />
          Nova Simulação
        </Button>

        {/* CSAT Score */}
        <Card className="mb-8 border-2 shadow-elegant">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-4">
              {[1, 2, 3, 4, 5].map((star) => (
                <Star
                  key={star}
                  className={`w-10 h-10 ${
                    star <= evaluation.csat
                      ? 'fill-secondary text-secondary'
                      : 'text-gray-300'
                  }`}
                />
              ))}
            </div>
            <CardTitle className="text-3xl">
              <span className={getScoreColor(evaluation.csat)}>
                {evaluation.csat}/5 - {getScoreLabel(evaluation.csat)}
              </span>
            </CardTitle>
            <CardDescription className="text-base mt-2">
              {evaluation.resumo}
            </CardDescription>
          </CardHeader>
        </Card>

        {/* Positive Points */}
        <Card className="mb-6 shadow-elegant">
          <CardHeader>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-6 h-6 text-green-600" />
              <CardTitle className="text-xl">Pontos Positivos</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {evaluation.pontos_positivos.map((point, index) => (
                <li key={index} className="flex items-start gap-2">
                  <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200 mt-1">
                    ✓
                  </Badge>
                  <span className="text-sm">{point}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        {/* Improvement Opportunities */}
        {evaluation.oportunidades && evaluation.oportunidades.length > 0 && (
          <Card className="shadow-elegant">
            <CardHeader>
              <div className="flex items-center gap-2">
                <AlertCircle className="w-6 h-6 text-secondary" />
                <CardTitle className="text-xl">Oportunidades de Melhoria</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-6">
                {evaluation.oportunidades.map((opp, index) => (
                  <div key={index} className="border-l-4 border-secondary pl-4 py-2">
                    <h4 className="font-semibold text-primary mb-2">{opp.area}</h4>
                    
                    <div className="space-y-3">
                      <div className="bg-red-50 p-3 rounded-lg border border-red-200">
                        <p className="text-xs font-semibold text-red-700 mb-1">O que você disse:</p>
                        <p className="text-sm text-red-900">"{opp.trecho_original}"</p>
                      </div>
                      
                      <div className="bg-green-50 p-3 rounded-lg border border-green-200">
                        <p className="text-xs font-semibold text-green-700 mb-1">Sugestão de melhoria:</p>
                        <p className="text-sm text-green-900">"{opp.sugestao}"</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        <div className="flex justify-center mt-8">
          <Button
            size="lg"
            className="bg-gradient-primary text-white hover:opacity-90 shadow-glow"
            onClick={onBack}
          >
            Fazer Nova Simulação
          </Button>
        </div>
      </div>
    </div>
  );
};

export default EvaluationResults;

/**
 * Utilitários de autenticação e sessão
 * - isAuthenticated(): verifica existência e validade (exp) do JWT de acesso
 * - setTokens(): salva access/refresh tokens
 * - getAccessToken()/getRefreshToken(): obtém tokens
 * - clearTokens(): limpa sessão
 * - getAuthHeader(): cabeçalho Authorization
 */

type JwtPayload = {
  exp?: number;
  iat?: number;
  [key: string]: any;
};

const ACCESS_TOKEN_KEY = "access_token";
const REFRESH_TOKEN_KEY = "refresh_token";

/**
 * Converte base64url para base64
 */
function base64UrlToBase64(input: string): string {
  let base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4;
  if (pad === 2) base64 += "==";
  else if (pad === 3) base64 += "=";
  else if (pad !== 0) base64 += "====";
  return base64;
}

/**
 * Faz o parse do payload do JWT sem validação de assinatura
 */
function parseJwt(token: string): JwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1];
    const json = atob(base64UrlToBase64(payload));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Verifica se o token está expirado pelo campo exp (em segundos)
 */
export function isTokenExpired(token: string): boolean {
  const payload = parseJwt(token);
  if (!payload || typeof payload.exp !== "number") {
    // Se não houver exp, considera inválido
    return true;
  }
  const nowMs = Date.now();
  const expMs = payload.exp * 1000;
  return nowMs >= expMs;
}

/**
 * Retorna o access token armazenado
 */
export function getAccessToken(): string | null {
  try {
    return localStorage.getItem(ACCESS_TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * Retorna o refresh token armazenado
 */
export function getRefreshToken(): string | null {
  try {
    return localStorage.getItem(REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * Salva tokens de acesso e refresh
 */
export function setTokens(accessToken: string, refreshToken?: string) {
  try {
    localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    if (refreshToken) {
      localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
    }
  } catch {
    // storage indisponível (modo privado, etc.)
  }
}

/**
 * Limpa sessão (tokens)
 */
export function clearTokens() {
  try {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  } catch {
    // ignore
  }
}

/**
 * Indica se usuário está autenticado (token válido e não expirado)
 */
export function isAuthenticated(): boolean {
  const token = getAccessToken();
  if (!token) return false;
  return !isTokenExpired(token);
}

/**
 * Cabeçalho Authorization para chamadas à API
 */
export function getAuthHeader(): Record<string, string> {
  const token = getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Opcional: armazena/obtém o clientId selecionado para multi-tenant
 */
const CLIENT_ID_KEY = "client_id";

export function setClientId(clientId: string) {
  try {
    localStorage.setItem(CLIENT_ID_KEY, clientId);
  } catch {
    // ignore
  }
}

export function getClientId(): string | null {
  try {
    return localStorage.getItem(CLIENT_ID_KEY);
  } catch {
    return null;
  }
}

/**
 * Cabeçalhos comuns para multi-tenant
 */
export function getCommonHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const auth = getAuthHeader();
  const clientId = getClientId();
  if (auth.Authorization) {
    headers.Authorization = auth.Authorization;
  }
  if (clientId) {
    headers["X-Client-Id"] = clientId;
  }
  return headers;
}
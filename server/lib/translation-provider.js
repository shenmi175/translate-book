function stripKnownEndpointSuffix(baseUrl) {
  return String(baseUrl || "").trim().replace(/\/+$/, "").replace(/\/(?:chat\/completions|responses)$/i, "");
}

export function normalizeApiProtocol(value, fallback = "chat_completions") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (!normalized) {
    return fallback;
  }

  if (["chat", "chat_completion", "chat_completions", "chatcompletions"].includes(normalized)) {
    return "chat_completions";
  }

  if (["response", "responses"].includes(normalized)) {
    return "responses";
  }

  return fallback;
}

function getEndpointSuffix(apiProtocol) {
  return normalizeApiProtocol(apiProtocol) === "responses" ? "/responses" : "/chat/completions";
}

function buildProviderUrl(baseUrl, apiProtocol) {
  const root = stripKnownEndpointSuffix(baseUrl);

  if (!root) {
    throw new Error("apiBaseUrl is required.");
  }

  return `${root}${getEndpointSuffix(apiProtocol)}`;
}

function extractTextPart(part) {
  if (typeof part === "string") {
    return part;
  }

  if (!part || typeof part !== "object") {
    return "";
  }

  if (typeof part.text === "string") {
    return part.text;
  }

  if (typeof part.content === "string") {
    return part.content;
  }

  if (Array.isArray(part.content)) {
    return part.content.map((item) => extractTextPart(item)).join("");
  }

  if (Array.isArray(part.text)) {
    return part.text.map((item) => extractTextPart(item)).join("");
  }

  return "";
}

function extractChatCompletionsContent(payload) {
  const content = payload?.choices?.[0]?.message?.content;

  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content.map((item) => extractTextPart(item)).join("").trim();
  }

  return "";
}

function extractResponsesContent(payload) {
  if (typeof payload?.output_text === "string") {
    return payload.output_text.trim();
  }

  if (Array.isArray(payload?.output_text)) {
    return payload.output_text.map((item) => extractTextPart(item)).join("").trim();
  }

  if (Array.isArray(payload?.output)) {
    return payload.output
      .map((item) => {
        if (Array.isArray(item?.content)) {
          return item.content.map((part) => extractTextPart(part)).join("");
        }
        return extractTextPart(item);
      })
      .join("")
      .trim();
  }

  return "";
}

function extractAssistantContent(payload, apiProtocol) {
  if (normalizeApiProtocol(apiProtocol) === "responses") {
    return extractResponsesContent(payload) || extractChatCompletionsContent(payload);
  }

  return extractChatCompletionsContent(payload) || extractResponsesContent(payload);
}

function buildRequestBody({ provider, body }) {
  const apiProtocol = normalizeApiProtocol(provider?.apiProtocol);
  const model = provider?.model || "deepseek-chat";

  if (apiProtocol === "responses") {
    return {
      model,
      ...body
    };
  }

  return {
    model,
    stream: false,
    temperature: 0,
    ...body
  };
}

function getProviderLabel(provider) {
  return provider?.apiProvider || "Provider";
}

function describeProviderError(payload, status, providerLabel) {
  const providerMessage =
    payload?.error?.message ||
    payload?.message ||
    payload?.detail ||
    `Provider request failed with status ${status}.`;

  return `${providerLabel} API error: ${providerMessage}`;
}

function describeTransportFailure(error, providerLabel, url) {
  const cause = error?.cause;
  const code = cause?.code || error?.code || "";
  const detail =
    (typeof cause?.message === "string" && cause.message.trim()) ||
    (typeof error?.message === "string" && error.message.trim()) ||
    "fetch failed";

  let hint = "";
  if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(code)) {
    hint = "The provider host could not be reached. Check the base URL, DNS, proxy, or server availability.";
  } else if (["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"].includes(code)) {
    hint = "The request timed out. Check provider latency, proxy settings, or server responsiveness.";
  } else if (["ECONNRESET", "UND_ERR_SOCKET"].includes(code)) {
    hint = "The TLS or socket connection was interrupted. Check Clash / VPN / HTTPS interception settings.";
  } else if (["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"].includes(code)) {
    hint = "TLS certificate verification failed. Check the certificate chain or local proxy interception.";
  }

  const pieces = [
    `${providerLabel} network error while requesting ${url}:`,
    code ? `${code}.` : "",
    detail.endsWith(".") ? detail : `${detail}.`,
    hint
  ].filter(Boolean);

  return pieces.join(" ");
}

function logProvider(message, meta = {}) {
  const timestamp = new Date().toISOString();
  const details = Object.entries(meta)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");

  console.log(`[${timestamp}] [INFO] provider:${message}${details ? ` ${details}` : ""}`);
}

async function requestModelResponse({ provider, body, operation, signal: externalSignal }) {
  const providerLabel = getProviderLabel(provider);
  const apiKey = provider?.apiKey || "";
  const model = provider?.model || "deepseek-chat";
  const apiBaseUrl = provider?.apiBaseUrl || "https://api.deepseek.com";
  const apiProtocol = normalizeApiProtocol(provider?.apiProtocol);
  const requestTimeoutMs = Number(provider?.requestTimeoutMs || 60000);
  const url = buildProviderUrl(apiBaseUrl, apiProtocol);

  if (!apiKey) {
    throw new Error(`${providerLabel} API key is not configured.`);
  }

  const controller = new AbortController();
  let timedOut = false;
  const relayAbort = () => controller.abort(externalSignal?.reason);
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1000, requestTimeoutMs));
  if (externalSignal) {
    if (externalSignal.aborted) {
      relayAbort();
    } else {
      externalSignal.addEventListener("abort", relayAbort, { once: true });
    }
  }
  const startedAt = Date.now();

  try {
    logProvider("request:start", {
      provider: providerLabel,
      url,
      model,
      apiProtocol,
      operation
    });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(buildRequestBody({ provider: { ...provider, apiProtocol }, body })),
      signal: controller.signal
    });

    const rawText = await response.text();
    let payload = null;

    try {
      payload = rawText ? JSON.parse(rawText) : null;
    } catch {
      payload = null;
    }

    const elapsedMs = Date.now() - startedAt;

    if (!response.ok) {
      throw Object.assign(new Error(describeProviderError(payload, response.status, providerLabel)), {
        responseStatus: response.status,
        responsePayload: payload,
        responseRawText: rawText,
        requestUrl: url,
        providerLabel,
        model,
        apiProtocol,
        elapsedMs
      });
    }

    const translation = extractAssistantContent(payload, apiProtocol);
    if (!translation) {
      throw Object.assign(new Error(`${providerLabel} API returned empty content.`), {
        responseStatus: response.status,
        responsePayload: payload,
        responseRawText: rawText,
        requestUrl: url,
        providerLabel,
        model,
        apiProtocol,
        elapsedMs
      });
    }

    logProvider("request:end", {
      provider: providerLabel,
      url,
      model,
      apiProtocol,
      status: response.status,
      outputLength: translation.length,
      operation
    });

    return {
      translation,
      raw: payload,
      status: response.status,
      url,
      providerLabel,
      model,
      apiProtocol,
      elapsedMs
    };
  } catch (error) {
    logProvider("request:failed", {
      provider: providerLabel,
      url,
      model,
      apiProtocol,
      operation,
      error: error instanceof Error ? error.message : String(error)
    });

    if (error?.name === "AbortError") {
      if (externalSignal?.aborted && !timedOut) {
        throw new Error(`${providerLabel} API request was cancelled.`);
      }
      throw new Error(`${providerLabel} API request timed out after ${requestTimeoutMs} ms.`);
    }

    if (!error?.responseStatus) {
      throw new Error(describeTransportFailure(error, providerLabel, url));
    }

    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timeoutId);
    if (externalSignal) {
      externalSignal.removeEventListener?.("abort", relayAbort);
    }
  }
}

function buildTranslationRequestBody({ provider, promptSnapshot, useRetranslationPrompt }) {
  const userPrompt = useRetranslationPrompt ? promptSnapshot.retranslationPrompt : promptSnapshot.translationPrompt;

  if (normalizeApiProtocol(provider?.apiProtocol) === "responses") {
    return {
      instructions: promptSnapshot.systemPrompt,
      input: userPrompt,
      text: {
        format: {
          type: "text"
        }
      }
    };
  }

  return {
    messages: [
      {
        role: "system",
        content: promptSnapshot.systemPrompt
      },
      {
        role: "user",
        content: userPrompt
      }
    ]
  };
}

function buildConnectionTestBody(provider) {
  if (normalizeApiProtocol(provider?.apiProtocol) === "responses") {
    return {
      instructions: "You are a connection probe. Reply with OK.",
      input: "Reply with OK.",
      max_output_tokens: 8,
      text: {
        format: {
          type: "text"
        }
      }
    };
  }

  return {
    max_tokens: 8,
    messages: [
      {
        role: "user",
        content: "Reply with OK."
      }
    ]
  };
}

export async function translateWithProvider({ provider, promptSnapshot, useRetranslationPrompt = false, signal }) {
  const result = await requestModelResponse({
    provider,
    operation: useRetranslationPrompt ? "retranslation" : "translation",
    signal,
    body: buildTranslationRequestBody({ provider, promptSnapshot, useRetranslationPrompt })
  });

  return {
    translation: result.translation,
    raw: result.raw
  };
}

export async function testProviderConnection({ provider }) {
  try {
    const result = await requestModelResponse({
      provider,
      operation: "connection-test",
      body: buildConnectionTestBody(provider)
    });

    return {
      ok: true,
      provider: result.providerLabel,
      model: result.model,
      apiProtocol: result.apiProtocol,
      url: result.url,
      status: result.status,
      latencyMs: result.elapsedMs,
      preview: result.translation.slice(0, 200),
      error: ""
    };
  } catch (error) {
    const apiProtocol = normalizeApiProtocol(error?.apiProtocol || provider?.apiProtocol);
    return {
      ok: false,
      provider: error?.providerLabel || getProviderLabel(provider),
      model: error?.model || provider?.model || "",
      apiProtocol,
      url: error?.requestUrl || (provider?.apiBaseUrl ? buildProviderUrl(provider.apiBaseUrl, apiProtocol) : ""),
      status: Number.isInteger(error?.responseStatus) ? error.responseStatus : 0,
      latencyMs: Number.isInteger(error?.elapsedMs) ? error.elapsedMs : 0,
      preview: "",
      error: error instanceof Error ? error.message : String(error),
      raw: error?.responsePayload || error?.responseRawText || null
    };
  }
}

export const translateWithDeepSeek = translateWithProvider;
export const testChatCompletionsConnection = testProviderConnection;

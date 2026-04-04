function buildChatCompletionsUrl(baseUrl) {
  const trimmed = String(baseUrl || "").replace(/\/+$/, "");

  if (!trimmed) {
    throw new Error("apiBaseUrl is required.");
  }

  if (trimmed.endsWith("/chat/completions")) {
    return trimmed;
  }

  return `${trimmed}/chat/completions`;
}

function extractAssistantContent(payload) {
  const content = payload?.choices?.[0]?.message?.content;

  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        if (item?.type === "text" && typeof item.text === "string") {
          return item.text;
        }

        return "";
      })
      .join("")
      .trim();
  }

  return "";
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

async function requestChatCompletions({ provider, body, operation, signal: externalSignal }) {
  const providerLabel = getProviderLabel(provider);
  const apiKey = provider?.apiKey || "";
  const model = provider?.model || "deepseek-chat";
  const apiBaseUrl = provider?.apiBaseUrl || "https://api.deepseek.com";
  const requestTimeoutMs = Number(provider?.requestTimeoutMs || 60000);
  const url = buildChatCompletionsUrl(apiBaseUrl);

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
      operation
    });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        stream: false,
        temperature: 0,
        ...body
      }),
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
        elapsedMs
      });
    }

    const translation = extractAssistantContent(payload);
    if (!translation) {
      throw Object.assign(new Error(`${providerLabel} API returned empty content.`), {
        responseStatus: response.status,
        responsePayload: payload,
        responseRawText: rawText,
        requestUrl: url,
        providerLabel,
        model,
        elapsedMs
      });
    }

    logProvider("request:end", {
      provider: providerLabel,
      url,
      model,
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
      elapsedMs
    };
  } catch (error) {
    logProvider("request:failed", {
      provider: providerLabel,
      url,
      model,
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

export async function translateWithDeepSeek({ provider, promptSnapshot, useRetranslationPrompt = false, signal }) {
  const result = await requestChatCompletions({
    provider,
    operation: useRetranslationPrompt ? "retranslation" : "translation",
    signal,
    body: {
      messages: [
        {
          role: "system",
          content: promptSnapshot.systemPrompt
        },
        {
          role: "user",
          content: useRetranslationPrompt ? promptSnapshot.retranslationPrompt : promptSnapshot.translationPrompt
        }
      ]
    }
  });

  return {
    translation: result.translation,
    raw: result.raw
  };
}

export async function testChatCompletionsConnection({ provider }) {
  try {
    const result = await requestChatCompletions({
      provider,
      operation: "connection-test",
      body: {
        max_tokens: 8,
        messages: [
          {
            role: "user",
            content: "Reply with OK."
          }
        ]
      }
    });

    return {
      ok: true,
      provider: result.providerLabel,
      model: result.model,
      url: result.url,
      status: result.status,
      latencyMs: result.elapsedMs,
      preview: result.translation.slice(0, 200),
      error: ""
    };
  } catch (error) {
    return {
      ok: false,
      provider: error?.providerLabel || getProviderLabel(provider),
      model: error?.model || provider?.model || "",
      url: error?.requestUrl || buildChatCompletionsUrl(provider?.apiBaseUrl || ""),
      status: Number.isInteger(error?.responseStatus) ? error.responseStatus : 0,
      latencyMs: Number.isInteger(error?.elapsedMs) ? error.elapsedMs : 0,
      preview: "",
      error: error instanceof Error ? error.message : String(error),
      raw: error?.responsePayload || error?.responseRawText || null
    };
  }
}

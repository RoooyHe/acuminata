/**
 * AI provider module — transport-agnostic.
 *
 * Provides two interfaces:
 *   - callText(prompt)            : text-only completion
 *   - callWithTools(messages, tools): tool-aware completion
 *
 * Both return raw strings / parsed tool calls. Localization is the caller's job.
 *
 * @param {Function} getConfig     - () => { provider, endpoint, apiKey, model }
 * @param {Function} requestFn     - (urlStr, {method, headers, body}, timeout) => Promise<{status, data}>
 */

const DEFAULT_TIMEOUT = 60000;

function createAIProviders(getConfig, requestFn) {
  function cfg() {
    return getConfig() || {};
  }

  function request(urlStr, options, timeout) {
    return requestFn(urlStr, options, timeout || DEFAULT_TIMEOUT);
  }

  // ── Helpers ──

  function parseJsonSafe(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  function extractJson(text) {
    if (!text || typeof text !== "string") return null;
    let s = text;
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1];
    const start = s.indexOf("{");
    if (start === -1) return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\" && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) return null;
    return s.slice(start, end + 1);
  }

  // ── Text-only providers ──

  async function callOllama(prompt, withFormat) {
    const endpoint = (cfg().endpoint || "").replace(/\/+$/, "");
    const model = cfg().model || "";
    const url = endpoint + "/api/generate";
    const body = { model, prompt, stream: false };
    if (withFormat !== false) body.format = "json";

    const { data } = await request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    let result = parseJsonSafe(data);
    if (!result) throw new Error("Ollama: failed to parse response");
    if (result.error) throw new Error(typeof result.error === "string" ? result.error : JSON.stringify(result.error));

    // Retry without format=json if the provider complains
    if (withFormat !== false && result.error && result.error.toLowerCase().includes("format")) {
      return callOllama(prompt, false);
    }
    return result.response || data;
  }

  async function callOpenAI(prompt) {
    const base = (cfg().endpoint || "").replace(/\/+$/, "").replace(/\/v1$/, "");
    const apiKey = cfg().apiKey || "";
    const model = cfg().model || "";
    const url = base + "/v1/chat/completions";
    const body = JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: "You are a content recommendation expert. Always respond with valid JSON only, no markdown fences.",
        },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.7,
    });

    const { status, data } = await request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      },
      body,
    });

    let result = parseJsonSafe(data);
    if (!result) throw new Error("OpenAI: failed to parse response, status: " + status);
    if (result.error) throw new Error(result.error.message || JSON.stringify(result.error));
    if (!result.choices || !result.choices[0]) throw new Error("OpenAI: no choices in response");
    return result.choices[0].message.content;
  }

  async function callAnthropic(prompt) {
    const base = (cfg().endpoint || "").replace(/\/+$/, "").replace(/\/v1$/, "");
    const apiKey = cfg().apiKey || "";
    const model = cfg().model || "";
    const url = base + "/v1/messages";
    const body = JSON.stringify({
      model,
      max_tokens: 1024,
      system: "You are a content recommendation expert. Always respond with valid JSON only, no markdown fences.",
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    });

    const { status, data } = await request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body,
    });

    let result = parseJsonSafe(data);
    if (!result) throw new Error("Anthropic: failed to parse response, status: " + status);
    if (result.error) throw new Error(result.error.message || JSON.stringify(result.error));
    if (result.content) {
      for (const block of result.content) {
        if (block.type === "text" && block.text != null) return block.text;
      }
    }
    throw new Error("Anthropic: no text content in response");
  }

  async function callText(prompt) {
    const provider = cfg().provider || "ollama";
    switch (provider) {
      case "openai":
        return callOpenAI(prompt);
      case "anthropic":
        return callAnthropic(prompt);
      default:
        return callOllama(prompt);
    }
  }

  // ── Tool-aware providers ──

  async function callOllamaToolsNative(messages, tools) {
    const endpoint = (cfg().endpoint || "").replace(/\/+$/, "");
    const model = cfg().model || "";
    const url = endpoint + "/api/chat";
    const ollamaMessages = messages.map((m) => {
      if (m.role === "tool")
        return {
          role: "user",
          content: "[Tool result for " + m.tool_call_id + "]: " + m.content,
        };
      if (m.role === "assistant" && m.tool_calls) {
        const blocks = m.tool_calls.map((tc) => ({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: typeof tc.arguments === "string" ? JSON.parse(tc.arguments) : tc.arguments,
        }));
        if (m.content) blocks.unshift({ type: "text", text: m.content });
        return { role: "assistant", content: blocks };
      }
      return { role: m.role, content: m.content || "" };
    });

    const ollamaTools = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));

    const body = JSON.stringify({
      model,
      messages: ollamaMessages,
      tools: ollamaTools,
      stream: false,
    });

    const { data } = await request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    const parsed = parseJsonSafe(data);
    if (parsed.error) throw new Error(parsed.error.message || JSON.stringify(parsed.error));
    const msg = parsed.message || {};
    const toolCalls = [];
    let content = "";

    if (msg.content) {
      if (typeof msg.content === "string") content = msg.content;
      else {
        for (const block of msg.content) {
          if (block.type === "text") content += block.text;
          if (block.type === "tool_use") {
            toolCalls.push({
              id: block.id || "call_" + toolCalls.length,
              name: block.name,
              arguments: JSON.stringify(block.input || {}),
            });
          }
        }
      }
    }
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        toolCalls.push({
          id: tc.id || "call_" + toolCalls.length,
          name: tc.function?.name || tc.name,
          arguments: typeof tc.function?.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function?.arguments || tc.arguments || {}),
        });
      }
    }
    return { content, tool_calls: toolCalls };
  }

  async function callOllamaToolsPrompt(messages, tools) {
    const systemPrompt =
      'You are an intelligent browsing assistant with access to tools. You can call tools to search records, analyze patterns, and manage the user\'s watchlist. When you need to call a tool, respond with JSON in this format:\n\n' +
      '{ "tool_calls": [{ "id": "call_1", "function": { "name": "tool_name", "arguments": "{{...}}" } }], "content": "Your observation text" }\n\n' +
      "Available tools:\n" +
      JSON.stringify(tools, null, 2) +
      "\n\nWhen you are done and don't need more tools, respond with:\n{ \"content\": \"Your final response text\" }\n\nAlways use valid JSON.";

    const userContent = messages
      .map((m) => {
        if (m.role === "tool") return "[Tool result for " + m.tool_call_id + "]: " + m.content;
        return m.role + ": " + (m.content || "");
      })
      .join("\n\n");

    const prompt = systemPrompt + "\n\n---\n\n" + userContent;
    const raw = await callOllama(prompt);
    try {
      const parsed = JSON.parse(raw);
      return { content: parsed.content || "", tool_calls: parsed.tool_calls || [] };
    } catch (e) {
      return { content: raw, tool_calls: [] };
    }
  }

  async function callOllamaTools(messages, tools) {
    try {
      return await callOllamaToolsNative(messages, tools);
    } catch (e) {
      return callOllamaToolsPrompt(messages, tools);
    }
  }

  async function callOpenAITools(messages, tools) {
    const base = (cfg().endpoint || "").replace(/\/+$/, "").replace(/\/v1$/, "");
    const apiKey = cfg().apiKey || "";
    const model = cfg().model || "";
    const url = base + "/v1/chat/completions";
    const msgs =
      messages[0]?.role === "system"
        ? messages
        : [
            {
              role: "system",
              content: "You are an intelligent browsing history assistant. Use tools to search records, analyze patterns, and manage the watchlist.",
            },
            ...messages,
          ];

    const body = JSON.stringify({
      model,
      messages: msgs,
      tools: tools,
      tool_choice: "auto",
      temperature: 0.7,
    });

    const { data } = await request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      },
      body,
    });

    let result = parseJsonSafe(data);
    if (!result) throw new Error("OpenAI: failed to parse response during tool call");
    if (result.error) throw new Error(result.error.message || JSON.stringify(result.error));
    const choice = result.choices?.[0];
    if (!choice) throw new Error("OpenAI: no choices in tool response");
    const message = choice.message;
    const toolCalls = (message.tool_calls || []).map((tc) => ({
      id: tc.id,
      name: tc.function?.name,
      arguments: tc.function?.arguments,
    }));
    return { content: message.content || "", tool_calls: toolCalls };
  }

  async function callAnthropicTools(messages, tools) {
    const base = (cfg().endpoint || "").replace(/\/+$/, "").replace(/\/v1$/, "");
    const apiKey = cfg().apiKey || "";
    const model = cfg().model || "";
    const url = base + "/v1/messages";
    const systemMsg =
      messages[0]?.role === "system"
        ? messages[0].content
        : "You are an intelligent browsing history assistant. Use tools to search records, analyze patterns, and manage the watchlist.";
    const conversationMsgs = messages[0]?.role === "system" ? messages.slice(1) : messages;

    const anthropicMessages = conversationMsgs.map((m) => {
      if (m.role === "tool")
        return {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: m.tool_call_id,
              content: m.content,
            },
          ],
        };
      if (m.role === "assistant" && m.tool_calls) {
        const blocks = m.tool_calls.map((tc) => ({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: typeof tc.arguments === "string" ? JSON.parse(tc.arguments) : tc.arguments,
        }));
        if (m.content) blocks.unshift({ type: "text", text: m.content });
        return { role: "assistant", content: blocks };
      }
      return { role: m.role, content: [{ type: "text", text: m.content || "" }] };
    });

    const body = JSON.stringify({
      model,
      max_tokens: 1024,
      system: systemMsg,
      messages: anthropicMessages,
      tools: tools,
    });

    const { data } = await request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body,
    });

    let result = parseJsonSafe(data);
    if (!result) throw new Error("Anthropic: failed to parse response during tool call");
    if (result.error) throw new Error(result.error.message || JSON.stringify(result.error));
    const toolCalls = [];
    let textContent = "";
    if (result.content) {
      for (const block of result.content) {
        if (block.type === "text" && block.text != null) textContent += block.text;
        if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
          });
        }
      }
    }
    return { content: textContent, tool_calls: toolCalls };
  }

  async function callWithTools(messages, tools) {
    const provider = cfg().provider || "ollama";
    switch (provider) {
      case "openai":
        return callOpenAITools(messages, tools);
      case "anthropic":
        return callAnthropicTools(messages, tools);
      default:
        return callOllamaTools(messages, tools);
    }
  }

  return { callText, callWithTools, extractJson };
}

module.exports = { createAIProviders };

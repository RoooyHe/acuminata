/**
 * Mocked transport tests for agent/providers.js
 * Run with: node agent/providers.test.js
 */

const { createAIProviders } = require('./providers');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

async function runTests() {
  console.log('\n── agent/providers.js mocked transport tests ──\n');

  // ── Text: Ollama ──
  {
    console.log('Text provider: Ollama');
    const captured = [];
    const requestFn = async (url, opts, timeout) => {
      captured.push({ url, method: opts.method, body: JSON.parse(opts.body) });
      return { status: 200, data: JSON.stringify({ response: 'ollama-result' }) };
    };
    const providers = createAIProviders(() => ({ provider: 'ollama', endpoint: 'http://localhost:11434', model: 'm' }), requestFn);
    const result = await providers.callText('hello');
    assert(result === 'ollama-result', 'returns raw response text');
    assert(captured.length === 1, 'made one request');
    assert(captured[0].url === 'http://localhost:11434/api/generate', 'hits /api/generate');
    assert(captured[0].body.model === 'm', 'uses configured model');
    assert(captured[0].body.format === 'json', 'sends format=json by default');
  }

  // ── Text: OpenAI ──
  {
    console.log('Text provider: OpenAI');
    const captured = [];
    const requestFn = async (url, opts, timeout) => {
      captured.push({ url, method: opts.method, headers: opts.headers, body: JSON.parse(opts.body) });
      return { status: 200, data: JSON.stringify({ choices: [{ message: { content: 'openai-result' } }] }) };
    };
    const providers = createAIProviders(() => ({ provider: 'openai', endpoint: 'http://localhost:9000/v1', apiKey: 'k', model: 'gpt' }), requestFn);
    const result = await providers.callText('hello');
    assert(result === 'openai-result', 'returns message content');
    assert(captured[0].url === 'http://localhost:9000/v1/chat/completions', 'hits chat/completions');
    assert(captured[0].body.model === 'gpt', 'uses configured model');
    assert(captured[0].headers.Authorization === 'Bearer k', 'sends api key');
  }

  // ── Text: Anthropic ──
  {
    console.log('Text provider: Anthropic');
    const captured = [];
    const requestFn = async (url, opts, timeout) => {
      captured.push({ url, method: opts.method, headers: opts.headers, body: JSON.parse(opts.body) });
      return { status: 200, data: JSON.stringify({ content: [{ type: 'text', text: 'anthropic-result' }] }) };
    };
    const providers = createAIProviders(() => ({ provider: 'anthropic', endpoint: 'http://localhost:9000', apiKey: 'k', model: 'claude' }), requestFn);
    const result = await providers.callText('hello');
    assert(result === 'anthropic-result', 'returns text block content');
    assert(captured[0].url === 'http://localhost:9000/v1/messages', 'hits /v1/messages');
    assert(captured[0].headers['anthropic-version'] === '2023-06-01', 'sends anthropic version');
  }

  // ── Tools: Ollama native ──
  {
    console.log('Tools provider: Ollama native');
    const captured = [];
    const requestFn = async (url, opts, timeout) => {
      captured.push({ url, body: JSON.parse(opts.body) });
      return {
        status: 200,
        data: JSON.stringify({
          message: {
            content: [
              { type: 'text', text: 'thinking...' },
              { type: 'tool_use', id: 't1', name: 'search', input: { q: 'x' } },
            ],
          },
        }),
      };
    };
    const providers = createAIProviders(() => ({ provider: 'ollama', endpoint: 'http://localhost:11434', model: 'm' }), requestFn);
    const result = await providers.callWithTools([{ role: 'user', content: 'hi' }], [{ name: 'search', description: '', input_schema: {} }]);
    assert(result.content === 'thinking...', 'returns text content');
    assert(result.tool_calls.length === 1, 'returns one tool call');
    assert(result.tool_calls[0].id === 't1', 'preserves tool id');
    assert(result.tool_calls[0].name === 'search', 'preserves tool name');
    assert(result.tool_calls[0].arguments === '{"q":"x"}', 'stringifies tool arguments');
  }

  // ── Tools: OpenAI ──
  {
    console.log('Tools provider: OpenAI');
    const captured = [];
    const requestFn = async (url, opts, timeout) => {
      captured.push({ url, body: JSON.parse(opts.body) });
      return {
        status: 200,
        data: JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  { id: 'c1', function: { name: 'get_stats', arguments: '{}' } },
                ],
              },
            },
          ],
        }),
      };
    };
    const providers = createAIProviders(() => ({ provider: 'openai', endpoint: 'http://localhost:9000/v1', apiKey: 'k', model: 'gpt' }), requestFn);
    const result = await providers.callWithTools([{ role: 'user', content: 'hi' }], [{ name: 'get_stats', description: '', input_schema: {} }]);
    assert(captured[0].url === 'http://localhost:9000/v1/chat/completions', 'hits chat/completions once, not /v1/v1');
    assert(result.tool_calls.length === 1, 'returns one tool call');
    assert(result.tool_calls[0].name === 'get_stats', 'maps function name');
    assert(result.tool_calls[0].arguments === '{}', 'maps function arguments');
    assert(captured[0].body.tool_choice === 'auto', 'sets tool_choice auto');
  }

  // ── Tools: Anthropic ──
  {
    console.log('Tools provider: Anthropic');
    const captured = [];
    const requestFn = async (url, opts, timeout) => {
      captured.push({ body: JSON.parse(opts.body) });
      return {
        status: 200,
        data: JSON.stringify({
          content: [
            { type: 'text', text: 'ok' },
            { type: 'tool_use', id: 'a1', name: 'delete', input: { ids: ['1'] } },
          ],
        }),
      };
    };
    const providers = createAIProviders(() => ({ provider: 'anthropic', endpoint: 'http://localhost:9000', apiKey: 'k', model: 'claude' }), requestFn);
    const result = await providers.callWithTools([{ role: 'user', content: 'hi' }], [{ name: 'delete', description: '', input_schema: {} }]);
    assert(result.content === 'ok', 'returns text content');
    assert(result.tool_calls.length === 1, 'returns one tool call');
    assert(result.tool_calls[0].id === 'a1', 'preserves tool id');
    assert(result.tool_calls[0].arguments === '{"ids":["1"]}', 'stringifies input object');
  }

  // ── Config freshness ──
  {
    console.log('Config freshness (live getConfig)');
    let current = { provider: 'ollama', endpoint: 'http://a', apiKey: '', model: 'm1' };
    const captured = [];
    const requestFn = async (url, opts, timeout) => {
      captured.push({ url });
      return { status: 200, data: JSON.stringify({ response: 'r' }) };
    };
    const providers = createAIProviders(() => current, requestFn);
    await providers.callText('x');
    assert(captured[0].url === 'http://a/api/generate', 'uses initial endpoint');
    current.endpoint = 'http://b';
    await providers.callText('x');
    assert(captured[1].url === 'http://b/api/generate', 'picks up updated endpoint');
  }

  // ── Error propagation ──
  {
    console.log('Error propagation');
    const requestFn = async () => {
      throw new Error('network-down');
    };
    const providers = createAIProviders(() => ({ provider: 'openai', endpoint: 'http://localhost:9000/v1', apiKey: 'k', model: 'gpt' }), requestFn);
    let threw = false;
    try {
      await providers.callText('hello');
    } catch (e) {
      threw = true;
      assert((e.message || '').includes('network-down'), 'preserves transport error message');
    }
    assert(threw, 'propagates transport error');
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((e) => {
  console.error('Test runner error:', e);
  process.exit(1);
});

/**
 * THE CHAT COMPLETIONS TOOL PROTOCOL, which the loop could not read.
 *
 * `toolExchange` was written against OpenAI's Responses API, where one event carries a whole tool call
 * and the next turn just names a `previous_response_id`. Chat Completions — GLM, Grok, and most
 * OpenAI-COMPATIBLE vendors — does neither:
 *
 *   tool calls arrive as FRAGMENTS, keyed by index, with `arguments` concatenated across events
 *   there is no chain id, so the whole `messages` array is resent every turn
 *
 * Both were real blockers, not theoretical: reading `arguments` off any single GLM event yields a piece
 * of JSON like `{"qu` that cannot be parsed, and without a transcript the model forgets its own tool
 * call between turns and loops forever.
 *
 * A REAL SERVER, because the thing under test is what goes on the wire across TWO turns — that the
 * fragments reassemble, that the transcript arrives in the second request, and that the assistant's
 * tool-call turn precedes its results (a tool message with no preceding tool_call is a vendor ERROR,
 * so the order is not cosmetic).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { runToolLoop, type ToolBridge } from "../src/manifests/runtime/tools/toolloop.js";
import { makeEmitter } from "../src/manifests/runtime/events.js";
import { emptyContext } from "../src/manifests/runtime/index.js";

/** GLM's shape: tool_calls in pieces, then a second turn that answers in words. */
function chatServer() {
  const bodies: any[] = [];
  const sse = (lines: string[]) => lines.map((l) => `data: ${l}\n\n`).join("") + "data: [DONE]\n\n";
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      bodies.push(JSON.parse(body || "{}"));
      res.setHeader("content-type", "text/event-stream");
      if (bodies.length === 1) {
        // Turn one: a preamble, then ONE call split across four events.
        res.end(sse([
          JSON.stringify({ choices: [{ delta: { content: "Let me look that up. " } }] }),
          JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "search" } }] } }] }),
          JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"qu' } }] } }] }),
          JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ery":"cats"}' } }] } }] }),
        ]));
      } else {
        res.end(sse([JSON.stringify({ choices: [{ delta: { content: "Cats are small." } }] })]));
      }
    });
  });
  return { server, bodies, listen: () => new Promise<number>((r) => server.listen(0, () => r((server.address() as any).port))) };
}

const bridge: ToolBridge = {
  async discover() { return [{ name: "search", description: "search", parameters: { type: "object" } }]; },
  async call(_n, _a) { return JSON.stringify({ hits: ["cats are small"] }); },
  async absorb(_n, c) { return { content: c, minted: [] }; },
  endsTurn() { return false; },
};

/** The Chat Completions protocol, exactly as a zai/grok manifest would declare it. */
const CHAT_EXCHANGE = (port: number) => ({
  maxTurns: 5,
  stuckAfterRepeats: 3,
  tool: "return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }",
  toolsInto: "tools",
  call: {
    // NO `match`: a Chat Completions chunk has no `type` field at all, so `when` does the filtering.
    when: "return Array.isArray((((response.choices || [])[0] || {}).delta || {}).tool_calls)",
    each: "return (((response.choices || [])[0] || {}).delta || {}).tool_calls || []",
    index: "return part.index || 0",
    id: "return part.id",
    name: "return (part.function || {}).name",
    arguments: "return (part.function || {}).arguments",
  },
  result: "return { role: 'tool', tool_call_id: call.id, content: call.output }",
  transcript: {
    text: "return (((response.choices || [])[0] || {}).delta || {}).content",
    assistant: "return { role: 'assistant', content: text || null, tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) }",
  },
});

const nodeFor = (port: number) => ({
  type: "GLMLike",
  allowedHosts: [`127.0.0.1:${port}`],
  api: {
    toolExchange: CHAT_EXCHANGE(port),
    events: [],
    run: [{
      name: "generate",
      method: "POST",
      url: `http://127.0.0.1:${port}/chat`,
      transport: "sse",
      terminator: "[DONE]",
      // The manifest spreads the loop's transcript into its OWN message array — the vendor's shape
      // stays in the manifest, which is the whole point of the design.
      body: "return { model: 'glm-5.2', stream: true, messages: [{ role: 'user', content: 'how big are cats' }].concat(transcript) }",
    }],
  },
}) as any;

test("tool call fragments reassemble into one parseable call", async () => {
  const { server, bodies, listen } = chatServer();
  const port = await listen();
  try {
    const node = nodeFor(port);
    const seen: any[] = [];
    await runToolLoop(node, emptyContext(), bridge, makeEmitter(node, (e) => seen.push(e), {}));

    assert.equal(bodies.length, 2, "expected a tool turn then an answer turn");

    const assistant = bodies[1].messages.find((m: any) => m.role === "assistant");
    assert.ok(assistant, "the second request must carry the assistant's tool-call turn");
    // THE POINT: '{"qu' + 'ery":"cats"}' reassembled. Reading either fragment alone is unparseable.
    assert.equal(assistant.tool_calls[0].function.arguments, '{"query":"cats"}');
    assert.equal(assistant.tool_calls[0].function.name, "search");
    assert.equal(assistant.tool_calls[0].id, "call_1");
  } finally {
    server.close();
  }
});

test("the transcript grows, and the assistant turn precedes its results", async () => {
  const { server, bodies, listen } = chatServer();
  const port = await listen();
  try {
    const node = nodeFor(port);
    await runToolLoop(node, emptyContext(), bridge, makeEmitter(node, () => {}, {}));

    // Turn one sends only the user message: an empty transcript must change nothing.
    assert.deepEqual(bodies[0].messages.map((m: any) => m.role), ["user"]);

    // Turn two carries the history, IN ORDER. A tool message before its tool_call is a vendor error,
    // so this assertion is about correctness on the wire, not tidiness.
    assert.deepEqual(bodies[1].messages.map((m: any) => m.role), ["user", "assistant", "tool"]);
    const toolMsg = bodies[1].messages[2];
    assert.equal(toolMsg.tool_call_id, "call_1", "the result must be joined to the call that asked for it");
    assert.match(toolMsg.content, /cats are small/);
  } finally {
    server.close();
  }
});

test("the assistant's preamble is kept, not dropped", async () => {
  const { server, bodies, listen } = chatServer();
  const port = await listen();
  try {
    const node = nodeFor(port);
    await runToolLoop(node, emptyContext(), bridge, makeEmitter(node, () => {}, {}));
    // With preambles on, a model explains itself before calling a tool. Losing that text would cost the
    // model its own reasoning thread on the next turn.
    assert.equal(bodies[1].messages[1].content, "Let me look that up. ");
  } finally {
    server.close();
  }
});
